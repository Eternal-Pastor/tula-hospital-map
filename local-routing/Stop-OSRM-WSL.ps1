param([string]$Distribution='Ubuntu-24.04')
$ErrorActionPreference='Stop'
if ($Distribution -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid distribution name.' }
$routingLinuxRoot=(& wsl.exe --distribution $Distribution --user root -- wslpath -a $PSScriptRoot).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate OSRM project inside WSL.' }
& wsl.exe --distribution $Distribution --user root -- docker compose --project-directory $routingLinuxRoot -f "$routingLinuxRoot/compose.yaml" stop osrm-car osrm-foot
if ($LASTEXITCODE -ne 0) { throw 'Cannot stop OSRM containers.' }
$routingKeepFile=Join-Path $PSScriptRoot "runtime/wsl-keepalive-$Distribution.json"
if (Test-Path -LiteralPath $routingKeepFile) {
    $routingPrevious=Get-Content -LiteralPath $routingKeepFile -Raw | ConvertFrom-Json
    $routingProcess=Get-Process -Id $routingPrevious.processId -ErrorAction SilentlyContinue
    if ($routingProcess -and $routingProcess.ProcessName -eq 'wsl' -and $routingProcess.StartTime.ToUniversalTime().Ticks -eq ([datetime]$routingPrevious.startedAt).ToUniversalTime().Ticks) {
        Stop-Process -Id $routingProcess.Id
    }
}
