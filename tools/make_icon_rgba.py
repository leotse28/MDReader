# -*- coding: utf-8 -*-
"""从 assets/icon.ico 生成窗口图标原始 RGBA（assets/icon32.rgba）。

tao 的窗口图标需要原始 RGBA 字节（Icon::from_rgba），而 icon.ico 内部是
PNG 压缩条目——运行时解码需引入 PNG 解码器，故用 Pillow 预转一次提交入库。
重新生成：python tools/make_icon_rgba.py（需要 Pillow）
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICO = ROOT / "assets" / "icon.ico"
OUT = ROOT / "assets" / "icon32.rgba"
SIZE = 32  # 标题栏/任务栏标准尺寸；Windows 自动缩放其他尺寸


def main():
    ico = Image.open(ICO)
    ico.size = (SIZE, SIZE)
    img = ico.convert("RGBA")
    assert img.size == (SIZE, SIZE), img.size
    OUT.write_bytes(img.tobytes())
    print(f"written: {OUT} ({SIZE * SIZE * 4} bytes)")


if __name__ == "__main__":
    main()
