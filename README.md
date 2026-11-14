# MD Reader（Rust 版）

轻量便携的 Windows Markdown 阅读器 —— Python 版（`../md-reader`，pywebview）的
Rust 重写。**Web 前端原样复用**（同一份 markdown.js/app.js/mermaid-mini.js，
同一 WebView2 引擎），渲染输出与 Python 版构造性一致；Rust 重写宿主层。

## 架构

```
mdreader.exe (Rust)
├── tao        窗口 / 事件循环
├── muda       原生菜单栏（动作 → __mdr.menu(id)）
├── wry        WebView2 宿主
│   ├── 自定义协议 mdreader:// → 内联资产服务（无 HTTP 缓存问题）
│   ├── IPC    window.ipc.postMessage → 桥接 RPC
│   └── 初始化脚本 web/js/pywebview-shim.js（模拟 pywebview.api Promise 语义）
├── web/       前端资产（与 Python 版逐字节一致，由一致性测试保证）
└── COM        ICoreWebView2_16::PrintToPdf → A4 无页眉页脚 PDF 导出
```

## 命令

- 运行：`cargo run --release`（或 `mdreader.exe [文件/文件夹]`）
- 单元测试 + 一致性校验：`cargo test`（12 项）
- 自检（真实 WebView2 内跑 79 项 UI 检查后退出）：
  `mdreader.exe --selftest` → 配置目录写入 `selftest-result.json`
- 发布构建：`cargo build --release` → `target/release/mdreader.exe`
  （便携部署：EXE 与 `web/` 目录放在一起即可）

## 与 Python 版的一致性

- **桥接 RPC 20 方法**逐字段一致（`parity/`：Python 版 Api 无窗口模式产出
  基线 `expected.json`，`cargo test` 逐项比对——10 个边界样例含 GB18030/
  UTF-16/BOM/1.4MB/XSS、目录树、相对资源 data URL、startup/dropped 消费语义）。
- **Web 资产逐字节一致**（测试断言 SHA 级等同）。
- **编码链**一致：utf-8-sig → utf-8 → gb18030 → utf-16 → latin-1。
- **A4 PDF 导出**一致：8.27×11.69in、无页眉页脚、背景开、边距 0（版面由
  CSS `@page` 控制），成功后系统打开文件。
- 自检结果 JSON 同构（`phase: "final"`、`total: true`）。

已声明的行为差异见 `INVENTORY.md` §7（版本线独立从 1.0.0 起版、配置固定
EXE 旁、对话框过滤器串格式、自检关窗时机、webview 缓存层）。

## 移植契约

`INVENTORY.md` 是完整移植契约：RPC 签名/返回形状/副作用、编码链、扩展名
集合、菜单表、配置默认值与迁移、自检协议。改动行为前先对照该文档。
