/* ═══════════════════════════════════════════════════════════════
   Cockpit Financeiro — Grupo REF · núcleo do frontend (window.CK)
   Vanilla JS + Chart.js 4 (CDN) — sem build step.
   Contrato: cockpit-app/API_CONTRACT.md (fonte da verdade).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const CK = {};
  window.CK = CK;

  /* ─── Registro de empresas (slug ↔ código do banco, cf. contrato) ─── */
  CK.EMPRESAS = [
    { slug: 'ref-plus',   code: 'REF', label: 'REF+',           color: '#D9DA00' },
    { slug: 'black-door', code: 'BD',  label: 'Black Door',     color: '#22C55E' },
    { slug: '4in',        code: '4PR', label: '4In',            color: '#F97316' },
    { slug: 'viv',        code: 'VIV', label: 'Viv Experience', color: '#A855F7' },
    { slug: 'zuptech',    code: 'ZUP', label: 'Zuptech',        color: '#3B82F6' },
  ];
  CK.GRUPO = { slug: 'grupo', code: null, label: 'Grupo REF', color: '#D9DA00' };

  // Resolve slug → objeto empresa (inclui 'grupo')
  CK.empresa = function (slug) {
    if (slug === 'grupo') return CK.GRUPO;
    return CK.EMPRESAS.find(e => e.slug === slug) || null;
  };

  /* ─── Estado global ─── */
  CK.state = {
    ano: null,     // ano selecionado no topbar
    anos: [],      // anos disponíveis (derivados de /api/historico/<1ª empresa permitida>)
    autenticado: false,
    usuario: null, // username da sessão (RBAC — Iteração 3)
    escopo: null,  // 'todas' | array de slugs permitidos | null (sessão sem RBAC → sem restrição no front)
    admin: false,  // super-admin (Iteração 4) — habilita a tela #/admin
  };

  /* ─── Super-admin (Iteração 4) ─── */
  CK.ehAdmin = function () { return !!CK.state.admin; };

  /* ─── RBAC por usuário (Iteração 3 do contrato) ───
     O front só ESCONDE o que está fora do escopo — a rede de segurança
     real é o 403 server-side em todos os endpoints. */
  CK.temAcesso = function (slug) {
    const escopo = CK.state.escopo;
    if (escopo == null) return true;      // backend antigo/sessão sem RBAC — compat
    if (escopo === 'todas') return true;
    if (slug === 'grupo') return false;   // consolidado só p/ escopo total (revela as outras)
    return Array.isArray(escopo) && escopo.indexOf(slug) !== -1;
  };

  // Empresas visíveis ao usuário, na ordem do registro (sem 'grupo')
  CK.empresasPermitidas = function () {
    return CK.EMPRESAS.filter(e => CK.temAcesso(e.slug));
  };

  // Rota inicial segura p/ o escopo: macro (total) → 1ª micro permitida → alertas
  function rotaInicial() {
    if (CK.temAcesso('grupo')) return 'macro';
    const perm = CK.empresasPermitidas();
    return perm.length ? 'micro/' + perm[0].slug : 'alertas';
  }

  /* ─── Utilidades DOM ─── */
  const $ = sel => document.querySelector(sel);

  CK.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ─── Formatação pt-BR ─── */
  const nfMi  = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nfInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const nfFull = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  CK.fmt = {
    // Moeda compacta: 94200000 → "R$ 94,2M" · 461000 → "R$ 461k" · 830 → "R$ 830"
    moeda(v) {
      if (v == null || isNaN(v)) return '—';
      const neg = v < 0, a = Math.abs(v);
      let s;
      if (a >= 1e6)      s = nfMi.format(a / 1e6) + 'M';
      else if (a >= 1e3) s = nfInt.format(a / 1e3) + 'k';
      else               s = nfInt.format(a);
      return (neg ? '−' : '') + 'R$ ' + s;
    },
    // Moeda completa: 461000 → "R$ 461.000,00"
    moedaFull(v) {
      if (v == null || isNaN(v)) return '—';
      return nfFull.format(v);
    },
    // Percentual: recebe FRAÇÃO (0.038 → "3,8%"). casas default 1.
    pct(v, casas) {
      if (v == null || isNaN(v)) return '—';
      const c = casas == null ? 1 : casas;
      return (v * 100).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) + '%';
    },
    // Percentual: recebe PERCENTUAL (3.8 → "3,8%") — convenção da API (contrato).
    percent(v, casas) {
      if (v == null || isNaN(v)) return '—';
      const c = casas == null ? 1 : casas;
      return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) + '%';
    },
    // Número inteiro pt-BR
    num(v) {
      if (v == null || isNaN(v)) return '—';
      return nfInt.format(v);
    },
  };

  /* ─── Aplicação do escopo na UI (sidebar + user-pill) ─── */
  function aplicaEscopo(sess) {
    CK.state.usuario = (sess && sess.usuario) || null;
    CK.state.admin = !!(sess && sess.admin); // Iteração 4 — default false se ausente
    const emp = sess ? sess.empresas : null;
    if (emp === 'todas') CK.state.escopo = 'todas';
    else if (Array.isArray(emp)) CK.state.escopo = emp;
    else CK.state.escopo = null; // resposta sem campo empresas (backend antigo)

    // Sidebar: esconde "Macro — Grupo" e micros fora do escopo.
    // Receitas/Custos/Alertas ficam — as telas se adaptam ao escopo.
    // "Administração" (data-route 'admin') só p/ super-admin (Iteração 4).
    document.querySelectorAll('.nav-item[data-route]').forEach(el => {
      const r = el.dataset.route;
      let visivel = true;
      if (r === 'macro') visivel = CK.temAcesso('grupo');
      else if (r === 'admin') visivel = CK.ehAdmin();
      else if (r.indexOf('micro/') === 0) visivel = CK.temAcesso(r.slice(6));
      el.style.display = visivel ? '' : 'none';
    });

    // User-pill: nome + resumo do escopo
    const nome = $('#user-nome'), escopoEl = $('#user-escopo'), av = $('#user-avatar');
    if (nome && escopoEl && av) {
      if (CK.state.usuario) {
        nome.textContent = CK.state.usuario;
        av.textContent = CK.state.usuario.slice(0, 2).toUpperCase();
      }
      const e = CK.state.escopo;
      if (e == null || e === 'todas') escopoEl.textContent = 'Acesso total';
      else if (e.length === 1) {
        const emp1 = CK.empresa(e[0]);
        escopoEl.textContent = emp1 ? emp1.label : e[0];
      } else escopoEl.textContent = e.length + ' empresas';
    }
  }

  /* ─── Login overlay ─── */
  function showLogin(msg) {
    const ov = $('#login-overlay');
    if (!ov) return;
    ov.hidden = false;
    if (msg) $('#login-msg').textContent = msg;
    const usu = $('#login-usuario');
    const inp = (usu && !usu.value) ? usu : $('#login-senha');
    if (inp) setTimeout(() => inp.focus(), 50);
  }
  function hideLogin() {
    const ov = $('#login-overlay');
    if (ov) ov.hidden = true;
    const m = $('#login-msg');
    if (m) m.textContent = '';
  }

  /* ─── CK.api — wrapper de fetch com gate de auth ─── */
  CK.api = async function (path, opts) {
    const o = Object.assign({ credentials: 'same-origin' }, opts || {});
    if (o.body && typeof o.body !== 'string') {
      o.body = JSON.stringify(o.body);
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    }
    const r = await fetch(path, o);
    if (r.status === 401) {
      CK.state.autenticado = false;
      showLogin();
      const e = new Error('401 não autenticado'); e.status = 401; throw e;
    }
    if (r.status === 503) {
      // Servidor sem COCKPIT_PASSWORD definida — fechado por padrão (cf. contrato)
      showLogin('Servidor sem senha configurada (COCKPIT_PASSWORD ausente). Contate o administrador.');
      const e = new Error('503 serviço indisponível'); e.status = 503; throw e;
    }
    if (!r.ok) {
      const e = new Error('Erro ' + r.status + ' em ' + path); e.status = r.status; throw e;
    }
    if (r.status === 204) return null;
    return r.json();
  };

  /* ─── CK.charts — helpers Chart.js tema dark ─── */
  const DARK = {
    grid:    'rgba(0,0,0,0.05)',
    ticks:   '#81807C',
    tooltipBg: '#FFFFFF',
    tooltipBorder: 'rgba(0,0,0,0.10)',
    title:   '#1C1C1C',
    body:    '#81807C',
  };

  if (window.Chart) {
    Chart.defaults.font.family = "'Urbanist', 'Inter', sans-serif";
    Chart.defaults.font.size = 10;
    Chart.defaults.color = DARK.ticks;
  }

  function tooltipDefaults() {
    return {
      backgroundColor: DARK.tooltipBg,
      borderColor: DARK.tooltipBorder,
      borderWidth: 1,
      titleColor: DARK.title,
      bodyColor: DARK.body,
      padding: 10,
    };
  }

  // merge raso de 2 níveis (suficiente p/ options do Chart.js aqui)
  function merge(base, extra) {
    const out = Object.assign({}, base);
    for (const k in (extra || {})) {
      if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = merge(base[k], extra[k]);
      } else out[k] = extra[k];
    }
    return out;
  }

  CK.charts = {
    _list: [],

    // registra instância p/ destruição na troca de tela
    track(chart) { this._list.push(chart); return chart; },

    destroyAll() {
      this._list.forEach(c => { try { c.destroy(); } catch (e) { /* já destruído */ } });
      this._list = [];
    },

    // opções base tema dark (escala cartesiana)
    baseOptions(extra) {
      const base = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipDefaults(),
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: DARK.ticks, font: { family: "'Urbanist', 'Inter', sans-serif", size: 10 } },
            border: { color: 'rgba(0,0,0,0.07)' },
          },
          y: {
            grid: { color: DARK.grid },
            ticks: { color: DARK.ticks, font: { family: "'Urbanist', 'Inter', sans-serif", size: 10 } },
            border: { dash: [3, 3], color: 'transparent' },
          },
        },
      };
      return merge(base, extra);
    },

    // cria chart genérico, aplica aria-label e track
    _make(canvas, config, aria) {
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', aria || 'Gráfico');
      return this.track(new Chart(canvas.getContext('2d'), config));
    },

    // create(canvas, config): config Chart.js cru — preserva aria já definida no canvas.
    // É a interface que as telas usam; garante track() (destroy na troca de rota).
    create(canvas, config) {
      return this._make(canvas, config,
        (config && config.aria) || canvas.getAttribute('aria-label'));
    },

    // Barras: makeBar(canvas, {labels, datasets, aria, options})
    makeBar(canvas, cfg) {
      return this._make(canvas, {
        type: 'bar',
        data: { labels: cfg.labels, datasets: cfg.datasets },
        options: this.baseOptions(cfg.options),
      }, cfg.aria);
    },

    // Donut: makeDonut(canvas, {labels, data, colors, aria, cutout, options})
    makeDonut(canvas, cfg) {
      const options = merge({
        responsive: true,
        maintainAspectRatio: false,
        cutout: cfg.cutout || '68%',
        plugins: { legend: { display: false }, tooltip: tooltipDefaults() },
      }, cfg.options);
      return this._make(canvas, {
        type: 'doughnut',
        data: {
          labels: cfg.labels,
          datasets: [{
            data: cfg.data,
            backgroundColor: cfg.colors,
            borderColor: '#FFFFFF',
            borderWidth: 3,
            hoverBorderWidth: 2,
          }],
        },
        options,
      }, cfg.aria);
    },

    // Composto (barras + linha): datasets já vêm com type por dataset
    makeComposed(canvas, cfg) {
      return this._make(canvas, {
        type: 'bar',
        data: { labels: cfg.labels, datasets: cfg.datasets },
        options: this.baseOptions(cfg.options),
      }, cfg.aria);
    },
  };

  /* ═══════════════════════════════════════════════════════════════
     CK.exportInit() — exportação universal (PNG / XLSX-CSV)
     ───────────────────────────────────────────────────────────────
     Torna TODO quadro do cockpit exportável sem editar cada painel.
     Varre #content atrás de .chart-card, injeta um botão "⤓" discreto
     (canto sup. dir.) que abre um menu com "PNG" e "XLSX/CSV".
       • PNG  — do <canvas> do card (fundo branco p/ tema claro) → download.
       • CSV  — da instância Chart.js rastreada em CK.charts (labels +
                datasets); se não houver gráfico, faz fallback p/ o <table>.
     Idempotente: marca cards já processados. Um MutationObserver em
     #content reprocessa cards renderizados de forma assíncrona.
     Não depende de nada nas telas — trabalha 100% a partir do DOM.
     ═══════════════════════════════════════════════════════════════ */

  // localiza a instância Chart.js (rastreada em CK.charts._list) de um canvas
  function chartForCanvas(canvas) {
    const list = (CK.charts && CK.charts._list) || [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c && (c.canvas === canvas || (c.ctx && c.ctx.canvas === canvas))) return c;
    }
    return null;
  }

  // título legível do card (para nome de arquivo e cabeçalho)
  function cardTitulo(card) {
    const t = card.querySelector('.card-title');
    return (t ? t.textContent : '').trim() || 'quadro';
  }

  // nome de arquivo seguro: "titulo-ano.ext"
  function nomeArquivo(card, ext) {
    const base = (cardTitulo(card) + '-' + (CK.state.ano || ''))
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove acentos
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'quadro';
    return base + '.' + ext;
  }

  // dispara download de um Blob/URL
  function baixar(url, nome, revoga) {
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    if (revoga) setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // ── PNG: canvas → PNG com fundo branco (tema claro) ──
  function exportarPNG(card) {
    const canvas = card.querySelector('canvas');
    if (!canvas) { alert('Este quadro não tem gráfico para exportar como imagem.'); return; }
    // recompõe sobre fundo branco (o canvas do Chart.js é transparente)
    const w = canvas.width, h = canvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);
    let url;
    try { url = tmp.toDataURL('image/png'); }
    catch (e) { alert('Não foi possível gerar a imagem.'); return; }
    baixar(url, nomeArquivo(card, 'png'), false);
  }

  // escapa uma célula p/ CSV (separador ';', aspas duplas RFC-4180)
  function csvCell(v) {
    let s = (v == null) ? '' : String(v);
    if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  // número → string pt-BR (vírgula decimal) p/ o Excel; texto passa direto
  function csvNum(v) {
    if (typeof v === 'number' && isFinite(v)) return String(v).replace('.', ',');
    if (v && typeof v === 'object') {                       // ponto {x,y} do Chart.js
      const n = (v.y != null) ? v.y : (v.v != null ? v.v : null);
      if (typeof n === 'number' && isFinite(n)) return String(n).replace('.', ',');
    }
    return v == null ? '' : String(v);
  }
  // monta o texto CSV a partir de matriz de linhas (arrays de células)
  function montaCSV(linhas) {
    const corpo = linhas.map(row => row.map(csvCell).join(';')).join('\r\n');
    return '﻿' + corpo;   // BOM → Excel reconhece UTF-8
  }
  function baixarCSV(card, linhas) {
    const blob = new Blob([montaCSV(linhas)], { type: 'text/csv;charset=utf-8;' });
    baixar(URL.createObjectURL(blob), nomeArquivo(card, 'csv'), true);
  }

  // ── CSV a partir da instância Chart.js ──
  function csvDeChart(chart, card) {
    const data = chart.data || {};
    const labels = data.labels || [];
    const ds = data.datasets || [];
    const cab = ['']; // 1ª coluna = rótulos das linhas (categorias/eixo X)
    ds.forEach((d, i) => cab.push(d.label != null ? d.label : ('Série ' + (i + 1))));
    const linhas = [cab];
    const n = labels.length || ds.reduce((m, d) => Math.max(m, (d.data || []).length), 0);
    for (let i = 0; i < n; i++) {
      const row = [labels[i] != null ? labels[i] : ('#' + (i + 1))];
      ds.forEach(d => row.push(csvNum((d.data || [])[i])));
      linhas.push(row);
    }
    baixarCSV(card, linhas);
  }

  // ── CSV a partir de um <table> (fallback p/ cards de tabela) ──
  function csvDeTabela(table, card) {
    const linhas = [];
    table.querySelectorAll('tr').forEach(tr => {
      const cels = tr.querySelectorAll('th,td');
      if (!cels.length) return;
      const row = [];
      cels.forEach(td => row.push(td.textContent.replace(/\s+/g, ' ').trim()));
      linhas.push(row);
    });
    if (!linhas.length) { alert('Nada para exportar neste quadro.'); return; }
    baixarCSV(card, linhas);
  }

  // decide a fonte dos dados do card e exporta CSV
  function exportarCSV(card) {
    const canvas = card.querySelector('canvas');
    const chart = canvas && chartForCanvas(canvas);
    if (chart) { csvDeChart(chart, card); return; }
    const table = card.querySelector('table');
    if (table) { csvDeTabela(table, card); return; }
    alert('Este quadro não tem dados tabulares para exportar.');
  }

  // um card é exportável se tiver gráfico OU tabela
  function cardExportavel(card) {
    return !!(card.querySelector('canvas') || card.querySelector('table'));
  }

  // fecha qualquer menu de exportação aberto
  function fechaMenuExport() {
    const m = document.querySelector('.ck-export-menu');
    if (m) m.remove();
    document.removeEventListener('click', fechaMenuExport, true);
    document.removeEventListener('keydown', onKeyExport, true);
  }
  function onKeyExport(ev) { if (ev.key === 'Escape') fechaMenuExport(); }

  // abre o menu ancorado ao botão do card
  function abreMenuExport(btn, card) {
    fechaMenuExport();
    const menu = document.createElement('div');
    menu.className = 'ck-export-menu';
    menu.setAttribute('role', 'menu');
    const temGrafico = !!card.querySelector('canvas');
    const itens = [];
    if (temGrafico) itens.push(['png', 'PNG (imagem)']);
    itens.push(['csv', 'XLSX/CSV']);
    itens.forEach(([tipo, rot]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ck-export-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = rot;
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        fechaMenuExport();
        if (tipo === 'png') exportarPNG(card); else exportarCSV(card);
      });
      menu.appendChild(b);
    });
    // posiciona sob o botão (dentro do card, que é position:relative)
    menu.style.top = (btn.offsetTop + btn.offsetHeight + 4) + 'px';
    menu.style.right = '12px';
    card.appendChild(menu);
    const first = menu.querySelector('.ck-export-item');
    if (first) first.focus();
    // fechar ao clicar fora / Esc (captura p/ pegar antes de outros handlers)
    setTimeout(() => {
      document.addEventListener('click', fechaMenuExport, true);
      document.addEventListener('keydown', onKeyExport, true);
    }, 0);
  }

  // injeta o botão "⤓" num card ainda não processado
  function injetaBotao(card) {
    if (card.dataset.ckExport) return;         // já processado (idempotente)
    if (!cardExportavel(card)) return;         // nada a exportar (ex.: card de flags)
    card.dataset.ckExport = '1';
    card.classList.add('ck-has-export');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ck-export-btn';
    btn.setAttribute('aria-label', 'Exportar quadro');
    btn.title = 'Exportar quadro';
    btn.textContent = '⤓';
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (card.querySelector('.ck-export-menu')) { fechaMenuExport(); return; }
      abreMenuExport(btn, card);
    });
    card.appendChild(btn);
  }

  // varre #content e injeta botões nos cards elegíveis (idempotente)
  function scanExport() {
    const root = document.getElementById('content');
    if (!root) return;
    root.querySelectorAll('.chart-card').forEach(injetaBotao);
  }

  // injeta o CSS do módulo uma única vez (tema claro)
  function ensureExportCSS() {
    if (document.getElementById('ck-export-style')) return;
    const st = document.createElement('style');
    st.id = 'ck-export-style';
    st.textContent =
      '.ck-has-export{position:relative;}' +
      '.ck-export-btn{position:absolute;top:12px;right:12px;z-index:5;' +
        'width:26px;height:26px;padding:0;line-height:24px;text-align:center;' +
        'font-size:15px;cursor:pointer;color:var(--text-3);' +
        'background:var(--bg-card);border:1px solid var(--border);' +
        'border-radius:var(--radius-sm,6px);opacity:0;transition:opacity .15s,color .15s,border-color .15s;}' +
      '.chart-card:hover .ck-export-btn,.ck-export-btn:focus-visible,' +
        '.ck-has-export:focus-within .ck-export-btn{opacity:1;}' +
      '.ck-export-btn:hover{color:var(--text-1);border-color:var(--accent,#D9DA00);}' +
      '.ck-export-btn:focus-visible{outline:2px solid var(--accent,#D9DA00);outline-offset:2px;}' +
      '.ck-export-menu{position:absolute;z-index:20;min-width:140px;padding:4px;' +
        'background:var(--bg-card,#fff);border:1px solid var(--border,#E6E3DC);' +
        'border-radius:var(--radius,10px);box-shadow:0 6px 24px rgba(0,0,0,0.12);}' +
      '.ck-export-item{display:block;width:100%;text-align:left;' +
        'padding:8px 10px;font-size:12px;font-weight:500;color:var(--text-1,#1C1C1C);' +
        'background:none;border:0;border-radius:var(--radius-sm,6px);cursor:pointer;}' +
      '.ck-export-item:hover,.ck-export-item:focus-visible{background:var(--accent-dim,rgba(217,218,0,0.16));' +
        'color:var(--text-1,#1C1C1C);outline:none;}';
    document.head.appendChild(st);
  }

  let _exportObserver = null;
  // Chamável a cada render (idempotente). Instala CSS + observer 1x e varre agora.
  CK.exportInit = function () {
    ensureExportCSS();
    const root = document.getElementById('content');
    if (root && !_exportObserver) {
      // reprocessa cards renderizados de forma assíncrona pelas telas
      _exportObserver = new MutationObserver(function () {
        if (CK._exportRaf) return;
        CK._exportRaf = requestAnimationFrame(function () {
          CK._exportRaf = 0; scanExport();
        });
      });
      _exportObserver.observe(root, { childList: true, subtree: true });
    }
    scanExport();
  };

  /* ═══════════════════════════════════════════════════════════════
     CK.layoutInit() — gerenciador de layout por tela (mostrar/ordenar)
     ───────────────────────────────────────────────────────────────
     Genérico e 100% DOM: cada .chart-card/.card dentro de #content que
     tenha um .card-title ou .sec-title é "gerenciável". A CHAVE estável
     é o TEXTO do título normalizado (trim + espaços colapsados + minúsculas
     + sem acentos). A TELA é parseHash().name.
       • Aplica o layout salvo (GET /api/layout/<tela>, cache por tela):
         esconde cards em config.ocultos e reordena conforme config.ordem.
         Cards novos (fora da config) seguem visíveis na posição natural.
       • Botão "Personalizar" (topbar, ao lado de #btn-relatorio) abre um
         drawer com checkbox (visível) + ↑/↓ (reordenar) por card, além de
         "Restaurar padrão" e "Salvar" (PUT /api/layout/<tela>).
     Idempotente: reaplica limpo a cada render; 401/erros → tudo visível.
     ═══════════════════════════════════════════════════════════════ */

  const _layoutCache = {};   // tela → { ordem:[], ocultos:[] }

  // tela p/ o layout: micro é POR EMPRESA (micro/<slug>), senão o nome da rota
  function telaAtual() {
    const r = parseHash();
    return r.name === 'micro' && r.params && r.params.slug ? 'micro/' + r.params.slug : r.name;
  }

  // normaliza o título → chave estável (remove contadores "(N)" e sufixos voláteis
  // após em/en-dash, ex.: "DRE Mês a Mês — Jun/26"), removendo acentos.
  function normKey(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')      // remove acentos
      .replace(/\s*\(\s*\d[\d.,\s]*\)\s*/g, ' ')             // remove "(N)" volátil
      .replace(/\s+[—–]\s.*$/, '')                           // remove sufixo após — / –
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Chave do card: prefere um atributo ESTÁVEL (data-ck-key do card ou o 1º
  // [data-ck] interno, ex.: 'dre-cascata') — imune a título com dado ao vivo;
  // só cai no título normalizado quando não há atributo.
  function cardKey(card, titulo) {
    const attr = card.getAttribute('data-ck-key');
    if (attr) return 'k:' + attr;
    const dc = card.querySelector('[data-ck]');
    if (dc && dc.getAttribute('data-ck')) return 'ck:' + dc.getAttribute('data-ck');
    return normKey(titulo);
  }

  // cards gerenciáveis da tela atual → [{card, key, titulo}] (ordem do DOM)
  function manageableCards() {
    const root = document.getElementById('content');
    if (!root) return [];
    const seen = [], out = [];
    root.querySelectorAll('.card-title, .sec-title').forEach(function (t) {
      const card = t.closest('.chart-card, .card');
      if (!card || seen.indexOf(card) !== -1) return;
      const titulo = (t.textContent || '').trim();
      const key = cardKey(card, titulo);
      if (!key) return;
      seen.push(card);
      out.push({ card: card, key: key, titulo: titulo });
    });
    return out;
  }

  // aplica config {ordem, ocultos} aos cards vivos (idempotente)
  function applyLayout(cfg) {
    const items = manageableCards();
    if (!items.length) return;
    const ocultos = (cfg && cfg.ocultos) || [];
    const ordem = (cfg && cfg.ordem) || [];
    // visibilidade — só mexe no que este módulo escondeu (dataset marca a origem)
    items.forEach(function (it) {
      if (ocultos.indexOf(it.key) !== -1) {
        it.card.style.display = 'none';
        it.card.dataset.ckHidden = '1';
      } else if (it.card.dataset.ckHidden) {
        it.card.style.display = '';
        delete it.card.dataset.ckHidden;
      }
    });
    // reordenação — anexa cada chave conhecida na sequência salva, dentro do seu
    // pai. Cards novos (fora de `ordem`) não são movidos → posição natural.
    if (ordem.length) {
      const byKey = {};
      items.forEach(function (it) { if (!(it.key in byKey)) byKey[it.key] = it; });
      ordem.forEach(function (k) {
        const it = byKey[k];
        if (it && it.card.parentNode) it.card.parentNode.appendChild(it.card);
      });
    }
  }

  // GET do layout com cache por tela; 404/erro → default vazio; 401 propaga
  function loadLayout(tela) {
    if (Object.prototype.hasOwnProperty.call(_layoutCache, tela)) {
      return Promise.resolve(_layoutCache[tela]);
    }
    return CK.api('/api/layout/' + encodeURIComponent(tela)).then(function (r) {
      const c = (r && r.config) ? r.config : (r || {});
      const cfg = { ordem: c.ordem || [], ocultos: c.ocultos || [] };
      _layoutCache[tela] = cfg;
      return cfg;
    }, function (e) {
      if (e && e.status === 401) throw e;   // overlay de login já exibido
      const cfg = { ordem: [], ocultos: [] };
      _layoutCache[tela] = cfg;             // 404/erro → não fica re-tentando
      return cfg;
    });
  }

  // CSS do módulo (tema claro) — 1x
  function ensureLayoutCSS() {
    if (document.getElementById('ck-layout-style')) return;
    const st = document.createElement('style');
    st.id = 'ck-layout-style';
    st.textContent =
      '.btn-personalizar{display:inline-flex;align-items:center;gap:6px;' +
        'padding:7px 12px;background:var(--bg-hover);color:var(--text-1);' +
        'border:1px solid var(--border);border-radius:8px;cursor:pointer;' +
        'font-size:12px;font-weight:600;font-family:inherit;transition:opacity .15s,border-color .15s;}' +
      '.btn-personalizar:hover{border-color:var(--accent,#D9DA00);}' +
      '.btn-personalizar:focus-visible{outline:2px solid var(--accent,#D9DA00);outline-offset:2px;}' +
      '.ck-lay-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}' +
      '.ck-lay-row{display:flex;align-items:center;gap:10px;padding:10px 12px;' +
        'background:var(--bg-card,#fff);border:1px solid var(--border,#E6E3DC);' +
        'border-radius:var(--radius-sm,6px);}' +
      '.ck-lay-row.oculto{opacity:.55;}' +
      '.ck-lay-chk{width:16px;height:16px;flex:0 0 auto;cursor:pointer;accent-color:var(--accent,#D9DA00);}' +
      '.ck-lay-titulo{flex:1;font-size:13px;color:var(--text-1,#1C1C1C);' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.ck-lay-mv{width:28px;height:28px;padding:0;flex:0 0 auto;line-height:26px;' +
        'text-align:center;font-size:14px;cursor:pointer;color:var(--text-3);' +
        'background:var(--bg-hover);border:1px solid var(--border);border-radius:var(--radius-sm,6px);}' +
      '.ck-lay-mv:hover:not([disabled]){color:var(--text-1);border-color:var(--accent,#D9DA00);}' +
      '.ck-lay-mv:focus-visible{outline:2px solid var(--accent,#D9DA00);outline-offset:2px;}' +
      '.ck-lay-mv[disabled]{opacity:.35;cursor:default;}' +
      '.ck-lay-foot{display:flex;gap:10px;align-items:center;margin-top:18px;' +
        'padding-top:16px;border-top:1px solid var(--border,#E6E3DC);}' +
      '.ck-lay-msg{flex:1;font-size:12px;color:var(--red,#E5484D);}' +
      '.ck-lay-btn{padding:8px 14px;font-size:12px;font-weight:600;font-family:inherit;' +
        'border-radius:var(--radius-sm,6px);cursor:pointer;}' +
      '.ck-lay-btn.prim{background:var(--ink,#1C1C1C);color:#F9F8F6;border:none;}' +
      '.ck-lay-btn.sec{background:none;color:var(--text-1);border:1px solid var(--border);}' +
      '.ck-lay-btn:focus-visible{outline:2px solid var(--accent,#D9DA00);outline-offset:2px;}' +
      '.ck-lay-btn[disabled]{opacity:.5;cursor:progress;}' +
      '.ck-lay-vazio{font-size:13px;color:var(--text-3);}';
    document.head.appendChild(st);
  }

  // injeta o botão "Personalizar" na topbar, ao lado do relatório (1x)
  function ensureLayoutButton() {
    if (document.getElementById('btn-personalizar')) return;
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const rel = document.getElementById('btn-relatorio');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-personalizar';
    btn.className = 'btn-personalizar';
    btn.setAttribute('aria-label', 'Personalizar painéis desta tela');
    btn.title = 'Personalizar painéis desta tela';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line>' +
        '<line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line>' +
        '<line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line>' +
        '<line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line>' +
        '<line x1="17" y1="16" x2="23" y2="16"></line></svg>' +
      '<span>Personalizar</span>';
    btn.addEventListener('click', openLayoutDrawer);
    if (rel && rel.parentNode) rel.parentNode.insertBefore(btn, rel);
    else topbar.appendChild(btn);
  }

  // abre o drawer de personalização da tela atual
  function openLayoutDrawer() {
    const tela = telaAtual();
    const items = manageableCards();
    if (!items.length) {
      CK.openDrawer({
        title: 'Personalizar painéis',
        render: function (body) {
          body.innerHTML = '<div class="ck-lay-vazio">Nenhum painel gerenciável nesta tela.</div>';
        },
      });
      return;
    }
    const tituloByKey = {};
    items.forEach(function (it) { tituloByKey[it.key] = it.titulo; });

    loadLayout(tela).then(function (saved) {
      // estado de trabalho: ordem = salvos presentes + novos (posição natural ao fim)
      const present = items.map(function (it) { return it.key; });
      const work = [];
      (saved.ordem || []).forEach(function (k) {
        if (present.indexOf(k) !== -1 && work.indexOf(k) === -1) work.push(k);
      });
      present.forEach(function (k) { if (work.indexOf(k) === -1) work.push(k); });
      const hidden = {};
      (saved.ocultos || []).forEach(function (k) { hidden[k] = true; });

      const close = CK.openDrawer({
        title: 'Personalizar painéis',
        subtitle: 'Marque para exibir · use ↑ ↓ para reordenar',
        render: function (body) {
          const list = document.createElement('ul');
          list.className = 'ck-lay-list';
          list.setAttribute('role', 'list');

          const msg = document.createElement('div');
          msg.className = 'ck-lay-msg';
          msg.setAttribute('role', 'alert');

          function renderList() {
            list.innerHTML = '';
            work.forEach(function (key, idx) {
              const titulo = tituloByKey[key] || key;
              const li = document.createElement('li');
              li.className = 'ck-lay-row' + (hidden[key] ? ' oculto' : '');

              const chk = document.createElement('input');
              chk.type = 'checkbox';
              chk.className = 'ck-lay-chk';
              chk.checked = !hidden[key];
              chk.setAttribute('aria-label', 'Exibir painel ' + titulo);
              chk.addEventListener('change', function () {
                if (chk.checked) delete hidden[key]; else hidden[key] = true;
                li.classList.toggle('oculto', !chk.checked);
              });

              const lbl = document.createElement('span');
              lbl.className = 'ck-lay-titulo';
              lbl.textContent = titulo;                 // textContent → seguro
              lbl.title = titulo;

              const up = document.createElement('button');
              up.type = 'button';
              up.className = 'ck-lay-mv';
              up.textContent = '↑';
              up.setAttribute('aria-label', 'Mover ' + titulo + ' para cima');
              up.disabled = idx === 0;
              up.addEventListener('click', function () {
                if (idx === 0) return;
                work.splice(idx - 1, 0, work.splice(idx, 1)[0]);
                renderList();
              });

              const down = document.createElement('button');
              down.type = 'button';
              down.className = 'ck-lay-mv';
              down.textContent = '↓';
              down.setAttribute('aria-label', 'Mover ' + titulo + ' para baixo');
              down.disabled = idx === work.length - 1;
              down.addEventListener('click', function () {
                if (idx === work.length - 1) return;
                work.splice(idx + 1, 0, work.splice(idx, 1)[0]);
                renderList();
              });

              li.appendChild(chk);
              li.appendChild(lbl);
              li.appendChild(up);
              li.appendChild(down);
              list.appendChild(li);
            });
          }
          renderList();

          const foot = document.createElement('div');
          foot.className = 'ck-lay-foot';

          const bRestaurar = document.createElement('button');
          bRestaurar.type = 'button';
          bRestaurar.className = 'ck-lay-btn sec';
          bRestaurar.textContent = 'Restaurar padrão';
          bRestaurar.setAttribute('aria-label', 'Restaurar layout padrão (tudo visível, ordem natural)');

          const bSalvar = document.createElement('button');
          bSalvar.type = 'button';
          bSalvar.className = 'ck-lay-btn prim';
          bSalvar.textContent = 'Salvar';

          function trava(v) { bSalvar.disabled = v; bRestaurar.disabled = v; }

          function persistir(config, aoOk) {
            trava(true);
            msg.textContent = '';
            CK.api('/api/layout/' + encodeURIComponent(tela),
                   { method: 'PUT', body: { config: config } })
              .then(function () {
                _layoutCache[tela] = { ordem: config.ordem, ocultos: config.ocultos };
                close();
                aoOk();
              }, function (e) {
                trava(false);
                if (e && e.status === 401) { close(); return; } // overlay já exibido
                msg.textContent = 'Falha ao salvar. Tente novamente.';
              });
          }

          bSalvar.addEventListener('click', function () {
            const ocultos = work.filter(function (k) { return hidden[k]; });
            const config = { ordem: work.slice(), ocultos: ocultos };
            persistir(config, function () {
              if (telaAtual() === tela) applyLayout(_layoutCache[tela]);
            });
          });

          bRestaurar.addEventListener('click', function () {
            // limpa a config → tudo visível, ordem natural (re-render devolve o DOM original)
            persistir({ ordem: [], ocultos: [] }, function () {
              if (telaAtual() === tela) CK.route();
            });
          });

          foot.appendChild(msg);
          foot.appendChild(bRestaurar);
          foot.appendChild(bSalvar);

          body.appendChild(list);
          body.appendChild(foot);
        },
      });
    }, function () { /* 401/erro → não abre alterações; overlay tratado em CK.api */ });
  }

  // Chamável a cada render (idempotente). Instala CSS+botão (1x) e aplica o layout.
  CK.layoutInit = function () {
    ensureLayoutCSS();
    ensureLayoutButton();
    const tela = telaAtual();
    loadLayout(tela).then(function (cfg) {
      if (telaAtual() === tela) applyLayout(cfg);   // ignora se a tela já mudou
    }, function () { /* 401/erro → tudo visível (default) */ });
  };

  /* ─── Drawer (slide-over) — nível 1 e 2 (empilhado) ─── */
  // CK.openDrawer({title, subtitle, render(bodyEl), level:1|2}) → função close()
  CK.openDrawer = function (cfg) {
    const level = cfg.level === 2 ? 2 : 1;
    const lvlCls = level === 2 ? ' l3' : '';

    const overlay = document.createElement('div');
    overlay.className = 'drawer-overlay' + lvlCls;

    const drawer = document.createElement('div');
    drawer.className = 'drawer' + lvlCls;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', cfg.title || 'Detalhe');
    drawer.innerHTML =
      '<div class="drawer-header">' +
        '<div><div class="drawer-title">' + CK.esc(cfg.title || '') + '</div>' +
        (cfg.subtitle ? '<div class="drawer-sub">' + CK.esc(cfg.subtitle) + '</div>' : '') +
        '</div>' +
        '<button class="drawer-close" type="button" aria-label="Fechar">✕</button>' +
      '</div>' +
      '<div class="drawer-body"></div>';

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      const i = CK._drawerStack.indexOf(close);
      if (i >= 0) CK._drawerStack.splice(i, 1);
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { overlay.remove(); drawer.remove(); }, 220);
    }
    // Escape fecha SÓ o drawer do topo da pilha (L2 antes do L1)
    function onKey(ev) {
      if (ev.key === 'Escape' && CK._drawerStack[CK._drawerStack.length - 1] === close) close();
    }

    CK._drawerStack = CK._drawerStack || [];
    CK._drawerStack.push(close);
    drawer.querySelector('.drawer-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    // renderiza conteúdo antes da animação de entrada
    if (typeof cfg.render === 'function') {
      try { cfg.render(drawer.querySelector('.drawer-body')); }
      catch (e) {
        drawer.querySelector('.drawer-body').innerHTML =
          '<div class="empty-state">Erro ao carregar detalhe.</div>';
        console.error('CK.openDrawer render:', e);
      }
    }

    requestAnimationFrame(() => requestAnimationFrame(() => {
      overlay.classList.add('open');
      drawer.classList.add('open');
    }));

    return close;
  };

  /* ─── Telas + roteador hash ─── */
  const screens = {};

  // CK.registerScreen('macro', {title, subtitle, render(el, params)})
  // title/subtitle podem ser string ou função(params) → string
  CK.registerScreen = function (name, def) { screens[name] = def; };

  CK.setTopbar = function (title, subtitle) {
    $('#topbar-title').textContent = title || '';
    $('#topbar-sub').textContent = subtitle || '';
  };

  function parseHash() {
    const h = (location.hash || '#/macro').replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'micro' && parts[1]) return { name: 'micro', params: { slug: parts[1] } };
    if (['macro', 'receitas', 'custos', 'alertas', 'admin', 'cenarios'].includes(parts[0]))
      return { name: parts[0], params: {} };
    return { name: 'macro', params: {} };
  }

  function setActiveNav(route) {
    const key = route.name === 'micro' ? 'micro/' + route.params.slug : route.name;
    document.querySelectorAll('.nav-item[data-route]').forEach(el => {
      el.classList.toggle('active', el.dataset.route === key);
    });
  }

  CK.route = function () {
    const route = parseHash();

    // Guarda RBAC: macro (consolidado) ou micro fora do escopo → 1ª rota permitida.
    // (Cobre também o hash default '#/macro' no load de usuário com escopo parcial.)
    const negada =
      (route.name === 'macro' && !CK.temAcesso('grupo')) ||
      (route.name === 'admin' && !CK.ehAdmin()) ||
      (route.name === 'micro' && !CK.temAcesso(route.params.slug));
    if (negada) { location.hash = '#/' + rotaInicial(); return; } // hashchange re-roteia

    setActiveNav(route);

    const def = screens[route.name];
    const container = $('#content');

    // destrói charts da tela anterior e limpa o container
    CK.charts.destroyAll();
    container.innerHTML = '';

    if (!def) {
      CK.setTopbar('Em construção', '');
      container.innerHTML = '<div class="empty-state">Tela "' + CK.esc(route.name) + '" ainda não registrada.</div>';
      return;
    }

    const t = typeof def.title === 'function' ? def.title(route.params) : def.title;
    const s = typeof def.subtitle === 'function' ? def.subtitle(route.params) : def.subtitle;
    CK.setTopbar(t, s);

    try {
      const ret = def.render(container, route.params);
      // Exportação universal: instala CSS+observer (1x) e varre os cards já
      // presentes. O MutationObserver cobre os cards renderizados de forma
      // assíncrona; a varredura pós-promessa cobre o caso síncrono comum.
      CK.exportInit();
      CK.layoutInit();
      if (ret && typeof ret.then === 'function') {
        ret.then(() => { CK.exportInit(); CK.layoutInit(); }, e => {
          if (e && e.status === 401) return; // overlay de login já exibido
          console.error('CK.route render:', e);
          container.innerHTML = '<div class="empty-state">Erro ao carregar dados. Tente novamente.</div>';
        });
      }
    } catch (e) {
      console.error('CK.route render:', e);
      container.innerHTML = '<div class="empty-state">Erro ao carregar a tela.</div>';
    }
  };

  window.addEventListener('hashchange', CK.route);

  /* ─── Filtro de ano (topbar) ─── */
  function populateAnoSelect() {
    const sel = $('#ano-select');
    sel.innerHTML = '';
    // mais recente primeiro
    [...CK.state.anos].sort((a, b) => b - a).forEach(ano => {
      const opt = document.createElement('option');
      opt.value = ano;
      opt.textContent = ano;
      if (ano === CK.state.ano) opt.selected = true;
      sel.appendChild(opt);
    });
    updateBadgeProj();
  }

  function updateBadgeProj() {
    $('#badge-proj-txt').textContent = 'Projeção ' + (CK.state.ano || '—');
  }

  $('#ano-select') && $('#ano-select').addEventListener('change', function () {
    CK.state.ano = parseInt(this.value, 10);
    updateBadgeProj();
    CK.route(); // re-renderiza tela atual com novo ano
  });

  /* ─── Badge de alertas (críticos não snoozados) ─── */
  CK.refreshAlertBadge = async function () {
    try {
      const data = await CK.api('/api/alertas');
      const snoozed = data.snoozed || [];
      const n = (data.criticos || []).filter(a => !snoozed.includes(a.id)).length;
      const badge = $('#nav-alertas-badge');
      badge.textContent = n;
      badge.hidden = n === 0;
    } catch (e) { /* silencioso — badge é acessório */ }
  };

  /* ─── Bootstrap pós-autenticação ─── */
  // sess = payload de GET /api/session ({usuario, empresas}); se ausente, busca aqui
  async function afterLogin(sess) {
    if (!sess) {
      try { sess = await CK.api('/api/session'); }
      catch (e) { if (e && (e.status === 401 || e.status === 503)) return; sess = null; }
    }
    CK.state.autenticado = true;
    aplicaEscopo(sess);
    hideLogin();
    if (CK.initAssistente) CK.initAssistente();   // Quadro 12 — barra do assistente

    // Lista de anos: contrato não tem /api/anos — deriva do histórico da 1ª empresa
    // PERMITIDA (ref-plus daria 403 p/ usuário de escopo parcial sem REF+)
    const perm = CK.empresasPermitidas();
    if (!perm.length && Array.isArray(CK.state.escopo)) {
      // escopo vazio: nenhuma chamada de dados (seria 403); defaults do ano
      CK.state.ano = new Date().getFullYear();
      CK.state.anos = [CK.state.ano];
      populateAnoSelect();
      CK.route();
      return;
    }
    const slugHist = perm.length ? perm[0].slug : 'ref-plus';
    try {
      const [, hist] = await Promise.all([
        CK.api('/api/empresas').catch(() => null), // sanity-check; registro local é a fonte de cores
        CK.api('/api/historico/' + slugHist),
      ]);
      CK.state.anos = (hist.anos || []).map(a => a.ano).sort((a, b) => a - b);
      CK.state.ano = CK.state.anos.length ? CK.state.anos[CK.state.anos.length - 1] : new Date().getFullYear();
    } catch (e) {
      if (e && e.status === 401) return;
      CK.state.ano = new Date().getFullYear();
      CK.state.anos = [CK.state.ano];
      console.error('CK.init anos:', e);
    }
    populateAnoSelect();
    CK.refreshAlertBadge(); // não bloqueia
    CK.route();
  }

  /* ─── Formulário de login ─── */
  $('#login-form') && $('#login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const btn = $('#login-btn'), msg = $('#login-msg');
    btn.disabled = true;
    msg.textContent = '';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usuario: ($('#login-usuario') ? $('#login-usuario').value.trim().toLowerCase() : ''),
          senha: $('#login-senha').value,
        }),
      });
      if (r.status === 204 || r.ok) {
        $('#login-senha').value = '';
        await afterLogin(null); // busca /api/session p/ usuario + escopo
      } else if (r.status === 401) {
        msg.textContent = 'Usuário ou senha incorretos. Tente novamente.';
      } else if (r.status === 503) {
        msg.textContent = 'Servidor sem senha configurada (COCKPIT_PASSWORD ausente). Contate o administrador.';
      } else {
        msg.textContent = 'Erro ' + r.status + ' ao autenticar.';
      }
    } catch (e) {
      msg.textContent = 'Falha de rede — servidor indisponível.';
    } finally {
      btn.disabled = false;
    }
  });

  /* ─── Logout ───
     Apaga o cookie no servidor e RECARREGA a página: garante que nenhum dado
     da sessão anterior (charts, state, drawers) sobreviva na memória do browser
     — importante em máquina compartilhada. Recarregar cai no gate de login. */
  CK.logout = async function () {
    const btn = $('#btn-logout');
    if (btn) btn.disabled = true;
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {
      /* mesmo offline seguimos: o reload devolve ao gate de login */
    } finally {
      CK.state.autenticado = false;
      CK.state.usuario = null;
      CK.state.escopo = null;
      CK.state.admin = false;
      // sem hash → recarrega no gate de login (replace: não deixa "voltar" p/ a sessão)
      window.location.replace(window.location.pathname);
    }
  };

  $('#btn-logout') && $('#btn-logout').addEventListener('click', function () {
    if (window.confirm('Deseja sair da sua sessão?')) CK.logout();
  });

  /* ─── Baixar relatório mensal (PPTX editável) ───
     slug da rota atual (macro/consolidado → grupo; micro/<slug> → empresa;
     telas sem empresa → 1ª permitida). O download carrega o cookie de sessão. */
  CK.slugAtual = function () {
    const r = parseHash();
    if (r.name === 'micro' && r.params.slug) return r.params.slug;
    if (r.name === 'macro') return CK.temAcesso('grupo') ? 'grupo' : (CK.empresasPermitidas()[0] || {}).slug;
    return CK.temAcesso('grupo') ? 'grupo' : (CK.empresasPermitidas()[0] || {}).slug;
  };
  $('#btn-relatorio') && $('#btn-relatorio').addEventListener('click', function () {
    const slug = CK.slugAtual();
    if (!slug) { alert('Sem empresa no escopo para gerar relatório.'); return; }
    const btn = $('#btn-relatorio');
    const ano = CK.state.ano || new Date().getFullYear();
    btn.disabled = true; btn.classList.add('carregando');
    // download via fetch (mesma-origem, cookie) → blob → <a download>
    fetch('/api/relatorio/' + encodeURIComponent(slug) + '?ano=' + ano, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { showLogin(); throw new Error('401'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const nome = (r.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
        return r.blob().then(function (b) { return { b: b, nome: nome ? nome[1] : 'relatorio.pptx' }; });
      })
      .then(function (o) {
        const url = URL.createObjectURL(o.b);
        const a = document.createElement('a');
        a.href = url; a.download = o.nome; document.body.appendChild(a); a.click();
        a.remove(); URL.revokeObjectURL(url);
      })
      .catch(function (e) { if (e.message !== '401') alert('Falha ao gerar o relatório: ' + e.message); })
      .finally(function () { btn.disabled = false; btn.classList.remove('carregando'); });
  });

  /* ─── Init ─── */
  CK.init = async function () {
    try {
      const sess = await CK.api('/api/session'); // 401/503 → overlay via CK.api
      await afterLogin(sess);
    } catch (e) {
      if (!e || (e.status !== 401 && e.status !== 503)) {
        console.error('CK.init:', e);
        showLogin('Não foi possível verificar a sessão.');
      }
    }
  };

  // scripts são "defer": todas as telas já se registraram quando o DOM carrega
  window.addEventListener('DOMContentLoaded', CK.init);
})();
