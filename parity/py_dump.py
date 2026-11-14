# -*- coding: utf-8 -*-
"""一致性校验基线生成器：用 Python 版 Api（无窗口模式）对 samples/edge 全样例
产出 open_path / list_folder / read_asset 结果，写入 parity/expected.json。
mtime 因运行时刻不同而排除。配置目录重定向到临时目录，避免污染原仓库配置。
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # md-reader-rs/
MD_READER = ROOT.parent / "md-reader"
sys.path.insert(0, str(MD_READER / "app"))

import main  # noqa: E402

# 配置重定向：Api.load_config/save_config 走 main.config_dir()
tmp_cfg = Path(tempfile.mkdtemp(prefix="mdreader-parity-py-"))
main.config_dir = lambda: tmp_cfg

EDGE = MD_READER / "samples" / "edge"


def strip_volatile(value):
    """剔除 mtime 等运行期易变字段，键排序保证可比。"""
    if isinstance(value, dict):
        return {k: strip_volatile(v) for k, v in sorted(value.items()) if k != "mtime"}
    if isinstance(value, list):
        return [strip_volatile(v) for v in value]
    return value


def dump():
    api = main.Api()
    out = {"open_path": {}, "list_folder": {}, "read_asset": {}}

    for p in sorted(EDGE.glob("*.md")):
        out["open_path"][p.name] = strip_volatile(api.open_path(str(p)))

    out["list_folder"]["edge"] = strip_volatile(api.list_folder(str(EDGE)))
    out["list_folder"]["imgs"] = strip_volatile(api.list_folder(str(EDGE / "imgs")))
    out["list_folder"]["missing"] = strip_volatile(api.list_folder(str(EDGE / "不存在的目录")))

    cases = [
        (str(EDGE), "imgs/ok.png"),
        (str(EDGE), "imgs/missing.png"),
        (str(EDGE), "../edge/imgs/ok.png"),
        (str(EDGE), "xss测试.md"),
        (str(EDGE), "%E5%9B%BE%E7%89%87%E6%B5%8B%E8%AF%95.md"),
        (str(EDGE), "evil.exe"),
    ]
    for i, (base, rel) in enumerate(cases):
        out["read_asset"][f"case{i}"] = {
            "base": base,
            "rel": rel,
            "result": api.read_asset(base, rel),
        }

    # take_startup_file / take_dropped 消费语义
    api._startup_file = str(EDGE / "xss测试.md")
    out["startup_first"] = strip_volatile(api.take_startup_file())
    out["startup_second"] = strip_volatile(api.take_startup_file())
    api._open_paths = ["D:\\a.md", "D:\\b.md"]
    out["dropped_first"] = strip_volatile(api.take_dropped())
    out["dropped_second"] = strip_volatile(api.take_dropped())

    # get_version（版本线不同，仅记录结构）
    out["version_shape"] = sorted(api.get_version().keys())

    dest = Path(__file__).resolve().parent / "expected.json"
    dest.write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(f"written: {dest}")


if __name__ == "__main__":
    dump()
