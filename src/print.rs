//! A4 无页眉页脚 PDF 导出：WebView2 原生 PrintToPdf 管线（COM）。
//! 与 Python 版一致：SaveFileDialog → PrintSettings(A4/无页眉页脚/背景开/边距 0)
//! → PrintToPdfAsync → 成功后系统打开文件。全部在 UI 线程执行，
//! 等待完成时由 webview2-com 的 wait_with_pump 泵消息，界面不冻结。

use serde_json::{json, Value};
use webview2_com::PrintToPdfCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_16, ICoreWebView2_2, ICoreWebView2Environment11, ICoreWebView2PrintSettings,
};
use windows_core::Interface;
use wry::WebViewExtWindows;

use std::sync::atomic::{AtomicBool, Ordering};

static PRINT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn sanitize_name(suggested: &str) -> String {
    let mut safe: String = suggested
        .trim()
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    if safe.is_empty() {
        safe = "document".into();
    }
    if !safe.to_lowercase().ends_with(".pdf") {
        safe.push_str(".pdf");
    }
    safe
}

fn open_in_shell(path: &str) {
    let _ = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", path])
        .spawn();
}

pub fn print_to_pdf(webview: &wry::WebView, suggested: &str) -> Result<Value, String> {
    if PRINT_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Ok(json!({"ok": false, "error": "打印进行中"}));
    }
    let result = print_to_pdf_inner(webview, suggested);
    PRINT_IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

fn print_to_pdf_inner(webview: &wry::WebView, suggested: &str) -> Result<Value, String> {
    let safe = sanitize_name(suggested);
    let Some(path) = rfd::FileDialog::new()
        .add_filter("PDF 文件", &["pdf"])
        .set_title("导出 PDF（A4 · 无页眉页脚）")
        .set_file_name(&safe)
        .save_file()
    else {
        return Ok(json!({"ok": false, "error": "canceled"}));
    };
    let path_str = path.to_string_lossy().into_owned();

    let core = webview.webview();
    let core2: ICoreWebView2_2 = core.cast().map_err(|e| e.to_string())?;
    let env = unsafe { core2.Environment() }.map_err(|e| e.to_string())?;
    let env11: ICoreWebView2Environment11 = env.cast().map_err(|e| e.to_string())?;
    let ps: ICoreWebView2PrintSettings =
        unsafe { env11.CreatePrintSettings() }.map_err(|e| e.to_string())?;
    unsafe {
        ps.SetPageWidth(8.27).map_err(|e| e.to_string())?;
        ps.SetPageHeight(11.69).map_err(|e| e.to_string())?;
        ps.SetShouldPrintHeaderAndFooter(false).map_err(|e| e.to_string())?;
        ps.SetShouldPrintBackgrounds(true).map_err(|e| e.to_string())?;
        ps.SetMarginTop(0.0).map_err(|e| e.to_string())?;
        ps.SetMarginBottom(0.0).map_err(|e| e.to_string())?;
        ps.SetMarginLeft(0.0).map_err(|e| e.to_string())?;
        ps.SetMarginRight(0.0).map_err(|e| e.to_string())?;
    }
    let core16: ICoreWebView2_16 = core.cast().map_err(|e| e.to_string())?;
    let path_h = windows_core::HSTRING::from(path_str.as_str());
    let settings = ps.clone();
    let print_op = core16.clone();

    let done = PrintToPdfCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| {
            unsafe { print_op.PrintToPdf(&path_h, &settings, &handler) }
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(|res: windows_core::Result<()>, ok: bool| {
            if res.is_ok() && ok {
                Ok(())
            } else {
                res
            }
        }),
    );

    match done {
        Ok(()) => {
            open_in_shell(&path_str);
            Ok(json!({"ok": true, "path": path_str}))
        }
        Err(e) => Ok(json!({"ok": false, "error": e.to_string()})),
    }
}
