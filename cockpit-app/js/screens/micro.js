/* ============================================================
 * Tela P2 — Visão Micro (empresa individual)
 * Rota: #/micro/{slug}  (slugs: ref-plus, black-door, 4in, viv, zuptech)
 * Contrato: usa APENAS window.CK (core.js) + Chart.js global.
 * ZERO dados hardcoded — tudo vem da API (spec §6).
 * ============================================================ */
(function () {
  'use strict';

  var charts = []; // instâncias Chart.js vivas desta tela

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
    var x = n(v);
    return (x < 0 ? '−' : '') + 'R$ ' + fmtShort(x);
  }
  function fmtPct(v, dec) { return ptBR(v, dec == null ? 1 : dec) + '%'; }

  function deltaBadge(atual, anterior) {
    var a = n(atual), p = n(anterior);
    if (!p) return '';
    var pct = (a - p) / Math.abs(p) * 100;
    var up = pct >= 0;
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      (up ? '▲ +' : '▼ −') + ptBR(Math.abs(pct), Math.abs(pct) >= 10 ? 0 : 1) + '%</span>';
  }

  // ebit_pct pode vir como fração (0.038) ou percentual (3.8) — normaliza p/ escala %
  // API devolve percentuais JÁ em pontos percentuais (contrato) — sem heurística de escala
  function pctEscala(v) { return n(v); }
  function pctEscalaArray(vals) { return vals.map(n); }

  var MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  function nomeMes(m) { m = n(m); return (m >= 1 && m <= 12) ? MESES[m - 1] : String(m); }

  // CK.EMPRESAS pode ser array ou mapa por slug
  function getEmpresa(slug) {
    var E = (window.CK && CK.EMPRESAS) || null;
    if (Array.isArray(E)) return E.find(function (e) { return e.slug === slug; }) || null;
    if (E && E[slug]) return E[slug];
    return null;
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

  function tooltipDark(extra) {
    return Object.assign({
      backgroundColor: '#FFFFFF',
      borderColor: 'rgba(0,0,0,0.10)',
      borderWidth: 1,
      titleColor: '#1C1C1C',
      bodyColor: '#81807C'
    }, extra || {});
  }
  function eixoX() {
    return { grid: { display: false }, ticks: { color: '#81807C', font: { size: 10 } }, border: { color: 'rgba(0,0,0,0.07)' } };
  }
  function eixoYMoeda() {
    return {
      grid: { color: 'rgba(0,0,0,0.05)' },
      ticks: { color: '#81807C', font: { size: 10 }, callback: function (v) { return fmtShort(v); } },
      border: { color: 'transparent' }
    };
  }
  function legendaDark() {
    return { position: 'bottom', labels: { color: '#81807C', font: { size: 10 }, boxWidth: 10, boxHeight: 10 } };
  }

  // plugin local: rótulos de valor acima das barras (EBIT trimestral)
  var pluginRotulos = {
    id: 'ckRotulosValor',
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      chart.data.datasets.forEach(function (ds, di) {
        var meta = chart.getDatasetMeta(di);
        if (!meta || meta.hidden || meta.type !== 'bar') return;
        meta.data.forEach(function (barra, i) {
          var v = ds.data[i];
          if (v == null) return;
          ctx.save();
          ctx.fillStyle = typeof ds.backgroundColor === 'string' ? ds.backgroundColor : '#81807C';
          ctx.font = "600 9px 'JetBrains Mono', monospace";
          ctx.textAlign = 'center';
          ctx.fillText(ptBR(v, 1) + '%', barra.x, n(v) >= 0 ? barra.y - 4 : barra.y + 11);
          ctx.restore();
        });
      });
    }
  };

  function qsAno() {
    var a = '';
    try {
      if (window.CK && CK.state && CK.state.ano) a = CK.state.ano;
      else { var sel = document.getElementById('ano-select'); if (sel && sel.value) a = sel.value; }
    } catch (e) { a = ''; }
    return a ? ('?ano=' + encodeURIComponent(a)) : '';
  }

  /* ── CSV client-side (rodapé do drawer de composição) ────────── */
  function baixaCsv(nomeArquivo, linhas) {
    // separador ';' + BOM: abre direto no Excel pt-BR
    var csv = '﻿' + linhas.map(function (l) {
      return l.map(function (c) {
        c = String(c == null ? '' : c);
        return /[;"\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(';');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function numCsv(v) { return ptBR(v, 2); } // decimal com vírgula

  /* ── drawer: Composição da Receita Bruta (tabs fees/variável) ── */
  function abreDrawerComposicao(slug, label, qs) {
    CK.openDrawer({
      title: 'Composição da Receita Bruta — ' + label,
      render: function (body) {
        var html =
          '<div style="display:flex;gap:8px;margin-bottom:14px;" role="tablist" aria-label="Tipo de receita">' +
            '<button type="button" data-ck="tab-fees" role="tab" aria-selected="true" class="chip accent" style="cursor:pointer;font-size:11px;padding:6px 14px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--border-acc);border-radius:20px;font-family:Inter,sans-serif;">Fees Fixos</button>' +
            '<button type="button" data-ck="tab-var" role="tab" aria-selected="false" class="chip" style="cursor:pointer;font-size:11px;padding:6px 14px;background:var(--bg-hover);color:var(--text-2);border:1px solid var(--border);border-radius:20px;font-family:Inter,sans-serif;">Receita Variável</button>' +
          '</div>' +
          '<div data-ck="tab-body" style="min-height:120px;"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;text-align:right;">' +
            '<button type="button" data-ck="btn-csv" style="cursor:pointer;background:var(--accent-dim);color:var(--accent);border:1px solid var(--border-acc);border-radius:6px;padding:8px 16px;font-size:12px;font-weight:600;font-family:Inter,sans-serif;">⬇ Exportar CSV</button>' +
          '</div>';

        if (!body || body.innerHTML === undefined) return html; // core pode esperar string
        body.innerHTML = html;

        var tabBody = body.querySelector('[data-ck="tab-body"]');
        var btnFees = body.querySelector('[data-ck="tab-fees"]');
        var btnVar = body.querySelector('[data-ck="tab-var"]');
        var btnCsv = body.querySelector('[data-ck="btn-csv"]');
        var dados = { fees: null, variavel: null };
        var tabAtiva = 'fees';

        function estiloTabs() {
          [[btnFees, 'fees'], [btnVar, 'var']].forEach(function (par) {
            var ativa = (tabAtiva === 'fees') === (par[1] === 'fees');
            par[0].setAttribute('aria-selected', ativa ? 'true' : 'false');
            par[0].style.background = ativa ? 'var(--accent-dim)' : 'var(--bg-hover)';
            par[0].style.color = ativa ? 'var(--accent)' : 'var(--text-2)';
            par[0].style.borderColor = ativa ? 'var(--border-acc)' : 'var(--border)';
          });
        }

        function pintaFees() {
          var f = dados.fees;
          var cls = (f && f.clientes) || [];
          if (!cls.length) { tabBody.innerHTML = '<p style="color:var(--text-3);font-size:12px;">Sem fees fixos cadastrados para ' + esc(label) + '.</p>'; return; }
          var max = 1;
          cls.forEach(function (c) { max = Math.max(max, Math.abs(n(c.fee_anual))); });
          tabBody.innerHTML =
            '<div style="font-size:11px;color:var(--text-3);margin-bottom:10px;">Total fee mensal: ' +
            '<span style="font-family:\'JetBrains Mono\',monospace;color:var(--text-1);font-weight:600;">' + fmtMoeda(f.total_fee_mensal) + '</span></div>' +
            cls.map(function (c, i) {
              var w = Math.round(Math.abs(n(c.fee_anual)) / max * 100);
              return '<div style="padding:7px 0;border-bottom:1px solid var(--border);">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">' +
                  '<span style="font-size:12px;font-weight:600;color:var(--text-1);"><span class="rank" style="margin-right:6px;">' + (i + 1) + '</span>' + esc(c.cliente) + '</span>' +
                  '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-1);white-space:nowrap;">' + fmtMoeda(c.fee_mensal) + '/mês</span>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:8px;margin-top:5px;">' +
                  '<div class="mini-bar-wrap" style="flex:1;width:auto;"><div class="mini-bar-fill" style="width:' + w + '%;background:var(--accent);"></div></div>' +
                  '<span style="font-size:10px;color:var(--text-3);font-family:\'JetBrains Mono\',monospace;white-space:nowrap;">' + fmtMoeda(c.fee_anual) + '/ano</span>' +
                '</div>' +
              '</div>';
            }).join('');
        }

        function pintaVariavel() {
          var cls = (dados.variavel && dados.variavel.clientes) || [];
          if (!cls.length) { tabBody.innerHTML = '<p style="color:var(--text-3);font-size:12px;">Sem receita variável registrada para ' + esc(label) + '.</p>'; return; }
          tabBody.innerHTML =
            '<table class="data-table" aria-label="Receita variável por cliente">' +
            '<thead><tr><th>Cliente</th><th>Tipo</th><th class="right">Total</th></tr></thead><tbody>' +
            cls.map(function (c) {
              return '<tr><td style="font-weight:600;color:var(--text-1)">' + esc(c.cliente) + '</td>' +
                '<td>' + esc(c.tipo_receita || '—') + '</td>' +
                '<td class="mono right">' + fmtMoeda(c.total) + '</td></tr>';
            }).join('') + '</tbody></table>';
        }

        function pintaTab() {
          estiloTabs();
          if (tabAtiva === 'fees') {
            if (dados.fees) pintaFees();
            else CK.api('/api/fees/' + slug + qs)
              .then(function (d) { dados.fees = d || { clientes: [] }; if (tabAtiva === 'fees') pintaFees(); })
              .catch(function () { tabBody.innerHTML = '<p style="color:var(--red);font-size:12px;">Erro ao carregar fees.</p>'; });
          } else {
            if (dados.variavel) pintaVariavel();
            else CK.api('/api/receita-var/' + slug + qs)
              .then(function (d) { dados.variavel = d || { clientes: [] }; if (tabAtiva === 'var') pintaVariavel(); })
              .catch(function () { tabBody.innerHTML = '<p style="color:var(--red);font-size:12px;">Erro ao carregar receita variável.</p>'; });
          }
        }

        btnFees.addEventListener('click', function () { tabAtiva = 'fees'; pintaTab(); });
        btnVar.addEventListener('click', function () { tabAtiva = 'var'; pintaTab(); });

        btnCsv.addEventListener('click', function () {
          var linhas;
          if (tabAtiva === 'fees') {
            var cls = (dados.fees && dados.fees.clientes) || [];
            linhas = [['cliente', 'fee_mensal', 'fee_anual']].concat(cls.map(function (c) {
              return [c.cliente, numCsv(c.fee_mensal), numCsv(c.fee_anual)];
            }));
            baixaCsv('fees_fixos_' + slug + '.csv', linhas);
          } else {
            var vs = (dados.variavel && dados.variavel.clientes) || [];
            linhas = [['cliente', 'tipo_receita', 'total']].concat(vs.map(function (c) {
              return [c.cliente, c.tipo_receita, numCsv(c.total)];
            }));
            baixaCsv('receita_variavel_' + slug + '.csv', linhas);
          }
        });

        pintaTab();
        return html;
      }
    });
  }

  /* ── KPIs da empresa (5 cards) ────────────────────────────────── */
  function pintaKpis(el, kpis, abreDrawer) {
    var row = el.querySelector('[data-ck="kpis"]');
    if (!row || !kpis) return;
    var prev = kpis.prev || {};
    var margemLiq = n(kpis.receita_bruta) ? n(kpis.receita_liquida) / n(kpis.receita_bruta) * 100 : 0;
    var margemAg = n(kpis.receita_bruta) ? n(kpis.resultado_agencia) / n(kpis.receita_bruta) * 100 : 0;
    var ebit = pctEscala(kpis.ebit_pct);
    var resLiqPos = n(kpis.resultado_liquido) >= 0;

    row.innerHTML =
      // Rec. Bruta — clicável → drawer composição
      '<div class="kpi-card green" data-ck="kpi-receita" role="button" tabindex="0" style="cursor:pointer;" ' +
           'aria-label="Receita bruta. Clique para ver a composição da receita bruta.">' +
        '<div class="kpi-icon green" aria-hidden="true">💰</div>' +
        '<div class="kpi-label">Rec. Bruta</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.receita_bruta) + '</div>' +
        deltaBadge(kpis.receita_bruta, prev.receita_bruta) +
        '<div class="kpi-compare">' + (prev.receita_bruta != null ? 'vs ' + fmtMoeda(prev.receita_bruta) + ' em ' + esc(prev.ano) : 'clique p/ composição') + '</div>' +
      '</div>' +
      // Rec. Op. Líq. — % s/ bruta
      '<div class="kpi-card blue">' +
        '<div class="kpi-icon blue" aria-hidden="true">📊</div>' +
        '<div class="kpi-label">Rec. Op. Líq.</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.receita_liquida) + '</div>' +
        '<span class="kpi-delta warn">' + fmtPct(margemLiq) + '</span>' +
        '<div class="kpi-compare">' + fmtPct(margemLiq) + ' s/ Rec. Bruta</div>' +
      '</div>' +
      // Res. Agência
      '<div class="kpi-card accent">' +
        '<div class="kpi-icon accent" aria-hidden="true">🏢</div>' +
        '<div class="kpi-label">Res. Agência</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.resultado_agencia) + '</div>' +
        '<span class="kpi-delta ' + (n(kpis.resultado_agencia) >= 0 ? 'up' : 'down') + '">' + fmtPct(margemAg) + '</span>' +
        '<div class="kpi-compare">margem s/ Rec. Bruta</div>' +
      '</div>' +
      // EBIT Negócio %
      '<div class="kpi-card ' + (ebit >= 0 ? 'blue' : 'red') + '">' +
        '<div class="kpi-icon ' + (ebit >= 0 ? 'blue' : 'red') + '" aria-hidden="true">📈</div>' +
        '<div class="kpi-label">EBIT Negócio</div>' +
        '<div class="kpi-value">' + fmtPct(ebit, 2) + '</div>' +
        '<span class="kpi-delta ' + (ebit >= 8 ? 'up' : ebit >= 0 ? 'warn' : 'down') + '">' + (ebit >= 8 ? 'acima da meta' : ebit >= 0 ? 'abaixo da meta 8%' : 'negativo') + '</span>' +
        '<div class="kpi-compare">EBIT / Receita Bruta</div>' +
      '</div>' +
      // Res. Líquido
      '<div class="kpi-card ' + (resLiqPos ? 'green' : 'red') + '">' +
        '<div class="kpi-icon ' + (resLiqPos ? 'green' : 'red') + '" aria-hidden="true">' + (resLiqPos ? '✓' : '✗') + '</div>' +
        '<div class="kpi-label">Res. Líquido</div>' +
        '<div class="kpi-value">' + fmtMoeda(kpis.resultado_liquido) + '</div>' +
        deltaBadge(kpis.resultado_liquido, prev.resultado_liquido) +
        '<div class="kpi-compare">' + (prev.resultado_liquido != null ? 'vs ' + fmtMoeda(prev.resultado_liquido) + ' em ' + esc(prev.ano) : '') + '</div>' +
      '</div>';

    var kpiReceita = row.querySelector('[data-ck="kpi-receita"]');
    if (kpiReceita) {
      kpiReceita.addEventListener('click', abreDrawer);
      kpiReceita.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abreDrawer(); } });
    }
  }

  /* ── gráfico: DRE mês a mês (barras + linha res. líquido) ────── */
  function pintaDreMensal(el, dre, label, abreDrawer) {
    var canvas = el.querySelector('[data-ck="dre-canvas"]');
    var meses = (dre && dre.meses) || [];
    if (!canvas || !meses.length) {
      if (canvas) canvas.closest('.chart-container').innerHTML =
        '<p style="color:var(--text-3);font-size:12px;">Sem DRE mensal disponível.</p>';
      return;
    }
    var labels = meses.map(function (m) { return nomeMes(m.mes); });
    var rb = meses.map(function (m) { return n(m.receita_bruta); });
    var ra = meses.map(function (m) { return n(m.resultado_agencia); });
    var rl = meses.map(function (m) { return n(m.resultado_liquido); });
    canvas.setAttribute('aria-label',
      'Gráfico DRE mês a mês de ' + label + ': barras de receita bruta e resultado da agência, linha do resultado líquido. Clique em uma barra para ver a composição da receita.');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'line', label: 'Resultado Líquido', data: rl, order: 0,
            borderColor: '#22C55E', borderWidth: 2, tension: 0.3,
            pointRadius: 4, pointHoverRadius: 5,
            pointBackgroundColor: rl.map(function (v) { return v >= 0 ? '#22C55E' : '#E5484D'; }),
            pointBorderColor: rl.map(function (v) { return v >= 0 ? '#22C55E' : '#E5484D'; }),
            segment: { borderColor: function (ctx) { return (ctx.p0.parsed.y < 0 || ctx.p1.parsed.y < 0) ? '#E5484D' : '#22C55E'; } }
          },
          { label: 'Receita Bruta', data: rb, backgroundColor: '#3B82F6', borderRadius: 4, borderSkipped: false, order: 2 },
          { label: 'Res. Agência', data: ra, backgroundColor: '#D9DA00', borderRadius: 4, borderSkipped: false, order: 2 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onHover: function (evt, els) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
        },
        onClick: function (evt, els) {
          // clique em barra mensal → drawer de composição da receita
          if (els && els.length) abreDrawer();
        },
        plugins: {
          legend: legendaDark(),
          tooltip: tooltipDark({
            callbacks: {
              label: function (c) { return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y); }
            }
          })
        },
        scales: { x: eixoX(), y: eixoYMoeda() }
      }
    });
  }

  /* ── gráfico: EBIT Negócio vs Agência trimestral ─────────────── */
  function pintaTrimestral(el, tri, label) {
    var canvas = el.querySelector('[data-ck="tri-canvas"]');
    var tris = (tri && tri.tris) ? tri.tris.slice() : [];
    if (tri && tri.total && typeof tri.total === 'object') {
      tris.push(Object.assign({ tri: 'Total' }, tri.total));
    }
    if (!canvas || !tris.length) {
      if (canvas) canvas.closest('.chart-container').innerHTML =
        '<p style="color:var(--text-3);font-size:12px;">Sem DRE trimestral disponível.</p>';
      return;
    }
    var labels = tris.map(function (t) {
      var q = t.tri;
      return (typeof q === 'number' || /^\d+$/.test(String(q))) ? 'Q' + q : String(q);
    });
    // normaliza escala em conjunto (negócio + agência)
    var brutoNeg = tris.map(function (t) { return n(t.ebit_negocio_pct); });
    var brutoAg = tris.map(function (t) { return n(t.ebit_agencia_pct); });
    var juntos = pctEscalaArray(brutoNeg.concat(brutoAg));
    var vNeg = juntos.slice(0, brutoNeg.length);
    var vAg = juntos.slice(brutoNeg.length);

    canvas.setAttribute('aria-label',
      'Gráfico de barras agrupadas: percentual de EBIT Negócio versus EBIT Agência por trimestre de ' + label + ', incluindo total do ano.');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'EBIT Negócio %', data: vNeg, backgroundColor: '#3B82F6', borderRadius: 4, borderSkipped: false },
          { label: 'EBIT Agência %', data: vAg, backgroundColor: '#D9DA00', borderRadius: 4, borderSkipped: false }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 14 } }, // espaço p/ rótulos de valor
        plugins: {
          legend: legendaDark(),
          tooltip: tooltipDark({
            callbacks: { label: function (c) { return ' ' + c.dataset.label + ': ' + ptBR(c.parsed.y, 2) + '%'; } }
          })
        },
        scales: {
          x: eixoX(),
          y: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { color: '#81807C', font: { size: 10 }, callback: function (v) { return v + '%'; } },
            border: { color: 'transparent' }
          }
        }
      },
      plugins: [pluginRotulos]
    });
  }

  /* ── gráfico: comparativo histórico (últimos 3 anos) ─────────── */
  function pintaHistorico(el, historico, label) {
    var canvas = el.querySelector('[data-ck="hist-canvas"]');
    var anos = ((historico && historico.anos) || []).slice();
    if (!canvas || !anos.length) {
      if (canvas) canvas.closest('.chart-container').innerHTML =
        '<p style="color:var(--text-3);font-size:12px;">Sem histórico disponível.</p>';
      return;
    }
    anos.sort(function (a, b) { return n(a.ano) - n(b.ano); });
    anos = anos.slice(-3); // últimos 3 anos
    var labels = anos.map(function (a) { return String(a.ano); });
    var rb = anos.map(function (a) { return n(a.receita_bruta); });
    var rl = anos.map(function (a) { return n(a.resultado_liquido); });

    canvas.setAttribute('aria-label',
      'Gráfico de barras agrupadas: receita bruta e resultado líquido de ' + label + ' nos últimos ' + labels.length + ' anos (' + labels.join(', ') + ').');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Receita Bruta', data: rb, backgroundColor: '#3B82F6', borderRadius: 4, borderSkipped: false },
          {
            label: 'Resultado Líquido', data: rl, borderRadius: 4, borderSkipped: false,
            backgroundColor: rl.map(function (v) { return v >= 0 ? '#22C55E' : '#E5484D'; })
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: legendaDark(),
          tooltip: tooltipDark({
            callbacks: { label: function (c) { return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y); } }
          })
        },
        scales: { x: eixoX(), y: eixoYMoeda() }
      }
    });
  }

  /* ── registro da tela ─────────────────────────────────────────── */
  CK.registerScreen('micro', {
    title: 'Visão Micro',
    subtitle: 'DRE mês a mês · EBIT Agência vs Negócio · histórico',
    render: function (el, params) {
      destroiCharts();
      var slug = (params && params.slug) || '';
      var emp = getEmpresa(slug);
      var label = (emp && emp.label) || slug;
      var cor = (emp && emp.color) || '#D9DA00';
      var qs = qsAno();

      function abreDrawer() { abreDrawerComposicao(slug, label, qs); }

      el.innerHTML =
        // breadcrumb: Grupo REF > {empresa}
        '<nav aria-label="Breadcrumb" style="display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px;">' +
          '<a href="#/macro" style="color:var(--text-2);text-decoration:none;cursor:pointer;">Grupo REF</a>' +
          '<span style="color:var(--text-3);" aria-hidden="true">›</span>' +
          '<span style="color:' + esc(cor) + ';font-weight:600;">' + esc(label) + '</span>' +
        '</nav>' +

        '<div class="kpi-row" style="grid-template-columns:repeat(5,1fr);" data-ck="kpis">' +
          '<div class="kpi-card"><div class="kpi-label">Carregando…</div></div>' +
        '</div>' +

        '<div class="chart-card" style="margin-bottom:24px;">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">DRE Mês a Mês — ' + esc(label) + '</div>' +
            '<div class="card-subtitle">Receita Bruta · Resultado Op. Agência · Resultado Líquido — clique em um mês para a composição da receita</div>' +
          '</div><div class="chip accent" style="background:' + hexAlpha(cor, 0.12) + ';color:' + esc(cor) + ';border:1px solid ' + hexAlpha(cor, 0.3) + ';">' + esc(label) + '</div></div>' +
          '<div class="chart-container" style="height:240px;">' +
            '<canvas data-ck="dre-canvas" role="img" aria-label="Gráfico DRE mês a mês"></canvas>' +
          '</div>' +
        '</div>' +

        '<div class="grid-bot">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">% EBIT Negócio vs EBIT Agência — Trimestral</div>' +
              '<div class="card-subtitle">Comparativo de margens · Q1–Q4 + Total</div>' +
            '</div><div class="chip blue">Margens</div></div>' +
            '<div class="chart-container" style="height:220px;">' +
              '<canvas data-ck="tri-canvas" role="img" aria-label="Gráfico EBIT trimestral"></canvas>' +
            '</div>' +
          '</div>' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Comparativo Histórico — últimos 3 anos</div>' +
              '<div class="card-subtitle">Receita Bruta e Resultado Líquido por ano</div>' +
            '</div><div class="chip blue">Histórico</div></div>' +
            '<div class="chart-container" style="height:220px;">' +
              '<canvas data-ck="hist-canvas" role="img" aria-label="Gráfico comparativo histórico"></canvas>' +
            '</div>' +
          '</div>' +
        '</div>';

      // busca resiliente: cada endpoint falha de forma isolada
      function pega(p) { return CK.api(p).catch(function () { return null; }); }
      Promise.all([
        pega('/api/kpis/' + slug + qs),
        pega('/api/dre/mensal/' + slug + qs),
        pega('/api/dre/trimestral/' + slug + qs),
        pega('/api/historico/' + slug)
      ]).then(function (r) {
        if (!el.isConnected) return; // tela já foi trocada
        var kpis = r[0], dre = r[1], tri = r[2], hist = r[3];
        if (kpis) pintaKpis(el, kpis, abreDrawer);
        else el.querySelector('[data-ck="kpis"]').innerHTML =
          '<div class="kpi-card red"><div class="kpi-label">Erro</div><div class="kpi-compare">Falha ao carregar KPIs de ' + esc(label) + '.</div></div>';
        pintaDreMensal(el, dre, label, abreDrawer);
        pintaTrimestral(el, tri, label);
        pintaHistorico(el, hist, label);
      });
    }
  });

  // hex "#RRGGBB" → rgba() (usado no chip com a cor da empresa)
  function hexAlpha(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(245,200,66,' + a + ')';
    var v = parseInt(m[1], 16);
    return 'rgba(' + (v >> 16 & 255) + ',' + (v >> 8 & 255) + ',' + (v & 255) + ',' + a + ')';
  }
})();
