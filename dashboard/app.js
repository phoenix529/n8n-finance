/* ==========================================================================
   Cockpit Financeiro Estratégico — Grupo Aurora
   App vanilla JS. Lê dashboard_data.json (contrato SPEC §8) e renderiza tudo.
   Sem dependências de CDN: todos os gráficos são SVG inline desenhados à mão.
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------------------------------------------------
     CONFIG — bloco único de marca/endpoint (trivialmente rebrandável, SPEC §1)
     ---------------------------------------------------------------------- */
  var BRAND = {
    name: "Ref Comunicação",
    legal: "Grupo · REF+ · BD · Viv · 4PR · Zup",
    // logo placeholder inline (SVG) — troque por <img src> do cliente quando houver
    logoSvg:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M3 19 L12 4 L21 19 Z" fill="#4F6BED"/>' +
      '<path d="M8.2 19 L12 12.5 L15.8 19 Z" fill="#fff" opacity=".9"/>' +
      '<circle cx="12" cy="16.4" r="1.8" fill="#0B1F3A"/></svg>',
  };

  // Endpoint RAG configurável (SPEC §7) — n8n Webhook. Sobrescrevível via window.
  var RAG_ENDPOINT = (typeof window !== "undefined" && window.RAG_ENDPOINT) ||
    "http://localhost:5678/webhook/cockpit-ask";
  var RAG_TIMEOUT_MS = 30000;   // critério Fase 2: resposta executiva < 30s

  var PALETTE = {
    navy: "#0B1F3A", indigo: "#4F6BED", indigo2: "#6E86F2",
    pos: "#10B981", neg: "#EF4444", warn: "#F59E0B", muted: "#6B7280",
    line: "#E6EAF2", line2: "#EEF1F8",
  };

  var MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  /* ----------------------------------------------------------------------
     UTIL — DOM helpers
     ---------------------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ----------------------------------------------------------------------
     FORMATAÇÃO pt-BR (SPEC §10): R$ 1,2 mi / R$ 850 mil ; % com sinal e cor
     ---------------------------------------------------------------------- */
  function moneyShort(v) {
    if (v == null || isNaN(v)) return "—";
    var neg = v < 0, a = Math.abs(v), out;
    if (a >= 1e9)      out = (a / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " bi";
    else if (a >= 1e6) out = (a / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    else if (a >= 1e3) out = (a / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
    else               out = a.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    return (neg ? "-R$ " : "R$ ") + out;
  }
  function moneyFull(v) {
    if (v == null || isNaN(v)) return "—";
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  }
  function num(v, dp) {
    if (v == null || isNaN(v)) return "—";
    return v.toLocaleString("pt-BR", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  }
  function pct(v, dp) {
    if (v == null || isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + v.toLocaleString("pt-BR", { minimumFractionDigits: dp == null ? 1 : dp, maximumFractionDigits: dp == null ? 1 : dp }) + "%";
  }
  function periodLabel(p) { // "2026-05" -> "mai/26"
    if (!p) return "";
    var parts = p.split("-");
    return MONTHS_PT[parseInt(parts[1], 10) - 1] + "/" + parts[0].slice(2);
  }
  function deltaClass(v) { return v > 0.05 ? "pos" : (v < -0.05 ? "neg" : "flat"); }

  /* delta pill (sinal + cor). higherIsBetter=false inverte semântica de cor. */
  function deltaPill(deltaPct, higherIsBetter) {
    var hib = higherIsBetter !== false;
    var dir = deltaPct > 0.05 ? "pos" : (deltaPct < -0.05 ? "neg" : "flat");
    var good = dir === "flat" ? "flat" : ((dir === "pos") === hib ? "pos" : "neg");
    var arrow = dir === "pos" ? "▲" : (dir === "neg" ? "▼" : "—");
    var span = el("span", "delta delta--" + good);
    span.innerHTML = '<span class="delta__arrow" aria-hidden="true">' + arrow + "</span>" + pct(deltaPct);
    return span;
  }

  /* ----------------------------------------------------------------------
     SPARKLINE (SVG inline)
     ---------------------------------------------------------------------- */
  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.w || 110, h = opts.h || 34, pad = 3;
    var color = opts.color || PALETTE.indigo;
    var svg = svgEl("svg", { viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none", role: "img" });
    if (!values || values.length < 2) return svg;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var range = (max - min) || 1;
    var n = values.length;
    function x(i) { return pad + (i / (n - 1)) * (w - pad * 2); }
    function y(v) { return h - pad - ((v - min) / range) * (h - pad * 2); }
    var d = "", area = "M" + x(0) + " " + (h - pad);
    for (var i = 0; i < n; i++) {
      d += (i ? " L" : "M") + x(i).toFixed(1) + " " + y(values[i]).toFixed(1);
      area += " L" + x(i).toFixed(1) + " " + y(values[i]).toFixed(1);
    }
    area += " L" + x(n - 1) + " " + (h - pad) + " Z";
    var gid = "spk" + Math.random().toString(36).slice(2, 8);
    var grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0", "stop-color": color, "stop-opacity": "0.22" }));
    grad.appendChild(svgEl("stop", { offset: "1", "stop-color": color, "stop-opacity": "0" }));
    var defs = svgEl("defs"); defs.appendChild(grad); svg.appendChild(defs);
    svg.appendChild(svgEl("path", { d: area, fill: "url(#" + gid + ")" }));
    svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: color, "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    svg.appendChild(svgEl("circle", { cx: x(n - 1), cy: y(values[n - 1]), r: "2.3", fill: color }));
    return svg;
  }

  /* ----------------------------------------------------------------------
     TOOLTIP compartilhado
     ---------------------------------------------------------------------- */
  var tip = $("#tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html; tip.hidden = false;
    tip.style.left = ev.clientX + "px";
    tip.style.top = ev.clientY + "px";
  }
  function hideTip() { tip.hidden = true; }

  /* ----------------------------------------------------------------------
     CARGA DE DADOS — fetch + fallback file:// (window.DASHBOARD_DATA)
     ---------------------------------------------------------------------- */
  function loadData() {
    if (window.DASHBOARD_DATA) {
      return Promise.resolve(window.DASHBOARD_DATA);
    }
    return fetch("dashboard_data.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function (err) {
        if (window.DASHBOARD_DATA) return window.DASHBOARD_DATA;
        throw err;
      });
  }

  function showError(err) {
    var ls = $("#loadState");
    ls.classList.add("is-error");
    ls.innerHTML =
      "<p><strong>Não foi possível carregar <code>dashboard_data.json</code>.</strong></p>" +
      "<p>" + (err && err.message ? err.message : err) + "</p>" +
      "<p style='color:var(--muted);max-width:520px;text-align:center;font-size:12.5px'>" +
      "Sirva a pasta via HTTP (<code>scripts/serve_dashboard.ps1</code> ou " +
      "<code>python -m http.server</code>). Para abrir direto do disco (file://), inclua um " +
      "<code>dashboard_data.js</code> definindo <code>window.DASHBOARD_DATA = {…}</code> antes de <code>app.js</code>.</p>";
  }

  /* ----------------------------------------------------------------------
     BOOT
     ---------------------------------------------------------------------- */
  loadData().then(render).catch(showError);

  function render(D) {
    $("#loadState").hidden = true;
    $("#content").hidden = false;

    renderBrand(D.meta);
    renderPeriodSelect(D.meta);
    renderKpis(D.kpis);
    renderResultadoChart(D.series_mensal);
    renderCaixaChart(D.series_mensal);
    renderDonut(D.gastos_por_categoria, D.meta);
    renderOrcado(D.orcado_vs_realizado);
    renderCompanies(D.por_empresa);
    renderDre(D.dre_consolidada, D.meta);
    if (D.aging && ((D.aging.receber || []).length || (D.aging.pagar || []).length)) renderAging(D.aging);
    renderInsights(D.insights_ia);
    renderAsk(D);
    renderFooter(D.meta);

    // redesenha gráficos responsivos no resize (debounced)
    var rt;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        renderResultadoChart(D.series_mensal);
        renderCaixaChart(D.series_mensal);
        renderDonut(D.gastos_por_categoria, D.meta);
      }, 180);
    });
  }

  /* ----------------------------------------------------------------------
     BRAND + PERÍODO + FOOTER
     ---------------------------------------------------------------------- */
  function renderBrand(meta) {
    var b = $("#brand");
    b.innerHTML =
      '<span class="brand__logo">' + BRAND.logoSvg + "</span>" +
      '<span><span class="brand__name">' + (meta.group_name || BRAND.name) + "</span><br>" +
      '<span class="brand__legal">' + BRAND.legal + "</span></span>";
    $("#appbarSubtitle").textContent =
      "Fechamento consolidado · " + periodLabel(meta.last_closed_period);
    document.title = "Cockpit Financeiro · " + (meta.group_name || BRAND.name);
  }

  function renderPeriodSelect(meta) {
    var sel = $("#periodSelect");
    // mostra o último fechado selecionado; lista alguns meses recentes (demo)
    var end = meta.last_closed_period;
    var opts = [];
    var y = parseInt(end.slice(0, 4), 10), m = parseInt(end.slice(5, 7), 10);
    for (var i = 0; i < 6; i++) {
      var mm = m - i, yy = y;
      while (mm <= 0) { mm += 12; yy -= 1; }
      opts.push(yy + "-" + String(mm).padStart(2, "0"));
    }
    clear(sel);
    opts.forEach(function (p, idx) {
      var o = el("option");
      o.value = p; o.textContent = periodLabel(p) + (idx === 0 ? " (fechado)" : "");
      sel.appendChild(o);
    });
    sel.value = end;
    // demo: troca de período apenas informa (dados são do último fechado)
    sel.addEventListener("change", function () {
      if (sel.value !== end) {
        sel.value = end;
        flash($("#appbarSubtitle"), "Demo: dados disponíveis para " + periodLabel(end));
      }
    });
  }

  var flashT;
  function flash(node, msg) {
    var prev = node.getAttribute("data-prev") || node.textContent;
    node.setAttribute("data-prev", prev);
    node.textContent = msg; node.style.color = PALETTE.warn;
    clearTimeout(flashT);
    flashT = setTimeout(function () { node.textContent = prev; node.style.color = ""; }, 2600);
  }

  function renderFooter(meta) {
    $("#footMeta").textContent =
      (meta.group_name || BRAND.name) + " · gerado em " +
      (meta.generated_at || "—") + " · período " +
      periodLabel(meta.period_start) + " → " + periodLabel(meta.period_end) +
      (meta.is_placeholder_brand ? " · marca demonstrativa" : "");
  }

  /* ----------------------------------------------------------------------
     KPI TILES
     ---------------------------------------------------------------------- */
  function renderKpis(k) {
    var grid = $("#kpiGrid"); clear(grid);

    // Cockpit de RESULTADO (P&L) — valor exibido = ACUMULADO no ano (jan–jun);
    // pílula = variação do último mês vs anterior (momentum); spark = trend 6m.
    function marg(d) { return d.margem_pct == null ? "" : "margem " + num(d.margem_pct, 1) + "%"; }
    function ultMes(d) { return "últ. mês " + moneyShort(d.value); }
    var tiles = [
      { key: "receita_bruta",     label: "Receita Bruta",                 hib: true, extra: ultMes },
      { key: "receita_liquida",   label: "Receita Líquida",               hib: true, extra: ultMes },
      { key: "resultado_agencia", label: "Lucro Bruto (Result. Operac.)", hib: true, extra: marg },
      { key: "ebit",              label: "Resultado Operacional (EBIT)",  hib: true, extra: marg,
        accent: function (d) { return d.ytd < 0 ? "warn" : ""; } },
      { key: "lucro_liquido",     label: "Lucro Líquido",                 hib: true, extra: marg,
        accent: function (d) { return d.ytd < 0 ? "warn" : ""; } },
      { key: "geracao_caixa",     label: "Geração de Caixa",              hib: true, extra: ultMes,
        accent: function (d) { return d.ytd < 0 ? "warn" : ""; } },
    ];

    tiles.forEach(function (t) {
      var d = k[t.key]; if (!d) return;
      var accent = t.accent ? t.accent(d) : "";
      var card = el("article", "kpi" + (accent ? " kpi--" + accent : ""));
      card.setAttribute("tabindex", "0");

      var spark = (d.spark && d.spark.length) ? '<div class="kpi__spark"></div>' : "";
      card.innerHTML =
        '<div class="kpi__label">' + t.label + "</div>" +
        '<div class="kpi__value">' + moneyShort(d.ytd) + "</div>" +
        '<div class="kpi__row"></div>' +
        spark;

      var row = $(".kpi__row", card);
      if (d.delta_pct != null) row.appendChild(deltaPill(d.delta_pct, t.hib));
      var ex = typeof t.extra === "function" ? t.extra(d) : t.extra;
      if (ex) row.appendChild(el("span", "kpi__extra", ex));

      if (d.spark && d.spark.length) {
        var col = (d.ytd < 0) ? PALETTE.neg : PALETTE.indigo;
        $(".kpi__spark", card).appendChild(sparkline(d.spark, { color: col, w: 130, h: 34 }));
      }

      card.title = t.label + " · acumulado jan–jun: " + moneyFull(d.ytd) +
        "  (último mês: " + moneyFull(d.value) + ")";
      grid.appendChild(card);
    });
  }

  /* ----------------------------------------------------------------------
     CHART 1 — Receita Líquida vs EBITDA (linha/área + orçado tracejado)
     ---------------------------------------------------------------------- */
  function renderResultadoChart(series) {
    var host = $("#chartResultado"); clear(host);
    var W = host.clientWidth || 560, H = 280;
    var m = { t: 14, r: 14, b: 26, l: 52 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var rl = series.map(function (s) { return s.receita_liquida; });
    var eb = series.map(function (s) { return s.ebitda; });   // = EBIT (Resultado Operacional)
    var maxV = Math.max.apply(null, rl) * 1.08;
    var minV = Math.min(0, Math.min.apply(null, eb)) * 1.08;
    var n = series.length;

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Receita líquida e EBITDA mensais" });
    function X(i) { return m.l + (i / (n - 1)) * iw; }
    function Y(v) { return m.t + ih - ((v - minV) / (maxV - minV)) * ih; }

    // grid + eixo Y
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var val = minV + (maxV - minV) * (g / ticks);
      var yy = Y(val);
      svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: yy, x2: W - m.r, y2: yy }));
      var lab = svgEl("text", { class: "axis-label", x: m.l - 8, y: yy + 3, "text-anchor": "end" });
      lab.textContent = moneyShort(val).replace("R$ ", "");
      svg.appendChild(lab);
    }
    // eixo X (alguns rótulos)
    var step = Math.ceil(n / 9);
    for (var i = 0; i < n; i++) {
      if (i % step === 0 || i === n - 1) {
        var tl = svgEl("text", { class: "axis-label", x: X(i), y: H - 8, "text-anchor": "middle" });
        tl.textContent = periodLabel(series[i].period);
        svg.appendChild(tl);
      }
    }

    // defs gradiente receita
    var gid = "rlgrad";
    var grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0", "stop-color": PALETTE.indigo, "stop-opacity": ".20" }));
    grad.appendChild(svgEl("stop", { offset: "1", "stop-color": PALETTE.indigo, "stop-opacity": "0" }));
    var defs = svgEl("defs"); defs.appendChild(grad); svg.appendChild(defs);

    function path(arr) {
      return arr.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ");
    }
    // área receita
    var areaD = path(rl) + " L" + X(n - 1) + " " + Y(0) + " L" + X(0) + " " + Y(0) + " Z";
    svg.appendChild(svgEl("path", { d: areaD, fill: "url(#" + gid + ")" }));
    // linha zero (EBIT pode ser negativo em alguns meses)
    if (minV < 0) svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: Y(0), x2: W - m.r, y2: Y(0), opacity: ".5" }));
    // receita
    svg.appendChild(svgEl("path", { d: path(rl), fill: "none", stroke: PALETTE.indigo, "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    // ebitda
    svg.appendChild(svgEl("path", { d: path(eb), fill: "none", stroke: PALETTE.pos, "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }));

    // hover
    var dot1 = svgEl("circle", { class: "hover-dot", r: "4", fill: PALETTE.indigo, stroke: "#fff", "stroke-width": "2", opacity: "0" });
    var dot2 = svgEl("circle", { class: "hover-dot", r: "4", fill: PALETTE.pos, stroke: "#fff", "stroke-width": "2", opacity: "0" });
    var vline = svgEl("line", { class: "grid-line", y1: m.t, y2: m.t + ih, opacity: "0", stroke: PALETTE.indigo, "stroke-dasharray": "3 3" });
    svg.appendChild(vline); svg.appendChild(dot1); svg.appendChild(dot2);

    var hit = svgEl("rect", { class: "hover-rect", x: m.l, y: m.t, width: iw, height: ih });
    hit.addEventListener("mousemove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) / rect.width * W;
      var i = Math.round((px - m.l) / iw * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      var s = series[i];
      [dot1, dot2, vline].forEach(function (d) { d.setAttribute("opacity", "1"); });
      dot1.setAttribute("cx", X(i)); dot1.setAttribute("cy", Y(rl[i]));
      dot2.setAttribute("cx", X(i)); dot2.setAttribute("cy", Y(eb[i]));
      vline.setAttribute("x1", X(i)); vline.setAttribute("x2", X(i));
      showTip(
        "<b>" + periodLabel(s.period) + "</b>" +
        "<div class='t-row'><span>Receita líq.</span><span>" + moneyFull(s.receita_liquida) + "</span></div>" +
        "<div class='t-row'><span>Result. operac.</span><span>" + moneyFull(s.ebit) + "</span></div>" +
        "<div class='t-row'><span>Margem op.</span><span>" + num(s.margem_ebitda_pct, 1) + "%</span></div>", ev);
    });
    hit.addEventListener("mouseleave", function () {
      [dot1, dot2, vline].forEach(function (d) { d.setAttribute("opacity", "0"); });
      hideTip();
    });
    svg.appendChild(hit);
    host.appendChild(svg);

    setLegend("#legendResultado", [
      { label: "Receita Líquida", color: PALETTE.indigo },
      { label: "Resultado Operacional", color: PALETTE.pos },
    ]);
  }

  /* ----------------------------------------------------------------------
     CHART 2 — Posição de caixa (linha) + fluxo (barras)
     ---------------------------------------------------------------------- */
  function renderCaixaChart(series) {
    var host = $("#chartCaixa"); clear(host);
    var W = host.clientWidth || 560, H = 280;
    var m = { t: 14, r: 14, b: 26, l: 52 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = series.length;

    var caixa = series.map(function (s) { return s.caixa; });       // geração ACUMULADA
    var fluxo = series.map(function (s) { return s.fluxo_caixa; });  // geração do MÊS
    var allv = caixa.concat(fluxo).concat([0]);
    var maxC = Math.max.apply(null, allv), minC = Math.min.apply(null, allv);
    var padc = (maxC - minC) * 0.10 || 1; maxC += padc; minC -= padc;

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Geração de caixa acumulada e mensal" });
    function X(i) { return m.l + (i / (n - 1)) * iw; }
    function Yc(v) { return m.t + ih - ((v - minC) / (maxC - minC)) * ih; }

    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var val = minC + (maxC - minC) * (g / ticks), yy = Yc(val);
      svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: yy, x2: W - m.r, y2: yy }));
      var lab = svgEl("text", { class: "axis-label", x: m.l - 8, y: yy + 3, "text-anchor": "end" });
      lab.textContent = moneyShort(val).replace("R$ ", "");
      svg.appendChild(lab);
    }
    var step = Math.ceil(n / 9);
    for (var i = 0; i < n; i++) {
      if (i % step === 0 || i === n - 1) {
        var tl = svgEl("text", { class: "axis-label", x: X(i), y: H - 8, "text-anchor": "middle" });
        tl.textContent = periodLabel(series[i].period);
        svg.appendChild(tl);
      }
    }

    // barras = geração de caixa do mês (a partir do eixo zero)
    var y0 = Yc(0);
    var bw = Math.max(3, iw / n * 0.42);
    for (var j = 0; j < n; j++) {
      var f = fluxo[j], yf = Yc(f);
      svg.appendChild(svgEl("rect", {
        x: X(j) - bw / 2, y: Math.min(y0, yf), width: bw, height: Math.max(Math.abs(yf - y0), 0.6), rx: 2,
        fill: f >= 0 ? PALETTE.pos : PALETTE.neg, opacity: ".40",
      }));
    }
    svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: y0, x2: W - m.r, y2: y0, opacity: ".6" }));

    // linha de caixa + área
    var gid = "cxgrad";
    var grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0", "stop-color": PALETTE.navy, "stop-opacity": ".16" }));
    grad.appendChild(svgEl("stop", { offset: "1", "stop-color": PALETTE.navy, "stop-opacity": "0" }));
    var defs = svgEl("defs"); defs.appendChild(grad); svg.appendChild(defs);
    var dPath = caixa.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Yc(v).toFixed(1); }).join(" ");
    svg.appendChild(svgEl("path", { d: dPath + " L" + X(n - 1) + " " + Yc(0) + " L" + X(0) + " " + Yc(0) + " Z", fill: "url(#" + gid + ")" }));
    svg.appendChild(svgEl("path", { d: dPath, fill: "none", stroke: PALETTE.navy, "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));

    var dot = svgEl("circle", { class: "hover-dot", r: "4", fill: PALETTE.navy, stroke: "#fff", "stroke-width": "2", opacity: "0" });
    svg.appendChild(dot);
    var hit = svgEl("rect", { class: "hover-rect", x: m.l, y: m.t, width: iw, height: ih });
    hit.addEventListener("mousemove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) / rect.width * W;
      var i = Math.round((px - m.l) / iw * (n - 1)); i = Math.max(0, Math.min(n - 1, i));
      var s = series[i];
      dot.setAttribute("opacity", "1"); dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Yc(caixa[i]));
      showTip(
        "<b>" + periodLabel(s.period) + "</b>" +
        "<div class='t-row'><span>Geração acum.</span><span>" + moneyFull(s.caixa) + "</span></div>" +
        "<div class='t-row'><span>Geração do mês</span><span>" + moneyFull(s.fluxo_caixa) + "</span></div>", ev);
    });
    hit.addEventListener("mouseleave", function () { dot.setAttribute("opacity", "0"); hideTip(); });
    svg.appendChild(hit);
    host.appendChild(svg);

    setLegend("#legendCaixa", [
      { label: "Geração acumulada", color: PALETTE.navy },
      { label: "Mês positivo", color: PALETTE.pos },
      { label: "Mês negativo", color: PALETTE.neg },
    ]);
  }

  function setLegend(sel, items) {
    var host = $(sel); clear(host);
    items.forEach(function (it) {
      var sw = it.dash ? '<span class="legend__swatch legend__swatch--dash" style="color:' + it.color + '"></span>'
        : '<span class="legend__swatch" style="background:' + it.color + '"></span>';
      host.appendChild(el("span", "legend__item", sw + it.label));
    });
  }

  /* ----------------------------------------------------------------------
     CHART 3 — Donut "Gastos por Categoria"
     ---------------------------------------------------------------------- */
  function renderDonut(cats, meta) {
    var host = $("#chartDonut"); clear(host);
    var legend = $("#donutLegend"); clear(legend);
    if (meta) $("#gastosSub").textContent = "Composição de custos e despesas · acumulado jan–jun";

    var size = 168, r = 70, rin = 46, cx = size / 2, cy = size / 2;
    var total = cats.reduce(function (a, c) { return a + c.valor; }, 0);
    var svg = svgEl("svg", { viewBox: "0 0 " + size + " " + size, role: "img", "aria-label": "Gastos por categoria" });

    var ang = -Math.PI / 2;
    cats.forEach(function (c, idx) {
      var frac = c.valor / total;
      var a2 = ang + frac * Math.PI * 2;
      var large = frac > 0.5 ? 1 : 0;
      var x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
      var x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      var xi2 = cx + rin * Math.cos(a2), yi2 = cy + rin * Math.sin(a2);
      var xi1 = cx + rin * Math.cos(ang), yi1 = cy + rin * Math.sin(ang);
      var d = "M" + x1 + " " + y1 + " A" + r + " " + r + " 0 " + large + " 1 " + x2 + " " + y2 +
        " L" + xi2 + " " + yi2 + " A" + rin + " " + rin + " 0 " + large + " 0 " + xi1 + " " + yi1 + " Z";
      var seg = svgEl("path", { d: d, fill: c.color, stroke: "#fff", "stroke-width": "2" });
      seg.style.cursor = "pointer"; seg.style.transition = "opacity .15s";
      seg.addEventListener("mousemove", function (ev) {
        seg.setAttribute("opacity", ".82");
        showTip("<b>" + c.categoria + "</b><div class='t-row'><span>" + num(c.pct, 1) + "%</span><span>" + moneyFull(c.valor) + "</span></div>", ev);
      });
      seg.addEventListener("mouseleave", function () { seg.setAttribute("opacity", "1"); hideTip(); });
      svg.appendChild(seg);
      ang = a2;

      var li = el("li");
      li.innerHTML =
        '<span class="sw" style="background:' + c.color + '"></span>' +
        '<span class="nm">' + c.categoria + "</span>" +
        '<span class="vl">' + num(c.pct, 1) + "% · " + moneyShort(c.valor) + "</span>";
      legend.appendChild(li);
    });
    host.appendChild(svg);
    var center = el("div", "donut-center");
    center.innerHTML = '<div><div class="donut-center__val">' + moneyShort(total) + '</div><div class="donut-center__lbl">total acum.</div></div>';
    host.appendChild(center);
  }

  /* ----------------------------------------------------------------------
     CHART 4 — Orçado vs Realizado por empresa (barras horizontais + var%)
     ---------------------------------------------------------------------- */
  function renderOrcado(rows) {
    var host = $("#chartOrcado"); clear(host);
    var wrap = el("div", "ovr");
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.realizado; })) || 1;
    rows.forEach(function (r) {
      var row = el("div", "ovr__row");
      row.innerHTML =
        '<div class="ovr__name" title="' + r.name + '">' + shortName(r.name) + "</div>" +
        '<div class="ovr__bars">' +
          '<div class="ovr__track"><div class="ovr__bar ovr__bar--real" style="width:0%"></div></div>' +
          '<div class="ovr__meta"><span>' + moneyShort(r.realizado) + " · receita líq. YTD</span>" +
          '<span class="ovr__var" style="color:' + PALETTE.indigo + '">' + num(r.var_pct, 1) + "% do grupo</span></div>" +
        "</div>";
      wrap.appendChild(row);
      requestAnimationFrame(function () {
        $(".ovr__bar--real", row).style.width = (r.realizado / maxV * 100) + "%";
      });
      row.title = r.name + " — receita líquida YTD " + moneyFull(r.realizado) + " (" + num(r.var_pct, 1) + "% do grupo)";
    });
    host.appendChild(wrap);
  }
  function shortName(n) { return n.replace("Aurora ", "").replace(/ (S\.A\.|Ltda\.)$/, ""); }

  /* ----------------------------------------------------------------------
     PER-COMPANY CARDS
     ---------------------------------------------------------------------- */
  function renderCompanies(rows) {
    var host = $("#companyCards"); clear(host);
    rows.forEach(function (c) {
      var card = el("article", "co");
      var negLL = (c.lucro_liquido_ltm != null && c.lucro_liquido_ltm < 0);
      card.innerHTML =
        '<div class="co__head"><span class="co__dot" style="background:' + c.color + '"></span>' +
          '<div><div class="co__name">' + shortName(c.name) + '</div><div class="co__sector">' +
            c.sector + (c.incompleto ? " · dados parciais" : "") + "</div></div></div>" +
        '<div class="co__stats">' +
          stat("Receita Líq. YTD", moneyShort(c.receita_ltm)) +
          stat("Result. Op.", c.ebitda_ltm == null ? "—" : moneyShort(c.ebitda_ltm)) +
          stat("Margem Op.", c.margem_ebitda_pct == null ? "—" : num(c.margem_ebitda_pct, 1) + "%") +
          stat("Lucro Líq.", c.lucro_liquido_ltm == null ? "—" : moneyShort(c.lucro_liquido_ltm),
               negLL ? PALETTE.neg : (c.lucro_liquido_ltm != null ? PALETTE.pos : "")) +
        "</div>" +
        '<div><div class="co__stat"><span class="k">Share da receita · ' + num(c.share_receita_pct, 1) + '%</span></div>' +
          '<div class="co__share"><i style="width:' + c.share_receita_pct + "%;background:" + c.color + '"></i></div></div>' +
        '<div class="co__foot"><span class="co__sector">receita líq. jan–jun</span><span class="co__spark"></span></div>';
      $(".co__spark", card).appendChild(sparkline(c.serie_receita, { color: c.color, w: 90, h: 26 }));
      host.appendChild(card);
    });
  }
  function stat(k, v, color) {
    return '<div class="co__stat"><span class="k">' + k + '</span><span class="v"' +
      (color ? ' style="color:' + color + '"' : "") + ">" + v + "</span></div>";
  }

  /* ----------------------------------------------------------------------
     DRE CONSOLIDADA (tabela)
     ---------------------------------------------------------------------- */
  function renderDre(rows, meta) {
    if (meta) $("#dreSub").textContent = "Mês " + periodLabel(meta.last_closed_period) + " · acumulado jan–jun · % da receita líquida";
    var tb = $("#dreTable tbody"); clear(tb);
    var totals = { receita_liquida: 1, lucro_bruto: 1, ebit: 1, lucro_liquido: 1, geracao_caixa: 1 };
    rows.forEach(function (r) {
      var tr = el("tr");
      if (totals[r.code]) tr.className = "is-total";
      tr.innerHTML =
        '<td class="lh">' + r.linha + "</td>" +
        '<td class="num">' + moneyShort(r.mes) + "</td>" +
        '<td class="num">' + moneyShort(r.ltm) + "</td>" +
        '<td class="num">' + (r.pct_rec == null ? "—" : num(r.pct_rec, 1) + "%") + "</td>";
      tr.title = r.linha + " — mês " + moneyFull(r.mes) + " · acumulado " + moneyFull(r.ltm) +
        (r.pct_rec == null ? "" : " · " + num(r.pct_rec, 1) + "% da receita líquida");
      tb.appendChild(tr);
    });
  }

  /* ----------------------------------------------------------------------
     AGING AR/AP (mini barras)
     ---------------------------------------------------------------------- */
  function renderAging(aging) {
    var host = $("#agingBody"); clear(host);
    host.appendChild(agingGroup("Contas a Receber", aging.receber, PALETTE.indigo));
    host.appendChild(agingGroup("Contas a Pagar", aging.pagar, PALETTE.warn));
  }
  function agingGroup(title, buckets, color) {
    var total = buckets.reduce(function (a, b) { return a + b.valor; }, 0);
    var max = Math.max.apply(null, buckets.map(function (b) { return b.valor; })) || 1;
    var wrap = el("div", "aging-grp");
    wrap.appendChild(el("div", "aging-grp__title", title + " <small>" + moneyShort(total) + "</small>"));
    var bars = el("div", "aging-bars");
    buckets.forEach(function (b) {
      var row = el("div", "aging-row");
      var over = b.faixa === "90+" || b.faixa === "61-90";
      var c = over ? PALETTE.neg : color;
      row.innerHTML =
        '<span class="fx">' + b.faixa + "</span>" +
        '<span class="tr"><i style="width:0%;background:' + c + '"></i></span>' +
        '<span class="vl">' + moneyShort(b.valor) + "</span>";
      row.title = title + " · faixa " + b.faixa + " dias: " + moneyFull(b.valor);
      bars.appendChild(row);
      requestAnimationFrame(function () { $("i", row).style.width = (b.valor / max * 100) + "%"; });
    });
    wrap.appendChild(bars);
    return wrap;
  }

  /* ----------------------------------------------------------------------
     KEY INSIGHTS (IA)
     ---------------------------------------------------------------------- */
  function renderInsights(items) {
    var list = $("#insightsList"); clear(list);
    var badge = { positive: "Positivo", warning: "Atenção", info: "Info" };
    items.forEach(function (it) {
      var sev = ["positive", "warning", "info"].indexOf(it.severity) >= 0 ? it.severity : "info";
      var li = el("li", "insight insight--" + sev);
      li.innerHTML =
        '<div class="insight__head"><span class="insight__badge">' + (badge[sev] || "Info") + "</span>" +
          '<span class="insight__title">' + it.titulo + "</span></div>" +
        '<p class="insight__text">' + it.texto + "</p>";
      list.appendChild(li);
    });
  }

  /* ----------------------------------------------------------------------
     ASK YOUR DATA (RAG) — POST endpoint → fallback fuzzy respostas_demo
     ---------------------------------------------------------------------- */
  function renderAsk(D) {
    var form = $("#askForm"), input = $("#askInput"), thread = $("#askThread");
    var chips = $("#chips"); clear(chips);

    (D.perguntas_sugeridas || []).forEach(function (q) {
      var c = el("button", "chip"); c.type = "button"; c.textContent = q;
      c.addEventListener("click", function () { input.value = q; submit(q); });
      chips.appendChild(c);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (q) submit(q);
    });

    function submit(q) {
      input.value = "";
      addMsg("q", q);
      var typing = addTyping();
      var t0 = performance.now();

      askBackend(q).then(function (res) {
        typing.remove();
        var ms = Math.round(performance.now() - t0);
        addAnswer(res.answer, res.fontes, ms, res.source);
      }).catch(function () {
        typing.remove();
        var local = matchDemo(q, D.respostas_demo);
        var ms = Math.round(performance.now() - t0);
        addAnswer(local.a, local.fontes, ms, "demo");
      });
    }

    function addMsg(role, text) {
      var m = el("div", "msg msg--" + role);
      m.innerHTML = '<div class="msg__bubble"></div>';
      $(".msg__bubble", m).textContent = text;
      thread.appendChild(m);
      thread.scrollTop = thread.scrollHeight;
      return m;
    }
    function addTyping() {
      var m = el("div", "msg msg--a");
      m.innerHTML = '<div class="msg__bubble" style="padding:0"><span class="typing"><i></i><i></i><i></i></span></div>';
      thread.appendChild(m); thread.scrollTop = thread.scrollHeight;
      return m;
    }
    function addAnswer(answer, fontes, ms, source) {
      var m = el("div", "msg msg--a");
      var srcHtml = "";
      if (fontes && fontes.length) {
        srcHtml = '<div class="msg__src"><span class="src-label">fontes:</span>' +
          fontes.map(function (f) { return '<span class="s">' + f + "</span>"; }).join("") + "</div>";
      }
      var badge = source === "rag" ? "via RAG (n8n)" : "demo offline";
      m.innerHTML =
        '<div class="msg__bubble"></div>' + srcHtml +
        '<div class="msg__meta"><span>✦ ' + badge + "</span><span>·</span><span>" + ms + " ms</span></div>";
      $(".msg__bubble", m).textContent = answer;
      thread.appendChild(m); thread.scrollTop = thread.scrollHeight;
    }
  }

  /* tenta o endpoint RAG; resolve com {answer, fontes, source} ou rejeita */
  function askBackend(question) {
    return new Promise(function (resolve, reject) {
      var ctrl = ("AbortController" in window) ? new AbortController() : null;
      var to = setTimeout(function () { if (ctrl) ctrl.abort(); reject(new Error("timeout")); }, RAG_TIMEOUT_MS);
      fetch(RAG_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question, locale: "pt-BR" }),
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (r) {
        clearTimeout(to);
        if (!r.ok) return reject(new Error("HTTP " + r.status));
        return r.json();
      }).then(function (j) {
        if (!j) return reject(new Error("empty"));
        resolve({
          answer: j.answer || j.resposta || j.a || JSON.stringify(j),
          fontes: j.fontes || j.sources || j.fontes_utilizadas || [],
          source: "rag",
        });
      }).catch(function (e) { clearTimeout(to); reject(e); });
    });
  }

  /* fallback offline: fuzzy match nas respostas_demo */
  function matchDemo(q, demos) {
    if (!demos || !demos.length) {
      return { a: "Não há resposta demonstrativa cadastrada para esta pergunta. Em produção, esta consulta é respondida pelo pipeline RAG (n8n + pgvector + Claude) com base nos dados do fechamento.", fontes: [] };
    }
    var nq = normalize(q);
    var best = null, bestScore = -1;
    demos.forEach(function (d) {
      var s = jaccard(nq, normalize(d.q));
      if (s > bestScore) { bestScore = s; best = d; }
    });
    if (bestScore < 0.12) {
      // sem boa correspondência: resposta honesta + sugestão
      return {
        a: "Não consegui casar sua pergunta com os exemplos demonstrativos offline. Tente uma das perguntas sugeridas, ou conecte o endpoint RAG (" + RAG_ENDPOINT + ") para consultas livres sobre os dados.",
        fontes: [],
      };
    }
    return best;
  }
  function normalize(s) {
    return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s]/g, " ");
  }
  var STOP = { "o": 1, "a": 1, "de": 1, "do": 1, "da": 1, "e": 1, "qual": 1, "como": 1, "em": 1, "no": 1, "na": 1, "os": 1, "as": 1, "um": 1, "uma": 1, "esta": 1, "está": 1, "the": 1 };
  function jaccard(a, b) {
    var sa = tokset(a), sb = tokset(b), inter = 0;
    for (var k in sa) if (sb[k]) inter++;
    var uni = Object.keys(sa).length + Object.keys(sb).length - inter;
    return uni ? inter / uni : 0;
  }
  function tokset(s) {
    var o = {};
    s.split(/\s+/).forEach(function (t) { if (t.length > 1 && !STOP[t]) o[t] = 1; });
    return o;
  }
})();
