/* ============================================================
 * PAINEL 12 — Assistente Claude (barra global do cockpit)
 * NÃO é uma tela roteável (CK.registerScreen): é uma barra FIXA
 * no rodapé do viewport, disponível em TODAS as telas.
 *
 * Exposto como CK.initAssistente(): monta a UI dentro do container
 * #assistente-bar (o integrador adiciona esse elemento ao index.html)
 * e é chamada UMA vez após o login (ver instruções de wiring).
 *
 * Contrato (API_CONTRACT §B):
 *   POST /api/perguntar {texto} → {resposta, escopo:[slugs]|"todas"}
 *   Nunca 500 — se a IA cair, devolve 200 com aviso amigável.
 *
 * Segurança: a RESPOSTA é texto do modelo → escapada com CK.esc
 * (XSS). A PERGUNTA também é escapada ao ecoar no histórico.
 * Usa APENAS window.CK (CK.api, CK.esc, CK.empresa, CK.state).
 * ============================================================ */
(function () {
  'use strict';

  var esc = (window.CK && CK.esc) || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var MAX_QA = 6; // mantém só as últimas trocas no painel (memória curta)

  /* ── estilos escopados 'ass-*' (injetados 1x; não tocam app.css) ── */
  function injetaCSS() {
    if (document.getElementById('ass-css')) return;
    var s = document.createElement('style');
    s.id = 'ass-css';
    s.textContent =
      /* barra fixa no rodapé — começa após o sidebar (220px) p/ não cobri-lo */
      '#assistente-bar{position:fixed;left:220px;right:0;bottom:0;z-index:60;' +
        'background:var(--bg-base,#F9F8F6);border-top:1px solid var(--border,#E6E3DC);' +
        'box-shadow:0 -6px 20px rgba(0,0,0,0.06);font-family:inherit;}' +
      '@media (max-width:720px){#assistente-bar{left:0;}}' +
      '.ass-wrap{max-width:1100px;margin:0 auto;padding:0 22px;}' +
      /* painel de histórico (acima da barra) — rolável */
      '.ass-log{max-height:0;overflow-y:auto;transition:max-height .22s ease;' +
        'padding:0;}' +
      '.ass-log.open{max-height:46vh;padding:14px 0 4px;}' +
      '.ass-qa{margin-bottom:14px;}' +
      '.ass-q{display:flex;gap:8px;align-items:flex-start;font-size:13px;' +
        'color:var(--text-1,#1C1C1C);font-weight:600;margin-bottom:6px;}' +
      '.ass-q .ass-ico{color:var(--text-3,#81807C);flex-shrink:0;font-weight:700;}' +
      '.ass-a{display:flex;gap:8px;align-items:flex-start;font-size:13px;' +
        'line-height:1.55;color:var(--text-2,#55544F);white-space:pre-wrap;' +
        'word-break:break-word;}' +
      '.ass-a .ass-ico{color:var(--accent,#D9DA00);flex-shrink:0;font-weight:700;}' +
      '.ass-escopo{font-size:11px;color:var(--text-3,#81807C);margin:4px 0 0 24px;' +
        'font-style:italic;}' +
      '.ass-a.pensando{color:var(--text-3,#81807C);font-style:italic;}' +
      '.ass-erro{color:var(--red,#E5484D);}' +
      '.ass-vazio{font-size:12px;color:var(--text-3,#81807C);padding:2px 0 8px;}' +
      /* barra de input */
      '.ass-bar{display:flex;align-items:flex-end;gap:10px;padding:12px 0;}' +
      '.ass-toggle{flex-shrink:0;width:30px;height:30px;border-radius:var(--radius-sm,6px);' +
        'border:1px solid var(--border,#E6E3DC);background:var(--bg-card,#FFF);' +
        'color:var(--text-3,#81807C);cursor:pointer;font-size:13px;line-height:1;' +
        'display:flex;align-items:center;justify-content:center;}' +
      '.ass-toggle:hover{color:var(--text-1,#1C1C1C);border-color:var(--border-acc,rgba(217,218,0,0.55));}' +
      '.ass-toggle:focus-visible{outline:2px solid var(--accent,#D9DA00);outline-offset:2px;}' +
      '.ass-field{flex:1;display:flex;align-items:flex-end;gap:8px;' +
        'background:var(--bg-card,#FFF);border:1px solid var(--border,#E6E3DC);' +
        'border-radius:var(--radius,10px);padding:6px 8px 6px 14px;}' +
      '.ass-field:focus-within{border-color:var(--border-acc,rgba(217,218,0,0.55));}' +
      '.ass-input{flex:1;border:0;outline:0;resize:none;background:transparent;' +
        'font-family:inherit;font-size:13px;line-height:1.5;color:var(--text-1,#1C1C1C);' +
        'max-height:120px;padding:5px 0;}' +
      '.ass-input::placeholder{color:var(--text-3,#81807C);}' +
      '.ass-send{flex-shrink:0;background:var(--ink,#1C1C1C);color:#F9F8F6;border:0;' +
        'border-radius:var(--radius-sm,6px);padding:8px 16px;font-family:inherit;' +
        'font-size:13px;font-weight:600;cursor:pointer;}' +
      '.ass-send:hover:not(:disabled){background:#000;}' +
      '.ass-send:disabled{opacity:0.45;cursor:not-allowed;}' +
      '.ass-send:focus-visible{outline:2px solid var(--accent,#D9DA00);outline-offset:2px;}';
    document.head.appendChild(s);
  }

  /* ── nome legível do escopo devolvido pela API ─────────────── */
  function rotuloEscopo(escopo) {
    if (escopo === 'todas' || escopo == null) return 'Grupo REF (todas as empresas)';
    if (!Array.isArray(escopo) || !escopo.length) return '—';
    return escopo.map(function (slug) {
      var e = (window.CK && CK.empresa) ? CK.empresa(slug) : null;
      return e ? e.label : slug;
    }).join(', ');
  }

  /* ── estado do módulo ──────────────────────────────────────── */
  var inicializado = false;

  CK.initAssistente = function () {
    var host = document.getElementById('assistente-bar');
    if (!host) return;                 // integrador ainda não adicionou o container
    if (inicializado) return;          // idempotente (chamada 1x após login)
    inicializado = true;

    injetaCSS();

    host.innerHTML =
      '<div class="ass-wrap">' +
        '<div class="ass-log" data-ass="log" role="log" aria-live="polite" ' +
          'aria-label="Histórico de perguntas ao assistente"></div>' +
        '<div class="ass-bar">' +
          '<button type="button" class="ass-toggle" data-ass="toggle" aria-expanded="false" ' +
            'title="Mostrar/ocultar respostas" aria-label="Mostrar ou ocultar as respostas">⌃</button>' +
          '<div class="ass-field">' +
            '<textarea class="ass-input" data-ass="input" rows="1" ' +
              'aria-label="Pergunte sobre qualquer quadro" ' +
              'placeholder="Pergunte sobre qualquer quadro… ex.: como está o EBIT Agência no 2º tri?"></textarea>' +
            '<button type="button" class="ass-send" data-ass="send">Perguntar</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var log    = host.querySelector('[data-ass="log"]');
    var toggle = host.querySelector('[data-ass="toggle"]');
    var input  = host.querySelector('[data-ass="input"]');
    var send   = host.querySelector('[data-ass="send"]');

    var qas = [];        // {q, a, escopo, erro} — últimas MAX_QA trocas
    var enviando = false;

    /* auto-grow do textarea (até max-height do CSS) */
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    /* abre/fecha o painel de histórico */
    function setAberto(aberto) {
      log.classList.toggle('open', aberto);
      toggle.setAttribute('aria-expanded', aberto ? 'true' : 'false');
      toggle.textContent = aberto ? '⌄' : '⌃';
      if (aberto) log.scrollTop = log.scrollHeight;
    }

    /* re-renderiza o histórico (sempre escapando q e a — XSS) */
    function pinta() {
      if (!qas.length) {
        log.innerHTML = '<div class="ass-vazio">Faça uma pergunta sobre os números do cockpit — ' +
          'as respostas aparecem aqui.</div>';
        return;
      }
      log.innerHTML = qas.map(function (item) {
        var corpo;
        if (item.pendente) {
          corpo = '<div class="ass-a pensando"><span class="ass-ico" aria-hidden="true">✦</span>' +
            '<span>Analisando…</span></div>';
        } else if (item.erro) {
          corpo = '<div class="ass-a ass-erro"><span class="ass-ico" aria-hidden="true">✦</span>' +
            '<span>' + esc(item.a) + '</span></div>';
        } else {
          corpo = '<div class="ass-a"><span class="ass-ico" aria-hidden="true">✦</span>' +
            '<span>' + esc(item.a) + '</span></div>' +
            (item.escopo !== undefined
              ? '<div class="ass-escopo">respondendo por: ' + esc(rotuloEscopo(item.escopo)) + '</div>'
              : '');
        }
        return '<div class="ass-qa">' +
          '<div class="ass-q"><span class="ass-ico" aria-hidden="true">›</span>' +
            '<span>' + esc(item.q) + '</span></div>' +
          corpo +
        '</div>';
      }).join('');
      log.scrollTop = log.scrollHeight;
    }

    function push(item) {
      qas.push(item);
      if (qas.length > MAX_QA) qas.shift();
      pinta();
    }

    function submeter() {
      if (enviando) return;
      var texto = (input.value || '').trim();
      if (!texto) return;              // pergunta vazia → no-op

      enviando = true;
      send.disabled = true;
      send.textContent = 'Analisando…';
      input.disabled = true;

      input.value = '';
      autoGrow();

      var item = { q: texto, pendente: true };
      push(item);
      setAberto(true);

      CK.api('/api/perguntar', { body: { texto: texto } })
        .then(function (r) {
          item.pendente = false;
          item.a = (r && r.resposta) || 'Sem resposta.';
          item.escopo = r ? r.escopo : undefined;
          pinta();
        })
        .catch(function (e) {
          item.pendente = false;
          item.erro = true;
          if (e && e.status === 401) {
            // CK.api já reexibiu o overlay de login; ecoa aviso inline
            item.a = 'Sua sessão expirou. Entre novamente para continuar.';
          } else {
            item.a = 'Não foi possível falar com o assistente agora. Verifique a conexão e tente de novo.';
          }
          pinta();
        })
        .then(function () {
          enviando = false;
          send.disabled = false;
          send.textContent = 'Perguntar';
          input.disabled = false;
          input.focus();
        });
    }

    /* Enter envia · Shift+Enter quebra linha */
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submeter();
      }
    });
    input.addEventListener('input', autoGrow);
    send.addEventListener('click', submeter);
    toggle.addEventListener('click', function () {
      setAberto(!log.classList.contains('open'));
    });

    pinta(); // estado inicial (vazio)
  };
})();
