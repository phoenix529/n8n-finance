/* ============================================================
 * Tela P4 — Cockpit de Custos (drill-down de folha salarial)
 * Rota: #/custos
 * Contrato: usa APENAS window.CK (core.js) + Chart.js global.
 * ZERO dados hardcoded — tudo vem da API (spec §6).
 * LGPD: colaboradores exibem cargo + faixa salarial, nunca salário exato.
 * ============================================================ */
(function () {
  'use strict';

  var charts = [];
  var mesSel = null;      // mês selecionado (default = mais recente com folha, vindo da API)
  var empresaSelC = null; // empresa selecionada (só p/ escopo parcial — RBAC)
  var baseCusto = 'custo'; // 'custo' = custo total p/ a empresa | 'bruto' = salário recebido

  // rótulo curto da base ativa
  function labelBase() { return baseCusto === 'custo' ? 'Custo total (empresa)' : 'Salário bruto'; }
  // total da folha/depto/empresa segundo a base ativa (fallback → bruto se custo ausente)
  function vTotal(o) {
    if (!o) return 0;
    if (baseCusto === 'custo') return o.total_custo != null ? n(o.total_custo) : n(o.total);
    return n(o.total);
  }
  // custo médio/funcionário de uma folha segundo a base ativa
  function vMedioFolha(f) {
    if (!f) return 0;
    var hc = n(f.headcount);
    if (baseCusto === 'custo') {
      if (f.custo_medio_custo != null) return n(f.custo_medio_custo);
      return hc ? vTotal(f) / hc : 0;
    }
    return f.custo_medio != null ? n(f.custo_medio) : (hc ? vTotal(f) / hc : 0);
  }

  var MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

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
  function hexA(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(245,200,66,' + a + ')';
    var v = parseInt(m[1], 16);
    return 'rgba(' + (v >> 16 & 255) + ',' + (v >> 8 & 255) + ',' + (v & 255) + ',' + a + ')';
  }
  // ratio pode vir como fração (0.2) ou percentual (20)
  // API devolve o ratio JÁ em pontos percentuais (contrato) — sem heurística de escala
  function ratioPct(v) { return n(v); }

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

  function qsAno(prefixo) {
    var a = '';
    try {
      if (window.CK && CK.state && CK.state.ano) a = CK.state.ano;
      else { var sel = document.getElementById('ano-select'); if (sel && sel.value) a = sel.value; }
    } catch (e) { a = ''; }
    return a ? ((prefixo || '?') + 'ano=' + encodeURIComponent(a)) : '';
  }

  // empresas do registro global (sem 'grupo'), RESTRITAS ao escopo do usuário
  // (RBAC — o 403 server-side é a rede de segurança)
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

  // true se o usuário pode ver o consolidado do grupo
  function escopoTotal() {
    return !window.CK || typeof CK.temAcesso !== 'function' || CK.temAcesso('grupo');
  }
  function pega(p) { return CK.api(p).catch(function () { return null; }); }

  // querystring de folha: ano (filtro global) + mês selecionado
  function qsFolha() {
    var qs = qsAno();
    if (mesSel) qs += (qs ? '&' : '?') + 'mes=' + encodeURIComponent(mesSel);
    return qs;
  }

  /* ── drawer L2: colaboradores de um departamento ─────────────── */
  function abreDrawerDeptL2(empresa, dept) {
    CK.openDrawer({
      level: 2,
      title: 'Detalhe de Folha — ' + (empresa.label || '') + '/' + (dept.nome || ''),
      render: function (body) {
        var h = htmlDept(empresa, dept, null, true);
        if (body && body.innerHTML !== undefined) {
          body.innerHTML = h;
        }
        return h;
      }
    });
  }

  // bloco de KPIs + colaboradores de um departamento (usado nos drawers L1 e L2)
  function htmlDept(empresa, dept, folhaEmpresa, semExtras) {
    var hc = n(dept.headcount);
    var totDept = vTotal(dept);
    var medio = hc ? totDept / hc : 0;
    var h =
      '<div class="kpi-row" style="grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">' +
        '<div class="kpi-card accent" style="padding:12px;">' +
          '<div class="kpi-label">' + esc(labelBase()) + '</div>' +
          '<div class="kpi-value" style="font-size:17px;">' + fmtMoeda(totDept) + '</div>' +
        '</div>' +
        '<div class="kpi-card blue" style="padding:12px;">' +
          '<div class="kpi-label">Headcount</div>' +
          '<div class="kpi-value" style="font-size:17px;">' + hc.toLocaleString('pt-BR') + '</div>' +
        '</div>' +
        '<div class="kpi-card green" style="padding:12px;">' +
          '<div class="kpi-label">Custo médio</div>' +
          '<div class="kpi-value" style="font-size:17px;">' + fmtMoeda(medio) + '</div>' +
        '</div>' +
      '</div>';

    var colabs = dept.colaboradores || [];
    h += '<div class="card-title" style="margin-bottom:8px;">Colaboradores (' + colabs.length + ')</div>';
    if (!colabs.length) {
      h += '<p style="font-size:12px;color:var(--text-3);">Sem colaboradores listados para este departamento no período.</p>';
    } else {
      // resumo: nome · cargo · tipo (CLT/PJ) · faixa salarial (banda) — LGPD: nunca salário exato
      colabs.forEach(function (c) {
        h += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);">' +
          '<div style="min-width:0;flex:1;">' +
            '<div style="font-size:12px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(c.nome || '—') + '</div>' +
            '<div style="font-size:11px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(c.cargo || '—') + '</div>' +
          '</div>' +
          '<span class="chip" style="font-size:9px;padding:1px 6px;flex-shrink:0;">' + esc(c.tipo || '—') + '</span>' +
          '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-1);white-space:nowrap;flex-shrink:0;">' + esc(c.faixa_salarial || '—') + '</span>' +
        '</div>';
      });
      h += '<p style="font-size:10px;color:var(--text-3);margin-top:8px;">Faixas salariais em bandas (LGPD) — salários exatos não são exibidos.</p>';
    }

    // extras do drawer L1: outros departamentos (→ L2) + comparação entre empresas
    if (!semExtras && folhaEmpresa) {
      var outros = (folhaEmpresa.departamentos || []).filter(function (d) { return d.nome !== dept.nome; });
      if (outros.length) {
        var maxD = 1;
        outros.forEach(function (d) { maxD = Math.max(maxD, Math.abs(vTotal(d))); });
        h += '<div class="card-title" style="margin:18px 0 8px;">Outros departamentos — ' + esc(empresa.label || '') + '</div>' +
          '<p style="font-size:10px;color:var(--text-3);margin-bottom:8px;">Clique numa barra para abrir o detalhe do departamento.</p>';
        outros.forEach(function (d, i) {
          var w = Math.round(Math.abs(vTotal(d)) / maxD * 100);
          h += '<div data-ck="outro-dept" data-i="' + i + '" role="button" tabindex="0" ' +
            'aria-label="Abrir detalhe do departamento ' + esc(d.nome) + '" ' +
            'style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">' +
            '<span style="font-size:11px;color:var(--text-2);width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.nome) + '</span>' +
            '<div class="mini-bar-wrap" style="flex:1;width:auto;"><div class="mini-bar-fill" style="width:' + w + '%;background:' + esc(empresa.color || '#D9DA00') + '"></div></div>' +
            '<span style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:var(--text-1);white-space:nowrap;">' + fmtMoeda(vTotal(d)) + ' · ' + n(d.headcount) + 'p</span>' +
          '</div>';
        });
      }
      h += '<div style="margin-top:18px;">' +
        '<button type="button" class="btn primary" data-ck="btn-comparar">Comparar com outras empresas</button>' +
        '<div data-ck="comparar-box" style="margin-top:12px;"></div>' +
      '</div>';
    }
    return h;
  }

  /* ── drawer L1: detalhe de folha de um departamento ──────────── */
  function abreDrawerDept(empresa, dept, folhaEmpresa, comparativo) {
    CK.openDrawer({
      title: 'Detalhe de Folha — ' + (empresa.label || '') + '/' + (dept.nome || ''),
      render: function (body) {
        var h = htmlDept(empresa, dept, folhaEmpresa, false);
        if (body && body.innerHTML !== undefined) {
          body.innerHTML = h;

          // L2: clique numa barra de outro departamento abre segundo drawer
          var outros = (folhaEmpresa.departamentos || []).filter(function (d) { return d.nome !== dept.nome; });
          body.querySelectorAll('[data-ck="outro-dept"]').forEach(function (row) {
            function abre() {
              var d = outros[Number(row.getAttribute('data-i'))];
              if (d) abreDrawerDeptL2(empresa, d);
            }
            row.addEventListener('click', abre);
            row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(); } });
          });

          // botão: comparativo de custo médio/funcionário entre as empresas
          var btn = body.querySelector('[data-ck="btn-comparar"]');
          var box = body.querySelector('[data-ck="comparar-box"]');
          if (btn && box) {
            btn.addEventListener('click', function () {
              btn.disabled = true;
              var itens = (comparativo || []).filter(function (e) { return e && e.headcount > 0; });
              if (!itens.length) {
                box.innerHTML = '<p style="font-size:12px;color:var(--text-3);">Sem dados para comparação.</p>';
                return;
              }
              box.innerHTML = '<div style="height:180px;position:relative;"><canvas data-ck="cmp-canvas" role="img" ' +
                'aria-label="Barras comparando o custo médio por funcionário entre as empresas do grupo"></canvas></div>';
              novoChart(box.querySelector('[data-ck="cmp-canvas"]'), {
                type: 'bar',
                data: {
                  labels: itens.map(function (e) { return e.label; }),
                  datasets: [{
                    label: 'Custo médio/func. — ' + labelBase(),
                    data: itens.map(function (e) { return e.custo_medio; }),
                    backgroundColor: itens.map(function (e) { return e.color || '#D9DA00'; }),
                    borderRadius: 4,
                    borderSkipped: false
                  }]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: { display: false },
                    tooltip: tooltipDark({
                      callbacks: { label: function (c) { return ' ' + fmtMoeda(c.parsed.y) + '/mês por funcionário'; } }
                    })
                  },
                  scales: {
                    x: { grid: { display: false }, ticks: { color: '#81807C', font: { size: 9 } }, border: { color: 'rgba(0,0,0,0.07)' } },
                    y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#81807C', font: { size: 9 }, callback: function (v) { return 'R$' + fmtShort(v); } }, border: { color: 'transparent' } }
                  }
                }
              });
            });
          }
        }
        return h;
      }
    });
  }

  /* ── KPIs do grupo (5 cards) ─────────────────────────────────── */
  function pintaKpis(el, grupo) {
    var row = el.querySelector('[data-ck="kpis"]');
    if (!row) return;
    if (!grupo) {
      row.innerHTML = '<div class="kpi-card red"><div class="kpi-label">Erro</div>' +
        '<div class="kpi-compare">Falha ao carregar a folha do grupo.</div></div>';
      return;
    }
    var porEmp = grupo.por_empresa || [];
    var recTotal = 0;
    porEmp.forEach(function (e) { recTotal += n(e.receita_mes); });
    var totGrupo = vTotal(grupo);
    var ratioGrupo = recTotal ? totGrupo / recTotal * 100 : 0;
    var acima20 = ratioGrupo > 20;
    var estouradas = porEmp.filter(function (e) { return vTotal(e) > n(e.receita_mes); });

    row.innerHTML =
      '<div class="kpi-card accent">' +
        '<div class="kpi-icon accent" aria-hidden="true">💰</div>' +
        '<div class="kpi-label">Total Folha Grupo — ' + esc(labelBase()) + '</div>' +
        '<div class="kpi-value">' + fmtMoeda(totGrupo) + '</div>' +
        '<div class="kpi-compare">' + MESES[(n(grupo.mes) - 1 + 12) % 12] + '/' + esc(grupo.ano) + ' · por mês</div>' +
      '</div>' +
      '<div class="kpi-card blue">' +
        '<div class="kpi-icon blue" aria-hidden="true">👥</div>' +
        '<div class="kpi-label">Total Funcionários</div>' +
        '<div class="kpi-value">' + n(grupo.headcount).toLocaleString('pt-BR') + '</div>' +
        '<div class="kpi-compare">pessoas no grupo</div>' +
      '</div>' +
      '<div class="kpi-card green">' +
        '<div class="kpi-icon green" aria-hidden="true">⚖️</div>' +
        '<div class="kpi-label">Custo médio/func. — ' + esc(labelBase()) + '</div>' +
        '<div class="kpi-value">' + fmtMoeda(vMedioFolha(grupo)) + '</div>' +
        '<div class="kpi-compare">folha ÷ headcount no mês</div>' +
      '</div>' +
      '<div class="kpi-card ' + (acima20 ? 'red' : 'green') + '">' +
        '<div class="kpi-icon ' + (acima20 ? 'red' : 'green') + '" aria-hidden="true">📊</div>' +
        '<div class="kpi-label">Folha / Rec. Bruta</div>' +
        '<div class="kpi-value"' + (acima20 ? ' style="color:var(--red)"' : '') + '>' + fmtPct(ratioGrupo) + '</div>' +
        '<span class="kpi-delta ' + (acima20 ? 'down' : 'up') + '">' + (acima20 ? '▲ acima' : '▼ abaixo') + ' de 20%</span>' +
      '</div>' +
      '<div class="kpi-card ' + (estouradas.length ? 'red' : 'green') + '">' +
        '<div class="kpi-icon ' + (estouradas.length ? 'red' : 'green') + '" aria-hidden="true">' + (estouradas.length ? '🚨' : '✓') + '</div>' +
        '<div class="kpi-label">Empresas c/ folha &gt; receita</div>' +
        '<div class="kpi-value" style="font-size:17px;line-height:1.3;' + (estouradas.length ? 'color:var(--red);' : '') + '">' +
          (estouradas.length ? esc(estouradas.map(function (e) { return e.label; }).join(', ')) : 'Nenhuma') + '</div>' +
        '<div class="kpi-compare">folha mensal acima da receita do mês</div>' +
      '</div>';
  }

  /* ── KPIs de UMA empresa (escopo parcial — sem widgets grupo-only) ── */
  function pintaKpisEmpresa(el, empresa, folha) {
    var row = el.querySelector('[data-ck="kpis"]');
    if (!row) return;
    row.style.gridTemplateColumns = 'repeat(3,1fr)'; // 3 cards (ratio grupo-only escondido)
    if (!folha) {
      row.innerHTML = '<div class="kpi-card red"><div class="kpi-label">Erro</div>' +
        '<div class="kpi-compare">Falha ao carregar a folha de ' + esc((empresa && empresa.label) || '') + '.</div></div>';
      return;
    }
    var hc = n(folha.headcount);
    var medio = vMedioFolha(folha);
    row.innerHTML =
      '<div class="kpi-card accent">' +
        '<div class="kpi-icon accent" aria-hidden="true">💰</div>' +
        '<div class="kpi-label">Total Folha — ' + esc((empresa && empresa.label) || '') + ' · ' + esc(labelBase()) + '</div>' +
        '<div class="kpi-value">' + fmtMoeda(vTotal(folha)) + '</div>' +
        '<div class="kpi-compare">' + MESES[(n(folha.mes) - 1 + 12) % 12] + '/' + esc(folha.ano) + ' · por mês</div>' +
      '</div>' +
      '<div class="kpi-card blue">' +
        '<div class="kpi-icon blue" aria-hidden="true">👥</div>' +
        '<div class="kpi-label">Total Funcionários</div>' +
        '<div class="kpi-value">' + hc.toLocaleString('pt-BR') + '</div>' +
        '<div class="kpi-compare">pessoas na empresa</div>' +
      '</div>' +
      '<div class="kpi-card green">' +
        '<div class="kpi-icon green" aria-hidden="true">⚖️</div>' +
        '<div class="kpi-label">Custo médio/func. — ' + esc(labelBase()) + '</div>' +
        '<div class="kpi-value">' + fmtMoeda(medio) + '</div>' +
        '<div class="kpi-compare">folha ÷ headcount no mês</div>' +
      '</div>';
  }

  /* ── treemap CSS: empresa (largura ∝ total) → depto (altura) ── */
  function pintaTreemap(el, folhas, comparativo) {
    var box = el.querySelector('[data-ck="treemap"]');
    if (!box) return;
    var itens = folhas.filter(function (f) { return f && f.folha && vTotal(f.folha) > 0; });
    if (!itens.length) {
      box.innerHTML = '<p class="empty-state">Sem folha carregada para o mês selecionado.</p>';
      return;
    }
    itens.sort(function (a, b) { return vTotal(b.folha) - vTotal(a.folha); });

    box.innerHTML = '<div class="treemap" role="group" ' +
      'aria-label="Treemap da folha (' + esc(labelBase()) + '): largura de cada bloco proporcional ao total da empresa; blocos internos são os departamentos. Clique num departamento para abrir o detalhe.">' +
      itens.map(function (f, ei) {
        var cor = f.empresa.color || '#D9DA00';
        var depts = (f.folha.departamentos || []).slice().sort(function (a, b) { return vTotal(b) - vTotal(a); });
        return '<div class="treemap-block" data-ck="tm-emp" data-e="' + ei + '" ' +
          'style="flex:' + Math.max(vTotal(f.folha), 1) + ' 1 0;border-color:' + hexA(cor, 0.5) + ';background:' + hexA(cor, 0.08) + ';">' +
          '<div class="treemap-block-title" style="color:' + esc(cor) + ';">' + esc(f.empresa.label) + '</div>' +
          '<div class="treemap-block-val">' + fmtMoeda(vTotal(f.folha)) + ' · ' + n(f.folha.headcount) + 'p</div>' +
          depts.map(function (d, di) {
            return '<div class="treemap-dept" data-ck="tm-dept" data-e="' + ei + '" data-d="' + di + '" ' +
              'role="button" tabindex="0" aria-label="Departamento ' + esc(d.nome) + ' de ' + esc(f.empresa.label) + ': ' + fmtMoeda(vTotal(d)) + '" ' +
              'style="flex:' + Math.max(vTotal(d), 1) + ' 1 0;background:' + hexA(cor, 0.35) + ';cursor:pointer;">' +
              esc(d.nome) + '</div>';
          }).join('') +
        '</div>';
      }).join('') + '</div>';

    // clique num departamento → drawer L1 com detalhe (spec drill-down 1)
    box.querySelectorAll('[data-ck="tm-dept"]').forEach(function (cel) {
      function abre(e) {
        e.stopPropagation();
        var f = itens[Number(cel.getAttribute('data-e'))];
        if (!f) return;
        var depts = (f.folha.departamentos || []).slice().sort(function (a, b) { return vTotal(b) - vTotal(a); });
        var d = depts[Number(cel.getAttribute('data-d'))];
        if (d) abreDrawerDept(f.empresa, d, f.folha, comparativo);
      }
      cel.addEventListener('click', abre);
      cel.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(e); } });
    });
  }

  /* ── barras horizontais: custo por departamento (maior empresa) ─ */
  function pintaDeptos(el, maior, comparativo) {
    var box = el.querySelector('[data-ck="deptos"]');
    var chip = el.querySelector('[data-ck="deptos-chip"]');
    if (!box) return;
    if (!maior || !maior.folha || !(maior.folha.departamentos || []).length) {
      box.innerHTML = '<p class="empty-state">Sem departamentos para o mês.</p>';
      return;
    }
    var cor = maior.empresa.color || '#D9DA00';
    if (chip) {
      chip.textContent = maior.empresa.label;
      chip.style.background = hexA(cor, 0.15);
      chip.style.color = cor;
      chip.style.border = '1px solid ' + hexA(cor, 0.35);
    }
    var depts = maior.folha.departamentos.slice().sort(function (a, b) { return vTotal(b) - vTotal(a); }).slice(0, 8);
    var maxD = 1, maxHc = 1;
    depts.forEach(function (d) {
      maxD = Math.max(maxD, Math.abs(vTotal(d)));
      maxHc = Math.max(maxHc, n(d.headcount));
    });

    box.innerHTML = depts.map(function (d, i) {
      var w = Math.round(Math.abs(vTotal(d)) / maxD * 100);
      var diam = Math.round(18 + n(d.headcount) / maxHc * 14); // bolha ∝ headcount
      return '<div data-ck="dept-row" data-i="' + i + '" role="button" tabindex="0" ' +
        'aria-label="Departamento ' + esc(d.nome) + ': ' + fmtMoeda(vTotal(d)) + ' e ' + n(d.headcount) + ' pessoas. Clique para detalhe." ' +
        'style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">' +
        '<span style="font-size:12px;color:var(--text-2);width:118px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.nome) + '</span>' +
        '<div class="mini-bar-wrap" style="flex:1;width:auto;height:8px;"><div class="mini-bar-fill" style="width:' + w + '%;background:' + esc(cor) + '"></div></div>' +
        '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-1);white-space:nowrap;">' + fmtMoeda(vTotal(d)) + '</span>' +
        '<span aria-hidden="true" style="width:' + diam + 'px;height:' + diam + 'px;border-radius:50%;background:' + hexA(cor, 0.3) + ';' +
          'display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:' + esc(cor) + ';flex-shrink:0;">' +
          n(d.headcount) + '</span>' +
      '</div>';
    }).join('');

    box.querySelectorAll('[data-ck="dept-row"]').forEach(function (row) {
      function abre() {
        var d = depts[Number(row.getAttribute('data-i'))];
        if (d) abreDrawerDept(maior.empresa, d, maior.folha, comparativo);
      }
      row.addEventListener('click', abre);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(); } });
    });
  }

  /* ── plugin: linha de referência 20% folha/receita ───────────── */
  var ref20 = {
    id: 'ref20',
    afterDatasetsDraw: function (chart) {
      var eixo = chart.scales && chart.scales.y;
      if (!eixo || !chart.chartArea) return;
      var y = eixo.getPixelForValue(20);
      if (y < chart.chartArea.top || y > chart.chartArea.bottom) return;
      var ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = '#D9DA00';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(chart.chartArea.left, y);
      ctx.lineTo(chart.chartArea.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#D9DA00';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.fillText('Ref. 20% folha/receita', chart.chartArea.left + 6, y - 5);
      ctx.restore();
    }
  };

  /* ── gráfico: folha/receita por empresa (barra + linha 20%) ──── */
  function pintaRatio(el, grupo) {
    var box = el.querySelector('[data-ck="ratio-box"]');
    if (!box) return;
    var porEmp = (grupo && grupo.por_empresa) || [];
    if (!porEmp.length) {
      box.innerHTML = '<p class="empty-state">Sem dados por empresa para o mês.</p>';
      return;
    }
    box.innerHTML = '<canvas data-ck="ratio-canvas" role="img"></canvas>';
    var canvas = box.querySelector('[data-ck="ratio-canvas"]');
    var vals = porEmp.map(function (e) {
      // segue a base ativa (custo total × bruto), igual ao KPI e ao treemap:
      // ratio = folha(base) / receita do mês. Em 'bruto' vTotal(e)===e.total.
      return n(e.receita_mes) ? vTotal(e) / n(e.receita_mes) * 100 : 0;
    });
    canvas.setAttribute('aria-label',
      'Barras do percentual folha sobre receita bruta de cada empresa no mês, com linha de referência tracejada em 20%.');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: porEmp.map(function (e) { return e.label; }),
        datasets: [{
          label: 'Folha / Receita',
          data: vals,
          backgroundColor: vals.map(function (v) { return v > 20 ? '#E5484D' : v > 10 ? '#D9DA00' : '#22C55E'; }),
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
            callbacks: {
              label: function (c) {
                var e = porEmp[c.dataIndex];
                return [' Folha/Receita: ' + fmtPct(c.parsed.y),
                  ' ' + labelBase() + ': ' + fmtMoeda(vTotal(e)) + ' · Receita mês: ' + fmtMoeda(e.receita_mes)];
              }
            }
          })
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#81807C', font: { size: 10 } }, border: { color: 'rgba(0,0,0,0.07)' } },
          y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#81807C', font: { size: 10 }, callback: function (v) { return v + '%'; } }, border: { color: 'transparent' } }
        }
      },
      plugins: [ref20]
    });
  }

  /* ── PANEL 04: headcount por departamento (NEW /api/headcount) ──
     Contrato: {mes, departamentos:[{nome,headcount,total}] desc, meses:[{mes,total}]}
     folhaDrill/empresaObj (opcionais): drill p/ o drawer de colaboradores
     quando a folha da empresa selecionada traz colaboradores (escopo parcial). */
  function pintaHeadcount(el, data, folhaDrill, empresaObj) {
    var rank = el.querySelector('[data-ck="hc-rank"]');
    var box  = el.querySelector('[data-ck="hc-mes-box"]');
    var subT = el.querySelector('[data-ck="hc-rank-title"]');
    var depts = (data && data.departamentos) || [];
    var meses = (data && data.meses) || [];
    var snap  = data && data.mes;

    if (subT) {
      subT.textContent = 'Ranking de ' +
        (snap ? MESES[(n(snap) - 1 + 12) % 12] : 'período') + ' · headcount por departamento';
    }

    /* (a) ranking horizontal de headcount por departamento (snapshot) */
    if (rank) {
      if (!depts.length) {
        rank.innerHTML = '<p class="empty-state">Sem headcount para o período.</p>';
      } else {
        var deptsS = depts.slice().sort(function (a, b) { return n(b.headcount) - n(a.headcount); });
        var maxHc = 1;
        deptsS.forEach(function (d) { maxHc = Math.max(maxHc, n(d.headcount)); });
        // mapa de drill: só departamentos com colaboradores listados na folha da empresa
        var drillMap = {};
        if (empresaObj && folhaDrill && folhaDrill.departamentos) {
          folhaDrill.departamentos.forEach(function (d) {
            if (d && (d.colaboradores || []).length) drillMap[d.nome] = d;
          });
        }
        rank.innerHTML = deptsS.map(function (d, i) {
          var w = Math.round(n(d.headcount) / maxHc * 100);
          var canDrill = !!drillMap[d.nome];
          return '<div ' +
            (canDrill ? 'data-ck="hc-row" data-i="' + i + '" role="button" tabindex="0" ' : '') +
            'aria-label="Departamento ' + esc(d.nome) + ': ' + n(d.headcount) + ' pessoas' +
              (canDrill ? '. Clique para detalhe.' : '') + '" ' +
            'style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);' +
              (canDrill ? 'cursor:pointer;' : '') + '">' +
            '<span style="font-size:12px;color:var(--text-2);width:118px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(d.nome) + '</span>' +
            '<div class="mini-bar-wrap" style="flex:1;width:auto;height:8px;"><div class="mini-bar-fill" style="width:' + w + '%;background:#D9DA00"></div></div>' +
            '<span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:var(--text-1);white-space:nowrap;min-width:26px;text-align:right;">' + n(d.headcount) + '</span>' +
            ((d.total != null || d.total_custo != null)
              ? '<span style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:var(--text-3);white-space:nowrap;">' + fmtMoeda(vTotal(d)) + '</span>'
              : '') +
          '</div>';
        }).join('');

        // drill opcional → drawer L2 de colaboradores (não quebra se ausente)
        rank.querySelectorAll('[data-ck="hc-row"]').forEach(function (row) {
          function abre() {
            var d = drillMap[deptsS[Number(row.getAttribute('data-i'))].nome];
            if (d && empresaObj) abreDrawerDeptL2(empresaObj, d);
          }
          row.addEventListener('click', abre);
          row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(); } });
        });
      }
    }

    /* (b) barras de headcount total mês a mês */
    if (box) {
      if (!meses.length) {
        box.innerHTML = '<p class="empty-state">Sem série mensal de headcount.</p>';
      } else {
        box.innerHTML = '<canvas data-ck="hc-mes" role="img"></canvas>';
        var canvas = box.querySelector('[data-ck="hc-mes"]');
        var labels = meses.map(function (m) { return MESES[(n(m.mes) - 1 + 12) % 12]; });
        var vals = meses.map(function (m) { return n(m.total); });
        canvas.setAttribute('aria-label',
          'Evolução do headcount total mês a mês: ' +
          labels.map(function (l, i) { return l + ' ' + vals[i]; }).join(', ') + '.');
        novoChart(canvas, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              label: 'Headcount total',
              data: vals,
              backgroundColor: '#D9DA00',
              borderRadius: 4,
              borderSkipped: false
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: tooltipDark({
                callbacks: { label: function (c) { return ' ' + n(c.parsed.y).toLocaleString('pt-BR') + ' pessoas'; } }
              })
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#81807C', font: { size: 10 } }, border: { color: 'rgba(0,0,0,0.07)' } },
              y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#81807C', font: { size: 10 }, precision: 0 }, border: { color: 'transparent' } }
            }
          }
        });
      }
    }
  }

  /* ── PANEL 05: custo de pessoas por cliente (NEW /api/custo-cliente) ──
     Contrato: {ano, clientes:[{cliente,receita,custo_dedicado,overhead,
     custo_total,margem,pct_margem,dedicado}] desc por receita,
     totais:{receita,custo,margem}, folha:{...}, reconciliacao:{ok,diff}} */
  function pintaCustoCliente(el, data) {
    var box   = el.querySelector('[data-ck="cc-box"]');
    var tabela = el.querySelector('[data-ck="cc-tabela"]');
    if (!box) return;
    var clientes = (data && data.clientes) || [];
    if (!clientes.length) {
      box.innerHTML = '<p class="empty-state">Sem dados de custo por cliente para o ano.</p>';
      if (tabela) tabela.innerHTML = '';
      return;
    }
    // top N por receita (já vem desc da API; reforça a ordenação)
    var top = clientes.slice().sort(function (a, b) { return n(b.receita) - n(a.receita); }).slice(0, 10);

    box.innerHTML = '<canvas data-ck="cc-canvas" role="img"></canvas>';
    var canvas = box.querySelector('[data-ck="cc-canvas"]');
    canvas.setAttribute('aria-label',
      'Barras horizontais empilhadas por cliente (ordenado por receita): custo dedicado, ' +
      'overhead rateado e margem. ' +
      top.map(function (c) {
        return esc(c.cliente) + ' margem ' + fmtMoeda(c.margem);
      }).join('; ') + '.');

    novoChart(canvas, {
      type: 'bar',
      data: {
        labels: top.map(function (c) { return c.cliente; }),
        datasets: [
          { label: 'Custo dedicado', data: top.map(function (c) { return n(c.custo_dedicado); }),
            backgroundColor: '#D9DA00', borderRadius: 3, borderSkipped: false, stack: 'c' },
          { label: 'Overhead (rateio)', data: top.map(function (c) { return n(c.overhead); }),
            backgroundColor: '#81807C', borderRadius: 3, borderSkipped: false, stack: 'c' },
          { label: 'Margem', data: top.map(function (c) { return n(c.margem); }),
            backgroundColor: top.map(function (c) { return n(c.margem) < 0 ? '#E5484D' : '#2E7D32'; }),
            borderRadius: 3, borderSkipped: false, stack: 'c' }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#81807C', font: { size: 10 }, boxWidth: 12, padding: 12 } },
          tooltip: tooltipDark({
            callbacks: {
              label: function (c) { return ' ' + c.dataset.label + ': ' + fmtMoeda(c.parsed.x); },
              afterBody: function (items) {
                var cl = top[items[0].dataIndex];
                return '\nReceita: ' + fmtMoeda(cl.receita) + ' · Margem: ' + fmtPct(cl.pct_margem) +
                  (cl.dedicado ? '' : '\n(sem time dedicado — só overhead)');
              }
            }
          })
        },
        scales: {
          x: { stacked: true, grid: { color: 'rgba(0,0,0,0.05)' },
               ticks: { color: '#81807C', font: { size: 10 }, callback: function (v) { return 'R$' + fmtShort(v); } },
               border: { color: 'transparent' } },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#1C1C1C', font: { size: 10 } },
               border: { color: 'rgba(0,0,0,0.07)' } }
        }
      }
    });

    // tabela compacta: cliente · receita · custo · margem · %
    if (tabela) {
      var linhas = top.map(function (c) {
        var neg = n(c.margem) < 0;
        return '<tr>' +
          '<td style="padding:6px 8px;font-size:12px;color:var(--text-1);white-space:nowrap;">' +
            esc(c.cliente) + (c.dedicado ? ' <span class="chip accent" style="font-size:9px;padding:1px 5px;">dedicado</span>' : '') + '</td>' +
          '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;color:var(--text-1);">' + fmtMoeda(c.receita) + '</td>' +
          '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;color:var(--text-2);">' + fmtMoeda(c.custo_total) + '</td>' +
          '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;' + (neg ? 'color:var(--red);' : 'color:var(--text-1);') + '">' + fmtMoeda(c.margem) + '</td>' +
          '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;' + (neg ? 'color:var(--red);' : 'color:var(--text-2);') + '">' + fmtPct(c.pct_margem) + '</td>' +
        '</tr>';
      }).join('');
      var t = data.totais || {};
      tabela.innerHTML =
        '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;min-width:340px;">' +
          '<thead><tr style="border-bottom:1px solid var(--border);">' +
            '<th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text-3);font-weight:600;">Cliente</th>' +
            '<th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text-3);font-weight:600;">Receita</th>' +
            '<th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text-3);font-weight:600;">Custo</th>' +
            '<th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text-3);font-weight:600;">Margem</th>' +
            '<th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text-3);font-weight:600;">%</th>' +
          '</tr></thead>' +
          '<tbody>' + linhas + '</tbody>' +
          (t.receita != null ? '<tfoot><tr style="border-top:1px solid var(--border);font-weight:700;">' +
            '<td style="padding:6px 8px;font-size:11px;color:var(--text-1);">Total</td>' +
            '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;color:var(--text-1);">' + fmtMoeda(t.receita) + '</td>' +
            '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;color:var(--text-1);">' + fmtMoeda(t.custo) + '</td>' +
            '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;color:var(--text-1);">' + fmtMoeda(t.margem) + '</td>' +
            '<td style="padding:6px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;text-align:right;color:var(--text-2);">' + fmtPct(n(t.receita) ? n(t.margem) / n(t.receita) * 100 : 0) + '</td>' +
          '</tr></tfoot>' : '') +
        '</table></div>';
    }
  }

  /* ── registro da tela ─────────────────────────────────────────── */
  CK.registerScreen('custos', {
    title: 'Cockpit de Custos — Folha Salarial',
    subtitle: 'Distribuição por empresa · departamento · headcount · custo médio/funcionário',
    render: function (el) {
      destroiCharts();

      // Seletor de empresa: escopo TOTAL escolhe "Todas (Grupo)" (empresaSelC='grupo')
      // ou uma empresa específica; escopo parcial escolhe entre as suas empresas
      // (grupo=403). 'grupo' = visão consolidada; um slug = só aquela empresa.
      var total = escopoTotal();
      var permitidas = listaEmpresas();
      if (total) {
        if (empresaSelC == null) empresaSelC = 'grupo';
        if (empresaSelC !== 'grupo' && !permitidas.some(function (e) { return e.slug === empresaSelC; })) empresaSelC = 'grupo';
      } else {
        var aindaVale = permitidas.some(function (e) { return e.slug === empresaSelC; });
        empresaSelC = aindaVale ? empresaSelC : ((permitidas[0] || {}).slug || null);
      }

      if (!total && !empresaSelC) {
        // escopo sem nenhuma empresa — nada a mostrar nesta tela
        el.innerHTML = '<div class="empty-state">Seu usuário não tem empresas com folha no escopo.</div>';
        return;
      }

      el.innerHTML =
        // filtros: base de custo (toggle) + empresa (só escopo parcial com >1 permitida) + mês da folha
        '<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:6px;flex-wrap:wrap;">' +
          '<span class="filter-label">Base de custo</span>' +
          '<div role="group" aria-label="Base de custo da folha" style="display:inline-flex;gap:4px;margin-right:auto;">' +
            '<button type="button" data-ck="base-custo" aria-pressed="true" ' +
              'style="padding:5px 12px;border-radius:999px;font-size:12px;cursor:pointer;">Custo total (empresa)</button>' +
            '<button type="button" data-ck="base-bruto" aria-pressed="false" ' +
              'style="padding:5px 12px;border-radius:999px;font-size:12px;cursor:pointer;">Salário bruto (recebido)</button>' +
          '</div>' +
          (total || permitidas.length > 1
            ? '<span class="filter-label">Empresa</span>' +
              '<select data-ck="emp-select" aria-label="Filtro de empresa da folha"></select>'
            : '') +
          '<span class="filter-label">Mês da folha</span>' +
          '<select data-ck="mes-select" aria-label="Filtro de mês da folha"><option value="">Carregando…</option></select>' +
        '</div>' +
        '<p style="font-size:11px;color:var(--text-3);margin:0 0 16px;text-align:right;">' +
          'Custo total = salário + extras + VT + VR + FGTS + INSS; bruto = o que o colaborador recebe.' +
        '</p>' +

        '<div class="kpi-row cols-5" data-ck="kpis">' +
          '<div class="kpi-card"><div class="kpi-label">Carregando…</div></div>' +
        '</div>' +

        '<div class="grid-bot" style="margin-bottom:24px;">' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Distribuição Folha por Empresa e Departamento</div>' +
              '<div class="card-subtitle">' + (total
                ? 'Hierarquia Grupo → Empresa → Área · clique num departamento para o drill-down'
                : 'Hierarquia Empresa → Área (empresas do seu escopo) · clique num departamento para o drill-down') + '</div>' +
            '</div><div class="chip accent">Treemap</div></div>' +
            '<div data-ck="treemap"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '</div>' +
          '<div class="chart-card">' +
            '<div class="card-header"><div>' +
              '<div class="card-title">Custo por Departamento — ' + (total ? 'maior empresa do mês' : 'empresa selecionada') + '</div>' +
              '<div class="card-subtitle">Bolha = headcount · clique numa linha para detalhe e comparação</div>' +
            '</div><div class="chip accent" data-ck="deptos-chip">—</div></div>' +
            '<div data-ck="deptos"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '</div>' +
        '</div>' +

        // widget GRUPO-only: ratio folha/receita por empresa (some no escopo parcial)
        (total
          ? '<div class="chart-card">' +
              '<div class="card-header"><div>' +
                '<div class="card-title">Folha / Receita Bruta por Empresa</div>' +
                '<div class="card-subtitle">Percentual da folha mensal sobre a receita do mês · linha de referência em 20%</div>' +
              '</div><div class="chip blue">Grupo</div></div>' +
              '<div class="chart-container" style="height:220px;" data-ck="ratio-box">' +
                '<p style="color:var(--text-3);font-size:12px;">Carregando…</p>' +
              '</div>' +
            '</div>'
          : '') +

        // PANEL 04 — Headcount por departamento (NEW /api/headcount)
        '<div class="chart-card" style="margin-top:24px;">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Headcount por Departamento</div>' +
            '<div class="card-subtitle">Ranking do mês mais recente · evolução do headcount total no ano</div>' +
          '</div><div class="chip accent">Painel 04</div></div>' +
          '<div class="grid-bot">' +
            '<div>' +
              '<div class="card-subtitle" data-ck="hc-rank-title" style="margin-bottom:6px;">Ranking por departamento</div>' +
              '<div data-ck="hc-rank"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
            '</div>' +
            '<div>' +
              '<div class="card-subtitle" style="margin-bottom:6px;">Headcount total — mês a mês</div>' +
              '<div class="chart-container" style="height:220px;" data-ck="hc-mes-box">' +
                '<p style="color:var(--text-3);font-size:12px;">Carregando…</p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // PANEL 05 — Custo de pessoas por cliente (NEW /api/custo-cliente)
        '<div class="chart-card" style="margin-top:24px;">' +
          '<div class="card-header"><div>' +
            '<div class="card-title">Custo de pessoas por cliente</div>' +
            '<div class="card-subtitle">Folha do ano por cliente = custo do time dedicado + overhead rateado por receita · ordenado por receita</div>' +
          '</div><div class="chip accent">Painel 05</div></div>' +
          '<div class="grid-bot">' +
            '<div class="chart-container" style="height:300px;" data-ck="cc-box">' +
              '<p style="color:var(--text-3);font-size:12px;">Carregando…</p>' +
            '</div>' +
            '<div data-ck="cc-tabela"><p style="color:var(--text-3);font-size:12px;">Carregando…</p></div>' +
          '</div>' +
          '<p style="font-size:10px;color:var(--text-3);margin-top:10px;">' +
            'Apenas Ambev, Localiza, Safra e TecBan têm time dedicado; os demais departamentos são compartilhados (overhead). ' +
            'Regra de rateio padrão (overhead ∝ receita) — confirmar com o cliente.' +
          '</p>' +
        '</div>';

      var sel = el.querySelector('[data-ck="mes-select"]');

      // seletor de empresa — "Todas (Grupo)" (escopo total) + empresas permitidas
      var selEmp = el.querySelector('[data-ck="emp-select"]');
      if (selEmp) {
        var optsEmp = (total ? [{ slug: 'grupo', label: 'Todas (Grupo)' }] : []).concat(permitidas);
        selEmp.innerHTML = optsEmp.map(function (e) {
          return '<option value="' + esc(e.slug) + '"' + (e.slug === empresaSelC ? ' selected' : '') + '>' +
            esc(e.label) + '</option>';
        }).join('');
        selEmp.addEventListener('change', function () {
          empresaSelC = selEmp.value;
          carrega();
        });
      }

      // toggle "Base de custo": custo total (empresa) × salário bruto (recebido)
      var btnCusto = el.querySelector('[data-ck="base-custo"]');
      var btnBruto = el.querySelector('[data-ck="base-bruto"]');
      function pintaToggleBase() {
        [[btnCusto, 'custo'], [btnBruto, 'bruto']].forEach(function (par) {
          var b = par[0]; if (!b) return;
          var on = baseCusto === par[1];
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.style.border = '1px solid ' + (on ? '#D9DA00' : 'var(--border)');
          b.style.background = on ? '#D9DA00' : 'transparent';
          b.style.color = on ? '#1C1C1C' : 'var(--text-2)';
          b.style.fontWeight = on ? '600' : '400';
        });
      }
      function trocaBase(nova) {
        if (baseCusto === nova) return;
        baseCusto = nova;
        pintaToggleBase();
        carrega(); // re-renderiza usando total_custo × total (dados já em cache do backend)
      }
      if (btnCusto) btnCusto.addEventListener('click', function () { trocaBase('custo'); });
      if (btnBruto) btnBruto.addEventListener('click', function () { trocaBase('bruto'); });
      pintaToggleBase();

      function preencheSelect(mesAtivo) {
        sel.innerHTML = MESES.map(function (m, i) {
          return '<option value="' + (i + 1) + '"' + ((i + 1) === n(mesAtivo) ? ' selected' : '') + '>' + m + '</option>';
        }).join('');
      }

      function carrega() {
        destroiCharts();
        // 'grupo' = consolidado (todas); um slug = só aquela empresa (salários incluídos).
        var mostrarGrupo = (empresaSelC === 'grupo');
        var pathBase = mostrarGrupo
          ? '/api/folha/grupo' + qsFolha()
          : '/api/folha/' + encodeURIComponent(empresaSelC) + qsFolha();
        // widget grupo-only (folha/receita por empresa): só aparece em "Todas (Grupo)"
        var ratioCard = el.querySelector('[data-ck="ratio-box"]');
        ratioCard = ratioCard ? ratioCard.closest('.chart-card') : null;
        if (ratioCard) ratioCard.style.display = mostrarGrupo ? '' : 'none';

        pega(pathBase).then(function (base) {
          if (!el.isConnected) return;
          if (base && base.mes && !mesSel) {
            mesSel = n(base.mes); // mês mais recente com folha carregada
          }
          preencheSelect(mesSel || (base && base.mes));
          var empSel = mostrarGrupo ? null : permitidas.filter(function (e) { return e.slug === empresaSelC; })[0];
          if (mostrarGrupo) {
            pintaKpis(el, base);
            pintaRatio(el, base); // widget grupo-only (usa por_empresa)
          } else {
            pintaKpisEmpresa(el, empSel, base);
          }

          // PANEL 04: headcount do escopo atual (grupo consolidado OU empresa selecionada)
          // drill (base com departamentos+colaboradores) só quando UMA empresa está selecionada
          var slugHC = mostrarGrupo ? 'grupo' : empresaSelC;
          pega('/api/headcount/' + encodeURIComponent(slugHC) + qsAno()).then(function (hc) {
            if (!el.isConnected) return;
            pintaHeadcount(el, hc, mostrarGrupo ? null : base, empSel);
          });

          // PANEL 05: custo de pessoas por cliente (ano) — grupo OU empresa selecionada
          pega('/api/custo-cliente/' + encodeURIComponent(slugHC) + qsAno()).then(function (cc) {
            if (!el.isConnected) return;
            pintaCustoCliente(el, cc);
          });

          // 2) folha por empresa (departamentos) — TODAS no consolidado, ou só a
          //    empresa selecionada quando uma está escolhida (treemap/deptos filtrados)
          var alvos = mostrarGrupo ? permitidas : permitidas.filter(function (e) { return e.slug === empresaSelC; });
          Promise.all(alvos.map(function (e) {
            if (!mostrarGrupo && e.slug === empresaSelC) {
              return Promise.resolve({ empresa: e, folha: base }); // reusa a chamada base
            }
            return pega('/api/folha/' + encodeURIComponent(e.slug) + qsFolha()).then(function (f) {
              return { empresa: e, folha: f };
            });
          })).then(function (folhas) {
            if (!el.isConnected) return;
            // custo médio/funcionário por empresa (usado no botão "Comparar")
            var comparativo = folhas.map(function (f) {
              if (!f.folha) return null;
              return {
                slug: f.empresa.slug,
                label: f.empresa.label,
                color: f.empresa.color,
                headcount: n(f.folha.headcount),
                custo_medio: vMedioFolha(f.folha) // segue a base ativa
              };
            }).filter(Boolean);

            pintaTreemap(el, folhas, comparativo);
            var comFolha = folhas.filter(function (f) { return f.folha && vTotal(f.folha) > 0; });
            comFolha.sort(function (a, b) { return vTotal(b.folha) - vTotal(a.folha); });
            var destaque = comFolha[0];
            if (!mostrarGrupo) {
              // uma empresa selecionada: painel de departamentos segue a EMPRESA SELECIONADA
              var doSel = comFolha.filter(function (f) { return f.empresa.slug === empresaSelC; })[0];
              if (doSel) destaque = doSel;
            }
            pintaDeptos(el, destaque, comparativo);
          });
        });
      }

      sel.addEventListener('change', function () {
        mesSel = n(sel.value) || null;
        carrega();
      });

      mesSel = null; // sempre reabre no mês mais recente com dados
      carrega();
    }
  });
})();
