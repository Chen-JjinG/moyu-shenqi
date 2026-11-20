/** Low-frequency canvas traces. One sample per second, drawn only while the diagnostic theme is visible. */

/** Inner plot rectangle of the process-memory canvas. `.mem-slot` / `#mem-veil` use the same insets. */
export const MEM_INSET = { left: 28, right: 28, top: 4, bottom: 16 };

export type VeilSpec = {
  pts: number[][];
  gcs: number[][];
  snaps: number[][];
  grid: number[];
};

export type Monitor = {
  step: (t: number) => void;
  seed: (seconds: number) => void;
  draw: (elapsed: number) => void;
  resize: () => void;
  markSnap: (t: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  bump: (t: number) => void;
  current: () => { mem: number; cpu: number };
  veilSpec: (elapsed: number) => VeilSpec | null;
  paintVeil: (canvas: HTMLCanvasElement, elapsed: number) => void;
};

type Pt = { t: number; v: number };

const SPANS = [15, 30, 45, 60, 90, 120, 180];

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2) return null;
  const pw = Math.floor(w * dpr);
  const ph = Math.floor(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function domain(elapsed: number, span: number, zoomed: boolean): { start: number; end: number } {
  if (!zoomed && elapsed <= 60) {
    return { start: 0, end: Math.max(elapsed, 12) };
  }
  const end = Math.max(elapsed, span);
  return { start: Math.max(0, end - span), end };
}

function xOf(t: number, start: number, end: number, left: number, width: number): number {
  return left + ((t - start) / Math.max(0.001, end - start)) * width;
}

function niceTop(max: number): number {
  if (max <= 17) return 18;
  return Math.max(18, Math.ceil(max * 1.08));
}

function tri(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + 6);
  ctx.lineTo(x - 4.5, y);
  ctx.lineTo(x + 4.5, y);
  ctx.closePath();
  ctx.fill();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

type Mark = { x: number; y: number };

/** Translucent waveform painted over the live page. Same shape as the memory chart. */
function paintFusedChart(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  pts: Mark[],
  gcs: Mark[],
  snaps: Mark[],
  grid: number[],
) {
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  for (const x of grid) {
    ctx.moveTo(x * w, 0);
    ctx.lineTo(x * w, h);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(16, 20, 24, 0.2)";
  ctx.fillRect(0, 0, w, h);
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x * w, h);
  for (const p of pts) ctx.lineTo(p.x * w, p.y * h);
  ctx.lineTo(pts[pts.length - 1].x * w, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(93, 151, 176, 0.5)";
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x * w;
    const y = p.y * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "rgba(32, 68, 86, 0.7)";
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.strokeStyle = "rgba(214, 238, 246, 0.96)";
  ctx.lineWidth = 1.25;
  ctx.stroke();
  for (const m of gcs) tri(ctx, m.x * w, m.y * h - 1, "#e6c34a");
  for (const m of snaps) tri(ctx, m.x * w, m.y * h - 1, "#3aa0e6");
}

export function createMonitor(): Monitor {
  let mem = 15.8;
  let cpu = 2.2;
  const memS: Pt[] = [];
  const cpuS: Pt[] = [];
  const gcs: number[] = [];
  const snaps: number[] = [];
  let spanIdx = 3;
  let zoomed = false;
  let boostUntil = -1;

  const ruler = () => document.getElementById("c-ruler") as HTMLCanvasElement | null;
  const events = () => document.getElementById("c-events") as HTMLCanvasElement | null;
  const memC = () => document.getElementById("c-mem") as HTMLCanvasElement | null;
  const cpuC = () => document.getElementById("c-cpu") as HTMLCanvasElement | null;

  function step(t: number) {
    if (Math.random() < 0.3) {
      mem -= 0.45 + Math.random() * 0.85;
      gcs.push(t);
    }
    mem += (15.85 - mem) * 0.14 + (Math.random() - 0.5) * 0.18;
    if (mem < 13.4) mem = 13.4;
    if (mem > 16.55) mem = 16.55;

    let next = 0.6 + Math.random() * 2.8;
    if (t < boostUntil) next += 6 + Math.random() * 12;
    else if (Math.random() < 0.035) next += 8 + Math.random() * 16;
    cpu = cpu * 0.45 + next * 0.55;
    if (cpu < 0.2) cpu = 0.2;
    if (cpu > 92) cpu = 92;

    memS.push({ t, v: mem });
    cpuS.push({ t, v: cpu });
    const keep = t - 1200;
    while (memS.length && memS[0].t < keep) memS.shift();
    while (cpuS.length && cpuS[0].t < keep) cpuS.shift();
    while (gcs.length && gcs[0] < keep) gcs.shift();
    while (snaps.length && snaps[0] < keep) snaps.shift();
  }

  type Geo = {
    pts: Mark[];
    gcs: Mark[];
    snaps: Mark[];
    grid: number[];
    axis: number;
    start: number;
    end: number;
  };

  function memoryGeometry(elapsed: number): Geo | null {
    const span = SPANS[spanIdx];
    const dom = domain(elapsed, span, zoomed);
    const pts = memS.filter((p) => p.t >= dom.start && p.t <= dom.end);
    if (!pts.length) return null;
    let max = 1;
    for (const p of pts) if (p.v > max) max = p.v;
    const axis = niceTop(max);
    const widthT = Math.max(0.001, dom.end - dom.start);
    const xN = (t: number) => (t - dom.start) / widthT;
    const yN = (v: number) => 1 - v / axis;
    const nearest = (t: number) => pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    const marks = (ts: number[]) =>
      ts.filter((t) => t >= dom.start && t <= dom.end).map((t) => ({ x: xN(t), y: yN(nearest(t).v) }));
    const major = widthT <= 40 ? 10 : widthT <= 90 ? 15 : 30;
    const grid: number[] = [];
    for (let t = Math.ceil(dom.start / major) * major; t <= dom.end; t += major) grid.push(xN(t));
    return {
      pts: pts.map((p) => ({ x: xN(p.t), y: yN(p.v) })),
      gcs: marks(gcs),
      snaps: marks(snaps),
      grid,
      axis,
      start: dom.start,
      end: dom.end,
    };
  }

  function draw(elapsed: number) {
    const span = SPANS[spanIdx];
    const dom = domain(elapsed, span, zoomed);
    drawRuler(dom);
    drawEvents(dom);
    drawMem(elapsed);
    drawCpu(dom);
  }

  function drawRuler(dom: { start: number; end: number }) {
    const canvas = ruler();
    if (!canvas) return;
    const ctx = fit(canvas);
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const left = 28;
    const right = 28;
    const plotW = Math.max(1, w - left - right);
    const span = dom.end - dom.start;
    const stepSec = span <= 40 ? 10 : span <= 90 ? 15 : 30;
    ctx.strokeStyle = "#4a4a4a";
    ctx.fillStyle = "#bdbdbd";
    ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.beginPath();
    const first = Math.ceil(dom.start / 2) * 2;
    for (let t = first; t <= dom.end + 0.01; t += 2) {
      const x = xOf(t, dom.start, dom.end, left, plotW);
      const major = Math.abs(t / stepSec - Math.round(t / stepSec)) < 0.01 && t > 0.5;
      ctx.moveTo(x, major ? 1 : 6);
      ctx.lineTo(x, 11);
    }
    ctx.stroke();
    for (let t = stepSec; t < dom.end - 0.2; t += stepSec) {
      if (t < dom.start + 0.2) continue;
      const x = xOf(t, dom.start, dom.end, left, plotW);
      const label = t < 60 ? `${t}秒` : `${Math.floor(t / 60)}分`;
      ctx.fillText(label, x, 4);
    }
  }

  function drawEvents(dom: { start: number; end: number }) {
    const canvas = events();
    if (!canvas) return;
    const ctx = fit(canvas);
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const left = 28;
    const plotW = Math.max(1, w - left - 28);
    const y = h / 2;
    ctx.strokeStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
    ctx.stroke();
    ctx.strokeStyle = "#8d8d8d";
    for (const t of gcs) {
      if (t < dom.start || t > dom.end) continue;
      const x = xOf(t, dom.start, dom.end, left, plotW);
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x, y + 5);
      ctx.stroke();
    }
  }

  function drawMem(elapsed: number) {
    const canvas = memC();
    if (!canvas) return;
    const ctx = fit(canvas);
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const left = MEM_INSET.left;
    const right = MEM_INSET.right;
    const top = MEM_INSET.top;
    const bottom = h - MEM_INSET.bottom;
    const plotW = Math.max(1, w - left - right);
    const plotH = Math.max(1, bottom - top);
    const geo = memoryGeometry(elapsed);
    const axis = geo?.axis ?? 18;
    const start = geo?.start ?? 0;
    const end = geo?.end ?? Math.max(elapsed, 12);
    const span = Math.max(0.001, end - start);
    ctx.strokeStyle = "#2f2f2f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const major = span <= 40 ? 10 : span <= 90 ? 15 : 30;
    for (let t = Math.ceil(start / major) * major; t <= end; t += major) {
      const x = left + ((t - start) / span) * plotW;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();
    ctx.strokeStyle = "#3f3f46";
    ctx.strokeRect(left + 0.5, top + 0.5, plotW, plotH);
    if (geo && geo.pts.length) {
      const X = (n: number) => left + n * plotW;
      const Y = (n: number) => top + n * plotH;
      ctx.beginPath();
      ctx.moveTo(X(geo.pts[0].x), bottom);
      for (const p of geo.pts) ctx.lineTo(X(p.x), Y(p.y));
      ctx.lineTo(X(geo.pts[geo.pts.length - 1].x), bottom);
      ctx.closePath();
      ctx.fillStyle = "#5d97b0";
      ctx.fill();
      ctx.beginPath();
      geo.pts.forEach((p, i) => {
        const x = X(p.x);
        const y = Y(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#8ec3d4";
      ctx.lineWidth = 1;
      ctx.stroke();
      for (const m of geo.gcs) tri(ctx, X(m.x), Y(m.y) - 1, "#e6c34a");
      for (const m of geo.snaps) tri(ctx, X(m.x), Y(m.y) - 1, "#3aa0e6");
    }
    ctx.fillStyle = "#c8c8c8";
    ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(String(axis), 2, top);
    ctx.fillText("0", 2, bottom - 12);
    ctx.textAlign = "right";
    ctx.fillText(String(axis), w - 2, top);
    ctx.fillText("0", w - 2, bottom - 12);
  }

  function drawCpu(dom: { start: number; end: number }) {
    const canvas = cpuC();
    if (!canvas) return;
    const ctx = fit(canvas);
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const left = 28;
    const right = 28;
    const plotW = Math.max(1, w - left - right);
    const top = 4;
    const bottom = h - 16;
    const plotH = Math.max(1, bottom - top);
    ctx.strokeStyle = "#3f3f46";
    ctx.strokeRect(left + 0.5, top + 0.5, plotW, plotH);
    const pts = cpuS.filter((p) => p.t >= dom.start && p.t <= dom.end);
    if (pts.length) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = xOf(p.t, dom.start, dom.end, left, plotW);
        const y = bottom - (p.v / 100) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#9a9a9a";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = "#c8c8c8";
    ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("100", 2, top);
    ctx.fillText("0", 2, bottom - 12);
    ctx.textAlign = "right";
    ctx.fillText("100", w - 2, top);
    ctx.fillText("0", w - 2, bottom - 12);
  }

  function bumpSpan(dir: number) {
    zoomed = true;
    spanIdx = Math.max(0, Math.min(SPANS.length - 1, spanIdx + dir));
  }

  step(0);

  return {
    step,
    seed: (seconds: number) => {
      const n = Math.max(0, Math.floor(seconds));
      for (let t = 1; t <= n; t += 1) step(t);
    },
    draw,
    resize: () => {},
    markSnap: (t) => snaps.push(t),
    zoomIn: () => bumpSpan(-1),
    zoomOut: () => bumpSpan(1),
    zoomReset: () => {
      zoomed = false;
      spanIdx = 3;
    },
    bump: (t) => {
      boostUntil = t + 2.4;
    },
    current: () => ({ mem, cpu }),
    veilSpec: (elapsed) => {
      const geo = memoryGeometry(elapsed);
      if (!geo || geo.pts.length < 2) return null;
      const pack = (p: Mark) => [round4(p.x), round4(p.y)];
      return {
        pts: geo.pts.map(pack),
        gcs: geo.gcs.map(pack),
        snaps: geo.snaps.map(pack),
        grid: geo.grid.map(round4),
      };
    },
    paintVeil: (canvas, elapsed) => {
      const geo = memoryGeometry(elapsed);
      const ctx = fit(canvas);
      if (!ctx) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!geo) {
        ctx.clearRect(0, 0, w, h);
        return;
      }
      paintFusedChart(ctx, w, h, geo.pts, geo.gcs, geo.snaps, geo.grid);
    },
  };
}
