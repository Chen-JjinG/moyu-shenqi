import { createMonitor, MEM_INSET, type Monitor } from "./charts";
import {
  closeWindow,
  inTauri,
  listen,
  minimizeWindow,
  nav,
  normalizeUrl,
  openUrl,
  setAlwaysOnTop,
  setBounds,
  setChartVeil,
  setFiltered,
  setPageZoom,
  setWindowSize,
  setWindowTitle,
  startResize,
  toggleMaximize,
  windowLogicalSize,
  type ThemeId,
} from "./bridge";

type Snap = {
  id: number;
  time: number;
  title: string;
  url: string;
  host: string;
  mem: number;
};

type Show = "empty" | "heap" | "code" | "ad" | "page";

const THEME_SIZE: Record<ThemeId, [number, number]> = {
  vs: [960, 760],
  vscode: [1120, 740],
  idea: [1100, 740],
  ad: [600, 520],
};

const TITLES: Record<ThemeId, string> = {
  vs: "诊断工具",
  vscode: "Diagnostics.cs - DiagnosticSession - Visual Studio Code",
  idea: "SessionMonitor.java - DiagnosticSession",
  ad: "搜狗每日新词",
};

const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const state = {
  theme: loadTheme(),
  scale: loadScale(),
  pinned: localStorage.getItem("diag.pinned") === "1",
  panic: false,
  heap: false,
  tab: "memory",
  paused: false,
  overlay: false,
  url: "",
  title: "",
  snaps: loadSnaps(),
};

const monitor: Monitor = createMonitor();
const PREFILL_SECONDS = 26;
monitor.seed(PREFILL_SECONDS);
let sessionStart = performance.now() - PREFILL_SECONDS * 1000;
let pausedAccum = 0;
let pauseStarted: number | null = null;
let hudTimer = 0;
let boundsQueued = false;
const fallback = document.getElementById("fallback") as HTMLIFrameElement;

function loadTheme(): ThemeId {
  const v = localStorage.getItem("diag.theme");
  if (v === "vs" || v === "vscode" || v === "idea" || v === "ad") return v;
  return "vs";
}

function loadScale(): number {
  const n = Number(localStorage.getItem("diag.scale"));
  return SCALES.includes(n) ? n : 1;
}

function loadSnaps(): Snap[] {
  try {
    const raw = JSON.parse(localStorage.getItem("diag.snaps") || "[]") as Snap[];
    if (!Array.isArray(raw)) return [];
    return raw.filter((s) => s && typeof s.url === "string").slice(0, 40);
  } catch {
    return [];
  }
}

function saveSnaps() {
  localStorage.setItem("diag.snaps", JSON.stringify(state.snaps.slice(0, 40)));
}

function elapsed(): number {
  const end = pauseStarted ?? performance.now();
  return Math.max(0, (end - sessionStart - pausedAccum) / 1000);
}

function fmtStamp(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pageLive(): boolean {
  return !!state.url && !state.panic && !(state.theme === "vs" && state.heap);
}

function showMode(): Show {
  if (state.theme === "vs" && state.heap && !state.panic) return "heap";
  if (state.theme === "vs") return "empty";
  if (state.theme === "ad") return "ad";
  if (pageLive()) return "page";
  return "code";
}

function activeStage(): HTMLElement | null {
  return document.querySelector(`.theme-${state.theme} .stage`);
}

/** Where the live page is placed. VS Code and IntelliJ keep the editor stage. */
function activeSlot(): HTMLElement | null {
  if (state.theme === "vs") return document.getElementById("mem-slot");
  if (state.theme === "ad") return document.getElementById("ad-hero");
  return activeStage();
}

function applyChrome() {
  const app = document.getElementById("app")!;
  app.dataset.theme = state.theme;
  const filtered = state.theme !== "ad";
  app.dataset.filtered = filtered ? "1" : "0";
  document.body.dataset.theme = state.theme;
  document.documentElement.style.setProperty("--ui-scale", String(state.scale));
  app.dataset.browsing = pageLive() && state.theme === "vs" ? "1" : "0";
  if (pageLive() && state.theme === "vs") {
    document.querySelector('.theme-vs [data-block="mem"]')?.classList.remove("collapsed");
  }
  syncPlotSlot();
  document.title = TITLES[state.theme];
  void setWindowTitle(TITLES[state.theme]);
  document.querySelectorAll(".js-pin").forEach((el) => el.classList.toggle("on", state.pinned));
  document.querySelectorAll("[data-drag]").forEach((el) => {
    if (state.pinned) el.removeAttribute("data-tauri-drag-region");
    else el.setAttribute("data-tauri-drag-region", "");
  });
  const secs = document.getElementById("vs-secs");
  if (secs) secs.textContent = String(Math.floor(elapsed()));
  const stage = activeStage();
  if (stage) stage.dataset.show = showMode();
  document.querySelectorAll(".vs-tabs button").forEach((btn) => {
    btn.classList.toggle("on", (btn as HTMLElement).dataset.tab === state.tab);
  });
  document.getElementById("vs-heap")?.classList.toggle("on", state.heap);
  document.getElementById("vs-pause")?.classList.toggle("on", state.paused);
  const hint = document.getElementById("vs-hint");
  if (hint) {
    hint.textContent =
      state.tab === "cpu"
        ? "检查 CPU 在您的应用程序中的使用位置"
        : state.tab === "summary"
          ? "会话正在收集数据"
          : state.tab === "events"
            ? "事件"
            : "检查 CPU 在您的应用程序中的使用位置";
  }
  renderHeap();
  const mem = monitor.current().mem;
  const jb = document.getElementById("jb-mem");
  if (jb) jb.textContent = `${mem.toFixed(0)} MB / 512 MB`;
  placeFallback();
}

function renderHeap() {
  const root = document.getElementById("heap-rows");
  if (!root) return;
  root.replaceChildren();
  for (const snap of state.snaps) {
    const row = document.createElement("div");
    row.className = "heap-row";
    row.title = snap.title;
    const cells = [String(snap.id), fmtStamp(snap.time), snap.title || snap.host, `${snap.mem.toFixed(1)} MB`, snap.host];
    for (const text of cells) {
      const span = document.createElement("span");
      span.textContent = text;
      row.appendChild(span);
    }
    row.addEventListener("dblclick", () => {
      state.heap = false;
      void go(snap.url);
    });
    root.appendChild(row);
  }
}

function syncPlotSlot() {
  const slot = document.getElementById("mem-slot");
  if (slot) {
    slot.style.top = `${MEM_INSET.top}px`;
    slot.style.right = `${MEM_INSET.right}px`;
    slot.style.bottom = `${MEM_INSET.bottom}px`;
    slot.style.left = `${MEM_INSET.left}px`;
  }
  const veil = document.getElementById("mem-veil");
  if (veil) {
    veil.style.top = `${MEM_INSET.top}px`;
    veil.style.left = `${MEM_INSET.left}px`;
    veil.style.right = "auto";
    veil.style.bottom = "auto";
    veil.style.width = `calc(100% - ${MEM_INSET.left + MEM_INSET.right}px)`;
    veil.style.height = `calc(100% - ${MEM_INSET.top + MEM_INSET.bottom}px)`;
  }
}

let veilSent = false;

function publishVeil() {
  const live = pageLive() && state.theme === "vs" && !state.overlay;
  const canvas = document.getElementById("mem-veil");
  if (!live) {
    canvas?.classList.remove("on");
    if (veilSent) {
      veilSent = false;
      if (inTauri()) void setChartVeil(null);
    }
    return;
  }
  veilSent = true;
  if (!inTauri()) {
    canvas?.classList.add("on");
    if (canvas instanceof HTMLCanvasElement) monitor.paintVeil(canvas, elapsed());
    return;
  }
  canvas?.classList.remove("on");
  void setChartVeil(monitor.veilSpec(elapsed()));
}

function redraw() {
  monitor.draw(elapsed());
  publishVeil();
}

function placeFallback() {
  const slot = activeSlot();
  const live = pageLive() && !state.overlay && !inTauri();
  if (!slot || !live) {
    fallback.hidden = true;
    return;
  }
  if (fallback.parentElement !== slot) slot.appendChild(fallback);
  fallback.hidden = false;
}

function hud(text: string) {
  const el = document.getElementById("hud")!;
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 900);
}

async function applyScale(next: number) {
  const prev = state.scale;
  const clamped = SCALES.includes(next) ? next : prev;
  if (clamped === prev) return;
  state.scale = clamped;
  localStorage.setItem("diag.scale", String(clamped));
  document.documentElement.style.setProperty("--ui-scale", String(clamped));
  if (inTauri()) {
    const size = await windowLogicalSize();
    if (size) {
      const ratio = clamped / prev;
      await setWindowSize(size.w * ratio, size.h * ratio);
    }
    await setPageZoom(clamped);
  }
  hud(`${Math.round(clamped * 100)}%`);
  requestBounds();
}

async function applyTheme(theme: ThemeId, resizeWindow: boolean) {
  state.theme = theme;
  localStorage.setItem("diag.theme", theme);
  applyChrome();
  await setFiltered(theme !== "ad");
  await setPageZoom(state.scale);
  if (resizeWindow && inTauri()) {
    const saved = loadBounds(theme);
    if (saved) await setWindowSize(saved.w, saved.h);
    else {
      const [w, h] = THEME_SIZE[theme];
      await setWindowSize(w * state.scale, h * state.scale);
    }
  }
  requestBounds();
}

function loadBounds(theme: ThemeId): { w: number; h: number } | null {
  try {
    const all = JSON.parse(localStorage.getItem("diag.bounds") || "{}") as Record<string, { w: number; h: number }>;
    const item = all[theme];
    if (item && item.w > 200 && item.h > 160) return item;
  } catch {
    /* ignore */
  }
  return null;
}

async function rememberBounds() {
  if (!inTauri()) return;
  const size = await windowLogicalSize();
  if (!size) return;
  let all: Record<string, { w: number; h: number }> = {};
  try {
    all = JSON.parse(localStorage.getItem("diag.bounds") || "{}");
  } catch {
    all = {};
  }
  all[state.theme] = { w: Math.round(size.w), h: Math.round(size.h) };
  localStorage.setItem("diag.bounds", JSON.stringify(all));
}

async function togglePin() {
  state.pinned = !state.pinned;
  localStorage.setItem("diag.pinned", state.pinned ? "1" : "0");
  applyChrome();
  await setAlwaysOnTop(state.pinned);
  hud(state.pinned ? "已置顶" : "已取消置顶");
}

function togglePanic() {
  state.panic = !state.panic;
  if (state.panic) state.heap = false;
  applyChrome();
  requestBounds();
}

async function go(input: string) {
  const url = normalizeUrl(input);
  const box = document.getElementById("addr")!;
  if (!url) {
    box.classList.add("bad");
    return;
  }
  box.classList.remove("bad");
  hideAddr();
  state.url = url;
  state.panic = false;
  state.heap = false;
  monitor.bump(elapsed());
  applyChrome();
  if (inTauri()) {
    try {
      await openUrl(url, state.scale, state.theme !== "ad");
    } catch {
      hud("无法打开");
    }
  } else {
    fallback.src = url;
  }
  requestBounds();
}

function hideAddr() {
  const el = document.getElementById("addr")!;
  el.hidden = true;
  state.overlay = menuOpen() || false;
  requestBounds();
}

function showAddr() {
  const el = document.getElementById("addr")!;
  const input = document.getElementById("addr-input") as HTMLInputElement;
  const app = document.getElementById("app")!.getBoundingClientRect();
  const width = Math.min(480 * state.scale, Math.max(220, app.width - 24));
  el.style.width = `${width}px`;
  el.style.left = `${app.left + (app.width - width) / 2}px`;
  el.style.top = `${app.top + 36 * state.scale}px`;
  el.hidden = false;
  input.value = state.url;
  input.focus();
  input.select();
  state.overlay = true;
  requestBounds();
}

function menuOpen(): boolean {
  return !document.getElementById("menu")!.hidden;
}

type Item = {
  label: string;
  shortcut?: string;
  checked?: boolean;
  action?: () => void;
  children?: Item[];
};

function menuItems(): Item[] {
  return [
    { label: "向后导航", shortcut: "Alt+←", action: () => void browse("back") },
    { label: "向前导航", shortcut: "Alt+→", action: () => void browse("forward") },
    { label: "刷新", shortcut: "Ctrl+R", action: () => void browse("reload") },
    { label: "打开…", shortcut: "Ctrl+L", action: () => showAddr() },
    {
      label: "界面缩放",
      children: SCALES.map((s) => ({
        label: `${Math.round(s * 100)}%`,
        checked: Math.abs(s - state.scale) < 0.001,
        action: () => void applyScale(s),
      })),
    },
    {
      label: "外观",
      children: [
        { id: "vs", label: "诊断工具" },
        { id: "vscode", label: "Visual Studio Code" },
        { id: "idea", label: "IntelliJ IDEA" },
        { id: "ad", label: "每日新词" },
      ].map((t) => ({
        label: t.label,
        checked: state.theme === t.id,
        action: () => void applyTheme(t.id as ThemeId, true),
      })),
    },
    { label: "始终置顶", shortcut: "Ctrl+Shift+T", checked: state.pinned, action: () => void togglePin() },
    { label: "隐藏详细信息", shortcut: "Ctrl+`", action: () => togglePanic() },
  ];
}

function renderItems(items: Item[], parent: HTMLElement) {
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "mi";
    if (item.checked) {
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = "✓";
      row.appendChild(ck);
    }
    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "sc";
      sc.textContent = item.shortcut;
      row.appendChild(sc);
    }
    if (item.children) {
      const sub = document.createElement("div");
      sub.className = "sub";
      renderItems(item.children, sub);
      row.appendChild(sub);
      row.addEventListener("mouseenter", () => row.classList.add("open"));
      row.addEventListener("mouseleave", () => row.classList.remove("open"));
    } else if (item.action) {
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeMenu();
        item.action?.();
      });
    }
    parent.appendChild(row);
  }
}

function openMenu(x: number, y: number) {
  const menu = document.getElementById("menu")!;
  menu.replaceChildren();
  renderItems(menuItems(), menu);
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
  state.overlay = true;
  requestBounds();
}

function closeMenu() {
  const menu = document.getElementById("menu")!;
  if (menu.hidden) return;
  menu.hidden = true;
  state.overlay = !document.getElementById("addr")!.hidden;
  requestBounds();
}

function takeSnap() {
  const t = elapsed();
  monitor.markSnap(t);
  if (state.url) {
    const maxId = state.snaps.reduce((m, s) => Math.max(m, s.id), 0);
    state.snaps.unshift({
      id: maxId + 1,
      time: t,
      title: state.title || hostOf(state.url),
      url: state.url,
      host: hostOf(state.url),
      mem: monitor.current().mem,
    });
    state.snaps = state.snaps.slice(0, 40);
    saveSnaps();
    renderHeap();
  }
  redraw();
  hud("已截取快照");
}

function tick() {
  if (!state.paused) {
    const t = elapsed();
    monitor.step(t);
    const secs = document.getElementById("vs-secs");
    if (secs) secs.textContent = String(Math.floor(t));
    if (state.theme === "idea") {
      const jb = document.getElementById("jb-mem");
      if (jb) jb.textContent = `${monitor.current().mem.toFixed(0)} MB / 512 MB`;
    }
  }
  if (state.theme === "vs" && !document.hidden) redraw();
}

async function browse(action: "back" | "forward" | "reload") {
  if (!state.url) return;
  monitor.bump(elapsed());
  if (!inTauri()) {
    if (action === "reload") fallback.src = state.url;
    return;
  }
  await nav(action);
}

function requestBounds() {
  if (boundsQueued) return;
  boundsQueued = true;
  requestAnimationFrame(() => {
    boundsQueued = false;
    void pushBounds();
  });
}

async function pushBounds() {
  const live = pageLive() && !state.overlay;
  const slot = activeSlot();
  if (!inTauri()) {
    placeFallback();
    publishVeil();
    return;
  }
  if (!live || !slot) {
    await setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    publishVeil();
    return;
  }
  const r = slot.getBoundingClientRect();
  await setBounds({
    x: r.left,
    y: r.top,
    width: Math.max(0, r.width),
    height: Math.max(0, r.height),
    visible: r.width > 8 && r.height > 8,
  });
  publishVeil();
}

function onHotkey(cmd: string) {
  if (cmd === "address") showAddr();
  else if (cmd === "panic") togglePanic();
  else if (cmd === "back") void browse("back");
  else if (cmd === "forward") void browse("forward");
  else if (cmd === "reload") void browse("reload");
  else if (cmd === "pin") void togglePin();
  else if (cmd === "scale-in") {
    const i = SCALES.findIndex((s) => Math.abs(s - state.scale) < 0.001);
    void applyScale(SCALES[Math.min(SCALES.length - 1, i + 1)] ?? 1);
  } else if (cmd === "scale-out") {
    const i = SCALES.findIndex((s) => Math.abs(s - state.scale) < 0.001);
    void applyScale(SCALES[Math.max(0, i - 1)] ?? 1);
  } else if (cmd === "scale-reset") void applyScale(1);
}

function onKey(e: KeyboardEvent) {
  const key = e.key.toLowerCase();
  const addr = document.getElementById("addr-input") as HTMLInputElement;
  if (document.activeElement === addr) {
    if (e.key === "Escape") {
      e.preventDefault();
      hideAddr();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void go(addr.value);
    }
    return;
  }
  if (e.key === "Escape") {
    closeMenu();
    hideAddr();
    return;
  }
  if (e.ctrlKey && key === "l") {
    e.preventDefault();
    showAddr();
  } else if ((e.ctrlKey && e.shiftKey && key === "t") || (e.ctrlKey && e.altKey && key === "p")) {
    e.preventDefault();
    void togglePin();
  } else if ((e.ctrlKey && key === "`") || (e.ctrlKey && e.shiftKey && key === "h")) {
    e.preventDefault();
    togglePanic();
  } else if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    void browse("back");
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    void browse("forward");
  } else if (e.key === "F5" || (e.ctrlKey && key === "r")) {
    e.preventDefault();
    void browse("reload");
  } else if (e.ctrlKey && (e.code === "Backquote" || key === "`")) {
    e.preventDefault();
    togglePanic();
  } else if (e.ctrlKey && (key === "=" || key === "+" || e.key === "+")) {
    e.preventDefault();
    onHotkey("scale-in");
  } else if (e.ctrlKey && (key === "-" || key === "_")) {
    e.preventDefault();
    onHotkey("scale-out");
  } else if (e.ctrlKey && key === "0") {
    e.preventDefault();
    onHotkey("scale-reset");
  }
}

function bind() {
  document.querySelectorAll(".js-close").forEach((el) => el.addEventListener("click", () => void closeWindow()));
  document.querySelectorAll(".js-min").forEach((el) => el.addEventListener("click", () => void minimizeWindow()));
  document.querySelectorAll(".js-max").forEach((el) => el.addEventListener("click", () => void toggleMaximize()));
  document.querySelectorAll(".js-pin").forEach((el) => el.addEventListener("click", () => void togglePin()));
  document.querySelectorAll(".js-menu").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const r = (el as HTMLElement).getBoundingClientRect();
      if (menuOpen()) closeMenu();
      else openMenu(r.left, r.bottom + 2);
    });
  });
  document.querySelectorAll("[data-drag]").forEach((el) => {
    el.addEventListener("dblclick", () => {
      if (!state.pinned) void toggleMaximize();
    });
  });
  document.getElementById("app")!.addEventListener("contextmenu", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.closest(".vs-title, .vsc-title, .jb-title, .ad-title")) return;
    ev.preventDefault();
    openMenu(ev.clientX, ev.clientY);
  });
  document.getElementById("vs-export")!.addEventListener("click", () => {
    const cur = monitor.current();
    const text = `诊断会话\r\n持续时间: ${Math.floor(elapsed())} 秒\r\n进程内存: ${cur.mem.toFixed(1)} MB\r\nCPU: ${cur.cpu.toFixed(1)}%`;
    void navigator.clipboard.writeText(text).then(
      () => hud("已复制会话摘要"),
      () => hud("无法写入剪贴板"),
    );
  });
  document.getElementById("vs-zin")!.addEventListener("click", () => {
    monitor.zoomIn();
    redraw();
  });
  document.getElementById("vs-zout")!.addEventListener("click", () => {
    monitor.zoomOut();
    redraw();
  });
  document.getElementById("vs-zreset")!.addEventListener("click", () => {
    monitor.zoomReset();
    redraw();
  });
  document.getElementById("vs-pause")!.addEventListener("click", () => {
    state.paused = !state.paused;
    if (state.paused) pauseStarted = performance.now();
    else if (pauseStarted != null) {
      pausedAccum += performance.now() - pauseStarted;
      pauseStarted = null;
    }
    applyChrome();
  });
  document.getElementById("vs-snap")!.addEventListener("click", takeSnap);
  document.getElementById("vs-heap")!.addEventListener("click", () => {
    state.heap = !state.heap;
    if (state.heap) state.panic = false;
    applyChrome();
    requestBounds();
  });
  document.querySelectorAll(".vs-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = (btn as HTMLElement).dataset.tab || "memory";
      applyChrome();
    });
  });
  document.querySelectorAll(".block-h, .block-toggle").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".legend")) return;
      const block = (btn as HTMLElement).closest(".block") as HTMLElement | null;
      if (block?.dataset.block === "mem" && pageLive() && state.theme === "vs") {
        block.classList.remove("collapsed");
        return;
      }
      block?.classList.toggle("collapsed");
      requestBounds();
      redraw();
    });
  });
  document.querySelectorAll(".resize").forEach((el) => {
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const dir = (el as HTMLElement).dataset.dir || "";
      void startResize(dir);
    });
  });
  document.addEventListener("mousedown", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest("#menu") && !t.closest(".js-menu")) closeMenu();
  });
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", () => {
    requestBounds();
    redraw();
    void rememberBounds();
  });
  const nomore = document.getElementById("ad-nomore") as HTMLInputElement;
  nomore.checked = localStorage.getItem("diag.nomore") === "1";
  nomore.addEventListener("change", () => {
    localStorage.setItem("diag.nomore", nomore.checked ? "1" : "0");
  });
  if (typeof ResizeObserver !== "undefined") {
    const root = document.querySelector(".theme-vs");
    if (root) {
      const ro = new ResizeObserver(() => {
        if (state.theme === "vs") redraw();
        requestBounds();
      });
      ro.observe(root);
    }
  }
  syncPlotSlot();
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const queryTheme = params.get("theme");
  if (queryTheme === "vs" || queryTheme === "vscode" || queryTheme === "idea" || queryTheme === "ad") {
    state.theme = queryTheme;
  }
  bind();
  applyChrome();
  const open = params.get("open");
  if (open) void go(open);
  const paint = () => redraw();
  requestAnimationFrame(paint);
  window.addEventListener("load", paint);
  window.setInterval(tick, 1000);
  if (inTauri()) {
    await setAlwaysOnTop(state.pinned);
    await setFiltered(state.theme !== "ad");
    await setPageZoom(state.scale);
    if (state.theme !== "vs" || Math.abs(state.scale - 1) > 0.001) {
      const saved = loadBounds(state.theme);
      if (saved) await setWindowSize(saved.w, saved.h);
      else {
        const [w, h] = THEME_SIZE[state.theme];
        await setWindowSize(w * state.scale, h * state.scale);
      }
    }
    await listen<string>("hotkey", onHotkey);
    await listen<string>("page-load", (url) => {
      if (url && url !== "about:blank") state.url = url;
      applyChrome();
      publishVeil();
    });
    await listen<string>("page-title", (title) => {
      state.title = title;
      if (state.heap) renderHeap();
    });
    requestBounds();
  }
}

void boot();
