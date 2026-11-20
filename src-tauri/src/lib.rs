use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl,
};
use url::Url;

struct DiagState {
    filtered: AtomicBool,
}

const FILTER: &str = "invert(0.9) hue-rotate(180deg) grayscale(0.62) sepia(0.4) hue-rotate(165deg) brightness(0.98) contrast(0.95)";

fn boot_script(initial_on: bool) -> String {
    let initial = if initial_on { "true" } else { "false" };
    format!(
        r#"(()=>{{
  const INITIAL={initial};
  const CSS="html.diag-on{{filter:{filter}!important;background:#e8e8e8!important}}";
  let on=INITIAL;
  try{{
    if(typeof window.name==="string"&&window.name.indexOf("diag:")===0) on=window.name.slice(5)!=="off";
  }}catch(e){{}}
  function apply(flag){{
    on=!!flag;
    try{{window.name=on?"diag:on":"diag:off";}}catch(e){{}}
    const root=document.documentElement;
    if(!root) return;
    if(on) root.removeAttribute("data-diag-off");
    else root.setAttribute("data-diag-off","1");
    const ext=root.hasAttribute("data-diag-ext");
    root.classList.toggle("diag-on", on && !ext);
    let style=document.getElementById("diag-filter-style");
    if(!on||ext){{ if(style) style.remove(); return; }}
    if(!style){{
      style=document.createElement("style");
      style.id="diag-filter-style";
      (document.head||root).appendChild(style);
    }}
    style.textContent=CSS;
  }}
  window.__diagSet=apply;
  if(document.documentElement) apply(on);
  document.addEventListener("DOMContentLoaded", function(){{ apply(on); }});
  window.addEventListener("keydown", function(e){{
    const k=(e.key||"").toLowerCase();
    let cmd="";
    if(e.ctrlKey&&k==="l") cmd="address";
    else if(e.ctrlKey&&e.shiftKey&&k==="t") cmd="pin";
    else if(e.ctrlKey&&e.altKey&&k==="p") cmd="pin";
    else if(e.ctrlKey&&(k==="`"||e.code==="Backquote")) cmd="panic";
    else if(e.ctrlKey&&e.shiftKey&&k==="h") cmd="panic";
    else if(e.altKey&&e.key==="ArrowLeft") cmd="back";
    else if(e.altKey&&e.key==="ArrowRight") cmd="forward";
    else if(e.key==="F5"||(e.ctrlKey&&k==="r")) cmd="reload";
    else if(e.ctrlKey&&(k==="="||k==="+"||e.code==="Equal"||e.code==="NumpadAdd")) cmd="scale-in";
    else if(e.ctrlKey&&(k==="-"||k==="_"||e.code==="Minus"||e.code==="NumpadSubtract")) cmd="scale-out";
    else if(e.ctrlKey&&(k==="0"||e.code==="Digit0"||e.code==="Numpad0")) cmd="scale-reset";
    if(!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    const api=window.__TAURI_INTERNALS__;
    if(api&&api.invoke) api.invoke("relay_key",{{cmd:cmd}});
  }}, true);
}})();"#,
        initial = initial,
        filter = FILTER
    )
}

fn parse_http(input: &str) -> Result<Url, String> {
    let url = Url::parse(input.trim()).map_err(|_| "无法打开该地址".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("只能打开 http 或 https 地址".into()),
    }
}

fn shell_only(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("denied".into())
    }
}

fn extension_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join("extensions"));
        candidates.push(dir.join("extensions"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources").join("extensions"));
            candidates.push(parent.join("extensions"));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("extensions"),
    );
    candidates
        .into_iter()
        .find(|path| path.join("diag-filter").join("manifest.json").exists())
}

fn bg(filtered: bool) -> tauri::webview::Color {
    if filtered {
        tauri::webview::Color(30, 30, 30, 255)
    } else {
        tauri::webview::Color(255, 255, 255, 255)
    }
}

fn page_builder(app: &AppHandle, url: Url, filtered: bool, use_extensions: bool) -> WebviewBuilder<tauri::Wry> {
    let app_for_links = app.clone();
    let mut builder = WebviewBuilder::new("page", WebviewUrl::External(url))
        .initialization_script(boot_script(filtered))
        .background_color(bg(filtered))
        .zoom_hotkeys_enabled(false)
        .enable_clipboard_access()
        .devtools(cfg!(debug_assertions))
        .on_document_title_changed(|view, title| {
            let _ = view.emit_to("main", "page-title", title);
        })
        .on_page_load(|view, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = view.emit_to("main", "page-load", payload.url().to_string());
            }
        })
        .on_new_window(move |target, _features| {
            if let Some(page) = app_for_links.get_webview("page") {
                let _ = page.navigate(target);
                let _ = page.show();
                let _ = page.set_focus();
            }
            NewWindowResponse::Deny
        });

    if use_extensions {
        if let Some(dir) = extension_dir(app) {
            builder = builder.browser_extensions_enabled(true).extensions_path(dir);
        }
    }
    builder
}

fn apply_filter(page: &tauri::Webview, on: bool) {
    let js = format!(
        "try{{window.__diagSet({})}}catch(e){{}}",
        if on { "true" } else { "false" }
    );
    let _ = page.eval(js);
    let _ = page.set_background_color(Some(bg(on)));
}

#[tauri::command]
async fn open_url(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
    zoom: f64,
    filtered: bool,
) -> Result<(), String> {
    shell_only(webview.label())?;
    let parsed = parse_http(&url)?;
    if let Some(state) = app.try_state::<DiagState>() {
        state.filtered.store(filtered, Ordering::Relaxed);
    }

    if let Some(page) = app.get_webview("page") {
        let _ = page.set_zoom(zoom.clamp(0.5, 2.5));
        apply_filter(&page, filtered);
        page.navigate(parsed).map_err(|err| err.to_string())?;
        let _ = page.show();
        let _ = page.set_focus();
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let zoom = zoom.clamp(0.5, 2.5);

    let created = window.add_child(
        page_builder(&app, parsed.clone(), filtered, cfg!(windows)),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(1.0, 1.0),
    );
    let page = match created {
        Ok(page) => page,
        Err(err) => {
            eprintln!("扩展加载失败，改用脚本滤镜: {err}");
            window
                .add_child(
                    page_builder(&app, parsed, filtered, false),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(1.0, 1.0),
                )
                .map_err(|err| err.to_string())?
        }
    };
    let _ = page.set_zoom(zoom);
    let _ = page.hide();
    Ok(())
}

#[tauri::command]
fn set_bounds(
    app: AppHandle,
    webview: tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    shell_only(webview.label())?;
    let Some(page) = app.get_webview("page") else {
        return Ok(());
    };
    if !visible || width < 2.0 || height < 2.0 {
        page.hide().map_err(|err| err.to_string())?;
        return Ok(());
    }
    page.set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|err| err.to_string())?;
    page.set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|err| err.to_string())?;
    page.show().map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn nav(app: AppHandle, webview: tauri::Webview, action: String) -> Result<(), String> {
    shell_only(webview.label())?;
    let Some(page) = app.get_webview("page") else {
        return Ok(());
    };
    match action.as_str() {
        "back" => page.eval("history.back()").map_err(|err| err.to_string())?,
        "forward" => page.eval("history.forward()").map_err(|err| err.to_string())?,
        "reload" => page.reload().map_err(|err| err.to_string())?,
        _ => return Err("denied".into()),
    }
    let _ = page.set_focus();
    Ok(())
}

#[tauri::command]
fn set_filtered(app: AppHandle, webview: tauri::Webview, on: bool) -> Result<(), String> {
    shell_only(webview.label())?;
    if let Some(state) = app.try_state::<DiagState>() {
        state.filtered.store(on, Ordering::Relaxed);
    }
    if let Some(page) = app.get_webview("page") {
        apply_filter(&page, on);
    }
    Ok(())
}

#[tauri::command]
fn set_page_zoom(app: AppHandle, webview: tauri::Webview, zoom: f64) -> Result<(), String> {
    shell_only(webview.label())?;
    if let Some(page) = app.get_webview("page") {
        page.set_zoom(zoom.clamp(0.5, 2.5))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn relay_key(app: AppHandle, webview: tauri::Webview, cmd: String) -> Result<(), String> {
    if webview.label() != "page" && webview.label() != "main" {
        return Err("denied".into());
    }
    const ALLOWED: &[&str] = &[
        "address",
        "panic",
        "back",
        "forward",
        "reload",
        "pin",
        "scale-in",
        "scale-out",
        "scale-reset",
    ];
    if !ALLOWED.contains(&cmd.as_str()) {
        return Err("denied".into());
    }
    app.emit_to("main", "hotkey", cmd)
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DiagState {
            filtered: AtomicBool::new(true),
        })
        .invoke_handler(tauri::generate_handler![
            open_url,
            set_bounds,
            nav,
            set_filtered,
            set_page_zoom,
            relay_key
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
