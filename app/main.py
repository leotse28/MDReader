"""
MD Reader - a lightweight, portable Markdown reader for Windows.

Architecture
------------
Python (pywebview) hosts a native window that renders a local HTML/JS UI
using the system Microsoft Edge WebView2 engine. All file access is done
through a small Python "bridge" exposed to JavaScript (`window.pywebview.api`).
Markdown parsing happens client-side in JS, so no network is required at all.

This file is the application entry point.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
import base64
import mimetypes
import webbrowser
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import webview
    from webview.menu import Menu, MenuAction, MenuSeparator
except Exception:  # pragma: no cover - only happens if deps missing
    webview = None


APP_NAME = "MD Reader"
APP_VERSION = "1.7.0"
CONFIG_FILENAME = "mdreader.config.json"

# Optional command-line file to open at startup
STARTUP_FILE: Optional[str] = None


# ---------------------------------------------------------------------------
# Resource resolution (works both in dev and inside a PyInstaller bundle)
# ---------------------------------------------------------------------------
def resource_base() -> Path:
    if getattr(sys, "frozen", False):
        # PyInstaller onefile: files unpacked to sys._MEIPASS
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def web_root() -> Path:
    return resource_base() / "web"


# Portable config: stored next to the EXE (or project root in dev)
def config_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def config_path() -> Path:
    return config_dir() / CONFIG_FILENAME


DEFAULT_CONFIG: Dict[str, Any] = {
    "theme": "light",
    "lastFile": "",
    "lastFolder": "",
    "recent": [],
    "tabs": [],
    "fontSize": 16,
    "width": 1180,
    "height": 820,
    "lineHeight": 1.75,
    "maxWidth": 1280,
}


def load_config() -> Dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    try:
        p = config_path()
        if p.exists():
            # utf-8-sig tolerates a BOM (e.g. hand-edited in Notepad)
            with p.open("r", encoding="utf-8-sig") as f:
                data = json.load(f)
            if isinstance(data, dict):
                cfg.update(data)
    except Exception:
        pass
    # 迁移：860 是旧版默认值（UI 从未提供修改入口），视为未设置，升级到新默认
    if cfg.get("maxWidth") == 860:
        cfg["maxWidth"] = 1280
    return cfg


def save_config(cfg: Dict[str, Any]) -> None:
    try:
        p = config_path()
        tmp = p.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    except Exception:
        pass


TEXT_EXT = {".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx", ".txt", ".text", ".rst"}
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif"}

# pywebview 校验格式为 'Name (*.ext1;*.ext2)'，Name 只允许字母/数字/下划线/空格
# （webview.util.parse_file_type 的正则），不能含 '/' 等符号，否则对话框报错。
FILE_DIALOG_TYPES = (
    "Markdown Text (*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdx;*.txt;*.rst)",
    "All Files (*.*)",
)


def is_text_file(p: Path) -> bool:
    return p.suffix.lower() in TEXT_EXT


def read_text_file(path: str) -> str:
    p = Path(path)
    raw = p.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "utf-16", "latin-1"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Python <-> JS bridge
# ---------------------------------------------------------------------------
class Api:
    def __init__(self) -> None:
        self._window: Optional["webview.Window"] = None
        self.cfg = load_config()
        self._open_paths: List[str] = []
        self._startup_file: Optional[str] = None
        self._lock = threading.Lock()

    # ---- config -------------------------------------------------------
    def get_config(self) -> Dict[str, Any]:
        return self.cfg

    def set_config(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        if isinstance(patch, dict):
            self.cfg.update(patch)
            save_config(self.cfg)
        return self.cfg

    def get_version(self) -> Dict[str, str]:
        return {"name": APP_NAME, "version": APP_VERSION}

    # ---- startup file (from "Open with" / CLI) --------------------------
    def take_startup_file(self) -> Optional[Dict[str, Any]]:
        """Called by the UI on boot; returns the file passed on the command
        line (if any) so the window can open it. Consumed once."""
        with self._lock:
            path = getattr(self, "_startup_file", None)
            self._startup_file = None
        if not path:
            return None
        try:
            p = Path(path)
            if p.is_dir():
                return {"kind": "folder", **self.list_folder(str(p))}
            if p.exists() and is_text_file(p):
                return {"kind": "doc", **self._load_doc(str(p))}
        except Exception:
            return None
        return None

    # ---- opening files -------------------------------------------------
    def pick_file(self) -> Optional[Dict[str, Any]]:
        if not self._window:
            return None
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=FILE_DIALOG_TYPES,
        )
        if not result:
            return None
        return self._load_doc(result[0])

    def pick_folder(self) -> Optional[Dict[str, Any]]:
        if not self._window:
            return None
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            return None
        folder = result[0]
        self.cfg["lastFolder"] = folder
        save_config(self.cfg)
        return self.list_folder(folder)

    def _load_doc(self, path: str) -> Dict[str, Any]:
        path = str(Path(path))
        content = read_text_file(path)
        p = Path(path)
        self.cfg["lastFile"] = path
        recent = [r for r in self.cfg.get("recent", []) if r != path]
        recent.insert(0, path)
        self.cfg["recent"] = recent[:12]
        save_config(self.cfg)
        return {
            "path": path,
            "name": p.name,
            "dir": str(p.parent),
            "content": content,
            "mtime": p.stat().st_mtime if p.exists() else time.time(),
        }

    def open_path(self, path: str) -> Optional[Dict[str, Any]]:
        try:
            p = Path(path)
            if p.is_dir():
                return {"kind": "folder", **self.list_folder(str(p))}
            if p.exists() and is_text_file(p):
                return {"kind": "doc", **self._load_doc(str(p))}
        except Exception:
            return None
        return None

    def reload_doc(self, path: str) -> Optional[Dict[str, Any]]:
        try:
            p = Path(path)
            if p.exists() and is_text_file(p):
                return self._load_doc(str(p))
        except Exception:
            return None
        return None

    # ---- folder tree ----------------------------------------------------
    def list_folder(self, folder: str) -> Dict[str, Any]:
        root = Path(folder)
        items: List[Dict[str, Any]] = []
        try:
            for entry in sorted(
                root.iterdir(),
                key=lambda e: (not e.is_dir(), e.name.lower()),
            ):
                if entry.name.startswith("."):
                    continue
                if entry.is_dir():
                    items.append({"type": "dir", "name": entry.name, "path": str(entry)})
                elif is_text_file(entry):
                    try:
                        size = entry.stat().st_size
                    except Exception:
                        size = 0
                    items.append(
                        {
                            "type": "file",
                            "name": entry.name,
                            "path": str(entry),
                            "size": size,
                        }
                    )
        except Exception:
            pass
        return {"folder": str(root), "name": root.name or str(root), "items": items}

    def list_subfolder(self, folder: str) -> List[Dict[str, Any]]:
        return self.list_folder(folder).get("items", [])

    # ---- assets (relative images) ---------------------------------------
    def read_asset(self, base_dir: str, relative: str) -> Optional[str]:
        """Return a data: URL for an image referenced from a markdown file."""
        try:
            candidate = Path(base_dir) / urllib.parse.unquote(relative)
            candidate = candidate.resolve()
            if not candidate.exists() or not candidate.is_file():
                return None
            if candidate.suffix.lower() not in IMG_EXT:
                if candidate.suffix.lower() not in TEXT_EXT:
                    return None
            if candidate.stat().st_size > 25 * 1024 * 1024:
                return None
            mime = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
            if candidate.suffix.lower() == ".svg":
                mime = "image/svg+xml"
            data = base64.b64encode(candidate.read_bytes()).decode("ascii")
            return f"data:{mime};base64,{data}"
        except Exception:
            return None

    # ---- saving ----------------------------------------------------------
    def save_file(self, path: str, content: str) -> Dict[str, Any]:
        """原子写入 UTF-8（无 BOM）；返回刷新后的文档信息。"""
        p = Path(path)
        if not p.name:
            raise ValueError("invalid path")
        tmp = p.with_suffix(p.suffix + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8", newline="") as f:
                f.write(content)
            os.replace(tmp, p)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
        return self._load_doc(str(p))

    def save_file_as(self, content: str, suggested_name: str = "") -> Optional[Dict[str, Any]]:
        """弹出另存为对话框，写入并返回文档信息；取消返回 None。"""
        if not self._window:
            return None
        result = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=suggested_name or "未命名.md",
            file_types=FILE_DIALOG_TYPES,
        )
        if not result:
            return None
        path = result if isinstance(result, str) else result[0]
        if not path:
            return None
        if not Path(path).suffix:
            path += ".md"
        return self.save_file(path, content)

    # ---- print / export PDF ------------------------------------------------
    def print_to_pdf(self, suggested_name: str = "") -> Dict[str, Any]:
        """经 WebView2 原生打印管线导出 PDF：A4 纸张、无页眉页脚（日期/标题/
        URL/页码）、保留背景色。Edge 打印对话框（window.print()）的页眉页脚
        默认开启且无法编程关闭，故 Ctrl+P 走本方法。成功后自动打开文件。"""
        if not self._window or self._window.native is None:
            return {"ok": False, "error": "窗口未就绪"}
        # 文件名净化（Windows 非法字符）
        safe = re.sub(r'[\\/:*?"<>|]', "_", (suggested_name or "document").strip()) or "document"
        if not safe.lower().endswith(".pdf"):
            safe += ".pdf"
        box: Dict[str, Any] = {}
        step1 = threading.Event()
        from System import Action  # pywebview 已加载 pythonnet

        def gui_work() -> None:
            # CoreWebView2 必须在 GUI 线程访问；对话框也在此线程弹出
            try:
                control = self._window.native.webview  # WinForms WebView2 控件
                from System.Windows.Forms import DialogResult, SaveFileDialog

                dlg = SaveFileDialog()
                dlg.Filter = "PDF 文件 (*.pdf)|*.pdf"
                dlg.Title = "导出 PDF（A4 · 无页眉页脚）"
                dlg.FileName = safe
                if dlg.ShowDialog() != DialogResult.OK:
                    box["canceled"] = True
                    return
                cv2 = control.CoreWebView2
                ps = cv2.Environment.CreatePrintSettings()
                ps.PageWidth = 8.27  # A4：8.27 × 11.69 英寸
                ps.PageHeight = 11.69
                ps.ShouldPrintHeaderAndFooter = False
                ps.ShouldPrintBackgrounds = True
                # 页边距交给 CSS @page 控制，避免双重边距
                ps.MarginTop = 0.0
                ps.MarginBottom = 0.0
                ps.MarginLeft = 0.0
                ps.MarginRight = 0.0
                box["task"] = cv2.PrintToPdfAsync(dlg.FileName, ps)
                box["path"] = dlg.FileName
            except Exception as e:
                box["error"] = repr(e)
            finally:
                step1.set()

        control = self._window.native.webview
        control.BeginInvoke(Action(gui_work))
        if not step1.wait(300):
            return {"ok": False, "error": "对话框超时"}
        if "error" in box:
            return {"ok": False, "error": box["error"]}
        if "canceled" in box:
            return {"ok": False, "error": "canceled"}
        if "task" not in box:
            return {"ok": False, "error": "未启动打印任务"}
        # 后台线程轮询任务状态；严禁在 GUI 线程阻塞等待异步完成（会死锁）
        task = box["task"]
        deadline = time.time() + 180
        while time.time() < deadline:
            st = str(task.Status)
            if st in ("RanToCompletion", "Faulted", "Canceled"):
                break
            time.sleep(0.1)
        if str(task.Status) != "RanToCompletion":
            err = ""
            try:
                if task.Exception:
                    err = str(task.Exception.GetBaseException())
            except Exception:
                pass
            return {"ok": False, "error": err or f"打印任务未完成（{task.Status}）"}
        path = box["path"]
        try:
            os.startfile(path)  # 展示打印结果，可直接从此处打印纸质件
        except Exception:
            pass
        return {"ok": True, "path": path}

    # ---- quit -------------------------------------------------------------
    def quit_app(self) -> bool:
        """退出应用。window.close() 在 WebView2 中被脚本策略阻止，
        必须由 Python 侧销毁窗口。"""
        try:
            if self._window:
                self._window.destroy()
                return True
        except Exception:
            pass
        return False

    # ---- shell helpers ---------------------------------------------------
    def open_external(self, url: str) -> bool:
        try:
            if url.startswith(("http://", "https://", "mailto:")):
                webbrowser.open(url)
                return True
        except Exception:
            pass
        return False

    def show_in_explorer(self, path: str) -> bool:
        try:
            p = Path(path)
            if p.exists():
                if os.name == "nt":
                    os.startfile(str(p if p.is_dir() else p.parent))  # type: ignore[attr-defined]
                else:
                    webbrowser.open(p.as_uri())
                return True
        except Exception:
            pass
        return False

    # ---- drag & drop (pywebview native event) ----------------------------
    def handle_drop(self, event: Any) -> None:
        try:
            files = event.get("dataTransfer", {}).get("files", [])
            paths = []
            for f in files:
                p = self._normalize_path(f)
                if p:
                    paths.append(p)
        except Exception:
            paths = []
        if not paths:
            return
        with self._lock:
            self._open_paths = paths
        if self._window:
            try:
                self._window.evaluate_js(
                    "window.__mdr && window.__mdr.onExternalOpen(%s);" % json.dumps(paths)
                )
            except Exception:
                pass

    @staticmethod
    def _normalize_path(item: Any) -> Optional[str]:
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            # pywebview 6.x puts the real filesystem path here (extracted from
            # CoreWebView2File via the FilesDropped postMessage channel).
            if "pywebviewFullPath" in item:
                return item["pywebviewFullPath"]
            if "path" in item:
                return item["path"]
        return None

    # ---- JS polls this after a drop --------------------------------------
    def take_dropped(self) -> List[str]:
        with self._lock:
            paths = list(self._open_paths)
            self._open_paths = []
        return paths

    # ---- dev self-test ----------------------------------------------------
    def report_selftest(self, results: Dict[str, Any]) -> bool:
        out = config_dir() / "selftest-result.json"
        try:
            with out.open("w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
        except Exception:
            return False
        self._selftest = results
        # close the window shortly after reporting
        if self._window:
            def _close():
                time.sleep(0.4)
                try:
                    self._window.destroy()
                except Exception:
                    pass
            threading.Thread(target=_close, daemon=True).start()
        return True


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
def parse_startup_arg(argv: List[str]) -> Optional[str]:
    for arg in argv[1:]:
        if arg.startswith("-") or arg.startswith("--"):
            continue
        try:
            p = Path(arg.strip('"'))
            if p.exists():
                return str(p.resolve())
        except Exception:
            continue
    return None


def build_menus(holder: Dict[str, Any]) -> list:
    """原生菜单栏；动作经 evaluate_js 派发给 window.__mdr.menu(id)。"""

    def act(menu_id: str):
        def _run():
            w = holder.get("window")
            if w is None:
                return
            try:
                w.evaluate_js(f"window.__mdr && window.__mdr.menu('{menu_id}');")
            except Exception:
                pass
        return _run

    return [
        Menu("文件", [
            MenuAction("打开… (Ctrl+O)", act("file.open")),
            MenuAction("打开文件夹… (Ctrl+Shift+O)", act("file.openFolder")),
            MenuAction("新建 (Ctrl+N)", act("file.new")),
            MenuSeparator(),
            MenuAction("保存 (Ctrl+S)", act("file.save")),
            MenuAction("另存为… (Ctrl+Shift+S)", act("file.saveAs")),
            MenuSeparator(),
            MenuAction("关闭标签 (Ctrl+W)", act("file.closeTab")),
            MenuAction("退出", act("file.quit")),
        ]),
        Menu("编辑", [
            MenuAction("编辑 / 预览切换 (Ctrl+E)", act("edit.toggleEdit")),
            MenuSeparator(),
            MenuAction("查找 (Ctrl+F)", act("edit.find")),
            MenuAction("替换 (Ctrl+H)", act("edit.replace")),
        ]),
        Menu("视图", [
            MenuAction("切换侧栏 (Ctrl+B)", act("view.sidebar")),
            MenuAction("文档大纲 (Ctrl+T)", act("view.toc")),
            MenuAction("切换主题 (Ctrl+D)", act("view.theme")),
            MenuSeparator(),
            MenuAction("放大 (Ctrl+=)", act("view.zoomIn")),
            MenuAction("缩小 (Ctrl+-)", act("view.zoomOut")),
            MenuAction("重置缩放 (Ctrl+0)", act("view.zoomReset")),
            MenuSeparator(),
            MenuAction("重新加载 (F5)", act("view.reload")),
            MenuSeparator(),
            MenuAction("打印 / 导出 PDF (Ctrl+P)", act("view.print")),
        ]),
        Menu("帮助", [
            MenuAction("关于 MD Reader", act("help.about")),
        ]),
    ]


def main() -> None:
    global STARTUP_FILE
    if webview is None:
        # Fallback: explain if pywebview is missing
        try:
            import tkinter.messagebox as mb
            mb.showerror(
                APP_NAME,
                "pywebview is required to run MD Reader.\n\nInstall with:\n  pip install pywebview",
            )
        except Exception:
            print("pywebview is required.")
        return

    # Self-test mode: run renderer/DOM checks inside real WebView2 then exit.
    selftest = "--selftest" in sys.argv
    STARTUP_FILE = None if selftest else parse_startup_arg(sys.argv)
    cfg = load_config()
    # WebView2 会缓存 file:// 子资源（CSS/JS）；版本升级或自检时清空缓存，
    # 避免加载到旧资源（配置键 assetVersion 记录上次运行的版本）。
    if selftest or cfg.get("assetVersion") != APP_VERSION:
        shutil.rmtree(config_dir() / ".webview-cache", ignore_errors=True)
        cfg["assetVersion"] = APP_VERSION
        save_config(cfg)
    index = web_root() / "index.html"
    if not index.exists():
        raise SystemExit(f"UI files not found: {index}")
    # NOTE: file:// URLs cannot carry a query string (?x) 鈥?WebView2 turns them
    # into a chrome-error page. Use a #hash instead so relative assets resolve.
    if selftest:
        index_url = index.as_uri() + "#selftest=1"
    else:
        index_url = str(index)

    api = Api()
    api.cfg = cfg
    api._startup_file = STARTUP_FILE
    menu_holder: Dict[str, Any] = {}

    window = webview.create_window(
        f"{APP_NAME} {APP_VERSION}",
        url=index_url,
        js_api=api,
        menu=build_menus(menu_holder),
        width=int(cfg.get("width", 1180)),
        height=int(cfg.get("height", 820)),
        min_size=(720, 520),
        background_color="#ffffff",
        text_select=True,
    )
    menu_holder["window"] = window
    api._window = window

    # Native drag & drop for real file paths (Windows/Edge)
    try:
        window.events.loaded += lambda: _after_load(api, window, STARTUP_FILE)
    except Exception:
        pass

    def _selftest_worker() -> None:
        """Runs on the GUI thread once the window is up (webview.start(func))."""
        out = config_dir() / "selftest-result.json"
        # give the page a moment to fire pywebviewready & run boot+selftest;
        # accept only the "final" phase result (early phase has no listeners)
        for _ in range(100):
            time.sleep(0.15)
            try:
                val = window.evaluate_js(
                    "(window.__SELFTEST__ && window.__SELFTEST__.phase === 'final' "
                    "? JSON.stringify(window.__SELFTEST__) : '')"
                )
            except Exception:
                val = None
            if val:
                try:
                    data = json.loads(val)
                    with out.open("w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass
                try:
                    window.destroy()
                except Exception:
                    pass
                return
        try:
            with out.open("w", encoding="utf-8") as f:
                json.dump({"error": "selftest timeout", "total": False}, f)
        except Exception:
            pass
        try:
            window.destroy()
        except Exception:
            pass

    def _run() -> None:
        try:
            webview.start(
                debug=False,
                storage_path=str(config_dir() / ".webview-cache"),
                private_mode=False,
                func=_selftest_worker if selftest else None,
            )
        finally:
            if not selftest:
                try:
                    api.cfg["width"], api.cfg["height"] = window.width, window.height
                except Exception:
                    pass
                save_config(api.cfg)

    _run()


def _after_load(api: Api, window: "webview.Window", startup: Optional[str]) -> None:
    # REQUIRED for drag & drop: on EdgeChromium, pywebview only captures real
    # file paths when at least one Python-side drop listener exists
    # (webview.dom.element.on('drop') increments _dnd_state['num_listeners']).
    # Without this subscription the dropped paths are discarded in
    # platforms/edgechromium.py and take_dropped() always returns [].
    try:
        window.dom.document.events.drop += api.handle_drop
    except Exception:
        pass
if __name__ == "__main__":
    main()
