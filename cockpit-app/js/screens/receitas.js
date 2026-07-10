/* ============================================================
 * Tela P3 — Cockpit de Receitas (Curva ABC de clientes + fees)
 * Rota: #/receitas
 * Contrato: usa APENAS window.CK (core.js) + Chart.js global.
 * ZERO dados hardcoded — tudo vem da API (spec §6).
 * ============================================================ */
(function () {
  'use strict';

  // instâncias Chart.js vivas desta tela (destruídas a cada render)
  var charts = [];
  // filtro de empresa ativo (slug da URL da API; 'grupo' = Todas)
  var empresaSel = 'grupo';

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
  function fmtShort(v) {
    var a = Math.abs(n(v));
    if (a >= 1e9) return ptBR(a / 1e9, 1) + 'B';
    if (a >= 1e6) return ptBR(a / 1e6, 1) + 'M';
    if (a >= 1e3) return ptBR(a / 1e3, 0) + 'k';
    return ptBR(a, 0);
  }
  function fmtMoeda(v) {
    try { if (window.CK && CK.fmt && typeof CK.fmt.moeda === 'function') return CK.fmt.moeda(v); } catch (e) { /* fallback local */ }
    var x = n(v);
    return (x < 0 ? '−' : '') + 'R$ ' + fmtShort(x);
  }
  function fmtPct(v, dec) {
    try { if (window.CK && CK.fmt && typeof CK.fmt.percent === 'function') return CK.fmt.percent(v); } catch (e) { /* fallback local */ }
    return ptBR(v, dec == null ? 1 : dec) + '%';
  }
  function hexA(hex, a) { // "#RRGGBB" → rgba()
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(245,200,66,' + a + ')';
    var v = parseInt(m[1], 16);
    return 'rgba(' + (v >> 16 & 255) + ',' + (v >> 8 & 255) + ',' + (v & 255) + ',' + a + ')';
  }
  // API devolve pct JÁ em pontos percentuais (contrato) — sem heurística de escala
  function normalizaPct(vals) { return vals.map(n); }

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
  function tooltipDark(extra) {
    return Object.assign({
      backgroundColor: '#FFFFFF',
      borderColor: 'rgba(0,0,0,0.10)',
      borderWidth: 1,
      titleColor: '#1C1C1C',
      bodyColor: '#81807C'
    }, extra || {});
  }

  // ano do filtro global (default = último ano com dados na API)
  function qsAno(prefixo) {
    var a = '';
    try {
      if (window.CK && CK.state && CK.state.ano) a = CK.state.ano;
      else { var sel = document.getElementById('ano-select'); if (sel && sel.value) a = sel.value; }
    } catch (e) { a = ''; }
    return a ? ((prefixo || '?') + 'ano=' + encodeURIComponent(a)) : '';
  }

  // lista de empresas do registro global (sem o consolidado 'grupo'),
  // RESTRITA ao escopo do usuário (RBAC — backend 403 é a rede de segurança)
  function listaEmpresas() {
    var raw = (window.CK && CK.EMPRESAS) || [];
    var arr = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) {
      var e = raw[k]; if (e && !e.slug) e.slug = k; return e;
    });
    return arr.filter(function (e) {
      return e && e.slug && e.slug !== 'grupo' &&
        (!window.CK || typeof CK.temAcesso !== 'function' || CK.temAcesso(e.slug));
    });
  }

  // true se o usuário pode ver o consolidado ('Todas'/grupo)
  function escopoTotal() {
    return !window.CK || typeof CK.temAcesso !== 'function' || CK.temAcesso('grupo');
  }

  function pega(p) { return CK.api(p).catch(function () { return null; }); }

  /* ── plugin: linha-guia tracejada vermelha em 80% (eixo pct) ─── */
  var guia80 = {
    id: 'guia80',
    afterDatasetsDraw: function (chart) {
      var eixo = chart.scales && chart.scales.pct;
      if (!eixo || !chart.chartArea) return;
      var y = eixo.getPixelForValue(80);
      var ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = '#E5484D';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(chart.chartArea.left, y);
      ctx.lineTo(chart.chartArea.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#E5484D';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.fillText('80% acum.', chart.chartArea.left + 6, y - 5);
      ctx.restore();
    }
  };

  /* ── gráfico: Curva ABC (barras top 10 + linha % acumulado) ──── */
  function pintaABC(el, fees) {
    var box = el.querySelector('[data-ck="abc-box"]');
    if (!box) return;
    var clientes = (fees && fees.clientes) || [];
    if (!clientes.length) {
      box.innerHTML = '<p class="empty-state">Sem fees carregados para o período/empresa.</p>';
      return;
    }
    box.innerHTML = '<canvas data-ck="abc-canvas" role="img"></canvas>';
    var canvas = box.querySelector('[data-ck="abc-canvas"]');

    var top = clientes.slice(0, 10);
    var pctAcum = normalizaPct(top.map(function (c) { return c.pct_acum; }));
    canvas.setAttribute('aria-label',
      'Curva ABC: barras com o fee anual dos ' + top.length +
      ' maiores clientes e linha laranja com o percentual acumulado (guia tracejada em 80%).');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: top.map(function (c) { return c.cliente; }),
        datasets: [
          {
            type: 'line',
            label: '% acumulado',
            data: pctAcum,
            yAxisID: 'pct',
            borderColor: '#F97316',
            backgroundColor: '#F97316',
            pointBackgroundColor: '#F97316',
            pointRadius: 4,
            pointHoverRadius: 5,
            borderWidth: 2,
            tension: 0.3,
            fill: false,
            order: 0
          },
          {
            type: 'bar',
            label: 'Fee anual',
            data: top.map(function (c) { return n(c.fee_anual); }),
            backgroundColor: top.map(function (c) { return c.color || '#D9DA00'; }),
            borderRadius: 5,
            borderSkipped: false,
            yAxisID: 'y',
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipDark({
            callbacks: {
              label: function (c) {
                if (c.dataset.yAxisID === 'pct') return ' Acumulado: ' + fmtPct(c.parsed.y);
                var cli = top[c.dataIndex];
                return ' ' + fmtMoeda(c.parsed.y) + '/ano' +
                  (cli && cli.empresa_label ? ' · ' + cli.empresa_label : '');
              }
            }
          })
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#81807C', font: { size: 10 } }, border: { color: 'rgba(0,0,0,0.07)' } },
          y: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { color: '#81807C', font: { size: 10 }, callback: function (v) { return 'R$' + fmtShort(v); } },
            border: { color: 'transparent' }
          },
          pct: {
            position: 'right',
            min: 0,
            suggestedMax: 100,
            grid: { display: false },
            ticks: { color: '#F97316', font: { size: 10 }, callback: function (v) { return v + '%'; } },
            border: { color: 'transparent' }
          }
        }
      },
      plugins: [guia80]
    });
  }

  /* ── drawer: detalhe de um cliente (fee x12 + variáveis) ─────── */
  function abreDrawerCliente(cli, varsCliente) {
    var cor = cli.color || '#D9DA00';
    var feeAnual = n(cli.fee_anual) || n(cli.fee_mensal) * 12;

    function html() {
      var h =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">' +
          '<span style="font-size:15px;font-weight:600;color:var(--text-1);">' + esc(cli.cliente) + '</span>' +
          '<span class="company-tag" style="background:' + hexA(cor, 0.15) + ';color:' + esc(cor) + ';">' +
            esc(cli.empresa_label || cli.empresa_slug || '') + '</span>' +
        '</div>' +
        '<div class="kpi-row" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">' +
          '<div class="kpi-card accent" style="padding:14px;">' +
            '<div class="kpi-label">Fee mensal</div>' +
            '<div class="kpi-value" style="font-size:20px;">' + fmtMoeda(cli.fee_mensal) + '</div>' +
          '</div>' +
          '<div class="kpi-card blue" style="padding:14px;">' +
            '<div class="kpi-label">Fee anual (×12)</div>' +
            '<div class="kpi-value" style="font-size:20px;">' + fmtMoeda(feeAnual) + '</div>' +
            (cli.pct != null ? '<div class="kpi-compare">' + fmtPct(normalizaPct([cli.pct])[0]) + ' do total de fees</div>' : '') +
          '</div>' +
        '</div>';

      if (varsCliente && varsCliente.length) {
        h += '<div class="card-title" style="margin-bottom:8px;">Receitas variáveis do cliente</div>';
        varsCliente.forEach(function (v) {
          h += '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">' +
            '<span style="font-size:12px;color:var(--text-2);">' + esc(v.tipo_receita || 'Variável') + '</span>' +
            '<span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;color:var(--text-1);">' + fmtMoeda(v.total) + '</span>' +
          '</div>';
        });
        h += '<p style="font-size:11px;color:var(--text-3);margin-top:10px;">' +
          'Observação: além do fee fixo, este cliente possui receita variável registrada no período.</p>';
      } else {
        h += '<p style="font-size:12px;color:var(--text-3);">Sem receitas variáveis registradas para este cliente no período — apenas fee fixo.</p>';
      }
      return h;
    }

    CK.openDrawer({
      title: 'Detalhe de Cliente — ' + cli.cliente,
      render: function (body) {
        var h = html();
        if (body && body.innerHTML !== undefined) body.innerHTML = h;
        return h;
      }
    });
  }

  /* ── tabela: Detalhamento de Fees (clique → drawer cliente) ──── */
  function pintaTabela(el, fees, mapaVar) {
    var tbody = el.querySelector('[data-ck="fees-tbody"]');
    if (!tbody) return;
    var clientes = (fees && fees.clientes) || [];
    if (!clientes.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-3);">Sem fees carregados.</td></tr>';
      return;
    }
    var maxFee = 1;
    clientes.forEach(function (c) { maxFee = Math.max(maxFee, Math.abs(n(c.fee_anual))); });

    tbody.innerHTML = clientes.slice(0, 10).map(function (c, i) {
      var chave = String(c.cliente || '').trim().toLowerCase();
      var temVar = !!(mapaVar && mapaVar[chave] && mapaVar[chave].length);
      var w = Math.round(Math.abs(n(c.fee_anual)) / maxFee * 100);
      var cor = c.color || '#D9DA00';
      return '<tr data-ck="fee-row" data-i="' + i + '" tabindex="0" role="button" ' +
        'aria-label="Abrir detalhe do cliente ' + esc(c.cliente) + '">' +
        '<td style="font-weight:600;color:var(--text-1)">' + esc(c.cliente) +
          '<span class="company-tag" style="background:' + hexA(cor, 0.15) + ';color:' + esc(cor) + '">' +
          esc(c.empresa_label || c.empresa_slug || '') + '</span></td>' +
        '<td>' + (temVar ? 'Fixo + Var.' : 'Fixo') + '</td>' +
        '<td class="mono right">' + fmtMoeda(c.fee_mensal) + '</td>' +
        '<td class="mono right">' + fmtMoeda(c.fee_anual) + '</td>' +
        '<td class="right"><div class="mini-bar-wrap"><div class="mini-bar-fill" style="width:' + w + '%;background:' + esc(cor) + '"></div></div></td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-ck="fee-row"]').forEach(function (tr) {
      function abre() {
        var c = clientes[Number(tr.getAttribute('data-i'))];
        if (!c) return;
        var chave = String(c.cliente || '').trim().toLowerCase();
        abreDrawerCliente(c, (mapaVar && mapaVar[chave]) || []);
      }
      tr.addEventListener('click', abre);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(); } });
    });
  }

  /* ── gráfico: Fees Fixos vs Receita Variável por empresa ─────── */
  function pintaFixoVsVar(el, porEmpresa) {
    var box = el.querySelector('[data-ck="fv-box"]');
    if (!box) return;
    var itens = porEmpresa.filter(function (e) { return e && (e.fees > 0 || e.variavel > 0); });
    if (!itens.length) {
      box.innerHTML = '<p class="empty-state">Sem dados de receita/fees por empresa.</p>';
      return;
    }
    box.innerHTML = '<canvas data-ck="fv-canvas" role="img"></canvas>';
    var canvas = box.querySelector('[data-ck="fv-canvas"]');
    canvas.setAttribute('aria-label',
      'Barras empilhadas: fees fixos anuais (sólido) e receita variável (translúcido) por empresa do grupo.');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: itens.map(function (e) { return e.label; }),
        datasets: [
          {
            label: 'Fees fixos (ano)',
            data: itens.map(function (e) { return e.fees; }),
            backgroundColor: itens.map(function (e) { return e.color || '#D9DA00'; }),
            borderRadius: 4,
            borderSkipped: false,
            stack: 'rec'
          },
          {
            label: 'Receita variável',
            data: itens.map(function (e) { return e.variavel; }),
            backgroundColor: itens.map(function (e) { return hexA(e.color, 0.45); }),
            borderRadius: 4,
            borderSkipped: false,
            stack: 'rec'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#81807C', font: { size: 10 }, boxWidth: 10 } },
          tooltip: tooltipDark({
            callbacks: {
              label: function (c) { return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y); }
            }
          })
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: '#81807C', font: { size: 10 } }, border: { color: 'rgba(0,0,0,0.07)' } },
          y: {
            stacked: true,
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { color: '#81807C', font: { size: 10 }, callback: function (v) { return 'R$' + fmtShort(v); } },
            border: { color: 'transparent' }
          }
        }
      }
    });
  }

  /* ── chips de filtro por empresa (Todas + 5) ─────────────────── */
  function pintaChips(el, aoTrocar) {
    var wrap = el.querySelector('[data-ck="chips"]');
    if (!wrap) return;
    // chip 'Todas' (consolidado) só p/ escopo total; demais chips = empresas permitidas
    var itens = (escopoTotal() ? [{ slug: 'grupo', label: 'Todas', color: '#D9DA00' }] : [])
      .concat(listaEmpresas());
    wrap.innerHTML = itens.map(function (e) {
      var ativo = e.slug === empresaSel;
      var cor = e.color || '#D9DA00';
      return '<button type="button" class="chip" data-slug="' + esc(e.slug) + '" ' +
        'aria-pressed="' + ativo + '" style="cursor:pointer;font-family:\'Inter\',sans-serif;' +
        'background:' + (ativo ? hexA(cor, 0.18) : 'var(--bg-hover)') + ';' +
        'color:' + (ativo ? esc(cor) : 'var(--text-2)') + ';' +
        'border:1px solid ' + (ativo ? hexA(cor, 0.4) : 'var(--border)') + ';">' +
        esc(e.label) + '</button>';
    }).join('');
    wrap.querySelectorAll('[data-slug]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-slug');
        if (slug === empresaSel) return;
        empresaSel = slug;
        pintaChips(el, aoTrocar); // re-render dos chips com novo ativo
        aoTrocar(slug);
      });
    });
  }

  // busca receita variável (por cliente) da seleção atual
  // ('grupo' = merge das 5 empresas — endpoint só existe por slug)
  function buscaVars(slug) {
    var slugs = slug === 'grupo' ? listaEmpresas().map(function (e) { return e.slug; }) : [slug];
    return Promise.all(slugs.map(function (s) {
      return pega('/api/receita-var/' + encodeURIComponent(s) + qsAno());
    })).then(function (rs) {
      var mapa = {};
      rs.forEach(function (r) {
        ((r && r.clientes) || []).forEach(function (v) {
          var chave = String(v.cliente || '').trim().toLowerCase();
          if (!mapa[chave]) mapa[chave] = [];
          mapa[chave].push(v);
        });
      });
      return mapa;
    });
  }

  /* ── registro da tela ─────────────────────────────────────────── */
  CK.registerScreen('receitas', {
    title: 'Cockpit de Receitas — Curva ABC de Clientes',
    subtitle: 'Fees fixos vs variáveis · Drill-down por empresa e cliente',
    render: function (el) {
      destroiCharts();
      // default: consolidado p/ escopo total; senão 1ª empresa permitida.
      // Escopo VAZIO (todas revogadas): empty-state — NUNCA cai no 'grupo' (403).
      var permitidas = listaEmpresas();
      if (!escopoTotal() && !permitidas.length) {
        el.innerHTML = '<div class="empty-state">Seu usuário não tem empresas no escopo. ' +
          'Fale com o administrador para liberar o acesso.</div>';
        return;
      }
      empresaSel = escopoTotal() ? 'grupo' : permitidas[0].slug;

      el.innerHTML =
        // ── Curva ABC (largura total) ──
        '<div class="chart-card" style="margin-bottom:24px;">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Curva ABC de Clientes — Fees</div>' +
            '<div class="card-subtitle">Top 10 por fee anual · linha laranja = % acumulado (Pareto 80/20) · clique numa linha da tabela para detalhe</div>' +
          '</div><div class="chip blue">Curva ABC</div></div>' +
          '<div class="filter-group" data-ck="chips" role="group" aria-label="Filtro de empresa da curva ABC" ' +
            'style="flex-wrap:wrap;margin-bottom:14px;"></div>' +
          '<div class="chart-container" style="height:260px;" data-ck="abc-box">' +
            '<p style="color:var(--text-3);font-size:12px;">Carregando…</p>' +
          '</div>' +
        '</div>' +

        // ── Fixo vs Variável + tabela de fees ──
        '<div class="grid-bot">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Fees Fixos vs Receita Variável por Empresa</div>' +
              '<div class="card-subtitle">Composição da receita bruta anual · fee fixo (sólido) + variável (translúcido)</div>' +
            '</div><div class="chip accent">' + (escopoTotal() ? 'Grupo' : 'Meu escopo') + '</div></div>' +
            '<div class="chart-container" style="height:260px;" data-ck="fv-box">' +
              '<p style="color:var(--text-3);font-size:12px;">Carregando…</p>' +
            '</div>' +
          '</div>' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Detalhamento de Fees</div>' +
              '<div class="card-subtitle" data-ck="fees-sub">Fee mensal e total do ano por cliente · clique para abrir o detalhe</div>' +
            '</div></div>' +
            '<table class="data-table" aria-label="Tabela de detalhamento de fees por cliente">' +
              '<thead><tr><th>Cliente</th><th>Tipo</th>' +
              '<th class="right">Fee/mês</th><th class="right">Total ano</th><th class="right">Barra</th></tr></thead>' +
              '<tbody data-ck="fees-tbody"><tr><td colspan="5" style="color:var(--text-3)">Carregando…</td></tr></tbody>' +
            '</table>' +
          '</div>' +
        '</div>';

      // carrega curva ABC + tabela para a seleção atual (chips refazem a chamada)
      function carregaSelecao(slug) {
        var box = el.querySelector('[data-ck="abc-box"]');
        if (box) box.innerHTML = '<p style="color:var(--text-3);font-size:12px;">Carregando…</p>';
        Promise.all([
          pega('/api/fees/' + encodeURIComponent(slug) + qsAno()),
          buscaVars(slug)
        ]).then(function (r) {
          if (!el.isConnected) return;
          pintaABC(el, r[0]);
          pintaTabela(el, r[0], r[1]);
        });
      }

      pintaChips(el, carregaSelecao);
      carregaSelecao(empresaSel);

      // Fees fixos (soma fee_anual) vs receita variável (rec. bruta − fees) por empresa
      var empresas = listaEmpresas();
      Promise.all(empresas.map(function (e) {
        return Promise.all([
          pega('/api/fees/' + encodeURIComponent(e.slug) + qsAno()),
          pega('/api/kpis/' + encodeURIComponent(e.slug) + qsAno())
        ]).then(function (r) {
          var fees = r[0], kpis = r[1];
          var somaFees = 0;
          ((fees && fees.clientes) || []).forEach(function (c) { somaFees += n(c.fee_anual); });
          var receita = kpis ? n(kpis.receita_bruta) : 0;
          return {
            slug: e.slug,
            label: e.label,
            color: e.color,
            fees: somaFees,
            variavel: Math.max(receita - somaFees, 0)
          };
        });
      })).then(function (porEmpresa) {
        if (!el.isConnected) return;
        pintaFixoVsVar(el, porEmpresa);
      });
    }
  });
})();
