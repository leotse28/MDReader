# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for MD Reader — portable single-file EXE.

Build:
    pyinstaller mdreader.spec --noconfirm

Output: dist/MDReader.exe  (a self-contained portable executable)
"""
from pathlib import Path

ROOT = Path(SPECPATH)
APP = ROOT / "app"

block_cipher = None

# Bundle the entire front-end (html/css/js) into the executable.
datas = [
    (str(APP / "web"), "web"),
    (str(ROOT / "assets" / "icon.png"), "assets"),
    (str(ROOT / "samples" / "welcome.md"), "samples"),
]

a = Analysis(
    [str(APP / "main.py")],
    pathex=[str(APP)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "clr_loader",
        "pythonnet",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "unittest", "test", "pydoc_data",
        "numpy", "PIL", "matplotlib", "pandas",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="MDReader",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,            # windowed app: no console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "assets" / "icon.ico"),
    version=None,
)
