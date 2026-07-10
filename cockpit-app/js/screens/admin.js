/* ============================================================
 * Tela — Administração de usuários (super-admin · Iteração 4)
 * Rota: #/admin  (visível/roteável só p/ session.admin — gate em core.js)
 * Contrato: API_CONTRACT.md §"Super-admin — gestão de usuários pela web".
 *   GET   /api/admin/users              → lista (nunca hash; master 'admin' fora)
 *   POST  /api/admin/users              → cria (201)
 *   PATCH /api/admin/users/{username}   → {empresas?, ativo?, admin?, senha?}
 * Trava anti-lockout é SERVER-SIDE (409); o front espelha p/ UX e mostra o detail.
 * Usa APENAS window.CK. Todo texto de usuário passa por CK.esc (XSS).
 * ============================================================ */
(function () {
  'use strict';

  var esc = CK.esc;
  // regex de username idêntica ao backend / ia/cockpit_users.py
  var RE_USER = /^[a-z0-9][a-z0-9._-]{1,79}$/;

  /* ── estilos da tela (escopados 'adm-*'; injetados 1x p/ não tocar app.css) ─ */
  (function injetaCSS() {
    if (document.getElementById('adm-css')) return;
    var s = document.createElement('style');
    s.id = 'adm-css';
    s.textContent =
      '.adm-table td{vertical-align:middle;}' +
      '.adm-table tr:hover td{background:transparent;cursor:default;}' +
      '.adm-acoes{white-space:nowrap;text-align:right;}' +
      '.adm-acoes .btn{margin-left:6px;}' +
      '.adm-acoes .btn[disabled]{opacity:0.4;cursor:not-allowed;}' +
      '.adm-emp-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;' +
        'color:var(--text-2);background:var(--bg-hover);border:1px solid var(--border);' +
        'padding:3px 9px;border-radius:20px;margin:2px 2px 2px 0;}' +
      '.adm-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;}' +
      '.adm-muted{color:var(--text-3);font-size:12px;}' +
      '.adm-form .adm-empresas{margin-bottom:4px;}' +
      '.adm-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);' +
        'padding:6px 0;cursor:pointer;}' +
      '.adm-check input{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;}' +
      '.adm-check-todas{border-bottom:1px solid var(--border);margin-bottom:6px;padding-bottom:10px;}' +
      '.adm-empresas-list{padding-left:2px;}' +
      '.adm-hint{font-size:11px;color:var(--text-3);}' +
      '.adm-erro{color:var(--red);font-size:12px;min-height:16px;line-height:1.4;margin:2px 0;}' +
      '.adm-actions{margin-top:18px;display:flex;gap:8px;}' +
      '.adm-form .login-input{width:100%;}';
    document.head.appendChild(s);
  })();

  /* ── fetch p/ mutações: expõe o `detail` PT-BR de erros 4xx ──────
     CK.api engole o corpo de erro; aqui precisamos do detail (400/409).
     401 → dispara o gate de login via CK.api (sessão) e propaga. */
  function mutar(path, metodo, corpo) {
    return fetch(path, {
      method: metodo,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (r) {
      if (r.status === 401) {
        CK.api('/api/session').catch(function () {}); // reexibe overlay de login
        var e401 = new Error('sessão expirada'); e401.status = 401; throw e401;
      }
      if (r.status === 204) return null;
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var det = (data && data.detail) || ('Erro ' + r.status);
          var e = new Error(det); e.status = r.status; e.detail = det; throw e;
        }
        return data;
      });
    });
  }

  /* ── campo de empresas: toggle "Todas" + checkboxes das 5 ────────
     Retorna { el, valor() → 'todas' | [slugs] }. `inicial` = mesmo formato. */
  function campoEmpresas(inicial) {
    var todas = inicial === 'todas';
    var sel = Array.isArray(inicial) ? inicial.slice() : [];
    var wrap = document.createElement('div');
    wrap.className = 'adm-empresas';

    var rowTodas =
      '<label class="adm-check adm-check-todas">' +
        '<input type="checkbox" data-adm="todas"' + (todas ? ' checked' : '') + '>' +
        '<span>Todas as empresas <span class="adm-hint">(acesso total — inclui o consolidado do Grupo)</span></span>' +
      '</label>';
    var linhas = CK.EMPRESAS.map(function (e) {
      var ck = !todas && sel.indexOf(e.slug) !== -1;
      return '<label class="adm-check">' +
        '<input type="checkbox" data-slug="' + esc(e.slug) + '"' + (ck ? ' checked' : '') +
          (todas ? ' disabled' : '') + '>' +
        '<span class="adm-dot" style="background:' + esc(e.color) + '"></span>' +
        '<span>' + esc(e.label) + '</span>' +
      '</label>';
    }).join('');
    wrap.innerHTML = rowTodas + '<div class="adm-empresas-list">' + linhas + '</div>';

    var chkTodas = wrap.querySelector('[data-adm="todas"]');
    function sync() {
      var t = chkTodas.checked;
      wrap.querySelectorAll('[data-slug]').forEach(function (c) {
        c.disabled = t;
        if (t) c.checked = false;
      });
    }
    chkTodas.addEventListener('change', sync);

    return {
      el: wrap,
      valor: function () {
        if (chkTodas.checked) return 'todas';
        var out = [];
        wrap.querySelectorAll('[data-slug]').forEach(function (c) {
          if (c.checked) out.push(c.getAttribute('data-slug'));
        });
        return out;
      }
    };
  }

  /* ── chips de empresas p/ a coluna da tabela ─────────────────────*/
  function chipsEmpresas(empresas) {
    if (empresas === 'todas') {
      return '<span class="chip accent">Todas</span>';
    }
    if (!Array.isArray(empresas) || !empresas.length) {
      return '<span class="adm-muted">nenhuma</span>';
    }
    return empresas.map(function (slug) {
      var e = CK.empresa(slug);
      var label = e ? e.label : slug;
      var cor = e ? e.color : 'var(--text-3)';
      return '<span class="adm-emp-chip"><span class="adm-dot" style="background:' +
        esc(cor) + '"></span>' + esc(label) + '</span>';
    }).join(' ');
  }

  /* ── drawer: novo usuário ────────────────────────────────────────*/
  function abrirNovo(aoSalvar) {
    CK.openDrawer({
      title: 'Novo usuário',
      subtitle: 'Cria um acesso na tabela cockpit_user',
      render: function (body) {
        var campos = campoEmpresas([]);
        body.innerHTML =
          '<form class="adm-form" novalidate>' +
            '<label class="login-label" for="adm-user">Usuário</label>' +
            '<input class="login-input" id="adm-user" type="text" autocomplete="off" ' +
              'autocapitalize="none" spellcheck="false" placeholder="ex.: maria.silva" ' +
              'aria-label="Nome de usuário">' +
            '<div class="adm-hint" style="margin:-8px 0 14px;">Minúsculo · letras, números, ponto, hífen ou underscore.</div>' +
            '<label class="login-label">Empresas com acesso</label>' +
            '<div data-slot="empresas"></div>' +
            '<label class="login-label" for="adm-senha" style="margin-top:14px;">Senha inicial</label>' +
            '<input class="login-input" id="adm-senha" type="password" autocomplete="new-password" ' +
              'placeholder="mínimo 8 caracteres" aria-label="Senha inicial">' +
            '<label class="adm-check" style="margin:4px 0 18px;">' +
              '<input type="checkbox" id="adm-isadmin">' +
              '<span>Conceder acesso de <strong>administrador</strong></span>' +
            '</label>' +
            '<div class="adm-erro" role="alert" data-slot="erro"></div>' +
            '<div class="adm-actions">' +
              '<button type="submit" class="btn primary" data-slot="submit">Criar usuário</button>' +
            '</div>' +
          '</form>';
        body.querySelector('[data-slot="empresas"]').appendChild(campos.el);
        var form = body.querySelector('form');
        var erroEl = body.querySelector('[data-slot="erro"]');
        var btn = body.querySelector('[data-slot="submit"]');

        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          erroEl.textContent = '';
          var user = body.querySelector('#adm-user').value.trim().toLowerCase();
          var senha = body.querySelector('#adm-senha').value;
          var isAdmin = body.querySelector('#adm-isadmin').checked;
          var emp = campos.valor();

          // validação espelho do backend (feedback imediato)
          if (!RE_USER.test(user)) {
            erroEl.textContent = 'Usuário inválido: use minúsculas (2–80 chars), sem espaços.'; return;
          }
          if (user === 'admin') {
            erroEl.textContent = 'O usuário "admin" é reservado (master).'; return;
          }
          if (emp !== 'todas' && emp.length === 0) {
            erroEl.textContent = 'Selecione ao menos uma empresa ou marque "Todas".'; return;
          }
          if ((senha || '').length < 8) {
            erroEl.textContent = 'A senha deve ter no mínimo 8 caracteres.'; return;
          }

          btn.disabled = true; btn.textContent = 'Criando…';
          mutar('/api/admin/users', 'POST',
            { username: user, empresas: emp, senha: senha, admin: isAdmin })
            .then(function () { aoSalvar(true); })
            .catch(function (e) {
              btn.disabled = false; btn.textContent = 'Criar usuário';
              if (e && e.status === 401) return;
              erroEl.textContent = (e && e.detail) || 'Falha ao criar o usuário.';
            });
        });
        setTimeout(function () { body.querySelector('#adm-user').focus(); }, 60);
      }
    });
  }

  /* ── drawer: editar empresas de um usuário ───────────────────────*/
  function abrirEditarEmpresas(u, aoSalvar) {
    CK.openDrawer({
      title: 'Empresas — ' + u.username,
      subtitle: 'Ajusta o escopo de acesso do usuário',
      render: function (body) {
        var campos = campoEmpresas(u.empresas);
        body.innerHTML =
          '<form class="adm-form" novalidate>' +
            '<label class="login-label">Empresas com acesso</label>' +
            '<div data-slot="empresas"></div>' +
            '<div class="adm-erro" role="alert" data-slot="erro" style="margin-top:14px;"></div>' +
            '<div class="adm-actions">' +
              '<button type="submit" class="btn primary" data-slot="submit">Salvar escopo</button>' +
            '</div>' +
          '</form>';
        body.querySelector('[data-slot="empresas"]').appendChild(campos.el);
        var form = body.querySelector('form');
        var erroEl = body.querySelector('[data-slot="erro"]');
        var btn = body.querySelector('[data-slot="submit"]');
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          erroEl.textContent = '';
          var emp = campos.valor();
          if (emp !== 'todas' && emp.length === 0) {
            erroEl.textContent = 'Selecione ao menos uma empresa ou marque "Todas".'; return;
          }
          btn.disabled = true; btn.textContent = 'Salvando…';
          mutar('/api/admin/users/' + encodeURIComponent(u.username), 'PATCH', { empresas: emp })
            .then(function () { aoSalvar(true); })
            .catch(function (e) {
              btn.disabled = false; btn.textContent = 'Salvar escopo';
              if (e && e.status === 401) return;
              erroEl.textContent = (e && e.detail) || 'Falha ao salvar o escopo.';
            });
        });
      }
    });
  }

  /* ── drawer: resetar senha ───────────────────────────────────────*/
  function abrirResetSenha(u, aoSalvar) {
    CK.openDrawer({
      title: 'Resetar senha — ' + u.username,
      subtitle: 'Define uma nova senha de acesso',
      render: function (body) {
        body.innerHTML =
          '<form class="adm-form" novalidate>' +
            '<label class="login-label" for="adm-nova">Nova senha</label>' +
            '<input class="login-input" id="adm-nova" type="password" autocomplete="new-password" ' +
              'placeholder="mínimo 8 caracteres" aria-label="Nova senha">' +
            '<div class="adm-erro" role="alert" data-slot="erro"></div>' +
            '<div class="adm-actions">' +
              '<button type="submit" class="btn primary" data-slot="submit">Salvar senha</button>' +
            '</div>' +
          '</form>';
        var form = body.querySelector('form');
        var erroEl = body.querySelector('[data-slot="erro"]');
        var btn = body.querySelector('[data-slot="submit"]');
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          erroEl.textContent = '';
          var senha = body.querySelector('#adm-nova').value;
          if ((senha || '').length < 8) {
            erroEl.textContent = 'A senha deve ter no mínimo 8 caracteres.'; return;
          }
          btn.disabled = true; btn.textContent = 'Salvando…';
          mutar('/api/admin/users/' + encodeURIComponent(u.username), 'PATCH', { senha: senha })
            .then(function () { aoSalvar(true); })
            .catch(function (e) {
              btn.disabled = false; btn.textContent = 'Salvar senha';
              if (e && e.status === 401) return;
              erroEl.textContent = (e && e.detail) || 'Falha ao redefinir a senha.';
            });
        });
        setTimeout(function () { body.querySelector('#adm-nova').focus(); }, 60);
      }
    });
  }

  /* ── PATCH direto (ativar/desativar · promover/rebaixar) c/ confirm ─*/
  function patchSimples(u, patch, confirmMsg, aoTerminar) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    mutar('/api/admin/users/' + encodeURIComponent(u.username), 'PATCH', patch)
      .then(function () { aoTerminar(true); })
      .catch(function (e) {
        if (e && e.status === 401) return;
        aoTerminar(false, (e && e.detail) || 'Falha ao aplicar a alteração.');
      });
  }

  /* ── registro da tela ────────────────────────────────────────────*/
  CK.registerScreen('admin', {
    title: 'Administração de usuários',
    subtitle: 'Criar, editar e desativar acessos',
    render: function (el) {
      el.innerHTML =
        '<div class="chart-card">' +
          '<div class="card-header">' +
            '<div>' +
              '<div class="card-title">Usuários do Cockpit</div>' +
              '<div class="card-subtitle">Acessos da tabela cockpit_user — o master “admin” é externo e não aparece aqui.</div>' +
            '</div>' +
            '<button type="button" class="btn primary" data-adm="novo" aria-label="Criar novo usuário">+ Novo usuário</button>' +
          '</div>' +
          '<div class="adm-erro" role="alert" data-adm="erro-topo"></div>' +
          '<div data-adm="corpo"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
        '</div>';

      var corpo = el.querySelector('[data-adm="corpo"]');
      var erroTopo = el.querySelector('[data-adm="erro-topo"]');

      function flash(msg) {
        if (!msg) { erroTopo.textContent = ''; return; }
        erroTopo.textContent = msg;
        setTimeout(function () { if (el.isConnected) erroTopo.textContent = ''; }, 6000);
      }

      function carrega() {
        CK.api('/api/admin/users').then(function (users) {
          if (!el.isConnected) return;
          pinta(users || []);
        }).catch(function (e) {
          if (!el.isConnected || (e && e.status === 401)) return;
          corpo.innerHTML = '<div class="empty-state">Falha ao carregar a lista de usuários.</div>';
        });
      }

      function recarrega(ok, msg) {
        if (msg) flash(msg);
        // fecha o drawer do topo (se aberto) e refaz a lista
        var stack = CK._drawerStack || [];
        if (ok && stack.length) stack[stack.length - 1]();
        carrega();
      }

      function pinta(users) {
        if (!users.length) {
          corpo.innerHTML =
            '<div class="empty-state">Nenhum usuário cadastrado ainda.<br>' +
            'Use “+ Novo usuário” para criar o primeiro acesso.</div>';
          return;
        }
        var linhas = users.map(function (u, i) {
          var ativo = !!u.ativo;
          var eu = u.username === CK.state.usuario; // não pode se autodesativar/rebaixar
          var stChip = ativo
            ? '<span class="chip green">Ativo</span>'
            : '<span class="chip red">Inativo</span>';
          var admChip = u.admin
            ? '<span class="chip accent">Sim</span>'
            : '<span class="adm-muted">—</span>';
          return '<tr>' +
            '<td class="mono">' + esc(u.username) + (eu ? ' <span class="adm-muted">(você)</span>' : '') + '</td>' +
            '<td>' + chipsEmpresas(u.empresas) + '</td>' +
            '<td>' + stChip + '</td>' +
            '<td>' + admChip + '</td>' +
            '<td class="adm-acoes">' +
              '<button type="button" class="btn" data-act="empresas" data-i="' + i + '" ' +
                'aria-label="Editar empresas de ' + esc(u.username) + '">Empresas</button>' +
              '<button type="button" class="btn" data-act="senha" data-i="' + i + '" ' +
                'aria-label="Resetar senha de ' + esc(u.username) + '">Resetar senha</button>' +
              '<button type="button" class="btn" data-act="ativo" data-i="' + i + '"' +
                (eu ? ' disabled title="Você não pode desativar o próprio acesso"' : '') +
                ' aria-label="' + (ativo ? 'Desativar' : 'Ativar') + ' ' + esc(u.username) + '">' +
                (ativo ? 'Desativar' : 'Ativar') + '</button>' +
              '<button type="button" class="btn" data-act="admin" data-i="' + i + '"' +
                (eu && u.admin ? ' disabled title="Você não pode remover o próprio acesso de admin"' : '') +
                ' aria-label="' + (u.admin ? 'Rebaixar' : 'Promover a admin') + ' ' + esc(u.username) + '">' +
                (u.admin ? 'Rebaixar' : 'Promover admin') + '</button>' +
            '</td>' +
          '</tr>';
        }).join('');

        corpo.innerHTML =
          '<div style="overflow-x:auto;">' +
          '<table class="data-table adm-table" aria-label="Lista de usuários do cockpit">' +
            '<thead><tr>' +
              '<th>Usuário</th><th>Empresas</th><th>Status</th><th>Admin</th>' +
              '<th style="text-align:right;">Ações</th>' +
            '</tr></thead>' +
            '<tbody>' + linhas + '</tbody>' +
          '</table></div>';

        corpo.querySelectorAll('button[data-act]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var u = users[Number(btn.getAttribute('data-i'))];
            if (!u) return;
            var act = btn.getAttribute('data-act');
            if (act === 'empresas') abrirEditarEmpresas(u, recarrega);
            else if (act === 'senha') abrirResetSenha(u, recarrega);
            else if (act === 'ativo') {
              patchSimples(u, { ativo: !u.ativo },
                (u.ativo ? 'Desativar' : 'Ativar') + ' o usuário “' + u.username + '”?',
                recarrega);
            } else if (act === 'admin') {
              patchSimples(u, { admin: !u.admin },
                (u.admin ? 'Remover o acesso de admin de “' : 'Promover “') + u.username +
                (u.admin ? '”?' : '” a administrador?'),
                recarrega);
            }
          });
        });
      }

      el.querySelector('[data-adm="novo"]').addEventListener('click', function () {
        abrirNovo(recarrega);
      });

      carrega();
    }
  });
})();
