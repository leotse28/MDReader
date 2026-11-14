# MD Reader — Rust 移植契约清单（INVENTORY）

> 本文档是 Rust 版（本仓库）对 Python 版（`../md-reader`，pywebview + WebView2）
> 的移植依据。逐项核对，行为基准以 Python 版为准。
> 移植策略：**Web 前端（HTML/CSS/JS）原样复用** —— 渲染输出一致性由同一
> WebView2 引擎 + 同一份 markdown.js/app.js/mermaid-mini.js 构造性保证；
> Rust 重写的是 **宿主层**（窗口、桥接、文件系统、对话框、菜单、打印、自检）。

## 1. 入口与运行模式

| 模式 | 触发 | 行为 |
|---|---|---|
| 正常 | `mdreader [path]` | 打开窗口；path 可为文件或文件夹（"打开方式"/CLI），经 `take_startup_file` 消费一次 |
| 自检 | `mdreader --selftest` | 加载 UI（`#selftest=1`）→ 轮询 `window.__SELFTEST__`（仅接受 `phase === "final"`，100 次 × 150ms）→ 写 `selftest-result.json`（配置目录下，UTF-8 缩进 2）→ 关窗退出 |
| 配置目录 | — | 便携语义：EXE 旁（dev 时为工程根）；`mdreader.config.json` |
| 缓存清理 | 版本变更 / 自检 | 删除 `.webview-cache`；配置键 `assetVersion` 记录上次版本 |

## 2. 窗口

- 标题：`MD Reader {版本}`（Rust 版本线独立：CARGO_PKG_VERSION，起始 1.0.0）
- 尺寸：`cfg.width/height`（默认 1180×820），最小 720×520，背景 `#ffffff`，文本可选
- 菜单：**应用内 HTML 菜单栏**（`.menubar`，13px 字体、随主题配色；Rust 版自
  60b3116 起替代 muda 原生菜单——原生菜单字体取系统值不可调）。菜单结构同
  Python 版：文件/编辑/视图/帮助，动作统一派发 `window.__mdr.menu(action)`。
  - 文件：打开(Ctrl+O) file.open / 打开文件夹(Ctrl+Shift+O) file.openFolder / 新建(Ctrl+N) file.new / 保存(Ctrl+S) file.save / 另存为(Ctrl+Shift+S) file.saveAs / 关闭标签(Ctrl+W) file.closeTab / 退出 file.quit
  - 编辑：编辑预览切换(Ctrl+E) edit.toggleEdit / 查找(Ctrl+F) edit.find / 替换(Ctrl+H) edit.replace
  - 视图：侧栏(Ctrl+B) view.sidebar / 大纲(Ctrl+T) view.toc / 主题(Ctrl+D) view.theme / 放大(Ctrl+=) view.zoomIn / 缩小(Ctrl+-) view.zoomOut / 重置(Ctrl+0) view.zoomReset / 重载(F5) view.reload / 打印导出PDF(Ctrl+P) view.print
  - 帮助：关于 help.about
- 原生拖放：路径入队 + `window.__mdr.onExternalOpen([paths])` 推送（JS 另有 `take_dropped` 800ms 轮询兜底）

## 3. RPC 桥接面（21 方法，JS 侧 `window.pywebview.api.<method>(...)` → Promise）

| 方法 | 参数 | 返回 | 副作用 |
|---|---|---|---|
| get_config | — | cfg 对象 | — |
| set_config | patch 对象 | cfg | merge + 持久化 |
| get_version | — | `{name:"MD Reader", version}` | — |
| take_startup_file | — | null \| `{kind:"doc",path,name,dir,content,mtime}` \| `{kind:"folder",folder,name,items}` | 消费一次 |
| take_dropped | — | `[path...]` | 消费一次 |
| pick_file | — | doc \| null | 对话框（过滤器见 §5） |
| pick_folder | — | folder 树 \| null | 记 `lastFolder` |
| open_path | path | `{kind:"doc",...}` \| `{kind:"folder",...}` \| null | 目录→folder；文本扩展名→doc；否则 null |
| reload_doc | path | doc \| null | 同 _load_doc 副作用 |
| list_folder | folder | `{folder,name,items[]}` | items: `{type:"dir",name,path}` / `{type:"file",name,path,size}`；排序（目录优先→name.lower()）；跳过 `.` 开头；仅文本扩展名 |
| list_subfolder | folder | items[] | — |
| read_asset | base_dir, relative | `data:<mime>;base64,...` \| null | URL-decode；IMG_EXT 或 TEXT_EXT；≤25MB；svg→`image/svg+xml`，其余按 mimetypes |
| save_file | path, content | doc | **原子写 UTF-8 无 BOM**（`.tmp` + replace） |
| save_file_as | content, suggested_name | doc \| null | 另存对话框；无后缀补 `.md` |
| print_to_pdf | suggested_name | `{ok:true,path}` \| `{ok:false,error}`（取消=`"canceled"`） | 另存对话框 `PDF 文件 (*.pdf)|*.pdf`；WebView2 PrintToPdf：A4 8.27×11.69in、无页眉页脚、背景开、边距 0（版面由 CSS `@page { size:A4; margin:16mm 14mm }` 控制）；成功后系统打开文件 |
| quit_app | — | bool | 销毁窗口（WebView2 阻止脚本 window.close） |
| open_external | url | bool | 仅 http/https/mailto → 系统浏览器 |
| show_in_explorer | path | bool | 打开文件所在目录 |
| report_selftest | results | bool | 写 selftest-result.json + 0.4s 后关窗 |

`_load_doc` 副作用（open_path/reload_doc/pick_file/save_* 共用）：
`lastFile=path`；`recent` 去重后前插、截断 12；持久化配置。
返回 doc = `{path, name, dir, content, mtime}`。

## 4. 文件系统行为

- **编码链**（read_text_file）：`utf-8-sig → utf-8(严格) → gb18030 → utf-16 → latin-1 → utf-8(replace)`
- **TEXT_EXT**：md, markdown, mdown, mkd, mkdn, mdx, txt, text, rst
- **IMG_EXT**：png, jpg, jpeg, gif, svg, webp, bmp, ico, avif
- **配置默认**：theme=light, lastFile="", lastFolder="", recent=[], tabs=[], fontSize=16, width=1180, height=820, lineHeight=1.75, maxWidth=1280（旧值 860 自动迁移）, assetVersion
- 配置读写：JSON（ensure_ascii=false, indent=2）；读容忍 BOM；写经 `.tmp` + replace

## 5. 对话框过滤器

Python 版（受 pywebview 名称正则约束）：`Markdown Text (*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdx;*.txt;*.rst)` + `All Files (*.*)`。
Rust 版（rfd/Win32 原生格式）：`Markdown Text (*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdx;*.txt;*.rst)|*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdx;*.txt;*.rst|All Files (*.*)|*.*`。
**用户可见行为一致**（同样的扩展名组与默认项）。

## 6. 前端资产（原样复用，不移植不改写）

`web/`：index.html、css/style.css、js/markdown.js、js/app.js、js/mermaid-mini.js。
唯一新增：`web/js/pywebview-shim.js` —— 在 Rust 宿主注入的 `window.ipc.postMessage`
之上模拟 pywebview 的 `window.pywebview.api.*`（Promise 语义）与 `pywebviewready` 事件。
渲染管线（markdown.js → sanitizeHtml → miniTeX → MermaidMini）与 Python 版逐字节相同。

## 7. 已声明的行为差异（移植决策）

1. **版本线**：Rust 版独立从 1.0.0 起版（窗口标题体现）；功能集对齐 Python 1.9.1。
2. **菜单栏**：Rust 版用应用内 HTML 菜单栏（字体 13px 可控）；Python 版仍为原生菜单。动作派发管线相同。
2. **配置目录**：Rust 版固定 EXE 旁（便携语义统一）；Python 版 dev 时在工程根。
3. **对话框过滤器串格式**：pywebview 名称正则限制不复存在，rfd 用 Win32 原生格式（扩展名组一致）。
4. **自检关窗时机**：Python 版报告后延迟 0.4s 关窗；Rust 版写完结果即退出（仅影响 --selftest，结果文件内容同构）。
5. **webview 缓存**：Rust 版用自定义协议内联资产（无 HTTP 缓存层），`assetVersion` 清理逻辑保留但通常为空操作。

## 8. 一致性验收（parity）——已实施 ✓

- `parity/py_dump.py`：用 Python 版 Api（无窗口模式，配置重定向临时目录）对
  `../md-reader/samples/edge/` 全样例产出 `open_path`/`list_folder`/`read_asset`/
  `take_startup_file`/`take_dropped` 结果 → `parity/expected.json`（mtime 除外，键排序）。
- `cargo test`（src/tests_parity.rs）：Rust 桥接对同一样例逐字段一致；
  并校验 `web/` 资产与 Python 版逐字节一致。
- 校验过程中发现并修复：`norm_path` 按字节迭代导致 UTF-8 中文路径腐蚀
  （改为按字符迭代 + UNC 前缀保留）。

## 12. 单实例与批量打开（v1.0.1）

- 资源管理器多选 md 文件"打开方式"时，Windows 会为每个文件启动一个进程。
- Rust 版实现单实例：首实例监听 127.0.0.1:6373（纯 std TCP）；后续实例把启动文件路径转发给首实例后立即退出（exit 0，无窗口闪烁）。
- 首实例收到路径后复用拖放通路（Uev::Drop → onExternalOpen），逐文件 openInTab 开成多标签；同时置前已最小化的窗口（Uev::Focus → set_minimized(false)+set_focus()）。
- onExternalOpen 由"只开第一个文件"改为逐文件开标签（拖放多文件同样受益）；单批多文件时第一个文件保持激活。
- open_paths 队列由覆盖改为追加，避免 800ms 轮询窗口内两批转发相互覆盖丢路径。
- --selftest 不参与单实例（并行自检互不干扰）。
- 行为差异：Python 版无单实例转发（每进程独立窗口）；JS 层多标签打开两版一致。
