// The benchmark report (bench/report_html.py): which labelers are compared, all metrics, config tabs, the image viewer.
// Without JavaScript the page shows the default labelers and every metric; nothing is loaded from other servers.
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode: not remembered */ } },
  };

  // --- the labelers shown next to Label Anything: ?vs=a,b in the address, else the last choice, else the defaults
  const chips = Array.from(document.querySelectorAll(".vs .chip[data-solver]"));
  const names = chips.map((c) => c.dataset.solver);
  const defaults = chips.filter((c) => c.dataset.default === "1").map((c) => c.dataset.solver);
  const KEY = "la-bench-vs";
  function initial() {
    const q = new URLSearchParams(window.location.search).get("vs");
    if (q !== null) return q.split(",").filter((s) => names.includes(s));
    const v = store.get(KEY);
    if (v !== null) {
      try { return JSON.parse(v).filter((s) => names.includes(s)); } catch (e) { /* ignore */ }
    }
    return defaults;
  }
  let shown = new Set(initial());
  function apply(remember) {
    chips.forEach((c) => c.setAttribute("aria-pressed", shown.has(c.dataset.solver) ? "true" : "false"));
    document.querySelectorAll("[data-solver]:not(.chip)").forEach((el) => {
      const s = el.dataset.solver;
      if (names.includes(s)) el.hidden = !shown.has(s);
    });
    if (!remember) return;
    const list = names.filter((s) => shown.has(s));
    store.set(KEY, JSON.stringify(list));
    const url = new URL(window.location.href);
    const same = list.length === defaults.length && list.every((s) => defaults.includes(s));
    url.searchParams.delete("vs");
    const rest = url.searchParams.toString();
    // commas stay readable in the address: ?vs=ggrepel,textalloc
    url.search = [rest, same ? "" : "vs=" + list.map(encodeURIComponent).join(",")].filter(Boolean).join("&");
    try { window.history.replaceState(null, "", url); } catch (e) { /* file:// in some browsers */ }
  }
  chips.forEach((c) => c.addEventListener("click", () => {
    const s = c.dataset.solver;
    if (shown.has(s)) shown.delete(s); else shown.add(s);
    apply(true);
  }));
  const allBtn = document.getElementById("vs-all"), resetBtn = document.getElementById("vs-reset");
  if (allBtn) allBtn.addEventListener("click", () => { shown = new Set(names); apply(true); });
  if (resetBtn) resetBtn.addEventListener("click", () => { shown = new Set(defaults); apply(true); });
  apply(false);

  // --- every metric column, or the main ones
  const allm = document.getElementById("allm");
  if (allm) {
    allm.checked = store.get("la-bench-allm") === "1";
    root.classList.toggle("allm", allm.checked);
    allm.addEventListener("change", () => {
      root.classList.toggle("allm", allm.checked);
      store.set("la-bench-allm", allm.checked ? "1" : "0");
    });
  }

  // --- one config of a scenario at a time
  document.querySelectorAll(".tabs").forEach((bar) => {
    const tabs = Array.from(bar.querySelectorAll(".tab"));
    const panes = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
    function select(i) {
      tabs.forEach((t, k) => {
        t.setAttribute("aria-selected", k === i ? "true" : "false");
        t.tabIndex = k === i ? 0 : -1;
        if (panes[k]) panes[k].hidden = k !== i;
      });
    }
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(i));
      t.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const k = (i + d + tabs.length) % tabs.length;
        select(k);
        tabs[k].focus();
      });
    });
    select(0);
  });

  // --- a scenario's images whole or their densest part
  document.querySelectorAll("button.whole").forEach((b) => b.addEventListener("click", () => {
    const art = b.closest(".scenario");
    const on = !art.classList.contains("whole");
    art.classList.toggle("whole", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? "show the densest parts" : "show the whole images";
  }));

  // --- contents: close the menu after a jump
  const toc = document.querySelector(".toc");
  if (toc) toc.addEventListener("click", (e) => { if (e.target.closest("a")) toc.open = false; });

  // --- the image viewer. Pinch, double-tap, the wheel or the buttons zoom; a drag pans; a swipe at fit, the arrow
  // buttons or keys step through the images of one group (one problem drawn by the labelers shown, or one chapter's
  // figures) and keep the view between images of the same canvas, for comparing the same spot. A zoom scales the
  // image with a transform while it runs; once it settles, the scale becomes the image's layout size, so that the
  // browser draws a vector image again at that size instead of magnifying a bitmap (up to MAXPX pixels).
  const dlg = document.getElementById("viewer");
  if (!dlg || typeof dlg.showModal !== "function") return;
  const $ = (id) => document.getElementById(id);
  const stage = $("v-stage"), img = $("v-img"), cap = $("v-cap"), pct = $("v-pct");
  const prev = $("v-prev"), next = $("v-next");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ptrs = new Map();
  const MAXPX = 40e6;
  let shots = [], cur = -1, natW = 1, natH = 1, baseW = 1, vector = false, fw = 1, fh = 1, s = 1, cs = 1, X = 0, Y = 0;
  let nudge = 0, g = null, tap = null, timer = 0;

  const rect = () => stage.getBoundingClientRect();
  const at = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  // vector images: up to their zoom size (data-w); raster images: up to 4 screen px per image px
  const maxScale = () => Math.max(4, ((vector ? 1 : 4) * natW) / fw);
  const visible = (a) => a.getClientRects().length > 0;

  function fit() {
    const r = rect();
    const k = Math.min(r.width / natW, r.height / natH);
    fw = natW * k;
    fh = natH * k;
  }
  function commit() {
    timer = 0;
    const target = Math.min(s, Math.max(1, Math.sqrt(MAXPX / (fw * fh))));
    if (!vector || Math.abs(target - cs) < 1e-3) return;
    cs = target;
    apply2(false);
  }
  function apply2(animate) {
    const r = rect();
    s = Math.min(Math.max(s, 1), maxScale());
    const w = fw * s, h = fh * s;
    X = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, X));
    Y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, Y));
    img.style.transition = animate && !still.matches ? "transform 0.2s ease-out" : "none";
    img.style.width = fw * cs + "px";
    img.style.height = fh * cs + "px";
    img.style.transform = "translate(" + (X + nudge) + "px, " + Y + "px) scale(" + s / cs + ")";
    pct.textContent = Math.round((100 * w) / baseW) + " %";
    stage.classList.toggle("zoomed", s > 1.001);
    if (vector && Math.abs(s - cs) > 1e-3) {
      clearTimeout(timer);
      timer = setTimeout(commit, animate ? 260 : 180);
    }
  }
  function zoomAt(px, py, ns, animate) {
    ns = Math.min(Math.max(ns, 1), maxScale());
    X = px - ((px - X) / s) * ns;
    Y = py - ((py - Y) / s) * ns;
    s = ns;
    apply2(animate);
  }
  function zoomBy(k) {
    const r = rect();
    zoomAt(r.width / 2, r.height / 2, s * k, true);
  }
  function show(i, keepView) {
    const a = shots[i];
    if (!a) return;
    const w = Number(a.dataset.w) || 1, h = Number(a.dataset.h) || 1;
    const bw = Number(a.dataset.bw) || w;
    // the same canvas (width and aspect): keep the zoom and the spot, whatever the image's resolution
    const keep = keepView && bw === baseW && Math.abs(h / w - natH / natW) < 1e-3;
    const thumb = a.querySelector("img");
    cur = i;
    natW = w;
    natH = h;
    baseW = bw;
    vector = a.dataset.vector === "1";
    cs = 1;
    img.src = thumb.currentSrc || thumb.src;
    img.alt = thumb.alt;
    cap.textContent = (a.dataset.caption || thumb.alt) + (shots.length > 1 ? " · " + (i + 1) + " of " + shots.length : "");
    if (a.href !== img.src) {
      const hi = new Image();
      hi.onload = () => { if (cur === i) img.src = a.href; };
      hi.src = a.href;
    }
    prev.disabled = i === 0;
    next.disabled = i === shots.length - 1;
    const sx = s;
    fit();
    s = keep ? sx : 1;
    nudge = 0;
    // a card that shows a detail: open on that detail
    const crop = !keep && a.dataset.crop && !a.closest(".whole") ? a.dataset.crop.split(",").map(Number) : null;
    if (crop) {
      const r = rect();
      const [cx, cy, cw, ch] = crop;
      s = Math.min(maxScale(), Math.max(1, Math.min(r.width / (cw * fw), r.height / (ch * fh))));
      X = r.width / 2 - (cx + cw / 2) * fw * s;
      Y = r.height / 2 - (cy + ch / 2) * fh * s;
    }
    apply2(false);
  }
  function step(d) {
    if (cur + d >= 0 && cur + d < shots.length) show(cur + d, true);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.shot");
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const group = a.closest("[data-group]") || document.body;
    shots = Array.from(group.querySelectorAll("a.shot")).filter(visible);
    root.classList.add("viewing");
    if (!dlg.open) dlg.showModal();
    show(Math.max(0, shots.indexOf(a)), false);
  });
  dlg.addEventListener("close", () => {
    root.classList.remove("viewing");
    cur = -1;
    ptrs.clear();
    g = null;
  });
  $("v-close").addEventListener("click", () => dlg.close());
  $("v-in").addEventListener("click", () => zoomBy(1.6));
  $("v-out").addEventListener("click", () => zoomBy(1 / 1.6));
  $("v-fit").addEventListener("click", () => { s = 1; apply2(true); });
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "+" || e.key === "=") zoomBy(1.6);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.6);
    else if (e.key === "0") { s = 1; apply2(true); }
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", () => { if (dlg.open) { fit(); apply2(false); } });

  // one pointer pans (at fit: swipes), two pinch around their midpoint; a second tap toggles the zoom
  function begin(before) {
    const p = Array.from(ptrs.values());
    if (p.length >= 2) {
      const a = p[0], b = p[1];
      g = { pinch: true, d: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, X, Y };
    } else if (p.length === 1) {
      g = { pinch: false, x: p[0].x, y: p[0].y, s, X, Y, t: performance.now(), moved: false, multi: !!before };
    } else g = null;
  }
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, at(e));
    begin(ptrs.size > 1 ? g : null);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, at(e));
    if (!g) return;
    const p = Array.from(ptrs.values());
    if (g.pinch) {
      if (p.length < 2) return;
      const a = p[0], b = p[1];
      const ns = Math.min(Math.max((g.s * Math.hypot(b.x - a.x, b.y - a.y)) / g.d, 1), maxScale());
      X = (a.x + b.x) / 2 - ((g.mx - g.X) / g.s) * ns;
      Y = (a.y + b.y) / 2 - ((g.my - g.Y) / g.s) * ns;
      s = ns;
      apply2(false);
      return;
    }
    const dx = p[0].x - g.x, dy = p[0].y - g.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
    if (!g.moved) return;
    if (g.s > 1.001) {
      X = g.X + dx;
      Y = g.Y + dy;
    } else if (!g.multi) nudge = dx * 0.6;
    apply2(false);
  });
  function end(e) {
    if (!ptrs.has(e.pointerId)) return;
    const q = e.type === "pointercancel" ? ptrs.get(e.pointerId) : at(e);
    ptrs.delete(e.pointerId);
    const was = g;
    if (ptrs.size > 0) { begin(was); return; }
    g = null;
    stage.classList.remove("dragging");
    const swiping = nudge !== 0;
    nudge = 0;
    if (!was || was.pinch || was.multi || e.type === "pointercancel") { apply2(true); return; }
    if (!was.moved) {
      const now = performance.now();
      if (now - was.t > 350) { tap = null; return; }
      if (tap && now - tap.t < 400 && Math.hypot(q.x - tap.x, q.y - tap.y) < 32) {
        tap = null;
        if (s > 1.001) { s = 1; apply2(true); }
        else zoomAt(q.x, q.y, Math.max(2.5, natW / 2 / fw), true);
      } else tap = { t: now, x: q.x, y: q.y };
      return;
    }
    tap = null;
    const dx = q.x - was.x, dy = q.y - was.y;
    const d = dx < 0 ? 1 : -1;
    if (was.s <= 1.001 && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && cur + d >= 0 && cur + d < shots.length) {
      step(d);
    } else if (swiping) apply2(true);
  }
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = at(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(p.x, p.y, s * Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)), false);
  }, { passive: false });
})();
