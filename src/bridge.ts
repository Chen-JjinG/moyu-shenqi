export type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
};

export type ThemeId = "vs" | "vscode" | "idea" | "ad";

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^(javascript|data|file|blob):/i.test(raw)) return null;
  let withScheme = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    const host = raw.split("/")[0];
    if (/^(localhost|127\.|\[)/.test(host) || /:\d+$/.test(host)) withScheme = `http://${raw}`;
    else withScheme = `https://${raw}`;
  }
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function core() {
  return import("@tauri-apps/api/core");
}

export async function openUrl(url: string, zoom: number, filtered: boolean): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("open_url", { url, zoom, filtered });
}

export async function setBounds(bounds: Bounds): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("set_bounds", bounds);
}

export async function nav(action: "back" | "forward" | "reload"): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("nav", { action });
}

export async function setFiltered(on: boolean): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("set_filtered", { on });
}

export async function setPageZoom(zoom: number): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("set_page_zoom", { zoom });
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<void> {
  if (!inTauri()) return;
  const { listen: on } = await import("@tauri-apps/api/event");
  await on<T>(event, (e) => cb(e.payload));
}

async function win() {
  const mod = await import("@tauri-apps/api/window");
  return mod.getCurrentWindow();
}

export async function setAlwaysOnTop(on: boolean): Promise<void> {
  if (!inTauri()) return;
  await (await win()).setAlwaysOnTop(on);
}

export async function closeWindow(): Promise<void> {
  if (!inTauri()) return;
  await (await win()).close();
}

export async function minimizeWindow(): Promise<void> {
  if (!inTauri()) return;
  await (await win()).minimize();
}

export async function toggleMaximize(): Promise<void> {
  if (!inTauri()) return;
  await (await win()).toggleMaximize();
}

export async function setWindowTitle(title: string): Promise<void> {
  if (!inTauri()) return;
  await (await win()).setTitle(title);
}

export async function windowLogicalSize(): Promise<{ w: number; h: number } | null> {
  if (!inTauri()) return null;
  const w = await win();
  const factor = await w.scaleFactor();
  const inner = await w.innerSize();
  return { w: inner.width / factor, h: inner.height / factor };
}

export async function setWindowSize(width: number, height: number): Promise<void> {
  if (!inTauri()) return;
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  await (await win()).setSize(new LogicalSize(Math.round(width), Math.round(height)));
}

export async function startResize(dir: string): Promise<void> {
  if (!inTauri()) return;
  const allowed = ["East", "West", "North", "South", "NorthEast", "NorthWest", "SouthEast", "SouthWest"] as const;
  const value = allowed.find((item) => item === dir);
  if (!value) return;
  await (await win()).startResizeDragging(value);
}
