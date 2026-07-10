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
    if (['macro', 'receitas', 'custos', 'alertas', 'admin'].includes(parts[0]))
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
      if (ret && typeof ret.catch === 'function') {
        ret.catch(e => {
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
