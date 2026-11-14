//! Python 版 vs Rust 版桥接一致性校验。
//! 基线由 parity/py_dump.py 生成（Python 版 Api 无窗口模式），
//! 本测试用相同输入驱动 Rust 桥接并逐字段比对（mtime 除外，键排序规范化）。

use crate::bridge::{Api, Uev};
use crate::config::load_config;
use serde_json::Value;
use std::sync::mpsc;

fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), canonical(&m[k])))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn strip_mtime(v: Value) -> Value {
    match v {
        Value::Object(mut m) => {
            m.remove("mtime");
            Value::Object(m)
        }
        other => other,
    }
}

fn temp_cfg_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mdreader-parity-rs-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn parity_with_python_bridge() {
    let _guard = crate::tests_core::CONFIG_LOCK.lock().unwrap();
    let manifest = env!("CARGO_MANIFEST_DIR");
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{manifest}/parity/expected.json")).unwrap(),
    )
    .unwrap();
    let md_reader = std::path::Path::new(manifest).parent().unwrap().join("md-reader");
    let edge = md_reader.join("samples").join("edge");

    let dir = temp_cfg_dir("main");
    unsafe { std::env::set_var("MDREADER_CONFIG_DIR", &dir) };
    let cfg = load_config();
    let mut api = Api::new(cfg, None);
    let (tx, rx) = mpsc::channel::<Uev>();
    std::thread::spawn(move || while let Ok(_) = rx.recv() {});
    let call = |api: &mut Api, method: &str, args: Value| -> Value {
        api.dispatch(method, &[args], None, &tx)
            .unwrap_or(Value::Null)
    };

    // ---- open_path：全部样例逐字段一致 ----
    let cases = expected["open_path"].as_object().unwrap();
    for (name, want) in cases {
        let path = edge.join(name);
        let res = api.dispatch(
            "open_path",
            &[Value::String(path.to_string_lossy().into_owned())],
            None,
            &tx,
        );
        let got = match res {
            Ok(v) => v,
            Err(e) => panic!(
                "open_path 派发失败: {name}: {e} | exists={} | path={}",
                path.exists(),
                path.display()
            ),
        };
        assert_eq!(
            canonical(&strip_mtime(got)),
            canonical(want),
            "open_path 不一致: {name}"
        );
    }

    // ---- list_folder ----
    for (key, want) in expected["list_folder"].as_object().unwrap() {
        let path = match key.as_str() {
            "edge" => edge.clone(),
            "imgs" => edge.join("imgs"),
            _ => edge.join("不存在的目录"),
        };
        let got = call(&mut api, "list_folder", json_str(&path.to_string_lossy()));
        assert_eq!(canonical(&got), canonical(want), "list_folder 不一致: {key}");
    }

    // ---- read_asset ----
    for (key, case) in expected["read_asset"].as_object().unwrap() {
        let args = serde_json::json!([case["base"], case["rel"]]);
        let got = api
            .dispatch("read_asset", args.as_array().unwrap(), None, &tx)
            .unwrap_or(Value::Null);
        assert_eq!(got, case["result"], "read_asset 不一致: {key}");
    }

    // ---- take_startup_file 消费一次 ----
    api.startup_file = Some(edge.join("xss测试.md").to_string_lossy().into_owned());
    let first = api.dispatch("take_startup_file", &[], None, &tx).unwrap();
    assert_eq!(
        canonical(&strip_mtime(first)),
        canonical(&expected["startup_first"]),
        "take_startup_file 首次不一致"
    );
    let second = api.dispatch("take_startup_file", &[], None, &tx).unwrap();
    assert_eq!(second, expected["startup_second"], "take_startup_file 未消费清空");

    // ---- take_dropped 消费一次 ----
    api.open_paths = vec!["D:\\a.md".into(), "D:\\b.md".into()];
    let first = api.dispatch("take_dropped", &[], None, &tx).unwrap();
    assert_eq!(first, expected["dropped_first"], "take_dropped 首次不一致");
    let second = api.dispatch("take_dropped", &[], None, &tx).unwrap();
    assert_eq!(second, expected["dropped_second"], "take_dropped 未消费清空");

    // ---- get_version 结构 ----
    let v = api.dispatch("get_version", &[], None, &tx).unwrap();
    let keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, expected["version_shape"].as_array().unwrap()
        .iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>());

    // ---- Web 资产与 Python 版逐字节一致 ----
    let rust_web = std::path::Path::new(manifest).join("web");
    let py_web = md_reader.join("app").join("web");
    for rel in ["index.html", "css/style.css", "js/app.js", "js/markdown.js", "js/mermaid-mini.js"] {
        let a = std::fs::read(rust_web.join(rel)).unwrap();
        let b = std::fs::read(py_web.join(rel)).unwrap();
        assert_eq!(a, b, "Web 资产不一致: {rel}");
    }

    unsafe { std::env::remove_var("MDREADER_CONFIG_DIR") };
    let _ = std::fs::remove_dir_all(&dir);
}

fn json_str(s: &str) -> Value {
    Value::String(s.to_string())
}
