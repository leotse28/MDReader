//! 文本解码链：utf-8(-sig) → gb18030 → utf-16 → latin-1，与 Python 版逐级一致。

use encoding_rs::Encoding;
use std::fs;
use std::path::Path;

pub fn read_text_file(path: &Path) -> std::io::Result<String> {
    let raw = fs::read(path)?;
    Ok(decode_text(&raw))
}

pub fn decode_text(raw: &[u8]) -> String {
    let body = raw.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(raw);
    if let Ok(s) = std::str::from_utf8(body) {
        return s.to_string();
    }
    let (s, had_errors) = encoding_rs::GB18030.decode_without_bom_handling(raw);
    if !had_errors {
        return s.into_owned();
    }
    let (enc, bytes): (&Encoding, &[u8]) = if raw.starts_with(&[0xFF, 0xFE]) {
        (encoding_rs::UTF_16LE, &raw[2..])
    } else if raw.starts_with(&[0xFE, 0xFF]) {
        (encoding_rs::UTF_16BE, &raw[2..])
    } else {
        (encoding_rs::UTF_16LE, raw)
    };
    let (s, had_errors) = enc.decode_without_bom_handling(bytes);
    if !had_errors {
        return s.into_owned();
    }
    raw.iter().map(|&b| b as char).collect()
}
