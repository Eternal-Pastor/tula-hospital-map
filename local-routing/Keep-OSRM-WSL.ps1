param([string]$Distribution='Ubuntu-24.04')
$ErrorActionPreference='Stop'
if ($Distribution -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid distribution name.' }
$routingRuntime=Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Path $routingRuntime -Force | Out-Null
$routingKeepFile=Join-Path $routingRuntime "wsl-keepalive-$Distribution.json"
$routingAlive=$false
if (Test-Path -LiteralPath $routingKeepFile) {
    try {
        $routingPrevious=Get-Content -LiteralPath $routingKeepFile -Raw | ConvertFrom-Json
        $routingProcess=Get-Process -Id $routingPrevious.processId -ErrorAction Stop
        $routingAlive=$routingProcess.ProcessName -eq 'wsl' -and $routingProcess.StartTime.ToUniversalTime().Ticks -eq ([datetime]$routingPrevious.startedAt).ToUniversalTime().Ticks
    } catch { $routingAlive=$false }
}
if (-not $routingAlive) {
    # systemd services alone do not keep WSL alive. Keep one explicit client open.
    $routingProcess=Start-Process -FilePath wsl.exe -ArgumentList @('--distribution',$Distribution,'--user','root','--exec','sleep','infinity') -WindowStyle Hidden -PassThru
    [pscustomobject]@{processId=$routingProcess.Id;startedAt=$routingProcess.StartTime.ToUniversalTime().ToString('o');distribution=$Distribution} |
        ConvertTo-Json | Set-Content -LiteralPath $routingKeepFile -Encoding UTF8
}
