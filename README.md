# MD Reader

轻量、便携、**完全离线**的 Markdown 阅读器，打包为单个免安装 EXE。

- 原生窗口（基于系统自带的 Microsoft Edge WebView2），体积小、启动快
- 自研零依赖 Markdown 渲染引擎（无 CDN、无网络请求）
- 便携：所有数据（配置）保存在 EXE 同目录，可放 U 盘随身携带

## 功能

| 功能 | 说明 |
| --- | --- |
| 原生菜单栏 | 文件 / 编辑 / 视图 / 帮助，全部动作可用 |
| 编辑与保存 | Ctrl+E 进入编辑（等宽字体，左侧行号栏随内容增删自动更新、随滚动同步），Ctrl+S 保存（原子写入 UTF-8）、Ctrl+Shift+S 另存为；未保存的标签带 ● 标记，误关需二次确认 |
| 多标签页 | 类浏览器标签：Ctrl+W 关闭、Ctrl+Tab 切换、中键关闭、滚动位置记忆、会话恢复 |
| Markdown 渲染 | 标题、粗/斜/删除线、高亮、行内代码、代码块（含语法高亮）、链接、图片、引用、有序/无序/嵌套列表、任务列表、表格（对齐）、分割线、脚注、自动链接 |
| LaTeX 公式 | `$行内$` 与 `$$块级$$`（内置离线渲染器；放入 KaTeX 发行文件到 `app/web/vendor/katex/` 即自动升级，无需改代码） |
| Mermaid 流程图 | ` ```mermaid ` 代码块渲染为 SVG 流程图（内置离线引擎：TD/LR、subgraph、四种节点形状、实线/虚线/加粗边及标签；放入完整 mermaid.min.js 到 `app/web/vendor/mermaid/` 自动升级全量 DSL），图上可缩放（−/+/%/⟲，百分比框可直接输入 40–400 回车确认）与拖拽平移 |
| 查找与替换 | `Ctrl+F` 查找（高亮全部命中、计数、Enter/Shift+Enter 跳转、Esc 关闭），`Ctrl+H` 替换（逐个 / 全部替换，替换后自动重渲染） |
| 深色 / 浅色主题 | `Ctrl+D` 切换，记忆偏好 |
| 文档大纲 | 自动生成 TOC，滚动高亮当前章节 |
| 文件树 | 打开文件夹，递归浏览子目录 |
| 最近打开 | 记录最近 12 个文件 |
| 拖放打开 | 把 `.md` 文件拖进窗口 |
| 关联打开 | 命令行 / 「打开方式」传入文件路径 |
| 打开对话框 | 文件类型过滤：Markdown / 文本 / 全部文件 |
| 图片显示 | 自动解析文档相对路径的图片 |
| 代码复制 | 每个代码块一键复制 |
| 图片放大 | 点击图片全屏查看（Esc 关闭） |
| 缩放 / 阅读进度 | 顶部进度条、字体缩放、内容栏宽约 1280px（可在 `mdreader.config.json` 的 `maxWidth` 调整） |
| 打印 / 导出 PDF | `Ctrl+P` 导出 A4 PDF（无页眉页脚、保留背景色，自动打开），排版边距 16mm/14mm |
| 安全 | 渲染结果经 HTML 净化，屏蔽 `<script>`、`on*` 事件、`javascript:` 链接 |

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+O` | 打开文件 |
| `Ctrl+Shift+O` | 打开文件夹 |
| `Ctrl+N` | 新建文件 |
| `Ctrl+S` / `Ctrl+Shift+S` | 保存 / 另存为 |
| `Ctrl+E` | 编辑 / 预览切换 |
| `Ctrl+F` | 查找（Enter / Shift+Enter 下一个 / 上一个，Esc 关闭） |
| `Ctrl+H` | 替换 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Ctrl+B` | 切换侧栏 |
| `Ctrl+T` | 文档大纲 |
| `Ctrl+D` | 切换主题 |
| `Ctrl+P` | 打印 / 导出 PDF（A4，无页眉页脚） |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置（也可按住 Ctrl + 滚轮缩放，点击缩放百分比恢复 100%） |
| `F5` | 重新加载当前文件 |

## 目录结构

```
md-reader/
├─ app/
│  ├─ main.py              # Python 入口：窗口、文件桥接、配置
│  └─ web/                 # 前端（HTML/CSS/JS，随 EXE 打包）
│     ├─ index.html
│     ├─ css/style.css
│     ├─ js/
│     │  ├─ markdown.js    # 自研 Markdown 渲染引擎（含 miniTeX 公式）
│     │  └─ app.js         # 应用控制器（标签页 / 文件树 / 主题）
│     └─ vendor/katex/     # 可选：KaTeX 完整渲染（手动放入后启用）
├─ assets/icon.ico|png     # 应用图标
├─ samples/
│  ├─ welcome.md           # 示例文档
│  └─ edge/                # 边界测试样本（多编码/超大/畸形/XSS/图片）
├─ tests/test_main.py      # 无 GUI 单元测试
├─ make_icon.py            # 生成图标
├─ requirements.txt
├─ mdreader.spec           # PyInstaller 打包配置
└─ build.ps1               # 一键打包脚本
```

## 从源码运行

```powershell
pip install -r requirements.txt
python app/main.py
# 打开指定文件
python app/main.py "C:\path\to\file.md"
```

需要系统安装 **Microsoft Edge WebView2 Runtime**（Windows 10/11 通常已预装）。

## 打包为便携 EXE

```powershell
.\build.ps1
# 产物：dist\MDReader.exe（单文件、免安装、可绿色分发）
```

或手动：

```powershell
pyinstaller mdreader.spec --noconfirm
```

## 便携性说明

- 配置保存在 EXE 同目录的 `mdreader.config.json`（可读写席位权限）。
- WebView2 缓存保存在同目录 `.webview-cache/`。
- 首次运行会在 EXE 同目录创建上述文件/文件夹；整体复制到其它机器即可继续使用。

## 开发自检与测试

```powershell
# 1) 无 GUI 单元测试（编码回退 / 配置 / 启动参数 / 桥接合同）
python tests\test_main.py

# 2) 渲染器穷举测试（Node 直跑 markdown.js，101 项断言）
node tests\md_render_test.js

# 3) 数学公式渲染测试（miniTeX 兜底路径，25 项断言）
node tests\md_math_test.js

# 4) 真实 WebView2 内的渲染 + XSS + UI 流程自检，结果写入 selftest-result.json
python app\main.py --selftest
```

发布前全部通过。

## 打包脚本被执行策略拦截时

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```
