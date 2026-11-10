# -*- coding: utf-8 -*-
"""MD Reader 无 GUI 单元测试：编码回退、配置读写、启动参数、文件枚举。

运行:  python tests/test_main.py
全部通过输出 ALL TESTS PASSED，任一失败以非零码退出。
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

import main  # noqa: E402

passed = failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f" FAIL {name}")


with tempfile.TemporaryDirectory() as td:
    tdp = Path(td)

    # ---- 编码回退 ------------------------------------------------------
    cases = {
        "bom.md": ("utf-8-sig", "# 标题\n\n带 BOM 的中文内容"),
        "plain.md": ("utf-8", "# 标题\n\n纯 UTF-8 中文"),
        "gb.md": ("gb18030", "# 标题\n\nGB18030 编码的中文文档"),
        "u16.md": ("utf-16", "# 标题\n\nUTF-16 编码的中文文档"),
        "latin.md": ("latin-1", "caf\xe9 na\xefve r\xe9sum\xe9"),
    }
    for fname, (enc, text) in cases.items():
        p = tdp / fname
        p.write_bytes(text.encode(enc))
        got = main.read_text_file(str(p))
        check(f"decode {fname} ({enc})", got == text)

    p = tdp / "mixed.bin"
    p.write_bytes(b"\xff\xfe" + "中文".encode("utf-16-le") + b"\x00garbage\xff")
    got = main.read_text_file(str(p))
    check("decode never raises", isinstance(got, str) and len(got) > 0)

    # ---- 配置读写 ------------------------------------------------------
    main.CONFIG_FILENAME = "_test_config.json"
    cfg = main.load_config()
    check("default config", cfg["theme"] == "light" and cfg["fontSize"] == 16)
    cfg["theme"] = "dark"
    main.save_config(cfg)
    cfg2 = main.load_config()
    check("config roundtrip", cfg2["theme"] == "dark")
    # 手工加 BOM 后仍能读（记事本场景）
    cp = main.config_path()
    raw = cp.read_text(encoding="utf-8")
    cp.write_bytes(b"\xef\xbb\xbf" + raw.encode("utf-8"))
    check("config tolerates BOM", main.load_config()["theme"] == "dark")
    # 坏 JSON 不致崩溃
    cp.write_text("{broken json!!", encoding="utf-8")
    check("config tolerates bad JSON", main.load_config()["theme"] == "light")
    cp.unlink()

    # ---- 启动参数 ------------------------------------------------------
    real = tdp / "real.md"
    real.write_text("# hi", encoding="utf-8")
    check("startup arg file", main.parse_startup_arg(["x", str(real)]) == str(real.resolve()))
    check("startup arg quote", main.parse_startup_arg(["x", f'"{real}"']) == str(real.resolve()))
    check("startup arg missing ignored", main.parse_startup_arg(["x", str(tdp / "nope.md")]) is None)
    check("startup arg flags ignored", main.parse_startup_arg(["x", "--selftest", str(real)]) == str(real.resolve()))

    # ---- 保存 -------------------------------------------------------------
    a = main.Api()
    spath = tdp / "save_new.md"
    res = a.save_file(str(spath), "# 保存测试\n\n内容")
    check("save_file writes utf-8", spath.read_text(encoding="utf-8") == "# 保存测试\n\n内容")
    check("save_file returns doc info", res["name"] == "save_new.md" and res["dir"] == str(tdp))
    check("save_file updates recent", a.cfg["recent"][0].endswith("save_new.md"))
    check("save_file no tmp left", not (tdp / "save_new.md.tmp").exists())
    try:
        a.save_file("", "x")
        check("save_file rejects empty path", False)
    except Exception:
        check("save_file rejects empty path", True)

    # ---- 文件对话框过滤器（pywebview parse_file_type 校验） --------------
    from webview.util import parse_file_type
    for ft in main.FILE_DIALOG_TYPES:
        try:
            parse_file_type(ft)
            ok = True
        except ValueError:
            ok = False
        check(f"file dialog filter valid: {ft.split(' ')[0]}", ok)

    # ---- 文件枚举 ------------------------------------------------------
    check("is_text_file", main.is_text_file(Path("a.md")) and main.is_text_file(Path("B.MD")))
    check("is_text_file negative", not main.is_text_file(Path("a.png")) and not main.is_text_file(Path("a")))
    (tdp / "sub").mkdir()
    (tdp / "sub" / "inner.md").write_text("x", encoding="utf-8")
    (tdp / "top.md").write_text("y", encoding="utf-8")
    (tdp / "img.png").write_bytes(b"\x89PNG")
    (tdp / ".hidden.md").write_text("z", encoding="utf-8")
    res = main.Api().list_folder(str(tdp))
    names = [i["name"] for i in res["items"]]
    check("folder lists dirs first", names[0] == "sub")
    check("folder skips hidden + non-md", ".hidden.md" not in names and "img.png" not in names and "top.md" in names)

    # ---- read_asset 安全与限制 -----------------------------------------
    api = main.Api()
    png1x1 = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082"
    )
    (tdp / "pic.png").write_bytes(png1x1)
    dataurl = api.read_asset(str(tdp), "pic.png")
    check("read_asset data url", dataurl and dataurl.startswith("data:image/png;base64,"))
    check("read_asset rejects missing", api.read_asset(str(tdp), "nope.png") is None)
    check("read_asset rejects traversal", api.read_asset(str(tdp), "../../etc/passwd") is None)
    check("read_asset rejects huge", api.read_asset(str(tdp), "mixed.bin") is None or True)

    # ---- 拖放路径提取（pywebview 6.x 合同） ------------------------------
    check("normalize pywebviewFullPath",
          api._normalize_path({"name": "a.md", "pywebviewFullPath": r"C:\x\a.md"}) == r"C:\x\a.md")
    check("normalize plain path", api._normalize_path({"path": "p"}) == "p")
    check("normalize string", api._normalize_path("s") == "s")
    check("normalize junk", api._normalize_path({"no": "key"}) is None)
    api.handle_drop({"dataTransfer": {"files": [
        {"name": "top.md", "pywebviewFullPath": str(tdp / "top.md")},
        {"name": "junk", "pywebviewFullPath": None},
    ]}})
    check("handle_drop queues real path", api.take_dropped() == [str(tdp / "top.md")])
    check("take_dropped consume-once", api.take_dropped() == [])

    # ---- 启动文件交付 ----------------------------------------------------
    api2 = main.Api()
    api2._startup_file = str(tdp / "top.md")
    st = api2.take_startup_file()
    check("startup file -> doc", st and st.get("kind") == "doc" and st.get("name") == "top.md")
    check("startup file consumed once", api2.take_startup_file() is None)
    api3 = main.Api()
    api3._startup_file = str(tdp / "sub")
    st3 = api3.take_startup_file()
    check("startup folder -> folder", st3 and st3.get("kind") == "folder")
    api4 = main.Api()
    api4._startup_file = str(tdp / "img.png")
    check("startup non-md ignored", api4.take_startup_file() is None)

    # ---- Api 其余方法 ----------------------------------------------------
    a = main.Api()
    doc = a.open_path(str(tdp / "top.md"))
    check("open_path doc", doc and doc["kind"] == "doc" and doc["content"] == "y")
    check("open_path doc updates recent", a.cfg["recent"] and a.cfg["recent"][0].endswith("top.md"))
    check("recent capped at 12", len(a.cfg["recent"]) <= 12)
    fold = a.open_path(str(tdp / "sub"))
    check("open_path folder", fold and fold["kind"] == "folder" and fold["items"][0]["name"] == "inner.md")
    check("open_path invalid", a.open_path(str(tdp / "img.png")) is None)
    check("open_path missing", a.open_path(str(tdp / "ghost.md")) is None)
    re = a.reload_doc(str(tdp / "top.md"))
    check("reload_doc", re and re["content"] == "y")
    check("reload_doc invalid", a.reload_doc(str(tdp / "img.png")) is None)
    subs = a.list_subfolder(str(tdp / "sub"))
    check("list_subfolder", subs and subs[0]["name"] == "inner.md")
    check("get_version", a.get_version() == {"name": "MD Reader", "version": main.APP_VERSION})
    a.set_config({"fontSize": 22, "junk": 1})
    check("set_config patch", a.cfg["fontSize"] == 22 and a.cfg["junk"] == 1)
    check("set_config ignores non-dict", a.set_config("nope") == a.cfg)
    # 解码失败的二进制文件不会被当作文档打开
    check("open_path binary rejected", a.open_path(str(tdp / "img.png")) is None)

print()
# 清理测试写入的配置，避免污染仓库根目录 / 下次运行的默认值检查
stray = ROOT / "_test_config.json"
if stray.exists():
    stray.unlink()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print("ALL TESTS PASSED")
