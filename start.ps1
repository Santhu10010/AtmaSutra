Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$venvPython = Join-Path $backendDir "venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { (Get-Command python -ErrorAction Stop).Source }
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

foreach ($port in 3000, 8000) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Close the existing app or server, then run start.cmd again."
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $frontendDir "node_modules\next"))) {
    throw "Frontend packages are missing. Run 'cd frontend' and 'npm install' once, then run start.cmd again."
}

& $python -c "import uvicorn, fastapi, duckdb, pandas, scipy" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Backend packages are missing. Run 'cd backend' and 'python -m pip install -r requirements.txt' once, then run start.cmd again."
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
