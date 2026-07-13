/* ============================================================
 * Painel 11 — Cenários & Projeções (simulador what-if)
 * Rota: #/cenarios
 * Contrato: usa APENAS window.CK (core.js).
 *   GET /api/cenario/<slug>?ano=  → {ano, titulo, realizado_ate,
 *     base:{rb, rl, ra, ebit, rliq, deducoes, custos, pessoal,
 *           infra, outras, tributos, headcount}}
 * A simulação é 100% client-side — NÃO altera o realizado nem toca o backend.
 * Cenários salvos ficam só em memória (módulo). Todo texto do usuário
 * passa por CK.esc (XSS). Tema CLARO (tokens do app.css).
 * ============================================================ */
(function () {
  'use strict';

  var esc = CK.esc;

  /* ── cenários salvos (em memória — até 3) + contexto (slug/ano) ──
     Se a empresa/ano muda, zera a lista p/ não comparar bases diferentes. */
  var salvos = [];
  var ctxSalvos = null;

  /* ── helpers numéricos ─────────────────────────────────────────── */
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function fmtMoeda(v) {
    return (CK.fmt && CK.fmt.moeda) ? CK.fmt.moeda(v) : ('R$ ' + n(v));
  }
  function fmtPct(v) {
    return (CK.fmt && CK.fmt.percent) ? CK.fmt.percent(v, 1) : (n(v).toFixed(1) + '%');
  }

  /* ── estilos escopados 'cen-*' (injetados 1x, não tocam app.css) ── */
  (function injetaCSS() {
    if (document.getElementById('cen-css')) return;
    var s = document.createElement('style');
    s.id = 'cen-css';
    s.textContent =
      '.cen-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;' +
        'letter-spacing:1px;text-transform:uppercase;background:var(--accent);color:var(--text-1);' +
        'padding:5px 12px;border-radius:20px;box-shadow:0 1px 4px rgba(0,0,0,0.12);}' +
      '.cen-badge .dot{width:7px;height:7px;border-radius:50%;background:var(--text-1);}' +
      '.cen-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px;}' +
      '.cen-head p{font-size:12px;color:var(--text-3);margin:0;}' +
      '.cen-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;align-items:start;}' +
      '.cen-sliders{display:flex;flex-direction:column;gap:18px;}' +
      '.cen-slider label{display:flex;justify-content:space-between;align-items:baseline;' +
        'font-size:13px;color:var(--text-2);margin-bottom:7px;}' +
      '.cen-slider .cen-val{font-family:\'JetBrains Mono\',monospace;font-size:13px;font-weight:600;' +
        'color:var(--text-1);min-width:52px;text-align:right;}' +
      '.cen-slider .cen-val.pos{color:var(--green);} .cen-slider .cen-val.neg{color:var(--red);}' +
      '.cen-slider input[type=range]{width:100%;accent-color:var(--accent);cursor:pointer;height:20px;}' +
      '.cen-out{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}' +
      '.cen-out .kpi-card{padding:14px;}' +
      '.cen-out .kpi-value{font-size:19px;margin-top:2px;}' +
      '.cen-actions{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 18px;}' +
      '.cen-foot{font-size:11px;color:var(--text-3);line-height:1.6;margin-top:6px;}' +
      '.cen-foot code{font-family:\'JetBrains Mono\',monospace;color:var(--text-2);}' +
      '.cen-cmp td.mono,.cen-cmp th{white-space:nowrap;}' +
      '.cen-cmp .cen-base{color:var(--text-3);}' +
      '@media (max-width:900px){.cen-grid{grid-template-columns:1fr;}.cen-out{grid-template-columns:repeat(2,1fr);}}';
    document.head.appendChild(s);
  })();

  /* ── as 4 alavancas (fração aplicada sobre a base) ───────────────── */
  var ALAVANCAS = [
    { key: 'rb',      label: 'Receita Bruta' },
    { key: 'custo',   label: 'Custo Direto' },
    { key: 'pessoal', label: 'Despesa com Pessoal' },
    { key: 'head',    label: 'Headcount' }
  ];

  /* ── motor de cálculo (fórmulas EXATAS do contrato) ──────────────
     s = {rb, custo, pessoal, head} em FRAÇÃO (ex.: 0.10 = +10%). */
  function calcula(base, s) {
    var rb0 = n(base.rb);
    var dedRate = rb0 ? n(base.deducoes) / rb0 : 0;
    var tribRate = rb0 ? n(base.tributos) / rb0 : 0;

    var RB = rb0 * (1 + s.rb);
    var RL = RB * (1 - dedRate);
    var custos = n(base.custos) * (1 + s.custo);
    var RA = RL - custos;
    var pessoal = n(base.pessoal) * (1 + s.head) * (1 + s.pessoal);
    var EBIT = RA - pessoal - n(base.infra) - n(base.outras);
    var trib = RB * tribRate;
    var RLIQ = EBIT - trib;
    var ebitNeg = RB ? EBIT / RB * 100 : 0;
    var ebitAg = RA ? EBIT / RA * 100 : 0;
    var headcount = Math.round(n(base.headcount) * (1 + s.head));

    return { rb: RB, rl: RL, ra: RA, ebit: EBIT, rliq: RLIQ,
      ebitNeg: ebitNeg, ebitAg: ebitAg, headcount: headcount };
  }

  /* ── badges de delta (verde sobe / vermelho desce) ───────────────── */
  function badgeMoeda(sim, base) {
    var d = sim - base, up = d >= 0;
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      (up ? '▲ +' : '▼ −') + fmtMoeda(Math.abs(d)).replace(/^−/, '') + '</span>';
  }
  function badgePP(sim, base) {
    var d = sim - base, up = d >= 0;
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      (up ? '▲ +' : '▼ −') +
      Math.abs(d).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) +
      ' p.p.</span>';
  }
  function badgeInt(sim, base) {
    var d = sim - base, up = d >= 0;
    if (d === 0) return '<span class="kpi-delta up">▬ 0</span>';
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      (up ? '▲ +' : '▼ −') + Math.abs(d).toLocaleString('pt-BR') + '</span>';
  }

  /* ── registro da tela ────────────────────────────────────────────── */
  CK.registerScreen('cenarios', {
    title: 'Cenários & Projeções',
    subtitle: 'Simulação — não altera o realizado',
    render: function (el) {
      var slug = CK.slugAtual();
      var ano = (CK.state && CK.state.ano) || '';

      if (!slug) {
        el.innerHTML = '<div class="empty-state">Nenhuma empresa no seu escopo para simular cenários.</div>';
        return;
      }

      el.innerHTML = '<div class="empty-state">Carregando base do cenário…</div>';

      var qs = ano ? ('?ano=' + encodeURIComponent(ano)) : '';
      CK.api('/api/cenario/' + encodeURIComponent(slug) + qs).then(function (data) {
        if (!el.isConnected) return;
        var base = data && data.base;
        if (!base || base.rb == null) {
          el.innerHTML = '<div class="empty-state">Sem dados para simular o cenário desta empresa em ' +
            esc(String(ano || '')) + '.</div>';
          return;
        }
        montaTela(el, data, base, slug, ano);
      }).catch(function (e) {
        if (!el.isConnected || (e && e.status === 401)) return;
        el.innerHTML = '<div class="empty-state">' +
          ((e && e.status === 403)
            ? 'Você não tem acesso à simulação desta empresa.'
            : 'Falha ao carregar a base do cenário. Tente novamente.') +
          '</div>';
      });
    }
  });

  /* ── montagem + interação ────────────────────────────────────────── */
  function montaTela(el, data, base, slug, ano) {
    var titulo = data.titulo || (CK.empresa(slug) || {}).label || slug;

    // reseta os cenários salvos se o contexto (empresa/ano) mudou
    var ctx = slug + '|' + ano;
    if (ctxSalvos !== ctx) { salvos = []; ctxSalvos = ctx; }

    // valores-base p/ os deltas (sliders todos em 0)
    var b = calcula(base, { rb: 0, custo: 0, pessoal: 0, head: 0 });

    var slidersHTML = ALAVANCAS.map(function (a) {
      return '<div class="cen-slider">' +
        '<label for="cen-' + a.key + '">' +
          '<span>' + esc(a.label) + '</span>' +
          '<span class="cen-val" data-val="' + a.key + '">0%</span>' +
        '</label>' +
        '<input type="range" id="cen-' + a.key + '" data-slider="' + a.key + '" ' +
          'min="-30" max="30" step="1" value="0" ' +
          'aria-label="' + esc(a.label) + ' (variação percentual)">' +
      '</div>';
    }).join('');

    el.innerHTML =
      '<div class="cen-head">' +
        '<span class="cen-badge"><span class="dot" aria-hidden="true"></span>Simulação</span>' +
        '<p>Ajuste as alavancas — o realizado de <strong>' + esc(String(titulo)) +
          '</strong> (' + esc(String(data.ano || ano || '')) + ') permanece intacto.</p>' +
      '</div>' +

      '<div class="cen-grid">' +
        // painel de alavancas
        '<div class="chart-card">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Alavancas</div>' +
            '<div class="card-subtitle">Variação de −30% a +30% sobre a base</div>' +
          '</div><div class="chip accent">What-if</div></div>' +
          '<div class="cen-sliders">' + slidersHTML + '</div>' +
        '</div>' +

        // painel de resultado
        '<div class="chart-card">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Resultado simulado</div>' +
            '<div class="card-subtitle">Valor projetado e Δ vs. base</div>' +
          '</div><div class="chip accent">Simulação</div></div>' +
          '<div class="cen-out" data-ck="out"></div>' +
          '<div class="cen-actions">' +
            '<button type="button" class="btn primary" data-ck="salvar">Salvar cenário</button>' +
            '<button type="button" class="btn" data-ck="restaurar">Restaurar</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // tabela comparativa (Base + salvos)
      '<div class="chart-card" data-ck="cmp-card" hidden>' +
        '<div class="card-header"><div>' +
          '<div class="card-title">Comparar cenários</div>' +
          '<div class="card-subtitle">Base + cenários salvos (até 3) lado a lado</div>' +
        '</div></div>' +
        '<div style="overflow-x:auto;"><table class="data-table cen-cmp" ' +
          'aria-label="Comparação entre a base e os cenários salvos">' +
          '<thead data-ck="cmp-head"></thead><tbody data-ck="cmp-body"></tbody>' +
        '</table></div>' +
      '</div>' +

      // notas de premissas
      '<div class="chart-card">' +
        '<div class="card-title" style="margin-bottom:8px;">Premissas do modelo</div>' +
        '<div class="cen-foot">' +
          'Taxas mantidas fixas a partir da base: <code>ded% = deduções/RB</code> e <code>trib% = tributos/RB</code>. ' +
          'Infra e Outras despesas ficam constantes. A alavanca de <strong>Headcount</strong> escala a Despesa com Pessoal ' +
          '(que ainda recebe o ajuste de Pessoal por cima) e arredonda o número de pessoas.<br>' +
          '<code>RB\' = RB·(1+rb)</code> · <code>RL\' = RB\'·(1−ded%)</code> · <code>RA\' = RL\'−Custos·(1+custo)</code> · ' +
          '<code>Pessoal\' = Pessoal·(1+head)·(1+pessoal)</code> · <code>EBIT\' = RA\'−Pessoal\'−Infra−Outras</code> · ' +
          '<code>RLíq\' = EBIT\'−RB\'·trib%</code>. Nada aqui é gravado — é apenas uma projeção visual.' +
        '</div>' +
      '</div>';

    var outEl = el.querySelector('[data-ck="out"]');
    var valEls = {};
    ALAVANCAS.forEach(function (a) { valEls[a.key] = el.querySelector('[data-val="' + a.key + '"]'); });
    var sliders = {};
    ALAVANCAS.forEach(function (a) { sliders[a.key] = el.querySelector('[data-slider="' + a.key + '"]'); });

    function leSliders() {
      return {
        rb: n(sliders.rb.value) / 100,
        custo: n(sliders.custo.value) / 100,
        pessoal: n(sliders.pessoal.value) / 100,
        head: n(sliders.head.value) / 100
      };
    }

    function pintaValLabels(s) {
      ALAVANCAS.forEach(function (a) {
        var pct = Math.round((a.key === 'rb' ? s.rb : a.key === 'custo' ? s.custo
          : a.key === 'pessoal' ? s.pessoal : s.head) * 100);
        var elv = valEls[a.key];
        elv.textContent = (pct > 0 ? '+' : '') + pct + '%';
        elv.className = 'cen-val' + (pct > 0 ? ' pos' : pct < 0 ? ' neg' : '');
      });
    }

    function recompute() {
      var s = leSliders();
      pintaValLabels(s);
      var r = calcula(base, s);
      outEl.innerHTML =
        card('Receita Líquida', fmtMoeda(r.rl), badgeMoeda(r.rl, b.rl), 'accent') +
        card('Resultado da Agência', fmtMoeda(r.ra), badgeMoeda(r.ra, b.ra), 'blue') +
        card('EBIT Negócio %', fmtPct(r.ebitNeg), badgePP(r.ebitNeg, b.ebitNeg),
          r.ebitNeg < 0 ? 'red' : 'green') +
        card('EBIT Agência %', fmtPct(r.ebitAg), badgePP(r.ebitAg, b.ebitAg),
          r.ebitAg < 0 ? 'red' : 'green') +
        card('Resultado Líquido', fmtMoeda(r.rliq), badgeMoeda(r.rliq, b.rliq),
          r.rliq < 0 ? 'red' : 'green') +
        card('Headcount', r.headcount.toLocaleString('pt-BR'), badgeInt(r.headcount, b.headcount), 'accent');
    }

    function card(rotulo, valor, badge, cor) {
      return '<div class="kpi-card ' + cor + '">' +
        '<div class="kpi-label">' + esc(rotulo) + '</div>' +
        '<div class="kpi-value">' + valor + '</div>' +
        badge +
      '</div>';
    }

    // input em qualquer slider → recálculo em tempo real
    ALAVANCAS.forEach(function (a) {
      sliders[a.key].addEventListener('input', recompute);
    });

    el.querySelector('[data-ck="restaurar"]').addEventListener('click', function () {
      ALAVANCAS.forEach(function (a) { sliders[a.key].value = 0; });
      recompute();
    });

    el.querySelector('[data-ck="salvar"]').addEventListener('click', function () {
      if (salvos.length >= 3) {
        window.alert('Limite de 3 cenários salvos atingido. Restaure ou recarregue para começar de novo.');
        return;
      }
      var nome = window.prompt('Nome do cenário:', 'Cenário ' + (salvos.length + 1));
      if (nome == null) return;
      nome = String(nome).trim() || ('Cenário ' + (salvos.length + 1));
      var s = leSliders();
      salvos.push({ nome: nome, s: s, r: calcula(base, s) });
      pintaComparativo();
    });

    /* ── tabela comparativa: Base + salvos ─────────────────────────── */
    function pintaComparativo() {
      var card = el.querySelector('[data-ck="cmp-card"]');
      var head = el.querySelector('[data-ck="cmp-head"]');
      var body = el.querySelector('[data-ck="cmp-body"]');
      if (!salvos.length) { card.hidden = true; return; }
      card.hidden = false;

      var cols = [{ nome: 'Base', r: b, s: { rb: 0, custo: 0, pessoal: 0, head: 0 }, base: true }]
        .concat(salvos);

      head.innerHTML = '<tr><th>Métrica</th>' + cols.map(function (c) {
        return '<th class="right' + (c.base ? ' cen-base' : '') + '">' + esc(c.nome) + '</th>';
      }).join('') + '</tr>';

      var linhas = [
        { rot: 'Premissas', fn: function (c) {
            return '<span style="font-size:11px;">RB ' + sg(c.s.rb) + ' · Cst ' + sg(c.s.custo) +
              ' · Pes ' + sg(c.s.pessoal) + ' · HC ' + sg(c.s.head) + '</span>'; }, plain: true },
        { rot: 'Receita Bruta', fn: function (c) { return fmtMoeda(c.r.rb); } },
        { rot: 'Receita Líquida', fn: function (c) { return fmtMoeda(c.r.rl); } },
        { rot: 'Resultado da Agência', fn: function (c) { return fmtMoeda(c.r.ra); } },
        { rot: 'EBIT Negócio %', fn: function (c) { return fmtPct(c.r.ebitNeg); } },
        { rot: 'EBIT Agência %', fn: function (c) { return fmtPct(c.r.ebitAg); } },
        { rot: 'Resultado Líquido', fn: function (c) { return fmtMoeda(c.r.rliq); } },
        { rot: 'Headcount', fn: function (c) { return c.r.headcount.toLocaleString('pt-BR'); } }
      ];

      body.innerHTML = linhas.map(function (ln) {
        return '<tr><td style="font-weight:600;color:var(--text-1)">' + esc(ln.rot) + '</td>' +
          cols.map(function (c) {
            return '<td class="right' + (ln.plain ? '' : ' mono') +
              (c.base ? ' cen-base' : '') + '">' + ln.fn(c) + '</td>';
          }).join('') + '</tr>';
      }).join('');
    }

    function sg(frac) {
      var p = Math.round(n(frac) * 100);
      return (p > 0 ? '+' : '') + p + '%';
    }

    recompute();
    pintaComparativo(); // reexibe salvos do contexto (se houver)
  }
})();
