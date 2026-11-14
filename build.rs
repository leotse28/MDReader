//! 构建脚本：为 Windows 可执行文件嵌入应用图标与版本资源。

fn main() {
    #[cfg(target_os = "windows")]
    {
        use winresource::WindowsResource;
        let mut res = WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("FileDescription", env!("CARGO_PKG_DESCRIPTION"));
        res.set("ProductName", "MD Reader");
        res.compile().expect("资源编译失败（需要 MSVC rc.exe 或 windres）");
    }
}
