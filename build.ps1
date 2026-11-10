# Build MD Reader into a single portable EXE (dist\MDReader.exe)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 运行中的实例会锁住 dist\MDReader.exe，导致构建产物无法覆盖（静默变旧包）
Get-Process MDReader -ErrorAction SilentlyContinue | Stop-Process -Force
$exe = Join-Path $root "dist\MDReader.exe"
if (Test-Path $exe) { Remove-Item $exe -Force }
$before = Get-Date

Write-Host "[1/3] Checking dependencies..." -ForegroundColor Cyan
python -m pip install -r requirements.txt | Out-Null

Write-Host "[2/3] Generating icon..." -ForegroundColor Cyan
python make_icon.py

Write-Host "[3/3] Building portable EXE..." -ForegroundColor Cyan
python -m PyInstaller mdreader.spec --noconfirm --distpath "$root\dist" --workpath "$root\build"

$exe = Join-Path $root "dist\MDReader.exe"
if (Test-Path $exe) {
    $written = (Get-Item $exe).LastWriteTime
    if ($written -lt $before) { Write-Error "Build failed: EXE was not rewritten (locked or stale)." }
    $mb = [math]::Round((Get-Item $exe).Length / 1MB, 2)
    Write-Host ""
    Write-Host "Build OK -> $exe ($mb MB, $written)" -ForegroundColor Green
} else {
    Write-Error "Build failed: EXE not found."
}
