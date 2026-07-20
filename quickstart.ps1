# quickstart.ps1 — Windows launcher for quickstart.sh
# Run from PowerShell:
#   irm https://raw.githubusercontent.com/<owner>/<repo>/main/quickstart.ps1 | iex
# Or save+run:  powershell -ExecutionPolicy Bypass -File quickstart.ps1
#
# It finds a bash environment (WSL2 or Git Bash) and runs the bash quickstart
# there — that script then clones the repo, runs the wizard, and starts the app.
# Docker Desktop (with WSL2 integration enabled) is required.

$ErrorActionPreference = "Stop"

# Same raw URL as quickstart.sh expects. Override: $env:KOBOI_UC_RAW
if (-not $env:KOBOI_UC_RAW) {
    $env:KOBOI_UC_RAW = "https://raw.githubusercontent.com/hedypamungkas/koboi-projects/main/quickstart.sh"
}

function Write-Step($m) { Write-Host "=> $m" -ForegroundColor Cyan }
function Write-Err($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

Write-Host @"
============================================================
 koboi-projects quickstart (Windows launcher)
============================================================
"@ -ForegroundColor Cyan

# 1) Docker present + daemon running?
Write-Step "Checking Docker..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Err "Docker not found. Install Docker Desktop (https://docs.docker.com/desktop/install/windows-install/) with WSL2 enabled, then re-run."
}
# Native exes (docker.exe) that exit nonzero do NOT throw under $ErrorActionPreference="Stop"
# -- only PowerShell cmdlet errors do. So test $LASTEXITCODE, not try/catch (P0-2).
docker info *> $null 2>&1
if ($LASTEXITCODE -ne 0) { Write-Err "Docker daemon not running. Start Docker Desktop, then re-run." }
Write-Host "  Docker OK."

# 2) Find a bash: prefer WSL2, fall back to Git Bash.
# Pass the URL to bash via the environment ($KOBOI_UC_RAW), not string-interpolated
# into `bash -lc`, so shell metachars in the URL can't be interpreted by bash (P1-7).
$bashCmd = $null
$runner  = $null

if (Get-Command wsl -ErrorAction SilentlyContinue) {
    Write-Step "Found WSL -- running the quickstart inside WSL2..."
    Write-Host "  (Make sure Docker Desktop's WSL integration is ON for your distro.)" -ForegroundColor DarkGray
    $bashCmd = 'curl -fsSL "$KOBOI_UC_RAW" | bash'
    $runner  = "wsl"
}
else {
    $gitBash = @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($gitBash) {
        Write-Step "Found Git Bash ($gitBash) -- running the quickstart..."
        $bashCmd = 'curl -fsSL "$KOBOI_UC_RAW" | bash'
        $runner  = $gitBash
    }
}

if (-not $runner) {
    Write-Host @"
[ERROR] No bash environment found. Install ONE of:
   - WSL2            :  wsl --install   (recommended; restart, then re-run this)
   - Git for Windows :  https://git-scm.com/download/win
Then re-run:
   irm $env:KOBOI_UC_RAW.replace('/quickstart.sh','/quickstart.ps1') | iex
"@ -ForegroundColor Red
    exit 1
}

# 3) Hand off to bash (interactive -- prompts come through the same terminal).
Write-Host ""
if ($runner -eq "wsl") {
    # Bridge KOBOI_UC_RAW into the WSL env so bash sees $KOBOI_UC_RAW (P1-7).
    if (-not $env:WSLENV) { $env:WSLENV = 'KOBOI_UC_RAW' }
    else { $env:WSLENV = "KOBOI_UC_RAW;$env:WSLENV" }
    wsl bash -lc $bashCmd
} else {
    # Git Bash inherits PowerShell env vars directly on Windows.
    & $runner -lc $bashCmd
}
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Err "quickstart exited with code $code." }
Write-Host "Done." -ForegroundColor Green
