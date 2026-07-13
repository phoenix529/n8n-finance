/* ============================================================
 * Análise DRE — painéis da Iteração 2 (dashboard de referência)
 * Exposto como window.CKDRE.render(container, slug, ano):
 * as telas macro (slug='grupo') e micro (slug da empresa) chamam
 * após seus grids. Carregado ANTES de macro.js no index.html.
 *
 * Endpoints (contrato API_CONTRACT.md · Iteração 2):
 *   /api/dre/mensal/{slug}    → meses + realizado_ate + caixa_acum
 *   /api/cascata/{slug}       → passos da cascata financeira
 *   /api/despesas/{slug}      → meses (4 grupos) + ranking anual
 *   /api/dre/trimestral/{slug}→ tris do ano + hist (anos anteriores)
 *
 * ZERO dados hardcoded — tudo vem da API (spec §6).
 * Tema CLARO: paper #F9F8F6 · ink #1C1C1C · gray #81807C ·
 *             line #E6E3DC · accent #D9DA00 · red #E5484D.
 * ============================================================ */
(function () {
  'use strict';

  /* ── helpers numéricos / formatação (pt-BR, padrão das telas) ── */
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMoeda(v) {
    return (window.CK && CK.fmt && CK.fmt.moeda) ? CK.fmt.moeda(v) : String(v);
  }
  function fmtPercent(v, casas) {
    return (window.CK && CK.fmt && CK.fmt.percent) ? CK.fmt.percent(v, casas) : (v + '%');
  }
  function hexA(hex, a) { // "#RRGGBB" → rgba()
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(217,218,0,' + a + ')';
    var v = parseInt(m[1], 16);
    return 'rgba(' + (v >> 16 & 255) + ',' + (v >> 8 & 255) + ',' + (v & 255) + ',' + a + ')';
  }

  /* Cores do tema claro (mesma paleta do app.css) */
  var INK = '#1C1C1C', GRAY = '#81807C', GRAY_LT = '#C3C2BF',
      ACCENT = '#D9DA00', GREEN = '#22C55E', RED = '#E5484D';

  /* cores por tipo de receita (Painel 02) — ordem canônica do endpoint */
  var TIPO_CORES = {
    'Fee Mensal': INK, 'Mídia Off': ACCENT, 'Mídia On': '#3B82F6',
    'Criação': '#A855F7', 'Filmes/Spot': GREEN, 'BVS': '#F97316', 'Outras': GRAY
  };
  function corTipo(t) { return TIPO_CORES[t] || GRAY; }

  var MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  var MESES_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  function nomeMes(m) { m = n(m); return (m >= 1 && m <= 12) ? MESES[m - 1] : String(m); }

  /* eixos/tooltip do tema claro */
  function tooltipClaro(extra) {
    return Object.assign({
      backgroundColor: '#FFFFFF',
      borderColor: 'rgba(0,0,0,0.10)',
      borderWidth: 1,
      titleColor: INK,
      bodyColor: GRAY
    }, extra || {});
  }
  function fmtShortAxis(v) {
    var a = Math.abs(n(v)), s;
    if (a >= 1e9) s = (a / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'B';
    else if (a >= 1e6) s = (a / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'M';
    else if (a >= 1e3) s = (a / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + 'k';
    else s = a.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    return (n(v) < 0 ? '−' : '') + s;
  }
  function eixoX(extra) {
    return Object.assign({
      grid: { display: false },
      ticks: { color: GRAY, font: { size: 10 } },
      border: { color: 'rgba(0,0,0,0.07)' }
    }, extra || {});
  }
  // eixo Y em moeda com linha do ZERO destacada (importante p/ valores negativos)
  function eixoYMoedaZero() {
    return {
      grid: { color: function (ctx) { return ctx.tick && ctx.tick.value === 0 ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.05)'; } },
      ticks: { color: GRAY, font: { size: 10 }, callback: function (v) { return fmtShortAxis(v); } },
      border: { color: 'transparent' }
    };
  }
  function eixoYPct() {
    return {
      grid: { color: function (ctx) { return ctx.tick && ctx.tick.value === 0 ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.05)'; } },
      ticks: { color: GRAY, font: { size: 10 }, callback: function (v) { return v + '%'; } },
      border: { color: 'transparent' }
    };
  }
  function legendaClara() {
    return { position: 'bottom', labels: { color: GRAY, font: { size: 10 }, boxWidth: 10, boxHeight: 10 } };
  }

  // cria chart via CK.charts.create (track + destroy na troca de rota)
  function novoChart(canvas, cfg) {
    if (window.CK && CK.charts && typeof CK.charts.create === 'function') {
      return CK.charts.create(canvas, cfg);
    }
    return new Chart(canvas.getContext('2d'), cfg); // fallback defensivo
  }

  function vazio(el, seletor, msg) {
    var c = el.querySelector(seletor);
    if (c) {
      var wrap = c.closest('.chart-container') || c;
      wrap.innerHTML = '<p style="color:var(--text-3);font-size:12px;">' + esc(msg) + '</p>';
    }
  }

  // plugin: rótulos de % na ponta das barras horizontais (ranking de despesas)
  var pluginPctRanking = {
    id: 'ckPctRanking',
    afterDatasetsDraw: function (chart, args, opts) {
      // pcts via options.plugins.ckPctRanking (chart.config é wrapper no v4 — não expõe props custom)
      var pcts = opts && opts.pcts;
      if (!pcts) return;
      var ctx = chart.ctx, meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      meta.data.forEach(function (barra, i) {
        if (pcts[i] == null) return;
        ctx.save();
        ctx.fillStyle = INK;
        ctx.font = "600 9px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmtPercent(pcts[i], 1), barra.x + 6, barra.y);
        ctx.restore();
      });
    }
  };

  /* ══ (a) banner realizado vs projeção ══════════════════════════ */
  function pintaBanner(sec, realizadoAte, ano) {
    var b = sec.querySelector('[data-ck="dre-banner"]');
    if (!b) return;
    if (realizadoAte >= 12) { b.hidden = true; return; }
    b.hidden = false;
    if (realizadoAte <= 0) {
      b.innerHTML = '<span aria-hidden="true">◔</span> Nenhum mês realizado em ' + esc(ano) +
        ' · ano inteiro = projeção';
    } else {
      b.innerHTML = '<span aria-hidden="true">◔</span> Realizado até ' +
        esc(MESES_FULL[realizadoAte - 1]) + '/' + esc(ano) + ' · demais meses = projeção';
    }
  }

  /* ══ (b) cascata financeira do ano (waterfall) ═════════════════ */
  function pintaCascata(sec, casc, ano) {
    var canvas = sec.querySelector('[data-ck="dre-cascata"]');
    var passos = (casc && casc.passos) || [];
    if (!canvas || !passos.length) {
      vazio(sec, '[data-ck="dre-cascata"]', 'Sem dados da cascata financeira.');
      return;
    }
    // barras flutuantes: totais partem do zero; deltas empilham no acumulado
    var acum = 0, barras = [], cores = [];
    passos.forEach(function (p, i) {
      var v = n(p.valor), total = p.tipo === 'total';
      if (total) { barras.push([0, v]); acum = v; }
      else { barras.push([acum, acum + v]); acum += v; }
      if (total && i === passos.length - 1) cores.push(ACCENT);       // Resultado Líquido final
      else if (total) cores.push(INK);                                 // subtotais (RB, RL, RA, EBIT…)
      else cores.push(v < 0 ? RED : GREEN);                            // deltas
    });
    canvas.setAttribute('aria-label',
      'Cascata financeira de ' + ano + ': da receita bruta ao resultado líquido em ' + passos.length + ' passos.');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: passos.map(function (p) { return p.label; }),
        datasets: [{
          label: 'Cascata',
          data: barras,
          backgroundColor: cores,
          borderRadius: 3,
          borderSkipped: false,
          barPercentage: 0.85
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                var p = passos[c.dataIndex];
                return ' ' + (p.tipo === 'total' ? 'Total: ' : 'Variação: ') + fmtMoeda(p.valor);
              }
            }
          })
        },
        scales: {
          x: eixoX({ ticks: { color: GRAY, font: { size: 9 }, maxRotation: 60, minRotation: 45, autoSkip: false } }),
          y: eixoYMoedaZero()
        }
      }
    });
  }

  /* ══ (c) evolução mensal com projeção ══════════════════════════ */
  function pintaEvolucao(sec, meses, realizadoAte, ano) {
    var canvas = sec.querySelector('[data-ck="dre-evolucao"]');
    if (!canvas || !meses.length) {
      vazio(sec, '[data-ck="dre-evolucao"]', 'Sem DRE mensal disponível.');
      return;
    }
    var labels = meses.map(function (m) { return nomeMes(m.mes); });
    var rl = meses.map(function (m) { return n(m.receita_liquida); });
    var res = meses.map(function (m) { return n(m.resultado_liquido); });
    function ehProj(i) { return n(meses[i].mes) > realizadoAte; }

    canvas.setAttribute('aria-label',
      'Evolução mensal de ' + ano + ': barras de receita líquida e linha do resultado líquido. Meses após o realizado aparecem esmaecidos e tracejados (projeção).');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'line', label: 'Resultado Líquido', data: res, order: 0,
            borderColor: INK, borderWidth: 2, tension: 0.3,
            pointRadius: 3, pointHoverRadius: 5,
            pointBackgroundColor: res.map(function (v, i) {
              var c = v >= 0 ? INK : RED;
              return ehProj(i) ? hexA(c === INK ? '#1C1C1C' : '#E5484D', 0.45) : c;
            }),
            pointBorderColor: 'transparent',
            // trecho projetado: linha tracejada
            segment: {
              borderDash: function (ctx) { return ehProj(ctx.p1DataIndex) ? [5, 4] : undefined; },
              borderColor: function (ctx) { return ehProj(ctx.p1DataIndex) ? hexA('#1C1C1C', 0.45) : INK; }
            }
          },
          {
            label: 'Receita Líquida', data: rl, order: 2,
            backgroundColor: rl.map(function (v, i) { return ehProj(i) ? hexA('#D9DA00', 0.45) : ACCENT; }),
            borderColor: rl.map(function (v, i) { return ehProj(i) ? hexA('#81807C', 0.5) : 'transparent'; }),
            borderWidth: rl.map(function (v, i) { return ehProj(i) ? 1 : 0; }),
            borderDash: [4, 3],
            borderRadius: 4, borderSkipped: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: legendaClara(),
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y) +
                  (ehProj(c.dataIndex) ? ' (projeção)' : '');
              }
            }
          })
        },
        scales: { x: eixoX(), y: eixoYMoedaZero() }
      }
    });
  }

  /* ══ (d) variação mês a mês % (receita líquida) ════════════════ */
  function pintaVariacaoMoM(sec, meses, realizadoAte, ano) {
    var canvas = sec.querySelector('[data-ck="dre-mom"]');
    if (!canvas || meses.length < 2) {
      vazio(sec, '[data-ck="dre-mom"]', 'Sem meses suficientes para variação mensal.');
      return;
    }
    var labels = [], vals = [], proj = [];
    for (var i = 1; i < meses.length; i++) {
      var ant = n(meses[i - 1].receita_liquida), atu = n(meses[i].receita_liquida);
      labels.push(nomeMes(meses[i].mes));
      vals.push(ant === 0 ? null : (atu - ant) / Math.abs(ant) * 100); // guard div/0
      proj.push(n(meses[i].mes) > realizadoAte);
    }
    canvas.setAttribute('aria-label',
      'Variação percentual da receita líquida mês a mês em ' + ano + ': barras verdes (alta) e vermelhas (queda).');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Δ% receita líquida',
          data: vals,
          backgroundColor: vals.map(function (v, i) {
            var c = (v == null || v >= 0) ? '#22C55E' : '#E5484D';
            return proj[i] ? hexA(c, 0.45) : c;
          }),
          borderRadius: 4,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                if (c.parsed.y == null) return ' sem base de comparação';
                return ' Δ ' + fmtPercent(c.parsed.y, 1) + (proj[c.dataIndex] ? ' (projeção)' : '');
              }
            }
          })
        },
        scales: { x: eixoX(), y: eixoYPct() }
      }
    });
  }

  /* ══ (e) resumo mensal (tabela com Δ badges) ═══════════════════ */
  function badgeDelta(pct) {
    if (pct == null || !isFinite(pct)) return '<span style="color:var(--text-3);">—</span>';
    var up = pct >= 0;
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      (up ? '▲ +' : '▼ −') +
      Math.abs(pct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) +
      '%</span>';
  }
  function badgeDeltaAbs(v) {
    if (v == null || !isFinite(v)) return '<span style="color:var(--text-3);">—</span>';
    var up = v >= 0;
    return '<span class="kpi-delta ' + (up ? 'up' : 'down') + '">' +
      (up ? '▲ ' : '▼ ') + fmtMoeda(Math.abs(v)) + '</span>';
  }
  function pintaResumo(sec, meses, realizadoAte) {
    var tbody = sec.querySelector('[data-ck="dre-resumo-tbody"]');
    if (!tbody) return;
    if (!meses.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-3);">Sem DRE mensal disponível.</td></tr>';
      return;
    }
    tbody.innerHTML = meses.map(function (m, i) {
      var proj = n(m.mes) > realizadoAte;
      var recAnt = i > 0 ? n(meses[i - 1].receita_liquida) : 0;
      var dPct = (i > 0 && recAnt !== 0) ? (n(m.receita_liquida) - recAnt) / Math.abs(recAnt) * 100 : null;
      var dRes = i > 0 ? n(m.resultado_liquido) - n(meses[i - 1].resultado_liquido) : null;
      return '<tr class="' + (proj ? 'proj' : '') + '">' +
        '<td style="font-weight:600;color:var(--text-1)">' + esc(nomeMes(m.mes)) +
          (proj ? ' <span class="tag-proj">proj</span>' : '') + '</td>' +
        '<td class="mono right">' + fmtMoeda(m.receita_liquida) + '</td>' +
        '<td class="right">' + badgeDelta(dPct) + '</td>' +
        '<td class="mono right"' + (n(m.resultado_liquido) < 0 ? ' style="color:var(--red)"' : '') + '>' +
          fmtMoeda(m.resultado_liquido) + '</td>' +
        '<td class="right">' + badgeDeltaAbs(dRes) + '</td>' +
        '<td class="mono right"' + (n(m.caixa_acum) < 0 ? ' style="color:var(--red)"' : '') + '>' +
          fmtMoeda(m.caixa_acum) + '</td>' +
      '</tr>';
    }).join('');
  }

  /* ══ (f) geração de caixa acumulada (área) ═════════════════════ */
  function pintaCaixa(sec, meses, realizadoAte, ano) {
    var canvas = sec.querySelector('[data-ck="dre-caixa"]');
    if (!canvas || !meses.length) {
      vazio(sec, '[data-ck="dre-caixa"]', 'Sem dados de caixa acumulado.');
      return;
    }
    var labels = meses.map(function (m) { return nomeMes(m.mes); });
    var caixa = meses.map(function (m) { return n(m.caixa_acum); });
    function ehProj(i) { return n(meses[i].mes) > realizadoAte; }

    canvas.setAttribute('aria-label',
      'Geração de caixa acumulada em ' + ano + ': área do resultado líquido acumulado mês a mês, com linha do zero visível.');

    novoChart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Caixa acumulado',
          data: caixa,
          borderColor: INK,
          borderWidth: 2,
          tension: 0.3,
          fill: 'origin',
          backgroundColor: hexA('#1C1C1C', 0.15),
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: caixa.map(function (v, i) {
            var c = v >= 0 ? '#1C1C1C' : '#E5484D';
            return ehProj(i) ? hexA(c, 0.45) : (v >= 0 ? INK : RED);
          }),
          pointBorderColor: 'transparent',
          segment: {
            borderDash: function (ctx) { return ehProj(ctx.p1DataIndex) ? [5, 4] : undefined; },
            borderColor: function (ctx) { return ehProj(ctx.p1DataIndex) ? hexA('#1C1C1C', 0.45) : INK; }
          }
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                return ' Caixa acumulado: ' + fmtMoeda(c.parsed.y) +
                  (ehProj(c.dataIndex) ? ' (projeção)' : '');
              }
            }
          })
        },
        scales: { x: eixoX(), y: eixoYMoedaZero() }
      }
    });
  }

  /* ══ (g) trimestres: ano atual vs histórico (2 gráficos) ═══════ */
  function pintaTrimestres(sec, tri, ano) {
    var tris = (tri && tri.tris) || [];
    var hist = ((tri && tri.hist) || []).slice().sort(function (a, b) { return n(a.ano) - n(b.ano); });

    // série por métrica: mapeia tri 1..4 → valor (null se ausente, ex. Zup sem 2024)
    function serie(listaTris, campo) {
      var out = [null, null, null, null];
      (listaTris || []).forEach(function (t) {
        var q = n(t.tri);
        if (q >= 1 && q <= 4) out[q - 1] = t[campo] == null ? null : n(t[campo]);
      });
      return out;
    }
    // cores: anos antigos em cinzas, ano atual em amarelo REF
    function corAno(idx, total) {
      if (idx === total - 1) return ACCENT;           // ano atual
      return (total - 1 - idx) % 2 === 1 ? GRAY : GRAY_LT; // alterna cinzas p/ trás
    }

    [['dre-tri-rb', 'receita_bruta', 'Receita bruta por trimestre'],
     ['dre-tri-rl', 'resultado_liquido', 'Resultado líquido por trimestre']].forEach(function (spec) {
      var canvas = sec.querySelector('[data-ck="' + spec[0] + '"]');
      if (!canvas) return;
      if (!tris.length && !hist.length) {
        vazio(sec, '[data-ck="' + spec[0] + '"]', 'Sem dados trimestrais.');
        return;
      }
      var anosSeries = hist.map(function (h) { return { ano: h.ano, tris: h.tris }; })
        .concat(tris.length ? [{ ano: (tri && tri.ano) || ano, tris: tris }] : []);
      var datasets = anosSeries.map(function (s, i) {
        return {
          label: String(s.ano),
          data: serie(s.tris, spec[1]),
          backgroundColor: corAno(i, anosSeries.length),
          borderRadius: 4,
          borderSkipped: false
        };
      });
      canvas.setAttribute('aria-label',
        spec[2] + ': barras agrupadas comparando ' + anosSeries.map(function (s) { return s.ano; }).join(', ') + '.');

      novoChart(canvas, {
        type: 'bar',
        data: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: legendaClara(),
            tooltip: tooltipClaro({
              callbacks: {
                label: function (c) { return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y); }
              }
            })
          },
          scales: { x: eixoX(), y: eixoYMoedaZero() }
        }
      });
    });
  }

  /* ══ (h) margem operacional da agência mensal ══════════════════ */
  function pintaMargem(sec, meses, realizadoAte, ano) {
    var canvas = sec.querySelector('[data-ck="dre-margem"]');
    if (!canvas || !meses.length) {
      vazio(sec, '[data-ck="dre-margem"]', 'Sem DRE mensal disponível.');
      return;
    }
    var labels = meses.map(function (m) { return nomeMes(m.mes); });
    var margem = meses.map(function (m) {
      var rb = n(m.receita_bruta);
      return rb === 0 ? null : n(m.resultado_agencia) / rb * 100; // guard div/0
    });
    function ehProj(i) { return n(meses[i].mes) > realizadoAte; }

    canvas.setAttribute('aria-label',
      'Margem operacional da agência mês a mês em ' + ano + ': resultado operacional da agência dividido pela receita bruta, em percentual.');

    novoChart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Margem agência %',
          data: margem,
          borderColor: '#3B82F6',
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: margem.map(function (v, i) {
            var c = (v != null && v < 0) ? '#E5484D' : '#3B82F6';
            return ehProj(i) ? hexA(c, 0.45) : c;
          }),
          pointBorderColor: 'transparent',
          spanGaps: true,
          segment: {
            borderDash: function (ctx) { return ehProj(ctx.p1DataIndex) ? [5, 4] : undefined; },
            borderColor: function (ctx) { return ehProj(ctx.p1DataIndex) ? hexA('#3B82F6', 0.45) : '#3B82F6'; }
          }
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                if (c.parsed.y == null) return ' sem receita no mês';
                return ' Margem agência: ' + fmtPercent(c.parsed.y, 1) +
                  (ehProj(c.dataIndex) ? ' (projeção)' : '');
              }
            }
          })
        },
        scales: { x: eixoX(), y: eixoYPct() }
      }
    });
  }

  /* ══ (i) composição das despesas + ranking ═════════════════════ */
  function pintaDespesas(sec, desp, realizadoAte, ano) {
    // 'administrativas' NÃO entra: é item de DETALHE já contido nos totais
    // (DRE fecha sem ele — ver nota em ia/api_cockpit.py); empilhar duplicaria.
    var GRUPOS = [
      { campo: 'pessoal',         label: 'Pessoal',        cor: INK },
      { campo: 'infra',           label: 'Infraestrutura', cor: GRAY },
      { campo: 'outras',          label: 'Outras',         cor: ACCENT }
    ];

    // stacked bars mensais
    var canvas = sec.querySelector('[data-ck="dre-despesas"]');
    var meses = (desp && desp.meses) || [];
    if (canvas && meses.length) {
      var labels = meses.map(function (m) { return nomeMes(m.mes); });
      function ehProj(i) { return n(meses[i].mes) > realizadoAte; }
      canvas.setAttribute('aria-label',
        'Composição das despesas operacionais por mês em ' + ano + ': barras empilhadas de pessoal, infraestrutura e outras despesas.');
      novoChart(canvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: GRUPOS.map(function (g) {
            return {
              label: g.label,
              data: meses.map(function (m) { return Math.abs(n(m[g.campo])); }),
              backgroundColor: meses.map(function (m, i) { return ehProj(i) ? hexA(g.cor, 0.45) : g.cor; }),
              borderRadius: 2,
              borderSkipped: false
            };
          })
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: legendaClara(),
            tooltip: tooltipClaro({
              callbacks: {
                label: function (c) {
                  return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y) +
                    (ehProj(c.dataIndex) ? ' (projeção)' : '');
                }
              }
            })
          },
          scales: {
            x: eixoX({ stacked: true }),
            y: Object.assign(eixoYMoedaZero(), { stacked: true })
          }
        }
      });
    } else {
      vazio(sec, '[data-ck="dre-despesas"]', 'Sem despesas mensais disponíveis.');
    }

    // ranking horizontal (endpoint já devolve só o período que interessa)
    var canvasRk = sec.querySelector('[data-ck="dre-ranking"]');
    var ranking = (desp && desp.ranking) || [];
    if (!canvasRk || !ranking.length) {
      vazio(sec, '[data-ck="dre-ranking"]', 'Sem ranking de despesas disponível.');
      return;
    }
    canvasRk.setAttribute('aria-label',
      'Ranking das despesas operacionais de ' + ano + ': barras horizontais por conta, com participação percentual.');
    var cfgRk = {
      type: 'bar',
      data: {
        labels: ranking.map(function (r) { return r.conta; }),
        datasets: [{
          label: 'Total no ano',
          data: ranking.map(function (r) { return Math.abs(n(r.total)); }),
          backgroundColor: ranking.map(function (r, i) { return i === 0 ? INK : GRAY; }),
          borderRadius: 4,
          borderSkipped: false,
          barPercentage: 0.7
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 46 } }, // espaço p/ rótulo de %
        plugins: {
          legend: { display: false },
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                var r = ranking[c.dataIndex];
                return ' ' + fmtMoeda(r.total) + ' · ' + fmtPercent(r.pct, 1) + ' do total';
              }
            }
          })
        },
        scales: {
          x: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { color: GRAY, font: { size: 10 }, callback: function (v) { return fmtShortAxis(v); } },
            border: { color: 'transparent' }
          },
          y: {
            grid: { display: false },
            ticks: { color: '#55544F', font: { size: 10 } },
            border: { color: 'rgba(0,0,0,0.07)' }
          }
        }
      },
      plugins: [pluginPctRanking]
    };
    cfgRk.options.plugins.ckPctRanking = {
      pcts: ranking.map(function (r) { return r.pct == null ? null : n(r.pct); }) };
    novoChart(canvasRk, cfgRk);
  }

  /* ══ (j) Painel 02 — distribuição da receita bruta por tipo ════ */
  // plugin: rótulos de % no interior das fatias do donut (mix anual)
  var pluginPctDonut = {
    id: 'ckPctDonut',
    afterDatasetsDraw: function (chart, args, opts) {
      var pcts = opts && opts.pcts;
      if (!pcts) return;
      var ctx = chart.ctx, meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      meta.data.forEach(function (arco, i) {
        if (pcts[i] == null || n(pcts[i]) < 6) return; // esconde rótulo de fatias mínimas
        var pos = arco.tooltipPosition();
        ctx.save();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = "700 10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmtPercent(pcts[i], 0), pos.x, pos.y);
        ctx.restore();
      });
    }
  };

  function pintaReceitaTipo(sec, rt, realizadoAte, ano) {
    var tipos = (rt && rt.tipos) || [];
    var meses = (rt && rt.meses) || [];
    var mix = (rt && rt.mix) || [];
    var totalGeral = mix.reduce(function (s, m) { return s + Math.abs(n(m.total)); }, 0);

    /* (a) barras EMPILHADAS 12 meses — uma série por tipo canônico */
    var canvas = sec.querySelector('[data-ck="rt-stack"]');
    if (canvas && meses.length && totalGeral > 0) {
      var labels = meses.map(function (m) { return nomeMes(m.mes); });
      function ehProj(i) { return n(meses[i].mes) > realizadoAte; }
      canvas.setAttribute('aria-label',
        'Distribuição da receita bruta por tipo, mês a mês em ' + ano +
        ': barras empilhadas com uma faixa por tipo de receita. Meses após o realizado aparecem esmaecidos (projeção).');
      novoChart(canvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: tipos.map(function (t) {
            var cor = corTipo(t);
            return {
              label: t,
              data: meses.map(function (m) { return Math.abs(n(m[t])); }),
              backgroundColor: meses.map(function (m, i) { return ehProj(i) ? hexA(cor, 0.45) : cor; }),
              borderRadius: 2,
              borderSkipped: false
            };
          })
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: legendaClara(),
            tooltip: tooltipClaro({
              callbacks: {
                label: function (c) {
                  return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y) +
                    (ehProj(c.dataIndex) ? ' (projeção)' : '');
                }
              }
            })
          },
          scales: {
            x: eixoX({ stacked: true }),
            y: Object.assign(eixoYMoedaZero(), { stacked: true })
          }
        }
      });
    } else {
      vazio(sec, '[data-ck="rt-stack"]', 'Sem receita por tipo carregada.');
    }

    /* (b) donut do mix anual + legenda com % */
    var canvasD = sec.querySelector('[data-ck="rt-donut"]');
    var leg = sec.querySelector('[data-ck="rt-legend"]');
    if (canvasD && mix.length && totalGeral > 0) {
      var pcts = mix.map(function (m) { return n(m.pct); });
      canvasD.setAttribute('aria-label',
        'Donut da participação de cada tipo de receita no total do ano ' + ano + ', com percentuais.');
      var cfgD = {
        type: 'doughnut',
        data: {
          labels: mix.map(function (m) { return m.tipo; }),
          datasets: [{
            data: mix.map(function (m) { return Math.abs(n(m.total)); }),
            backgroundColor: mix.map(function (m) { return corTipo(m.tipo); }),
            borderColor: '#FFFFFF',
            borderWidth: 3,
            hoverBorderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: { display: false },
            tooltip: tooltipClaro({
              callbacks: {
                label: function (c) {
                  return ' ' + fmtMoeda(c.parsed) + ' (' + fmtPercent(pcts[c.dataIndex], 1) + ')';
                }
              }
            })
          }
        },
        plugins: [pluginPctDonut]
      };
      cfgD.options.plugins.ckPctDonut = { pcts: pcts };
      novoChart(canvasD, cfgD);

      if (leg) {
        leg.innerHTML = mix.map(function (m) {
          return '<div class="legend-row">' +
            '<div class="legend-left">' +
              '<div class="legend-dot" style="background:' + esc(corTipo(m.tipo)) + '"></div>' +
              '<div><div class="legend-name">' + esc(m.tipo) + '</div>' +
              '<div class="legend-pct">' + fmtPercent(m.pct, 1) + ' do total</div></div>' +
            '</div>' +
            '<div class="legend-val">' + fmtMoeda(m.total) + '</div>' +
          '</div>';
        }).join('');
      }
    } else {
      vazio(sec, '[data-ck="rt-donut"]', 'Sem mix de receita disponível.');
      if (leg) leg.innerHTML = '';
    }
  }

  /* ══ tira de callouts (estatísticas de apoio sob o gráfico) ════ */
  function calloutStrip(items) {
    return '<div class="ckdre-callouts" style="display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">' +
      items.map(function (it) {
        return '<div><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;">' + esc(it.label) + '</div>' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:15px;font-weight:600;color:' + (it.cor || 'var(--text-1)') + ';">' + it.value + '</div></div>';
      }).join('') +
    '</div>';
  }

  // pct de fees já vem 0–100; normaliza se vier em fração (0–1)
  function normPct(arr) {
    var soma = arr.reduce(function (s, v) { return s + Math.abs(n(v)); }, 0);
    var f = (soma > 0 && soma <= 1.5) ? 100 : 1;
    return arr.map(function (v) { return n(v) * f; });
  }

  // plugin: guias horizontais de risco (30% / 50%) sobre um eixo % (ex.: y1 do Pareto)
  var pluginGuias = {
    id: 'ckGuias',
    afterDatasetsDraw: function (chart, args, opts) {
      var vals = opts && opts.valores;
      if (!vals) return;
      var sc = chart.scales[(opts && opts.scaleId) || 'y1'];
      if (!sc) return;
      var ctx = chart.ctx, area = chart.chartArea;
      vals.forEach(function (v) {
        var y = sc.getPixelForValue(v);
        if (y < area.top || y > area.bottom) return;
        ctx.save();
        ctx.strokeStyle = hexA('#E5484D', 0.5);
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.right, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = hexA('#E5484D', 0.9);
        ctx.font = "600 9px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(v + '%', area.left + 4, y - 2);
        ctx.restore();
      });
    }
  };

  /* ══ Painel 03 — despesas com pessoal (R$ + % da receita) ══════ */
  function pintaPessoal(sec, meses, realizadoAte, ano, kpis) {
    var box = sec.querySelector('[data-ck="dre-pessoal-callouts"]');
    var canvas = sec.querySelector('[data-ck="dre-pessoal"]');
    if (!canvas || !meses.length) {
      vazio(sec, '[data-ck="dre-pessoal"]', 'Sem DRE mensal disponível.');
      if (box) box.innerHTML = '';
      return;
    }
    var labels = meses.map(function (m) { return nomeMes(m.mes); });
    var pessoal = meses.map(function (m) { return Math.abs(n(m.pessoal)); });
    var pct = meses.map(function (m) { var rb = n(m.receita_bruta); return rb === 0 ? null : Math.abs(n(m.pessoal)) / rb * 100; });
    function ehProj(i) { return n(meses[i].mes) > realizadoAte; }

    canvas.setAttribute('aria-label',
      'Despesas com pessoal por mês em ' + ano + ': barras em reais e linha do percentual sobre a receita bruta (eixo à direita). Meses após o realizado aparecem esmaecidos (projeção).');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'line', label: '% da receita bruta', data: pct, yAxisID: 'y1', order: 0,
            borderColor: '#3B82F6', borderWidth: 2, tension: 0.3, spanGaps: true,
            pointRadius: 3, pointHoverRadius: 5,
            pointBackgroundColor: pct.map(function (v, i) { return ehProj(i) ? hexA('#3B82F6', 0.45) : '#3B82F6'; }),
            pointBorderColor: 'transparent',
            segment: {
              borderDash: function (ctx) { return ehProj(ctx.p1DataIndex) ? [5, 4] : undefined; },
              borderColor: function (ctx) { return ehProj(ctx.p1DataIndex) ? hexA('#3B82F6', 0.45) : '#3B82F6'; }
            }
          },
          {
            label: 'Despesa com pessoal', data: pessoal, yAxisID: 'y', order: 2,
            backgroundColor: pessoal.map(function (v, i) { return ehProj(i) ? hexA('#1C1C1C', 0.35) : INK; }),
            borderRadius: 4, borderSkipped: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: legendaClara(),
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                var proj = ehProj(c.dataIndex) ? ' (projeção)' : '';
                if (c.dataset.yAxisID === 'y1') return ' ' + (c.parsed.y == null ? 'sem receita no mês' : fmtPercent(c.parsed.y, 1)) + proj;
                return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.y) + proj;
              }
            }
          })
        },
        scales: {
          x: eixoX(),
          y: eixoYMoedaZero(),
          y1: Object.assign(eixoYPct(), { position: 'right', grid: { drawOnChartArea: false } })
        }
      }
    });

    // callouts: custo pessoal 1º semestre (realizado) · % médio (realizado) · headcount
    var custo1sem = 0, somaPct = 0, cntPct = 0;
    meses.forEach(function (m) { var mm = n(m.mes); if (mm <= 6 && mm <= realizadoAte) custo1sem += Math.abs(n(m.pessoal)); });
    pct.forEach(function (v, i) { if (v != null && !ehProj(i)) { somaPct += v; cntPct++; } });
    var pctMedio = cntPct ? somaPct / cntPct : null;
    var headcount = (kpis && kpis.headcount != null) ? n(kpis.headcount) : null;
    if (box) box.innerHTML = calloutStrip([
      { label: 'Custo pessoal · 1º sem.', value: fmtMoeda(custo1sem || 0) },
      { label: '% médio s/ receita', value: pctMedio != null ? fmtPercent(pctMedio, 1) : '—' },
      { label: 'Headcount', value: headcount != null ? headcount.toLocaleString('pt-BR') : '—' }
    ]);
  }

  /* ══ Painel 09 — evolução do EBIT (mensal + anual) ═════════════ */
  function linhaEbit(label, data, cor, ehProj) {
    return {
      label: label, data: data, borderColor: cor, backgroundColor: cor,
      borderWidth: 2, tension: 0.3, spanGaps: true,
      pointRadius: 3, pointHoverRadius: 5,
      pointBackgroundColor: data.map(function (v, i) { return ehProj(i) ? hexA(cor, 0.45) : cor; }),
      pointBorderColor: 'transparent',
      segment: {
        borderDash: function (ctx) { return ehProj(ctx.p1DataIndex) ? [5, 4] : undefined; },
        borderColor: function (ctx) { return ehProj(ctx.p1DataIndex) ? hexA(cor, 0.45) : cor; }
      }
    };
  }
  function pintaEbitEvolucao(sec, meses, realizadoAte, ano, historico) {
    /* (A) mensal: EBIT Negócio (ebit/receita_bruta) × EBIT Agência (ebit/resultado_agencia) */
    var cM = sec.querySelector('[data-ck="dre-ebit-mensal"]');
    var boxM = sec.querySelector('[data-ck="dre-ebit-callouts"]');
    if (cM && meses.length) {
      var labels = meses.map(function (m) { return nomeMes(m.mes); });
      var neg = meses.map(function (m) { var rb = n(m.receita_bruta); return rb === 0 ? null : n(m.ebit) / rb * 100; });
      var ag = meses.map(function (m) { var ra = n(m.resultado_agencia); return ra === 0 ? null : n(m.ebit) / ra * 100; });
      function ehProj(i) { return n(meses[i].mes) > realizadoAte; }
      cM.setAttribute('aria-label',
        'Evolução mensal do EBIT em ' + ano + ': linha do EBIT Negócio (sobre a receita bruta) e linha do EBIT Agência (sobre o resultado da agência). Projeção esmaecida e tracejada.');
      novoChart(cM, {
        type: 'line',
        data: { labels: labels, datasets: [
          linhaEbit('EBIT Negócio', neg, '#3B82F6', ehProj),
          linhaEbit('EBIT Agência', ag, ACCENT, ehProj)
        ] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: legendaClara(),
            tooltip: tooltipClaro({
              callbacks: {
                label: function (c) {
                  return ' ' + c.dataset.label + ': ' + (c.parsed.y == null ? 'n/d' : fmtPercent(c.parsed.y, 1)) +
                    (ehProj(c.dataIndex) ? ' (projeção)' : '');
                }
              }
            })
          },
          scales: { x: eixoX(), y: eixoYPct() }
        }
      });
      // callouts: melhor/pior mês do EBIT Negócio (só realizado)
      var best = null, worst = null;
      neg.forEach(function (v, i) {
        if (v == null || ehProj(i)) return;
        if (best == null || v > neg[best]) best = i;
        if (worst == null || v < neg[worst]) worst = i;
      });
      if (boxM) boxM.innerHTML = calloutStrip([
        { label: 'Melhor mês (Negócio)', value: best != null ? nomeMes(meses[best].mes) + ' · ' + fmtPercent(neg[best], 1) : '—', cor: 'var(--green)' },
        { label: 'Pior mês (Negócio)', value: worst != null ? nomeMes(meses[worst].mes) + ' · ' + fmtPercent(neg[worst], 1) : '—', cor: 'var(--red)' }
      ]);
    } else {
      vazio(sec, '[data-ck="dre-ebit-mensal"]', 'Sem DRE mensal disponível.');
      if (boxM) boxM.innerHTML = '';
    }

    /* (B) anual: histórico ebit_pct (Negócio) × ebit_agencia_pct (Agência) */
    var cA = sec.querySelector('[data-ck="dre-ebit-anual"]');
    var anos = ((historico && historico.anos) || []).slice().sort(function (a, b) { return n(a.ano) - n(b.ano); });
    if (cA && anos.length) {
      var labA = anos.map(function (a) { return String(a.ano); });
      var negA = anos.map(function (a) { return a.ebit_pct == null ? null : n(a.ebit_pct); });
      var agA = anos.map(function (a) { return a.ebit_agencia_pct == null ? null : n(a.ebit_agencia_pct); });
      cA.setAttribute('aria-label',
        'Evolução anual do EBIT: linha do EBIT Negócio e linha do EBIT Agência por ano, de ' + labA[0] + ' a ' + labA[labA.length - 1] + '.');
      novoChart(cA, {
        type: 'line',
        data: { labels: labA, datasets: [
          { label: 'EBIT Negócio', data: negA, borderColor: '#3B82F6', backgroundColor: '#3B82F6', borderWidth: 2, tension: 0.3, spanGaps: true, pointRadius: 3, pointHoverRadius: 5, pointBorderColor: 'transparent' },
          { label: 'EBIT Agência', data: agA, borderColor: ACCENT, backgroundColor: ACCENT, borderWidth: 2, tension: 0.3, spanGaps: true, pointRadius: 3, pointHoverRadius: 5, pointBorderColor: 'transparent' }
        ] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: legendaClara(),
            tooltip: tooltipClaro({
              callbacks: { label: function (c) { return ' ' + c.dataset.label + ': ' + (c.parsed.y == null ? 'n/d' : fmtPercent(c.parsed.y, 1)); } }
            })
          },
          scales: { x: eixoX(), y: eixoYPct() }
        }
      });
    } else {
      vazio(sec, '[data-ck="dre-ebit-anual"]', 'Sem histórico anual disponível.');
    }
  }

  /* ══ Painel 10 — concentração de receita por cliente (Pareto) ══ */
  function pintaPareto(sec, fees, ano) {
    var box = sec.querySelector('[data-ck="dre-pareto-callouts"]');
    var canvas = sec.querySelector('[data-ck="dre-pareto"]');
    var clientes = ((fees && fees.clientes) || []).slice()
      .sort(function (a, b) { return Math.abs(n(b.fee_anual)) - Math.abs(n(a.fee_anual)); });
    if (!canvas || !clientes.length) {
      vazio(sec, '[data-ck="dre-pareto"]', 'Sem fees por cliente carregados.');
      if (box) box.innerHTML = '';
      return;
    }
    var TOP = 20; // limita exibição p/ legibilidade; callouts usam a curva completa
    var mostra = clientes.slice(0, TOP);
    var labels = mostra.map(function (c) { return c.cliente; });
    var vals = mostra.map(function (c) { return Math.abs(n(c.fee_anual)); });
    var pctInd = normPct(clientes.map(function (c) { return c.pct; }));
    var temAcum = clientes.some(function (c) { return c.pct_acum != null; });
    var acumFull;
    if (temAcum) acumFull = normPct(clientes.map(function (c) { return c.pct_acum; }));
    else { var s = 0; acumFull = pctInd.map(function (v) { s += v; return s; }); }
    var acum = acumFull.slice(0, TOP);

    canvas.setAttribute('aria-label',
      'Pareto da concentração de receita por cliente em ' + ano + ': barras do fee anual em ordem decrescente e linha do percentual acumulado, com guias de risco em 30% e 50%.');

    var cfg = {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'line', label: '% acumulado', data: acum, yAxisID: 'y1', order: 0,
            borderColor: '#3B82F6', borderWidth: 2, tension: 0.25,
            pointRadius: 2, pointHoverRadius: 4, pointBorderColor: 'transparent', pointBackgroundColor: '#3B82F6'
          },
          {
            label: 'Fee anual', data: vals, yAxisID: 'y', order: 2,
            backgroundColor: mostra.map(function (c, i) { return i === 0 ? INK : (pctInd[i] >= 30 ? RED : GRAY); }),
            borderRadius: 4, borderSkipped: false, barPercentage: 0.85
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: legendaClara(),
          tooltip: tooltipClaro({
            callbacks: {
              label: function (c) {
                if (c.dataset.yAxisID === 'y1') return ' acumulado: ' + fmtPercent(c.parsed.y, 1);
                return ' ' + fmtMoeda(c.parsed.y) + ' · ' + fmtPercent(pctInd[c.dataIndex], 1) + ' do total';
              }
            }
          })
        },
        scales: {
          x: eixoX({ ticks: { color: GRAY, font: { size: 9 }, maxRotation: 60, minRotation: 45, autoSkip: false } }),
          y: eixoYMoedaZero(),
          y1: Object.assign(eixoYPct(), { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false } })
        }
      },
      plugins: [pluginGuias]
    };
    cfg.options.plugins.ckGuias = { scaleId: 'y1', valores: [30, 50] };
    novoChart(canvas, cfg);

    // callouts: Top-3 % · Top-5 % · cauda · aviso se cliente único > 30%
    var top3 = acumFull[Math.min(2, acumFull.length - 1)];
    var top5 = acumFull[Math.min(4, acumFull.length - 1)];
    var cauda = Math.max(0, 100 - top5);
    var itens = [
      { label: 'Top 3 clientes', value: fmtPercent(top3, 1) },
      { label: 'Top 5 clientes', value: fmtPercent(top5, 1) },
      { label: 'Cauda (demais)', value: fmtPercent(cauda, 1) }
    ];
    if (pctInd[0] >= 30) itens.push({ label: '⚠ Concentração', value: esc(clientes[0].cliente) + ' > 30%', cor: 'var(--red)' });
    if (box) box.innerHTML = calloutStrip(itens);
  }

  /* ══ esqueleto da seção ════════════════════════════════════════ */
  function cardChart(titulo, subtitulo, dataCk, altura, chip) {
    return '<div class="chart-card">' +
      '<div class="card-header"><div>' +
        '<div class="card-title">' + esc(titulo) + '</div>' +
        '<div class="card-subtitle">' + esc(subtitulo) + '</div>' +
      '</div>' + (chip ? '<div class="chip accent">' + esc(chip) + '</div>' : '') + '</div>' +
      '<div class="chart-container" style="height:' + (altura || 220) + 'px;">' +
        '<canvas data-ck="' + dataCk + '" role="img" aria-label="' + esc(titulo) + '"></canvas>' +
      '</div>' +
    '</div>';
  }

  /* ══ API pública: CKDRE.render(container, slug, ano) ═══════════ */
  window.CKDRE = {
    render: function (container, slug, ano) {
      if (!container) return;
      var qs = ano ? ('?ano=' + encodeURIComponent(ano)) : '';

      var sec = document.createElement('section');
      sec.className = 'ckdre';
      sec.setAttribute('aria-label', 'Análise DRE');
      sec.innerHTML =
        '<div class="ckdre-sec-title"><span class="dot" aria-hidden="true"></span>Análise DRE' +
          '<span class="ckdre-banner" data-ck="dre-banner" hidden></span></div>' +

        // (b) cascata — largura cheia
        cardChart('Cascata financeira do ano',
          'Da receita bruta ao resultado líquido — totais em preto, quedas em vermelho, ganhos em verde',
          'dre-cascata', 280, 'Waterfall') +

        // (c) evolução + (d) variação MoM
        '<div class="ckdre-grid2">' +
          cardChart('Evolução mensal com projeção',
            'Receita líquida (barras) e resultado líquido (linha) — projeção esmaecida/tracejada',
            'dre-evolucao', 240) +
          cardChart('Variação mês a mês (%)',
            'Δ% da receita líquida vs. mês anterior',
            'dre-mom', 240) +
        '</div>' +

        // (e) resumo mensal + (f) caixa acumulado
        '<div class="ckdre-grid2">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Resumo mensal e Δ vs. mês anterior</div>' +
              '<div class="card-subtitle">Receita líquida · resultado líquido · caixa acumulado</div>' +
            '</div></div>' +
            '<div style="overflow-x:auto;">' +
            '<table class="data-table" aria-label="Resumo mensal: receita líquida, variação percentual, resultado líquido, variação absoluta e caixa acumulado">' +
              '<thead><tr><th>Mês</th><th class="right">Rec. Líquida</th><th class="right">Δ%</th>' +
              '<th class="right">Resultado Líq.</th><th class="right">Δ</th><th class="right">Caixa Acum.</th></tr></thead>' +
              '<tbody data-ck="dre-resumo-tbody"><tr><td colspan="6" style="color:var(--text-3)">Carregando…</td></tr></tbody>' +
            '</table></div>' +
          '</div>' +
          cardChart('Geração de caixa acumulada',
            'Resultado líquido acumulado no ano — linha do zero em destaque',
            'dre-caixa', 260) +
        '</div>' +

        // (g) trimestres atual vs histórico
        '<div class="ckdre-grid2">' +
          cardChart('Receita bruta por trimestre',
            'Ano atual (amarelo) vs. anos anteriores (cinzas)',
            'dre-tri-rb', 220) +
          cardChart('Resultado líquido por trimestre',
            'Ano atual (amarelo) vs. anos anteriores (cinzas)',
            'dre-tri-rl', 220) +
        '</div>' +

        // (h) margem + (i) composição despesas
        '<div class="ckdre-grid2">' +
          cardChart('Margem operacional da agência',
            'Resultado operacional da agência / receita bruta, mês a mês',
            'dre-margem', 220) +
          cardChart('Composição das despesas operacionais',
            'Pessoal · Infraestrutura · Outras · Administrativas (barras empilhadas)',
            'dre-despesas', 220) +
        '</div>' +

        // (i) ranking — largura cheia
        cardChart('Ranking das despesas operacionais',
          'Somatório por conta no período realizado · participação % sobre o total',
          'dre-ranking', 240) +

        // (j) Painel 02 — distribuição da receita bruta por tipo (mix)
        '<div class="ckdre-sec-title" style="margin-top:20px;"><span class="dot" aria-hidden="true"></span>Distribuição da receita por tipo</div>' +
        '<div class="chart-card" style="margin-bottom:6px;">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Mix de receita bruta por tipo</div>' +
            '<div class="card-subtitle">Empilhado por mês (esquerda) e participação anual (direita) — meses após o realizado esmaecidos (projeção)</div>' +
          '</div><div class="chip accent">Painel 02</div></div>' +
          '<div class="ckdre-grid2" style="align-items:start;">' +
            '<div class="chart-container" style="height:300px;">' +
              '<canvas data-ck="rt-stack" role="img" aria-label="Receita bruta por tipo, mês a mês"></canvas>' +
            '</div>' +
            '<div>' +
              '<div class="chart-container" style="height:220px;">' +
                '<canvas data-ck="rt-donut" role="img" aria-label="Mix anual de receita por tipo"></canvas>' +
              '</div>' +
              '<div class="donut-legend" data-ck="rt-legend"></div>' +
            '</div>' +
          '</div>' +
          '<p style="color:var(--text-3);font-size:11px;margin:10px 4px 2px;">rollup do Grupo: regra padrão — confirmar categorias com o cliente.</p>' +
        '</div>' +

        // ── Painéis de refino (03 · 09 · 10) ──────────────────────
        '<div class="ckdre-sec-title" style="margin-top:20px;"><span class="dot" aria-hidden="true"></span>Pessoal, rentabilidade e concentração</div>' +

        // Painel 03 — despesas com pessoal (R$ + % da receita)
        '<div class="chart-card">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Despesas com pessoal — R$ e % da receita</div>' +
            '<div class="card-subtitle">Custo mensal (barras) e peso sobre a receita bruta (linha, eixo à direita) — projeção esmaecida</div>' +
          '</div><div class="chip accent">Painel 03</div></div>' +
          '<div class="chart-container" style="height:260px;">' +
            '<canvas data-ck="dre-pessoal" role="img" aria-label="Despesas com pessoal em reais e percentual da receita bruta"></canvas>' +
          '</div>' +
          '<div data-ck="dre-pessoal-callouts"></div>' +
        '</div>' +

        // Painel 09 — evolução do EBIT (mensal + anual)
        '<div class="chart-card" style="margin-bottom:6px;">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Evolução do EBIT — Negócio × Agência</div>' +
            '<div class="card-subtitle">Mensal (esquerda) e anual (direita) — % do EBIT sobre a receita bruta (Negócio) e sobre o resultado da agência (Agência)</div>' +
          '</div><div class="chip accent">Painel 09</div></div>' +
          '<div class="ckdre-grid2" style="align-items:start;">' +
            '<div>' +
              '<div class="chart-container" style="height:240px;">' +
                '<canvas data-ck="dre-ebit-mensal" role="img" aria-label="EBIT mensal Negócio versus Agência"></canvas>' +
              '</div>' +
              '<div data-ck="dre-ebit-callouts"></div>' +
            '</div>' +
            '<div class="chart-container" style="height:240px;">' +
              '<canvas data-ck="dre-ebit-anual" role="img" aria-label="EBIT anual Negócio versus Agência"></canvas>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Painel 10 — concentração de receita por cliente (Pareto)
        '<div class="chart-card">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Concentração de receita por cliente (Pareto)</div>' +
            '<div class="card-subtitle">Fee anual por cliente (ordem decrescente) e % acumulado — guias de risco em 30% e 50%</div>' +
          '</div><div class="chip accent">Painel 10</div></div>' +
          '<div class="chart-container" style="height:300px;">' +
            '<canvas data-ck="dre-pareto" role="img" aria-label="Pareto de concentração de receita por cliente"></canvas>' +
          '</div>' +
          '<div data-ck="dre-pareto-callouts"></div>' +
        '</div>';

      container.appendChild(sec);

      // busca resiliente: cada endpoint falha de forma isolada
      function pega(p) { return CK.api(p).catch(function () { return null; }); }
      return Promise.all([
        pega('/api/dre/mensal/' + slug + qs),
        pega('/api/cascata/' + slug + qs),
        pega('/api/despesas/' + slug + qs),
        pega('/api/dre/trimestral/' + slug + qs),
        pega('/api/receita-tipo/' + slug + qs),
        pega('/api/historico/' + slug),
        pega('/api/fees/' + slug + qs),
        pega('/api/kpis/' + slug + qs)
      ]).then(function (r) {
        if (!sec.isConnected) return; // tela já foi trocada
        var dre = r[0], casc = r[1], desp = r[2], tri = r[3], rt = r[4],
            historico = r[5], fees = r[6], kpis = r[7];
        var anoEf = (dre && dre.ano) || ano || (window.CK && CK.state && CK.state.ano) || '';
        // realizado_ate ausente → assume tudo realizado (sem estilo de projeção)
        var realizadoAte = (dre && dre.realizado_ate != null) ? n(dre.realizado_ate) : 12;
        var meses = (dre && dre.meses) || [];

        pintaBanner(sec, realizadoAte, anoEf);
        pintaCascata(sec, casc, anoEf);
        pintaEvolucao(sec, meses, realizadoAte, anoEf);
        pintaVariacaoMoM(sec, meses, realizadoAte, anoEf);
        pintaResumo(sec, meses, realizadoAte);
        pintaCaixa(sec, meses, realizadoAte, anoEf);
        pintaTrimestres(sec, tri, anoEf);
        pintaMargem(sec, meses, realizadoAte, anoEf);
        pintaDespesas(sec, desp, realizadoAte, anoEf);
        // Painel 02: realizado_ate próprio do endpoint (fallback p/ o da DRE)
        var rtAte = (rt && rt.realizado_ate != null) ? n(rt.realizado_ate) : realizadoAte;
        pintaReceitaTipo(sec, rt, rtAte, anoEf);
        // Painéis de refino 03 · 09 · 10
        pintaPessoal(sec, meses, realizadoAte, anoEf, kpis);
        pintaEbitEvolucao(sec, meses, realizadoAte, anoEf, historico);
        pintaPareto(sec, fees, anoEf);
      });
    }
  };
})();
