/* ============================================================
 * Tela P5 — Alertas / Red Flags (regras A01–A10 do briefing §4)
 * Rota: #/alertas
 * Contrato: usa APENAS window.CK (core.js). ZERO dados hardcoded.
 * Snooze: POST /api/alertas/{id}/snooze {dias:7} → some do badge,
 * continua no log (exibido esmaecido).
 * ============================================================ */
(function () {
  'use strict';

  var MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  /* ── helpers (padrão do mockup, pt-BR) ───────────────────────── */
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ptBR(v, dec) {
    if (dec == null) dec = 1;
    return n(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtShort(v) {
    var a = Math.abs(n(v));
    if (a >= 1e9) return ptBR(a / 1e9, 1) + 'B';
    if (a >= 1e6) return ptBR(a / 1e6, 1) + 'M';
    if (a >= 1e3) return ptBR(a / 1e3, 0) + 'k';
    return ptBR(a, 0);
  }
  // célula do heatmap: "+609k" / "−176k"
  function fmtCel(v) {
    var x = n(v);
    return (x >= 0 ? '+' : '−') + fmtShort(Math.abs(x));
  }

  function pega(p) { return CK.api(p).catch(function () { return null; }); }

  // status da API → rótulo do badge e classes CSS do semáforo
  var STATUS = {
    critico:  { rotulo: 'CRÍTICO',  cor: 'var(--red)' },
    atencao:  { rotulo: 'ATENÇÃO',  cor: 'var(--accent)' },
    saudavel: { rotulo: 'SAUDÁVEL', cor: 'var(--green)' }
  };

  /* ── semáforo: 5 cards com borda na cor do status ────────────── */
  function pintaSemaforo(el, alertas) {
    var wrap = el.querySelector('[data-ck="semaforo"]');
    if (!wrap) return;
    var itens = (alertas && alertas.semaforo) || [];
    if (!itens.length) {
      wrap.innerHTML = '<p class="empty-state" style="grid-column:1/-1;">Sem status de empresas disponível.</p>';
      return;
    }
    wrap.innerHTML = itens.map(function (s) {
      var st = STATUS[s.status] || STATUS.atencao;
      return '<div class="semaforo-card ' + esc(s.status) + '" role="status" ' +
        'aria-label="' + esc(s.label) + ': ' + st.rotulo + '. ' + esc(s.motivo || '') + '">' +
        '<div class="semaforo-dot" aria-hidden="true"></div>' +
        '<div class="semaforo-name">' + esc(s.label) + '</div>' +
        '<span class="chip" style="background:transparent;border:1px solid ' + st.cor + ';color:' + st.cor + ';">' + st.rotulo + '</span>' +
        '<div class="semaforo-motivo" style="margin-top:6px;">' + esc(s.motivo || '') + '</div>' +
      '</div>';
    }).join('');
  }

  /* ── POST snooze (fetch direto — cookie httpOnly vai junto) ──── */
  function snooze(id, aoTerminar) {
    fetch('/api/alertas/' + encodeURIComponent(id) + '/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ dias: 7 })
    }).catch(function () { /* falha silenciosa — refetch mostra estado real */ })
      .then(aoTerminar);
  }

  /* ── lista de flag-cards (críticos ou atenção) ───────────────── */
  function pintaLista(el, alertas, tipo, aoSnooze) {
    var wrap = el.querySelector('[data-ck="' + tipo + '"]');
    var chip = el.querySelector('[data-ck="' + tipo + '-chip"]');
    if (!wrap) return;
    var itens = (alertas && alertas[tipo]) || [];
    var snoozed = (alertas && alertas.snoozed) || [];
    function estaSnoozed(a) { return snoozed.indexOf(a.id) !== -1; }

    var ativos = itens.filter(function (a) { return !estaSnoozed(a); });
    if (chip) {
      chip.textContent = ativos.length + ' ativo' + (ativos.length === 1 ? '' : 's');
    }
    if (!itens.length) {
      wrap.innerHTML = '<div class="flag-card ok"><div class="flag-icon" aria-hidden="true">✅</div>' +
        '<div><div class="flag-title">Nenhum alerta ' + (tipo === 'criticos' ? 'crítico' : 'de atenção') + '</div>' +
        '<div class="flag-desc">Gatilhos (A01–A10) dentro dos limites configurados.</div></div></div>';
      return;
    }

    var corAcc = tipo === 'criticos' ? 'var(--red)' : 'var(--accent)';
    var classe = tipo === 'criticos' ? 'danger' : 'warn';
    wrap.innerHTML = itens.map(function (a, i) {
      var sn = estaSnoozed(a);
      return '<div class="flag-card ' + classe + '" style="border-left:3px solid ' + corAcc + ';' +
        (sn ? 'opacity:0.55;' : '') + '">' +
        '<div style="flex:1;min-width:0;">' +
          '<div class="flag-title">' + esc(a.titulo) +
            ' <span class="chip" style="background:var(--bg-hover);color:var(--text-3);margin-left:4px;">' + esc(a.regra || a.id || '') + '</span>' +
            (sn ? ' <span class="chip" style="background:var(--bg-hover);color:var(--text-3);">ciente</span>' : '') +
          '</div>' +
          '<div class="flag-desc">' + esc(a.detalhe || '') + '</div>' +
          (a.acao ? '<div class="flag-desc" style="color:var(--text-3);margin-top:2px;">Ação: ' + esc(a.acao) + '</div>' : '') +
          (sn ? '' :
            '<div class="flag-actions">' +
              '<button type="button" class="btn" data-ck="snooze" data-i="' + i + '" ' +
                'aria-label="Marcar ciente do alerta ' + esc(a.titulo) + ' por 7 dias">Ciente (7d)</button>' +
            '</div>') +
        '</div>' +
      '</div>';
    }).join('');

    wrap.querySelectorAll('[data-ck="snooze"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var a = itens[Number(btn.getAttribute('data-i'))];
        if (!a || !a.id) return;
        btn.disabled = true;
        btn.textContent = 'Registrando…';
        snooze(a.id, aoSnooze); // POST + refetch da tela
      });
    });
  }

  /* ── heatmap 5×12: resultado líquido mensal por empresa ──────── */
  // interpola a cor da célula entre o fundo e verde/vermelho pela
  // magnitude relativa DENTRO da empresa (linha)
  function corCelula(v, maxAbs) {
    var base = [30, 35, 48]; // --bg-hover
    var alvo = n(v) >= 0 ? [34, 197, 94] : [239, 68, 68];
    var t = maxAbs ? Math.min(Math.abs(n(v)) / maxAbs, 1) : 0;
    t = 0.12 + 0.88 * t; // piso p/ célula nunca sumir no fundo
    var rgb = base.map(function (b, i) { return Math.round(b + (alvo[i] - b) * t); });
    return 'rgb(' + rgb.join(',') + ')';
  }

  function pintaHeatmap(el, alertas) {
    var box = el.querySelector('[data-ck="heatmap"]');
    if (!box) return;
    var hm = (alertas && alertas.heatmap) || {};
    var meses = hm.meses || [];
    var empresas = hm.empresas || [];
    if (!meses.length || !empresas.length) {
      box.innerHTML = '<p class="empty-state">Sem dados mensais para o heatmap.</p>';
      return;
    }

    var h = '<div class="heatmap-grid" role="table" ' +
      'aria-label="Heatmap do resultado líquido mensal: ' + empresas.length + ' empresas por ' + meses.length +
      ' meses. Verde positivo, vermelho negativo, intensidade proporcional à magnitude. Clique no nome da empresa para abrir a visão dela." ' +
      'style="grid-template-columns:120px repeat(' + meses.length + ',1fr);">';

    h += '<div class="heatmap-corner" role="columnheader"></div>';
    meses.forEach(function (m) {
      h += '<div class="heatmap-col-label" role="columnheader">' + esc(MESES[(n(m) - 1 + 12) % 12] || m) + '</div>';
    });

    empresas.forEach(function (e) {
      var vals = e.valores || [];
      var maxAbs = 0;
      vals.forEach(function (v) { if (v != null) maxAbs = Math.max(maxAbs, Math.abs(n(v))); });
      // título da linha clicável → visão micro da empresa
      h += '<div class="heatmap-row-label" role="rowheader">' +
        '<a href="#/micro/' + esc(e.slug) + '" style="color:inherit;cursor:pointer;" ' +
          'aria-label="Abrir visão da empresa ' + esc(e.label) + '">' + esc(e.label) + '</a></div>';
      meses.forEach(function (m, ci) {
        var v = vals[ci];
        if (v == null) {
          h += '<div class="heatmap-cell empty" role="cell" aria-label="' + esc(e.label) + ' ' + esc(MESES[(n(m) - 1 + 12) % 12]) + ': sem dado">—</div>';
        } else {
          h += '<div class="heatmap-cell" role="cell" ' +
            'title="' + esc(e.label) + ' · ' + esc(MESES[(n(m) - 1 + 12) % 12]) + ': ' + fmtCel(v) + '" ' +
            'aria-label="' + esc(e.label) + ' ' + esc(MESES[(n(m) - 1 + 12) % 12]) + ': resultado líquido ' + fmtCel(v) + '" ' +
            'style="background:' + corCelula(v, maxAbs) + ';">' + fmtCel(v) + '</div>';
        }
      });
    });
    h += '</div>';
    box.innerHTML = h;
  }

  /* ── registro da tela ─────────────────────────────────────────── */
  CK.registerScreen('alertas', {
    title: 'Tela de Alertas — Red Flags & Monitoramento',
    subtitle: 'Gatilhos automáticos (A01–A10) · Semáforo de saúde financeira',
    render: function (el) {
      el.innerHTML =
        '<div class="semaforo-row" data-ck="semaforo" aria-label="Semáforo de saúde financeira por empresa">' +
          '<div class="semaforo-card"><div class="semaforo-name">Carregando…</div></div>' +
        '</div>' +

        '<div class="grid-bot" style="margin-bottom:24px;">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Alertas Ativos — Nível Crítico</div>' +
              '<div class="card-subtitle">Gatilhos acionados automaticamente pelas regras de negócio</div>' +
            '</div><div class="chip red" data-ck="criticos-chip">—</div></div>' +
            '<div data-ck="criticos"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '</div>' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Atenção — Concentração &amp; Margens</div>' +
              '<div class="card-subtitle">Regras de atenção (concentração de clientes, folha, metas de EBIT)</div>' +
            '</div><div class="chip accent" data-ck="atencao-chip">—</div></div>' +
            '<div data-ck="atencao"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '</div>' +
        '</div>' +

        '<div class="chart-card">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Heatmap — Resultado Líquido Mensal</div>' +
            '<div class="card-subtitle">Verde = positivo · Vermelho = negativo · intensidade = magnitude relativa da empresa · clique no nome para drill-down</div>' +
          '</div><div class="chip blue">5 × 12</div></div>' +
          '<div data-ck="heatmap"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
        '</div>';

      // busca + pintura (reaproveitada após o snooze)
      function carrega() {
        pega('/api/alertas').then(function (alertas) {
          if (!el.isConnected) return;
          if (!alertas) {
            el.querySelector('[data-ck="semaforo"]').innerHTML =
              '<p class="empty-state" style="grid-column:1/-1;">Falha ao carregar os alertas.</p>';
            return;
          }
          pintaSemaforo(el, alertas);
          pintaLista(el, alertas, 'criticos', carrega);
          pintaLista(el, alertas, 'atencao', carrega);
          pintaHeatmap(el, alertas);
        });
      }
      carrega();
    }
  });
})();
