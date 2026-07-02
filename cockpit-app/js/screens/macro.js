/* ============================================================
 * Tela P1 — Visão Macro (Grupo REF consolidado)
 * Rota: #/macro
 * Contrato: usa APENAS window.CK (core.js) + Chart.js global.
 * ZERO dados hardcoded — tudo vem da API (spec §6).
 * ============================================================ */
(function () {
  'use strict';

  // instâncias Chart.js vivas desta tela (destruídas a cada render)
  var charts = [];

  /* ── helpers numéricos / formatação (padrão do mockup, pt-BR) ── */
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
  // "94,2M" | "460k" | "980"
  function fmtShort(v) {
    var a = Math.abs(n(v));
    if (a >= 1e9) return ptBR(a / 1e9, 1) + 'B';
    if (a >= 1e6) return ptBR(a / 1e6, 1) + 'M';
    if (a >= 1e3) return ptBR(a / 1e3, 0) + 'k';
    return ptBR(a, 0);
  }
  // "R$ 94,2M" | "−R$ 331k" — formato dos KPIs do mockup
  function fmtMoeda(v) {
    var x = n(v);
    return (x < 0 ? '−' : '') + 'R$ ' + fmtShort(x);
  }
  function fmtPct(v, dec) { return ptBR(v, dec == null ? 1 : dec) + '%'; }

  // badge de variação vs ano anterior: "▲ +3,2%" / "▼ −53%"
  function deltaBadge(atual, anterior) {
    var a = n(atual), p = n(anterior);
    if (!p) return '';
    var pct = (a - p) / Math.abs(p) * 100;
    var up = pct >= 0;
    var cls = up ? 'up' : 'down';
    var txt = (up ? '▲ +' : '▼ −') + ptBR(Math.abs(pct), Math.abs(pct) >= 10 ? 0 : 1) + '%';
    return '<span class="kpi-delta ' + cls + '">' + txt + '</span>';
  }

  // API pode devolver participação como fração (0–1) ou percentual (0–100);
  // normaliza pelo somatório da lista (curva ABC / mix somam ~100).
  function normalizaPcts(items, campo) {
    var soma = 0;
    items.forEach(function (it) { soma += Math.abs(n(it[campo])); });
    var f = (soma > 0 && soma <= 1.5) ? 100 : 1;
    return items.map(function (it) { return n(it[campo]) * f; });
  }

  function hexA(hex, a) { // hex "#RRGGBB" → rgba()
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(245,200,66,' + a + ')';
    var v = parseInt(m[1], 16);
    return 'rgba(' + (v >> 16 & 255) + ',' + (v >> 8 & 255) + ',' + (v & 255) + ',' + a + ')';
  }

  /* ── wrappers CK.charts (destrói/recria a cada render) ───────── */
  function novoChart(canvas, cfg) {
    var ch = null, CC = window.CK && window.CK.charts;
    try {
      if (CC && typeof CC.create === 'function') ch = CC.create(canvas, cfg);
      else if (CC && typeof CC.make === 'function') ch = CC.make(canvas, cfg);
      else if (typeof CC === 'function') ch = CC(canvas, cfg);
    } catch (e) { ch = null; }
    if (!ch) ch = new Chart(canvas.getContext('2d'), cfg);
    charts.push(ch);
    return ch;
  }
  function destroiCharts() {
    charts.forEach(function (c) { try { if (c && c.destroy) c.destroy(); } catch (e) { /* já destruído */ } });
    charts = [];
  }

  // tooltip com tema dark idêntico ao mockup
  function tooltipDark(extra) {
    return Object.assign({
      backgroundColor: '#1A1E2C',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      titleColor: '#F0F2F8',
      bodyColor: '#9BA3B8'
    }, extra || {});
  }

  // ano selecionado no filtro global do topbar (default = último ano c/ dados na API)
  function qsAno() {
    var a = '';
    try {
      if (window.CK && CK.state && CK.state.ano) a = CK.state.ano;
      else { var sel = document.getElementById('ano-select'); if (sel && sel.value) a = sel.value; }
    } catch (e) { a = ''; }
    return a ? ('?ano=' + encodeURIComponent(a)) : '';
  }

  /* ── drawer: Composição da Receita (top clientes do grupo) ───── */
  function abreDrawerReceita(fees) {
    var clientes = (fees && fees.clientes) || [];
    var pcts = normalizaPcts(clientes, 'pct');
    var maxFee = 1;
    clientes.forEach(function (c) { maxFee = Math.max(maxFee, Math.abs(n(c.fee_anual))); });

    function html() {
      if (!clientes.length) return '<p style="color:var(--text-3);font-size:13px;">Sem fees carregados para o período.</p>';
      var h = '<div style="font-size:11px;color:var(--text-3);margin-bottom:12px;">' +
        'Total fee mensal do grupo: <span style="font-family:\'JetBrains Mono\',monospace;color:var(--text-1);font-weight:600;">' +
        fmtMoeda(fees.total_fee_mensal) + '</span></div>';
      clientes.slice(0, 12).forEach(function (c, i) {
        var w = Math.round(Math.abs(n(c.fee_anual)) / maxFee * 100);
        h += '<div style="padding:8px 0;border-bottom:1px solid var(--border);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
            '<div style="display:flex;align-items:center;gap:8px;min-width:0;">' +
              '<span class="rank">' + (i + 1) + '</span>' +
              '<span style="font-size:13px;font-weight:600;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(c.cliente) + '</span>' +
              '<span class="company-tag" style="background:' + hexA(c.color, 0.15) + ';color:' + esc(c.color || '#F5C842') + ';">' + esc(c.empresa_label || c.empresa_slug || '') + '</span>' +
            '</div>' +
            '<span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;color:var(--text-1);white-space:nowrap;">' + fmtMoeda(c.fee_mensal) + '/mês</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">' +
            '<div class="mini-bar-wrap" style="flex:1;width:auto;"><div class="mini-bar-fill" style="width:' + w + '%;background:' + esc(c.color || '#F5C842') + ';"></div></div>' +
            '<span style="font-size:10px;color:var(--text-3);font-family:\'JetBrains Mono\',monospace;white-space:nowrap;">' + fmtMoeda(c.fee_anual) + '/ano · ' + fmtPct(pcts[i]) + '</span>' +
          '</div>' +
        '</div>';
      });
      return h;
    }

    CK.openDrawer({
      title: 'Composição da Receita',
      render: function (body) {
        var h = html();
        if (body && body.innerHTML !== undefined) body.innerHTML = h;
        return h; // compatível caso o core espere string de retorno
      }
    });
  }

  /* ── gráfico: EBIT histórico REF+ (barras, cor por threshold) ── */
  function pintaEbit(el, historico) {
    var canvas = el.querySelector('[data-ck="ebit-canvas"]');
    var anos = (historico && historico.anos) || [];
    if (!canvas || !anos.length) {
      if (canvas) canvas.closest('.chart-container').innerHTML =
        '<p style="color:var(--text-3);font-size:12px;">Sem histórico disponível.</p>';
      return;
    }
    // normaliza escala do ebit_pct (fração → percentual) se necessário
    var vals = anos.map(function (a) { return n(a.ebit_pct); });
    var todosFracao = vals.length && vals.every(function (v) { return Math.abs(v) <= 1; });
    if (todosFracao) vals = vals.map(function (v) { return v * 100; });

    var labels = anos.map(function (a) { return String(a.ano); });
    var cores = vals.map(function (v) {
      return v >= 8 ? '#F5C842' : v >= 4 ? '#3B82F6' : v >= 0 ? '#9BA3B8' : '#EF4444';
    });
    canvas.setAttribute('aria-label',
      'Gráfico de barras: EBIT Negócio histórico da REF+ de ' + labels[0] + ' a ' + labels[labels.length - 1]);

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: '% EBIT Negócio',
          data: vals,
          backgroundColor: cores,
          borderRadius: 5,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipDark({
            callbacks: { label: function (c) { return ' EBIT: ' + ptBR(c.parsed.y, 2) + '%'; } }
          })
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#5A6178', font: { size: 10 } }, border: { color: 'rgba(255,255,255,0.06)' } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5A6178', font: { size: 10 }, callback: function (v) { return v + '%'; } }, border: { color: 'transparent' } }
        }
      }
    });
  }

  /* ── gráfico: donut Mix de Receita (click → tela micro) ──────── */
  function pintaDonut(el, kpis) {
    var canvas = el.querySelector('[data-ck="donut-canvas"]');
    var mix = (kpis && kpis.mix) || [];
    if (!canvas || !mix.length) return;

    var pcts = normalizaPcts(mix, 'pct');
    canvas.setAttribute('aria-label',
      'Donut: participação de cada empresa na receita bruta do grupo. Clique em uma fatia para abrir a visão da empresa.');

    novoChart(canvas, {
      type: 'doughnut',
      data: {
        labels: mix.map(function (m) { return m.label; }),
        datasets: [{
          data: mix.map(function (m) { return n(m.receita); }),
          backgroundColor: mix.map(function (m) { return m.color || '#F5C842'; }),
          borderColor: '#141720',
          borderWidth: 3,
          hoverBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        onHover: function (evt, els) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
        },
        onClick: function (evt, els) {
          if (els && els.length) {
            var m = mix[els[0].index];
            if (m && m.slug) location.hash = '#/micro/' + m.slug;
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: tooltipDark({
            callbacks: {
              label: function (c) {
                return ' ' + fmtMoeda(c.parsed) + ' (' + fmtPct(pcts[c.dataIndex]) + ')';
              }
            }
          })
        }
      }
    });

    // centro do donut (total) + legenda com linhas clicáveis
    var centro = el.querySelector('[data-ck="donut-total"]');
    if (centro) centro.textContent = fmtMoeda(kpis.receita_bruta);

    var leg = el.querySelector('[data-ck="donut-legend"]');
    if (leg) {
      leg.innerHTML = mix.map(function (m, i) {
        return '<div class="legend-row" role="button" tabindex="0" data-slug="' + esc(m.slug) + '" style="cursor:pointer;">' +
          '<div class="legend-left">' +
            '<div class="legend-dot" style="background:' + esc(m.color || '#F5C842') + '"></div>' +
            '<div><div class="legend-name">' + esc(m.label) + '</div>' +
            '<div class="legend-pct">' + fmtPct(pcts[i]) + ' da rec.</div></div>' +
          '</div>' +
          '<div class="legend-val">' + fmtShort(m.receita) + '</div>' +
        '</div>';
      }).join('');
      leg.querySelectorAll('[data-slug]').forEach(function (row) {
        function vai() { location.hash = '#/micro/' + row.getAttribute('data-slug'); }
        row.addEventListener('click', vai);
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vai(); } });
      });
    }
  }

  /* ── tabela: Top Clientes (curva ABC consolidada) ────────────── */
  function pintaClientes(el, fees) {
    var tbody = el.querySelector('[data-ck="clientes-tbody"]');
    if (!tbody) return;
    var clientes = (fees && fees.clientes) || [];
    if (!clientes.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-3);">Sem fees carregados.</td></tr>';
      return;
    }
    var pcts = normalizaPcts(clientes, 'pct');
    var maxFee = 1;
    clientes.forEach(function (c) { maxFee = Math.max(maxFee, Math.abs(n(c.fee_anual))); });

    tbody.innerHTML = clientes.slice(0, 8).map(function (c, i) {
      var w = Math.round(Math.abs(n(c.fee_anual)) / maxFee * 100);
      var cor = c.color || '#F5C842';
      return '<tr data-ck="cliente-row" tabindex="0">' +
        '<td><span class="rank">' + (i + 1) + '</span></td>' +
        '<td style="font-weight:600;color:var(--text-1)">' + esc(c.cliente) + '</td>' +
        '<td><span class="company-tag" style="background:' + hexA(cor, 0.15) + ';color:' + esc(cor) + '">' + esc(c.empresa_label || c.empresa_slug || '') + '</span></td>' +
        '<td class="mono right">' + fmtMoeda(c.fee_mensal) + '</td>' +
        '<td class="mono right">' + fmtMoeda(c.fee_anual) + '</td>' +
        '<td class="mono right"' + (i === 0 ? ' style="color:var(--accent)"' : '') + '>' + fmtPct(pcts[i]) + '</td>' +
        '<td class="right"><div class="mini-bar-wrap"><div class="mini-bar-fill" style="width:' + w + '%;background:' + esc(cor) + '"></div></div></td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-ck="cliente-row"]').forEach(function (tr) {
      function vai() { location.hash = '#/receitas'; }
      tr.addEventListener('click', vai);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') vai(); });
    });
  }

  /* ── painel: Red Flags + banner persistente de críticos ──────── */
  function pintaAlertas(el, alertas) {
    var wrap = el.querySelector('[data-ck="flags"]');
    var chip = el.querySelector('[data-ck="flags-chip"]');
    var banner = el.querySelector('[data-ck="banner"]');
    var criticos = (alertas && alertas.criticos) || [];
    var atencao = (alertas && alertas.atencao) || [];

    // banner persistente no topo da tela quando há CRÍTICO (spec §4 — A01/A02/A07 visíveis na Macro)
    if (banner) {
      if (criticos.length) {
        banner.hidden = false;
        banner.innerHTML =
          '<span class="flag-icon" aria-hidden="true">🔴</span>' +
          '<div><div class="flag-title">' + criticos.length + ' alerta' + (criticos.length > 1 ? 's' : '') + ' crítico' + (criticos.length > 1 ? 's' : '') + ' ativo' + (criticos.length > 1 ? 's' : '') + '</div>' +
          '<div class="flag-desc">' + criticos.slice(0, 3).map(function (a) { return esc(a.titulo); }).join(' · ') +
          ' — <a href="#/alertas" style="color:var(--red);font-weight:600;">ver todos os alertas</a></div></div>';
      } else {
        banner.hidden = true;
        banner.innerHTML = '';
      }
    }

    if (chip) {
      chip.textContent = criticos.length + ' ativos';
      chip.style.display = criticos.length ? '' : 'none';
    }
    if (!wrap) return;

    var cards = criticos.map(function (a) { return { tipo: 'danger', icone: '🔴', a: a }; })
      .concat(atencao.map(function (a) { return { tipo: 'warn', icone: '⚠️', a: a }; }))
      .slice(0, 4);

    if (!cards.length) {
      wrap.innerHTML = '<div class="flag-card ok"><div class="flag-icon">✅</div>' +
        '<div><div class="flag-title">Nenhum alerta ativo</div>' +
        '<div class="flag-desc">Todas as empresas dentro dos gatilhos configurados (A01–A10).</div></div></div>';
      return;
    }
    wrap.innerHTML = cards.map(function (c) {
      return '<div class="flag-card ' + c.tipo + '">' +
        '<div class="flag-icon" aria-hidden="true">' + c.icone + '</div>' +
        '<div><div class="flag-title">' + esc(c.a.titulo) + '</div>' +
        '<div class="flag-desc">' + esc(c.a.detalhe) + (c.a.acao ? ' <em style="color:var(--text-3)">' + esc(c.a.acao) + '</em>' : '') + '</div></div>' +
      '</div>';
    }).join('');
  }

  /* ── KPIs consolidados ────────────────────────────────────────── */
  function pintaKpis(el, kpis, fees) {
    var row = el.querySelector('[data-ck="kpis"]');
    if (!row || !kpis) return;
    var prev = kpis.prev || {};
    var margem = n(kpis.receita_bruta) ? n(kpis.receita_liquida) / n(kpis.receita_bruta) * 100 : 0;

    row.innerHTML =
      // Receita Bruta — clicável → drawer Composição da Receita
      '<div class="kpi-card accent" data-ck="kpi-receita" role="button" tabindex="0" style="cursor:pointer;" ' +
           'aria-label="Receita bruta total. Clique para ver a composição da receita por cliente.">' +
        '<div class="kpi-icon accent" aria-hidden="true">💰</div>' +
        '<div class="kpi-label">Receita Bruta Total</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.receita_bruta) + '</div>' +
        deltaBadge(kpis.receita_bruta, prev.receita_bruta) +
        '<div class="kpi-compare">' + (prev.receita_bruta != null ? 'vs ' + fmtMoeda(prev.receita_bruta) + ' em ' + esc(prev.ano) : 'sem base ' + (n(kpis.ano) - 1)) + '</div>' +
      '</div>' +
      // Receita Operacional Líquida
      '<div class="kpi-card blue">' +
        '<div class="kpi-icon blue" aria-hidden="true">📊</div>' +
        '<div class="kpi-label">Receita Op. Líquida</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.receita_liquida) + '</div>' +
        '<span class="kpi-delta up">' + fmtPct(margem) + '</span>' +
        '<div class="kpi-compare">Margem ' + fmtPct(margem) + ' s/ R. Bruta</div>' +
      '</div>' +
      // Folha
      '<div class="kpi-card red">' +
        '<div class="kpi-icon red" aria-hidden="true">👥</div>' +
        '<div class="kpi-label">Total Folha Salarial</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.folha_mes) + '</div>' +
        '<span class="kpi-delta warn">mensal</span>' +
        '<div class="kpi-compare">' + n(kpis.headcount).toLocaleString('pt-BR') + ' funcionários no grupo</div>' +
      '</div>' +
      // Resultado Líquido
      '<div class="kpi-card green">' +
        '<div class="kpi-icon green" aria-hidden="true">✓</div>' +
        '<div class="kpi-label">Resultado Líquido</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.resultado_liquido) + '</div>' +
        deltaBadge(kpis.resultado_liquido, prev.resultado_liquido) +
        '<div class="kpi-compare">' + (prev.resultado_liquido != null ? 'vs ' + fmtMoeda(prev.resultado_liquido) + ' em ' + esc(prev.ano) : '') + '</div>' +
      '</div>';

    var kpiReceita = row.querySelector('[data-ck="kpi-receita"]');
    if (kpiReceita) {
      function abre() { abreDrawerReceita(fees); }
      kpiReceita.addEventListener('click', abre);
      kpiReceita.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(); } });
    }
  }

  /* ── registro da tela ─────────────────────────────────────────── */
  CK.registerScreen('macro', {
    title: 'Visão Macro — Grupo REF',
    subtitle: 'Demonstrações Financeiras Consolidadas',
    render: function (el) {
      destroiCharts();
      var qs = qsAno();

      el.innerHTML =
        '<div class="flag-card danger" data-ck="banner" role="alert" hidden style="margin-bottom:16px;"></div>' +

        '<div class="kpi-row" data-ck="kpis">' +
          '<div class="kpi-card"><div class="kpi-label">Carregando…</div></div>' +
        '</div>' +

        '<div class="grid-mid">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Evolução % EBIT Negócio — histórico</div>' +
              '<div class="card-subtitle">REF+ · Resultado operacional antes dos impostos / Receita Bruta</div>' +
            '</div><div class="chip accent">REF+</div></div>' +
            '<div class="chart-container" style="height:220px;">' +
              '<canvas data-ck="ebit-canvas" role="img" aria-label="Gráfico de barras EBIT histórico REF+"></canvas>' +
            '</div>' +
          '</div>' +
          '<div class="chart-card donut-wrap">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Mix de Receita por Empresa</div>' +
              '<div class="card-subtitle">Participação % na receita bruta total · clique para drill-down</div>' +
            '</div><div class="chip blue">Grupo</div></div>' +
            '<div class="donut-chart-area">' +
              '<div class="donut-canvas">' +
                '<canvas data-ck="donut-canvas" role="img" aria-label="Donut da participação das empresas na receita"></canvas>' +
                '<div class="donut-center">' +
                  '<div class="donut-center-val" data-ck="donut-total">—</div>' +
                  '<div class="donut-center-lbl">Total</div>' +
                '</div>' +
              '</div>' +
              '<div class="donut-legend" data-ck="donut-legend"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="grid-bot">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Top Clientes — Fees Consolidados</div>' +
              '<div class="card-subtitle">Soma dos fees fixos por cliente no Grupo REF · Clique para drill-down</div>' +
            '</div><div class="chip blue">Curva ABC</div></div>' +
            '<table class="data-table" aria-label="Tabela de top clientes por fee anual (curva ABC)">' +
              '<thead><tr><th>#</th><th>Cliente</th><th>Empresa</th>' +
              '<th class="right">Fee Mensal</th><th class="right">Fee Anual</th>' +
              '<th class="right">Part. %</th><th class="right">Barra</th></tr></thead>' +
              '<tbody data-ck="clientes-tbody"><tr><td colspan="7" style="color:var(--text-3)">Carregando…</td></tr></tbody>' +
            '</table>' +
          '</div>' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Alertas — Red Flags</div>' +
              '<div class="card-subtitle">Gatilhos automáticos de monitoramento (A01–A10)</div>' +
            '</div><div class="chip" data-ck="flags-chip" style="background:var(--red-dim);color:var(--red);border:1px solid rgba(239,68,68,0.25);display:none;"></div></div>' +
            '<div data-ck="flags"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '</div>' +
        '</div>';

      // busca resiliente: cada endpoint falha de forma isolada
      function pega(p) { return CK.api(p).catch(function () { return null; }); }
      Promise.all([
        pega('/api/kpis/grupo' + qs),
        pega('/api/historico/ref-plus'),
        pega('/api/fees/grupo' + qs),
        pega('/api/alertas')
      ]).then(function (r) {
        var kpis = r[0], historico = r[1], fees = r[2], alertas = r[3];
        if (!el.isConnected) return; // tela já foi trocada
        if (kpis) pintaKpis(el, kpis, fees);
        else el.querySelector('[data-ck="kpis"]').innerHTML =
          '<div class="kpi-card red"><div class="kpi-label">Erro</div><div class="kpi-compare">Falha ao carregar KPIs do grupo.</div></div>';
        pintaEbit(el, historico);
        if (kpis) pintaDonut(el, kpis);
        pintaClientes(el, fees);
        pintaAlertas(el, alertas);
      });
    }
  });
})();
