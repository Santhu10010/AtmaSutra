Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$venvDir = Join-Path $backendDir "venv"
$venvPython = Join-Path $backendDir "venv\Scripts\python.exe"

function Test-Python([string]$Path) {
    & $Path -c "import sys" 2>$null
    return $LASTEXITCODE -eq 0
}

function Find-SystemPython {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) { return [pscustomobject]@{ File = $launcher.Source; Arguments = @("-3") } }
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command) { return [pscustomobject]@{ File = $command.Source; Arguments = @() } }
    return $null
}

$python = if ((Test-Path -LiteralPath $venvPython) -and (Test-Python $venvPython)) { $venvPython } else { $null }
if (-not $python) {
    $systemPython = Find-SystemPython
    if (-not $systemPython) {
        throw "Python 3 is required. Install it from python.org, then run start.cmd again."
    }
    Write-Host "Preparing the local Python environment..." -ForegroundColor Cyan
    $systemArguments = @($systemPython.Arguments)
    & $systemPython.File @systemArguments -m venv --clear $venvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Python $venvPython)) {
        throw "AtmaSutra could not create its Python environment. Repair Python 3, then run start.cmd again."
    }
    $python = $venvPython
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { throw "Node.js is required. Install it from nodejs.org, then run start.cmd again." }
$npm = $npmCommand.Source

foreach ($port in 3000, 8000) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Close the existing app or server, then run start.cmd again."
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $frontendDir "node_modules\next"))) {
    Write-Host "Installing the page packages..." -ForegroundColor Cyan
    Push-Location $frontendDir
    try {
        & $npm ci
        if ($LASTEXITCODE -ne 0) { throw "The page packages could not be installed." }
    } finally {
        Pop-Location
    }
}

& $python -c "import uvicorn, fastapi, duckdb, pandas, scipy" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing the local data packages..." -ForegroundColor Cyan
    & $python -m pip install -r (Join-Path $backendDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "The local data packages could not be installed." }
}

$backend = Start-Process -FilePath $python -ArgumentList @("-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000") -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru

try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($backend.HasExited) { break }
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 1 | Out-Null
            $ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $ready) {
        throw "The local data service did not start. Run the backend manually to see its error details."
    }

    if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) {
        throw "Port 3000 became busy while AtmaSutra was starting. Close the existing app, then run start.cmd again."
    }

    Write-Host "AtmaSutra is starting at http://localhost:3000" -ForegroundColor Green
    Write-Host "Keep this window open. Press Ctrl+C to stop the app."
    Push-Location $frontendDir
    try {
        & $npm run dev
        if ($LASTEXITCODE -ne 0) { throw "The AtmaSutra page stopped unexpectedly." }
    } finally {
        Pop-Location
    }
} finally {
    if (-not $backend.HasExited) {
        Stop-Process -Id $backend.Id -Force
        $backend.WaitForExit()
    }
}
