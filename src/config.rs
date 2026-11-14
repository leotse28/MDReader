//! 配置读写：便携语义（EXE 旁），默认值、迁移与原子写均与 Python 版对齐。

use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

pub type Cfg = Map<String, Value>;

pub const APP_NAME: &str = "MD Reader";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CONFIG_FILENAME: &str = "mdreader.config.json";

/// 配置目录：EXE 旁（便携）。测试可通过环境变量 MDREADER_CONFIG_DIR 重定向。
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MDREADER_CONFIG_DIR")
        && !dir.is_empty() {
            return PathBuf::from(dir);
        }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    config_dir().join(CONFIG_FILENAME)
}

pub fn default_config() -> Cfg {
    let mut m = Map::new();
    m.insert("theme".into(), Value::String("light".into()));
    m.insert("lastFile".into(), Value::String(String::new()));
    m.insert("lastFolder".into(), Value::String(String::new()));
    m.insert("recent".into(), Value::Array(Vec::new()));
    m.insert("tabs".into(), Value::Array(Vec::new()));
    m.insert("fontSize".into(), Value::from(16));
    m.insert("width".into(), Value::from(1180));
    m.insert("height".into(), Value::from(820));
    m.insert("lineHeight".into(), Value::from(1.75));
    m.insert("maxWidth".into(), Value::from(1280));
    m
}

pub fn load_config() -> Cfg {
    let mut cfg = default_config();
    if let Ok(text) = fs::read_to_string(config_path()) {
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        if let Ok(Value::Object(data)) = serde_json::from_str::<Value>(text) {
            for (k, v) in data {
                cfg.insert(k, v);
            }
        }
    }
    if cfg.get("maxWidth").and_then(|v| v.as_i64()) == Some(860) {
        cfg.insert("maxWidth".into(), Value::from(1280));
    }
    cfg
}

pub fn save_config(cfg: &Cfg) {
    let p = config_path();
    let tmp = p.with_extension("tmp");
    if let Ok(json) = serde_json::to_string_pretty(cfg)
        && fs::write(&tmp, json.as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, &p);
        }
    let _ = fs::remove_file(&tmp);
}
