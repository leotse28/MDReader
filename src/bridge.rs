//! Python <-> JS 桥接：与 Python 版 Api 逐方法对齐（RPC 面 20 个公开方法）。

use crate::config::{self, Cfg, APP_NAME, APP_VERSION};
use crate::fsops::{is_text_file, list_folder, norm_path, read_asset, save_file};
use crate::print;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tao::window::Window;
use wry::WebView;

/// 事件循环用户事件：桥接结果回注 / 菜单 / 拖放 / 退出。
/// 经 mpsc 通道转发到 UI 线程（main.rs 中的转发线程）。
pub enum Uev {
    RpcResult { id: u64, ok: bool, value: String },
    RpcUi { id: u64, method: String, args: Vec<Value> },
    Drop(Vec<String>),
    SelftestResult(String),
    Focus,
    Quit,
}

/// 仅能在 UI 线程执行的操作上下文（对话框、COM 打印）。
pub struct UiCtx<'a> {
    pub window: &'a Window,
    pub webview: &'a WebView,
}

pub struct Api {
    pub cfg: Cfg,
    pub startup_file: Option<String>,
    pub open_paths: Vec<String>,
}

const UI_METHODS: &[&str] = &["pick_file", "pick_folder", "save_file_as", "print_to_pdf"];

pub fn is_ui_method(method: &str) -> bool {
    UI_METHODS.contains(&method)
}

fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

impl Api {
    pub fn new(cfg: Cfg, startup: Option<String>) -> Self {
        Self { cfg, startup_file: startup, open_paths: Vec::new() }
    }

    pub fn dispatch(
        &mut self,
        method: &str,
        args: &[Value],
        ui: Option<&UiCtx>,
        tx: &Sender<Uev>,
    ) -> Result<Value, String> {
        match method {
            "get_config" => Ok(Value::Object(self.cfg.clone())),
            "set_config" => {
                if let Some(Value::Object(patch)) = args.first() {
                    for (k, v) in patch {
                        self.cfg.insert(k.clone(), v.clone());
                    }
                    config::save_config(&self.cfg);
                }
                Ok(Value::Object(self.cfg.clone()))
            }
            "get_version" => Ok(json!({"name": APP_NAME, "version": APP_VERSION})),
            "take_startup_file" => {
                let path = self.startup_file.take();
                match path {
                    None => Ok(Value::Null),
                    Some(p) => self.open_path(&p).or(Ok(Value::Null)),
                }
            }
            "take_dropped" => {
                let paths = std::mem::take(&mut self.open_paths);
                Ok(json!(paths))
            }
            "pick_file" => self.pick_file(ui.ok_or("窗口未就绪")?),
            "pick_folder" => self.pick_folder(ui.ok_or("窗口未就绪")?),
            "open_path" => self.open_path(&arg_str(args, 0)),
            "reload_doc" => self.reload_doc(&arg_str(args, 0)),
            "list_folder" => Ok(list_folder(Path::new(&arg_str(args, 0)))),
            "list_subfolder" => {
                let v = list_folder(Path::new(&arg_str(args, 0)));
                Ok(v.get("items").cloned().unwrap_or(Value::Array(Vec::new())))
            }
            "read_asset" => Ok(read_asset(&arg_str(args, 0), &arg_str(args, 1))
                .map(Value::String)
                .unwrap_or(Value::Null)),
            "save_file" => self.save_file_rpc(&arg_str(args, 0), &arg_str(args, 1)),
            "save_file_as" => {
                self.save_file_as(&arg_str(args, 0), &arg_str(args, 1), ui.ok_or("窗口未就绪")?)
            }
            "print_to_pdf" => print::print_to_pdf(ui.ok_or("窗口未就绪")?.webview, &arg_str(args, 0)),
            "quit_app" => {
                let _ = tx.send(Uev::Quit);
                Ok(Value::Bool(true))
            }
            "open_external" => {
                let url = arg_str(args, 0);
                if url.starts_with("http://")
                    || url.starts_with("https://")
                    || url.starts_with("mailto:")
                {
                    let ok = std::process::Command::new("rundll32")
                        .args(["url.dll,FileProtocolHandler", &url])
                        .spawn()
                        .is_ok();
                    Ok(Value::Bool(ok))
                } else {
                    Ok(Value::Bool(false))
                }
            }
            "show_in_explorer" => {
                let p = PathBuf::from(arg_str(args, 0));
                if p.exists() {
                    let target =
                        if p.is_dir() { p } else { p.parent().map(|x| x.to_path_buf()).unwrap_or(p) };
                    let ok = std::process::Command::new("explorer").arg(target).spawn().is_ok();
                    Ok(Value::Bool(ok))
                } else {
                    Ok(Value::Bool(false))
                }
            }
            "handle_drop" => {
                self.push_dropped(args.first().cloned().unwrap_or(Value::Null));
                Ok(Value::Null)
            }
            "report_selftest" => {
                let results = args.first().cloned().unwrap_or(Value::Null);
                let out = config::config_dir().join("selftest-result.json");
                let ok = serde_json::to_string_pretty(&results)
                    .map_err(|e| e.to_string())
                    .and_then(|s| fs::write(&out, s).map_err(|e| e.to_string()))
                    .is_ok();
                if ok {
                    let tx2 = tx.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(400));
                        let _ = tx2.send(Uev::Quit);
                    });
                }
                Ok(Value::Bool(ok))
            }
            _ => Err(format!("未知方法: {method}")),
        }
    }

    /// 原生拖放路径入队（兼容 pywebviewFullPath / path / 纯字符串三种形态）。
    pub fn push_dropped(&mut self, event: Value) {
        let mut paths: Vec<String> = Vec::new();
        if let Some(items) = event.as_array() {
            for item in items {
                if let Some(s) = item.as_str() {
                    paths.push(s.to_string());
                } else if let Some(obj) = item.as_object() {
                    if let Some(p) = obj.get("pywebviewFullPath").and_then(|v| v.as_str()) {
                        paths.push(p.to_string());
                    } else if let Some(p) = obj.get("path").and_then(|v| v.as_str()) {
                        paths.push(p.to_string());
                    }
                }
            }
        }
        if !paths.is_empty() {
            self.open_paths = paths;
        }
    }

    fn load_doc(&mut self, path: &str) -> Result<Value, String> {
        let p = Path::new(path);
        let content = crate::encoding::read_text_file(p).map_err(|e| e.to_string())?;
        let norm = norm_path(p);
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dir = p.parent().map(norm_path).unwrap_or_default();
        self.cfg.insert("lastFile".into(), json!(norm));
        let mut recent: Vec<String> = self
            .cfg
            .get("recent")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        recent.retain(|r| r != &norm);
        recent.insert(0, norm.clone());
        recent.truncate(12);
        self.cfg.insert("recent".into(), json!(recent));
        config::save_config(&self.cfg);
        let mtime = fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| Value::from(d.as_secs_f64()))
            .unwrap_or_else(|| {
                Value::from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64())
            });
        Ok(json!({"path": norm, "name": name, "dir": dir, "content": content, "mtime": mtime}))
    }

    fn open_path(&mut self, path: &str) -> Result<Value, String> {
        let p = Path::new(path);
        if p.is_dir() {
            let mut v = list_folder(p);
            if let Value::Object(m) = &mut v {
                m.shift_insert(0, "kind".into(), json!("folder"));
            }
            return Ok(v);
        }
        if p.exists() && is_text_file(p) {
            let mut d = self.load_doc(&norm_path(p))?;
            if let Value::Object(m) = &mut d {
                m.shift_insert(0, "kind".into(), json!("doc"));
            }
            return Ok(d);
        }
        Ok(Value::Null)
    }

    fn reload_doc(&mut self, path: &str) -> Result<Value, String> {
        let p = Path::new(path);
        if p.exists() && is_text_file(p) {
            return self.load_doc(&norm_path(p)).or(Ok(Value::Null));
        }
        Ok(Value::Null)
    }

    fn pick_file(&mut self, ui: &UiCtx) -> Result<Value, String> {
        let picked = rfd::FileDialog::new()
            .set_parent(ui.window)
            .add_filter(
                "Markdown Text",
                &["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt", "rst"],
            )
            .pick_file();
        match picked {
            None => Ok(Value::Null),
            Some(p) => self.load_doc(&p.to_string_lossy()),
        }
    }

    fn pick_folder(&mut self, ui: &UiCtx) -> Result<Value, String> {
        let picked = rfd::FileDialog::new().set_parent(ui.window).pick_folder();
        match picked {
            None => Ok(Value::Null),
            Some(folder) => {
                let fstr = folder.to_string_lossy().into_owned();
                self.cfg.insert("lastFolder".into(), json!(fstr));
                config::save_config(&self.cfg);
                Ok(list_folder(&folder))
            }
        }
    }

    fn save_file_rpc(&mut self, path: &str, content: &str) -> Result<Value, String> {
        let p = Path::new(path);
        if p.file_name().is_none() {
            return Err("invalid path".into());
        }
        save_file(p, content).map_err(|e| e.to_string())?;
        self.load_doc(&norm_path(p))
    }

    fn save_file_as(&mut self, content: &str, suggested: &str, ui: &UiCtx) -> Result<Value, String> {
        let name = if suggested.is_empty() { "未命名.md" } else { suggested };
        let picked = rfd::FileDialog::new()
            .set_parent(ui.window)
            .add_filter(
                "Markdown Text",
                &["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt", "rst"],
            )
            .set_file_name(name)
            .save_file();
        let Some(p) = picked else { return Ok(Value::Null) };
        let mut path = p.to_string_lossy().into_owned();
        if Path::new(&path).extension().is_none() {
            path.push_str(".md");
        }
        save_file(Path::new(&path), content).map_err(|e| e.to_string())?;
        self.load_doc(&norm_path(Path::new(&path)))
    }
}
