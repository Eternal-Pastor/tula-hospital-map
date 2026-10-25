param([string]$Distribution='Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
if ($Distribution -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid WSL distribution name.' }
$routingDistributions = @((& wsl.exe --list --quiet) | ForEach-Object { ($_ -replace "`0", '').Trim() })
if ($LASTEXITCODE -ne 0) { throw 'WSL is not ready. Complete Enable-WSL.ps1 and restart Windows first.' }
if ($routingDistributions -notcontains $Distribution) {
    & wsl.exe --install --distribution $Distribution --web-download --no-launch
    if ($LASTEXITCODE -ne 0) { throw 'Ubuntu installation failed. Complete Windows setup/restart before retrying.' }
}
$routingLinuxRoot = (& wsl.exe --distribution $Distribution --user root -- wslpath -a $PSScriptRoot).Trim()
if ($LASTEXITCODE -ne 0 -or -not $routingLinuxRoot.StartsWith('/')) { throw 'Cannot access project directory from WSL.' }
& wsl.exe --distribution $Distribution --user root -- bash "$routingLinuxRoot/prepare-osrm-wsl.sh" $routingLinuxRoot
if ($LASTEXITCODE -ne 0) { throw 'OSRM setup failed. See runtime/osrm-setup.log.' }
& (Join-Path $PSScriptRoot 'Keep-OSRM-WSL.ps1') -Distribution $Distribution
foreach ($routingPort in @(5000,5001)) {
    $routingProfile = if ($routingPort -eq 5000) {'driving'} else {'foot'}
    $routingProbe = "http://localhost:$routingPort/route/v1/$routingProfile/37.599689,54.182592;37.615541,54.1937?overview=false"
    $routingResponse = $null
    foreach ($routingAttempt in 1..15) {
        try { $routingResponse = Invoke-WebRequest -Uri $routingProbe -Headers @{Origin='http://localhost:8765'} -UseBasicParsing -TimeoutSec 5; break }
        catch { if ($routingAttempt -eq 15) { throw }; Start-Sleep -Seconds 2 }
    }
    $routingBody = $routingResponse.Content | ConvertFrom-Json
    if ($routingBody.code -ne 'Ok') { throw "OSRM port $routingPort did not return a route." }
    if (($routingResponse.Headers['Access-Control-Allow-Origin'] -join ',') -notin @('*','http://localhost:8765')) { throw "OSRM port $routingPort does not permit browser CORS." }
    [pscustomobject]@{port=$routingPort;status='OK';seconds=$routingBody.routes[0].duration}
}
