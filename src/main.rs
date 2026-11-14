//! MD Reader（Rust + WebView2 版）入口。
//! 架构：tao 窗口 + muda 原生菜单 + wry/WebView2 渲染原样复用的 Web 前端；
//! 桥接 RPC、对话框、拖放、自检、A4 PDF 导出均与 Python 版逐行为对齐。
//! release 构建为 GUI 子系统（无控制台）；Web 资产内嵌二进制，单文件便携。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod config;
mod encoding;
mod fsops;
mod print;

#[cfg(test)]
mod tests_core;

#[cfg(test)]
mod tests_parity;

use bridge::{Api, Uev};
use config::{config_dir, load_config, save_config, APP_NAME, APP_VERSION};
use serde_json::{json, Value};
use std::rc::Rc;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowExtWindows;
use tao::window::Window;
use wry::WebViewBuilder;

const SHIM_JS: &str = include_str!("../web/js/pywebview-shim.js");

const SELFTEST_CHECK_JS: &str = concat!(
    "(window.__SELFTEST__ && window.__SELFTEST__.phase === 'final' ",
    "? JSON.stringify(window.__SELFTEST__) : '')"
);

/// 内嵌 Web 资产：编译期打包进二进制（单文件便携，无外部 web/ 目录依赖）。
const EMBEDDED_ASSETS: &[(&str, &[u8])] = &[
    ("index.html", include_bytes!("../web/index.html")),
    ("css/style.css", include_bytes!("../web/css/style.css")),
    ("js/app.js", include_bytes!("../web/js/app.js")),
    ("js/markdown.js", include_bytes!("../web/js/markdown.js")),
    ("js/mermaid-mini.js", include_bytes!("../web/js/mermaid-mini.js")),
    ("js/pywebview-shim.js", include_bytes!("../web/js/pywebview-shim.js")),
];

/// 窗口图标（32×32 原始 RGBA，由 assets/icon.ico 经 Pillow 预转，
/// 见 tools/make_icon_rgba.py）。EXE 资源图标只作用于文件/任务栏默认值，
/// 标题栏图标必须经 with_window_icon 显式设置（tao 窗口类不读取 PE 资源）。
const WINDOW_ICON_RGBA: &[u8] = include_bytes!("../assets/icon32.rgba");
const WINDOW_ICON_SIZE: u32 = 32;

fn embedded_asset(path: &str) -> Option<&'static [u8]> {
    EMBEDDED_ASSETS
        .iter()
        .find(|(p, _)| p.eq_ignore_ascii_case(path))
        .map(|(_, bytes)| *bytes)
}

/// 致命初始化错误可视化：GUI 子系统下 panic/退出码不可见，改用原生弹窗。
fn fatal_error(title: &str, detail: &str) -> ! {
    eprintln!("{title}: {detail}");
    #[cfg(target_os = "windows")]
    {
        let _ = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title(title)
            .set_description(detail)
            .show();
    }
    std::process::exit(1);
}

fn parse_startup_arg(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let cleaned = arg.trim_matches('"');
        let p = std::path::Path::new(cleaned);
        if p.exists() {
            if let Ok(c) = std::fs::canonicalize(p) {
                let s = c.to_string_lossy().into_owned();
                return Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
            }
            return Some(fsops::norm_path(p));
        }
    }
    None
}

/// 单实例：资源管理器多选“打开方式”会为每个文件启动一个进程，
/// 这里让后续进程把文件路径转发给首进程后退出，由首进程开成多标签。
/// 传输层用本机回环 TCP（纯 std）：首实例绑定固定端口，后续实例连接失败即视为首实例。
mod singleton {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};

    const PORT: u16 = 6373;

    /// 返回 true 表示已有实例在运行且转发成功（调用方应立即退出）。
    pub fn forward_or_listen(tx: &mpsc::Sender<Uev>, paths: &[String]) -> bool {
        if try_forward(paths) {
            return true;
        }
        match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => {
                spawn_listener(listener, tx.clone());
                false
            }
            Err(_) => {
                // 端口被占：可能是并行启动的首实例尚未就绪，重试转发；仍失败则照常启动。
                for _ in 0..20 {
                    std::thread::sleep(Duration::from_millis(100));
                    if try_forward(paths) {
                        return true;
                    }
                }
                false
            }
        }
    }

    fn addr() -> SocketAddr {
        format!("127.0.0.1:{PORT}").parse().unwrap()
    }

    fn try_forward(paths: &[String]) -> bool {
        let Ok(mut s) = TcpStream::connect_timeout(&addr(), Duration::from_millis(300)) else {
            return false;
        };
        let mut msg = String::new();
        for p in paths {
            msg.push_str(p);
            msg.push('\n');
        }
        msg.push_str("FOCUS\n");
        s.write_all(msg.as_bytes()).is_ok()
    }

    fn spawn_listener(listener: TcpListener, tx: mpsc::Sender<Uev>) {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let mut s = stream;
                    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                    let mut buf = String::new();
                    if s.read_to_string(&mut buf).is_err() {
                        return;
                    }
                    let mut paths = Vec::new();
                    let mut focus = false;
                    for line in buf.lines() {
                        let line = line.trim();
                        if line == "FOCUS" {
                            focus = true;
                        } else if !line.is_empty() && std::path::Path::new(line).exists() {
                            paths.push(line.to_string());
                        }
                    }
                    if !paths.is_empty() {
                        let _ = tx.send(Uev::Drop(paths));
                    }
                    if focus {
                        let _ = tx.send(Uev::Focus);
                    }
                });
            }
        });
    }
}

fn asset_response(
    req: wry::http::Request<Vec<u8>>,
) -> wry::http::Response<std::borrow::Cow<'static, [u8]>> {
    use std::borrow::Cow;
    let resp = |status: u16, body: Cow<'static, [u8]>, mime: &str| {
        wry::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .body(body)
            .unwrap()
    };
    let uri = req.uri().to_string();
    let after_scheme = uri.split("://").nth(1).unwrap_or("");
    let path_part = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        None => "/",
    };
    let p = path_part
        .split(['?', '#'])
        .next()
        .unwrap_or("/")
        .trim_start_matches('/')
        .to_string();
    let p = percent_encoding::percent_decode_str(&p).decode_utf8_lossy().into_owned();
    if p.contains("..") {
        return resp(403, Cow::Borrowed(&[]), "text/plain");
    }
    let p = if p.is_empty() { "index.html" } else { p.as_str() };
    match embedded_asset(p) {
        Some(bytes) => resp(200, Cow::Borrowed(bytes), mime_of(p)),
        None => resp(404, Cow::Borrowed(&[]), "text/plain"),
    }
}

fn mime_of(p: &str) -> &'static str {
    let ext = p.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn resolve_js(id: u64, ok: bool, value: &str) -> String {
    format!("window.__pywebview && window.__pywebview.resolve({},{},{});", id, ok, value)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let selftest = args.iter().any(|a| a == "--selftest");
    let startup = if selftest { None } else { parse_startup_arg(&args) };

    let mut cfg = load_config();
    // WebView2 缓存清理：版本变更或自检时（配置键 assetVersion 记录上次版本）。
    if selftest || cfg.get("assetVersion").and_then(|v| v.as_str()) != Some(APP_VERSION) {
        let _ = std::fs::remove_dir_all(config_dir().join(".webview-cache"));
        cfg.insert("assetVersion".into(), json!(APP_VERSION));
        save_config(&cfg);
    }

    let event_loop = EventLoopBuilder::<Uev>::with_user_event().build();
    let proxy: EventLoopProxy<Uev> = event_loop.create_proxy();
    let (tx, rx) = mpsc::channel::<Uev>();
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            for uev in rx {
                if proxy.send_event(uev).is_err() {
                    break;
                }
            }
        });
    }

    // 单实例裁决：已有实例在运行 → 转发启动文件并退出（资源管理器批量打开时
    // 每个文件一个进程，全部汇入首窗口的多标签）。
    if !selftest {
        let fwd: Vec<String> = startup.iter().cloned().collect();
        if singleton::forward_or_listen(&tx, &fwd) {
            std::process::exit(0);
        }
    }

    let w = cfg.get("width").and_then(|v| v.as_f64()).unwrap_or(1180.0);
    let h = cfg.get("height").and_then(|v| v.as_f64()).unwrap_or(820.0);
    let window_icon = tao::window::Icon::from_rgba(
        WINDOW_ICON_RGBA.to_vec(),
        WINDOW_ICON_SIZE,
        WINDOW_ICON_SIZE,
    )
    .ok();
    let window = tao::window::WindowBuilder::new()
        .with_title(format!("{APP_NAME} {APP_VERSION}"))
        .with_window_icon(window_icon.clone())
        .with_inner_size(LogicalSize::new(w, h))
        .with_min_inner_size(LogicalSize::new(720.0, 520.0))
        .with_visible(false)
        .build(&event_loop)
        .unwrap_or_else(|e| fatal_error("MD Reader 启动失败", &format!("无法创建窗口：{e}")));
    // tao 将标题栏（ICON_SMALL）与任务栏（ICON_BIG）图标分开管理，
    // builder 的 with_window_icon 只覆盖前者，任务栏需显式补设。
    window.set_taskbar_icon(window_icon);

    let api = Arc::new(Mutex::new(Api::new(cfg, startup)));

    let mut context = wry::WebContext::new(Some(config_dir().join(".webview-cache")));
    let url = if selftest {
        "mdreader://localhost/index.html#selftest=1"
    } else {
        "mdreader://localhost/index.html"
    };

    let webview = {
        let ipc_tx = tx.clone();
        let api = api.clone();
        WebViewBuilder::new_with_web_context(&mut context)
            .with_url(url)
            .with_initialization_script(SHIM_JS)
            .with_custom_protocol("mdreader".into(), |_id, req| asset_response(req))
            .with_ipc_handler(move |req: wry::http::Request<String>| {
                handle_ipc(&ipc_tx, &api, req)
            })
            .with_drag_drop_handler({
                let tx = tx.clone();
                move |ev| {
                    if let wry::DragDropEvent::Drop { paths, .. } = ev {
                        let list: Vec<String> =
                            paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                        let _ = tx.send(Uev::Drop(list));
                    }
                    true
                }
            })
            .build(&window)
            .unwrap_or_else(|e| {
                fatal_error(
                    "MD Reader 启动失败",
                    &format!("WebView2 初始化失败：{e}\n\n请确认系统已安装 Microsoft Edge WebView2 运行时。"),
                )
            })
    };
    let webview = Rc::new(webview);
    window.set_visible(true);

    let mut next_poll = Instant::now() + Duration::from_millis(150);
    let mut poll_count: u32 = 0;
    let mut quit_saved = false;

    let api_for_loop = api.clone();
    let tx_for_loop = tx.clone();

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                if selftest {
                    *control_flow = ControlFlow::WaitUntil(next_poll);
                }
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) if selftest => {
                poll_count += 1;
                let tx = tx_for_loop.clone();
                let _ = webview.evaluate_script_with_callback(SELFTEST_CHECK_JS, move |raw| {
                    let _ = tx.send(Uev::SelftestResult(raw));
                });
                // 回调未及时返回时的兜底：继续按 150ms 节拍轮询。
                next_poll += Duration::from_millis(150);
                *control_flow = ControlFlow::WaitUntil(next_poll);
            }
            Event::UserEvent(uev) => match uev {
                Uev::RpcResult { id, ok, value } => {
                    let _ = webview.evaluate_script(&resolve_js(id, ok, &value));
                }
                Uev::RpcUi { id, method, args } => {
                    let ui = bridge::UiCtx { window: &window, webview: &webview };
                    let res = {
                        let mut api = api_for_loop.lock().unwrap();
                        api.dispatch(&method, &args, Some(&ui), &tx_for_loop)
                    };
                    let (ok, value) = match res {
                        Ok(v) => (true, v.to_string()),
                        Err(e) => (false, json!(e).to_string()),
                    };
                    let _ = webview.evaluate_script(&resolve_js(id, ok, &value));
                }
                Uev::Drop(paths) => {
                    {
                        let mut api = api_for_loop.lock().unwrap();
                        api.open_paths.extend(paths.iter().cloned());
                    }
                    if let Ok(arr) = serde_json::to_string(&paths) {
                        let js = format!("window.__mdr && window.__mdr.onExternalOpen({});", arr);
                        let _ = webview.evaluate_script(&js);
                    }
                }
                Uev::Focus => {
                    window.set_minimized(false);
                    window.set_focus();
                }
                Uev::SelftestResult(raw) => {
                    if !selftest {
                        return;
                    }
                    let text = serde_json::from_str::<String>(&raw).unwrap_or_default();
                    if !text.is_empty() {
                        if let Ok(data) = serde_json::from_str::<Value>(&text) {
                            let out = config_dir().join("selftest-result.json");
                            if let Ok(s) = serde_json::to_string_pretty(&data) {
                                let _ = std::fs::write(&out, s);
                            }
                        }
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                    if poll_count >= 100 {
                        let out = config_dir().join("selftest-result.json");
                        let _ = std::fs::write(
                            &out,
                            json!({"error": "selftest timeout", "total": false}).to_string(),
                        );
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                    next_poll += Duration::from_millis(150);
                    *control_flow = ControlFlow::WaitUntil(next_poll);
                }
                Uev::Quit => {
                    if !quit_saved && !selftest {
                        quit_saved = true;
                        save_window_size(&window, &api_for_loop);
                    }
                    *control_flow = ControlFlow::Exit;
                }
            },
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if !quit_saved && !selftest {
                    quit_saved = true;
                    save_window_size(&window, &api_for_loop);
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::LoopDestroyed
                if !quit_saved && !selftest => {
                    quit_saved = true;
                    save_window_size(&window, &api_for_loop);
                }
            _ => {}
        }
    });

    fn save_window_size(window: &Window, api: &Arc<Mutex<Api>>) {
        let size = window.inner_size();
        let scale = window.scale_factor();
        let logical = size.to_logical::<f64>(scale);
        let mut api = api.lock().unwrap();
        api.cfg.insert("width".into(), json!(logical.width.round() as i64));
        api.cfg.insert("height".into(), json!(logical.height.round() as i64));
        save_config(&api.cfg);
    }
}

fn handle_ipc(tx: &mpsc::Sender<Uev>, api: &Arc<Mutex<Api>>, req: wry::http::Request<String>) {
    let body = req.into_body();
    let Ok(msg) = serde_json::from_str::<Value>(&body) else { return };
    let id = msg["id"].as_u64();
    let method = msg["method"].as_str().map(String::from);
    let args = msg["args"].as_array().cloned().unwrap_or_default();
    let (Some(id), Some(method)) = (id, method) else { return };
    if bridge::is_ui_method(&method) {
        let _ = tx.send(Uev::RpcUi { id, method, args });
        return;
    }
    let tx = tx.clone();
    let api = api.clone();
    std::thread::spawn(move || {
        let res = {
            let mut api = api.lock().unwrap();
            api.dispatch(&method, &args, None, &tx)
        };
        let (ok, value) = match res {
            Ok(v) => (true, v.to_string()),
            Err(e) => (false, json!(e).to_string()),
        };
        let _ = tx.send(Uev::RpcResult { id, ok, value });
    });
}
