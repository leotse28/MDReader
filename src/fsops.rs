//! 文件系统操作：扩展名集合、目录树、相对资源、原子保存，均与 Python 版对齐。

use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const TEXT_EXT: &[&str] = &[
    ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx", ".txt", ".text", ".rst",
];
pub const IMG_EXT: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif",
];

/// 与 Python 3.12 mimetypes（含 Windows 注册表）逐项一致；None → application/octet-stream。
fn mime_for(ext: &str) -> &'static str {
    match ext {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".svg" => "image/svg+xml",
        ".bmp" => "image/bmp",
        ".ico" => "image/x-icon",
        ".avif" => "image/avif",
        ".txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn ext_lower(p: &Path) -> Option<String> {
    p.extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
}

pub fn is_text_file(p: &Path) -> bool {
    matches!(ext_lower(p).as_deref(), Some(e) if TEXT_EXT.contains(&e))
}

/// str(Path(x)) 的等价物：分隔符统一为反斜杠并折叠重复（保留 UNC 前缀）。
/// 必须按字符（而非字节）迭代，否则 UTF-8 多字节字符会被逐字节腐蚀。
pub fn norm_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let mut out = String::with_capacity(s.len());
    let mut prev_bs = false;
    for (i, c) in s.chars().enumerate() {
        if c == '\\' {
            if prev_bs && i != 1 {
                continue;
            }
            prev_bs = true;
        } else {
            prev_bs = false;
        }
        out.push(c);
    }
    out
}

pub fn list_folder(folder: &Path) -> Value {
    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(folder) {
        let mut list: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        list.sort_by_key(|p| {
            (
                !p.is_dir(),
                p.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default(),
            )
        });
        for p in list {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                items.push(json!({"type": "dir", "name": name, "path": norm_path(&p)}));
            } else if is_text_file(&p) {
                let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                items.push(json!({"type": "file", "name": name, "path": norm_path(&p), "size": size}));
            }
        }
    }
    let root_str = norm_path(folder);
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_str.clone());
    json!({"folder": root_str, "name": name, "items": items})
}

pub fn read_asset(base_dir: &str, relative: &str) -> Option<String> {
    let rel = percent_encoding::percent_decode_str(relative)
        .decode_utf8_lossy()
        .into_owned();
    let candidate = Path::new(base_dir).join(&rel).canonicalize().ok()?;
    if !candidate.is_file() {
        return None;
    }
    let ext = ext_lower(&candidate)?;
    if !IMG_EXT.contains(&ext.as_str()) && !TEXT_EXT.contains(&ext.as_str()) {
        return None;
    }
    if fs::metadata(&candidate).ok()?.len() > 25 * 1024 * 1024 {
        return None;
    }
    let data = fs::read(&candidate).ok()?;
    Some(format!(
        "data:{};base64,{}",
        mime_for(&ext),
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

/// 原子写入 UTF-8（无 BOM、无换行转换）：先写 .tmp 再 replace。
pub fn save_file(path: &Path, content: &str) -> io::Result<()> {
    if path.file_name().is_none() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid path"));
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let write = || -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        let _ = f.sync_all();
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}
