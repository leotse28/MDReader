//! 核心模块单元测试：配置、解码链、文件系统操作（与 Python 版 tests/test_main.py 对应）。

use crate::config::{default_config, load_config, save_config};
use crate::encoding::decode_text;
use crate::fsops::{is_text_file, list_folder, norm_path, read_asset, save_file};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "mdreader-rs-test-{}-{}",
        tag,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 配置测试串行化：MDREADER_CONFIG_DIR 是进程级环境变量，并行测试会互相覆盖。
pub(crate) static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn config_defaults_and_migration() {
    let _guard = CONFIG_LOCK.lock().unwrap();
    let cfg = default_config();
    assert_eq!(cfg.get("theme").and_then(|v| v.as_str()), Some("light"));
    assert_eq!(cfg.get("fontSize").and_then(|v| v.as_i64()), Some(16));
    assert_eq!(cfg.get("width").and_then(|v| v.as_i64()), Some(1180));
    assert_eq!(cfg.get("height").and_then(|v| v.as_i64()), Some(820));
    assert_eq!(cfg.get("lineHeight").and_then(|v| v.as_f64()), Some(1.75));
    assert_eq!(cfg.get("maxWidth").and_then(|v| v.as_i64()), Some(1280));

    // 旧默认 860 迁移到 1280
    let dir = temp_dir("migration");
    unsafe { std::env::set_var("MDREADER_CONFIG_DIR", &dir); }
    fs::write(
        crate::config::config_path(),
        serde_json::to_string(&json!({"maxWidth": 860})).unwrap(),
    )
    .unwrap();
    let cfg = load_config();
    assert_eq!(cfg.get("maxWidth").and_then(|v| v.as_i64()), Some(1280));
    unsafe { std::env::remove_var("MDREADER_CONFIG_DIR"); }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn config_roundtrip_and_bom() {
    let _guard = CONFIG_LOCK.lock().unwrap();
    let dir = temp_dir("roundtrip");
    unsafe { std::env::set_var("MDREADER_CONFIG_DIR", &dir); }
    let mut cfg = load_config();
    cfg.insert("theme".into(), json!("dark"));
    cfg.insert("recent".into(), json!(["a.md", "b.md"]));
    save_config(&cfg);
    let cfg2 = load_config();
    assert_eq!(cfg2.get("theme").and_then(|v| v.as_str()), Some("dark"));
    assert_eq!(
        cfg2.get("recent").and_then(|v| v.as_array().cloned()),
        Some(vec![json!("a.md"), json!("b.md")])
    );
    // BOM 容忍
    let p = crate::config::config_path();
    let body = fs::read_to_string(&p).unwrap();
    fs::write(&p, format!("\u{feff}{body}")).unwrap();
    let cfg3 = load_config();
    assert_eq!(cfg3.get("theme").and_then(|v| v.as_str()), Some("dark"));
    unsafe { std::env::remove_var("MDREADER_CONFIG_DIR"); }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn decode_utf8_variants() {
    assert_eq!(decode_text("hello".as_bytes()), "hello");
    assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'h', b'i']), "hi");
    // 无效 UTF-8 且非 GB18030 → latin-1（奇数字节使 UTF-16 失败）
    assert_eq!(decode_text(&[0x81, 0x00, 0x41]), "\u{81}\u{0}A");
}

#[test]
fn decode_gb18030_and_utf16() {
    // "中文" 的 GB18030 编码
    assert_eq!(decode_text(&[0xD6, 0xD0, 0xCE, 0xC4]), "中文");
    // UTF-16LE 带 BOM："中" = 2D 4E
    assert_eq!(decode_text(&[0xFF, 0xFE, 0x2D, 0x4E]), "\u{4E2D}");
    // UTF-16BE 带 BOM
    assert_eq!(decode_text(&[0xFE, 0xFF, 0x4E, 0x2D]), "\u{4E2D}");
    // UTF-16LE 无 BOM（Python utf-16 默认小端）；字节须含高位才不会先被 UTF-8 命中
    assert_eq!(decode_text(&[0x0C, 0xFF]), "\u{FF0C}");
}

#[test]
fn text_ext_detection() {
    assert!(is_text_file(Path::new("a.md")));
    assert!(is_text_file(Path::new("a.MD")));
    assert!(is_text_file(Path::new("x/y/z.markdown")));
    assert!(is_text_file(Path::new("notes.txt")));
    assert!(!is_text_file(Path::new("img.png")));
    assert!(!is_text_file(Path::new("archive.zip")));
    assert!(!is_text_file(Path::new(".md")));
    assert!(!is_text_file(Path::new("noext")));
}

#[test]
fn norm_path_separators() {
    assert_eq!(norm_path(Path::new("D:/a/b/c.md")), "D:\\a\\b\\c.md");
    assert_eq!(norm_path(Path::new("D:\\a\\b.md")), "D:\\a\\b.md");
    assert_eq!(norm_path(Path::new("D://a//b.md")), "D:\\a\\b.md");
}

#[test]
fn list_folder_sorting_and_filtering() {
    let dir = temp_dir("listfolder");
    fs::create_dir_all(dir.join("zsub")).unwrap();
    fs::create_dir_all(dir.join(".hidden_dir")).unwrap();
    fs::write(dir.join("b.md"), "# B").unwrap();
    fs::write(dir.join("A.md"), "# A").unwrap();
    fs::write(dir.join(".dotfile"), "x").unwrap();
    fs::write(dir.join("img.png"), "x").unwrap();
    fs::write(dir.join("c.txt"), "c").unwrap();

    let v = list_folder(&dir);
    assert_eq!(v["folder"], json!(norm_path(&dir)));
    assert_eq!(v["name"], json!(dir.file_name().unwrap().to_string_lossy()));
    let items = v["items"].as_array().unwrap();
    let names: Vec<&str> = items.iter().map(|i| i["name"].as_str().unwrap()).collect();
    // 目录优先，其后按名称小写排序；隐藏项与非文本文件被跳过
    assert_eq!(names, vec!["zsub", "A.md", "b.md", "c.txt"]);
    assert_eq!(items[0]["type"], json!("dir"));
    assert_eq!(items[0]["path"], json!(norm_path(&dir.join("zsub"))));
    assert_eq!(items[1]["type"], json!("file"));
    assert_eq!(items[1]["size"], json!(3));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn save_file_atomic_utf8_no_bom() {
    let dir = temp_dir("save");
    let p = dir.join("doc.md");
    save_file(&p, "# 标题\n内容").unwrap();
    let raw = fs::read(&p).unwrap();
    assert!(!raw.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert_eq!(String::from_utf8(raw).unwrap(), "# 标题\n内容");
    // 覆盖写入
    save_file(&p, "v2").unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "v2");
    // 无残留 tmp
    assert!(!dir.join("doc.md.tmp").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_asset_data_url() {
    let dir = temp_dir("asset");
    fs::write(dir.join("pic.png"), [0x89, 0x50, 0x4E, 0x47]).unwrap();
    fs::write(dir.join("vec.svg"), "<svg/>").unwrap();
    fs::write(dir.join("evil.exe"), "MZ").unwrap();
    fs::write(dir.join("note.txt"), "hi").unwrap();

    let url = read_asset(dir.to_str().unwrap(), "pic.png").unwrap();
    assert!(url.starts_with("data:image/png;base64,"));
    let url = read_asset(dir.to_str().unwrap(), "vec.svg").unwrap();
    assert!(url.starts_with("data:image/svg+xml;base64,"));
    let url = read_asset(dir.to_str().unwrap(), "note.txt").unwrap();
    assert!(url.starts_with("data:text/plain;base64,"));
    // 不允许的扩展名 / 不存在的文件
    assert!(read_asset(dir.to_str().unwrap(), "evil.exe").is_none());
    assert!(read_asset(dir.to_str().unwrap(), "missing.png").is_none());
    // URL 编码的相对路径
    let sub = dir.join("sub dir");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("a.png"), "x").unwrap();
    assert!(read_asset(dir.to_str().unwrap(), "sub%20dir/a.png").is_some());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recent_list_contract() {
    // recent：去重、前插、截断 12（bridge.load_doc 副作用的契约）
    let mut recent: Vec<String> = vec!["a", "b", "c"].iter().map(|s| s.to_string()).collect();
    let norm = "b".to_string();
    recent.retain(|r| r != &norm);
    recent.insert(0, norm.clone());
    recent.truncate(12);
    assert_eq!(recent, vec!["b", "a", "c"]);
    let mut big: Vec<String> = (0..20).map(|i| format!("f{i}.md")).collect();
    big.insert(0, "new.md".into());
    big.truncate(12);
    assert_eq!(big.len(), 12);
    assert_eq!(big[0], "new.md");
    assert_eq!(big[11], "f10.md");
}

#[test]
fn config_json_shape() {
    let cfg: Value = serde_json::to_value(default_config()).unwrap();
    let s = serde_json::to_string_pretty(&cfg).unwrap();
    assert!(s.contains("\"theme\": \"light\""));
    assert!(s.contains("\"maxWidth\": 1280"));
}
