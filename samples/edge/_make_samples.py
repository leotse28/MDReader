# -*- coding: utf-8 -*-
"""把 edge 样本转成各自声称的编码，并生成超大文件。"""
from pathlib import Path

base = Path(__file__).resolve().parent

# 1. GB18030
p = base / "gb18030编码.md"
p.write_bytes(p.read_text(encoding="utf-8").encode("gb18030"))

# 2. UTF-16
p = base / "utf16编码.md"
p.write_bytes(p.read_text(encoding="utf-8").encode("utf-16"))

# 3. UTF-8 BOM
p = base / "带BOM.md"
raw = p.read_bytes()
if not raw.startswith(b"\xef\xbb\xbf"):
    p.write_bytes(b"\xef\xbb\xbf" + raw)

# 4. 超大文件 ~5MB
big = base / "超大文件.md"
if big.stat().st_size < 1_000_000:
    big.write_text(
        "# 超大文件测试\n\n"
        + "".join(
            f"## 第{i}节\n\n这是第{i}段的**加粗**和*斜体*以及`代码`。\n\n"
            f"| A | B |\n|---|---|\n| {i}1 | {i}2 |\n\n"
            for i in range(40000)
        ),
        encoding="utf-8",
    )

print("sizes:", {f.name: f.stat().st_size for f in sorted(base.glob("*.md"))})
