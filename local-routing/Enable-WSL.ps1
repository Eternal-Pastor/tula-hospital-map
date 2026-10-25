#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$routingRuntime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Path $routingRuntime -Force | Out-Null
$routingStatus = Join-Path $routingRuntime 'windows-setup.json'
$routingLog = Join-Path $routingRuntime 'windows-setup.log'
$routingMsi = Join-Path $routingRuntime 'wsl.x64.msi'
$routingRestart = $false
function Set-RoutingSetupStatus($phase, $detail) {
    [pscustomobject]@{ phase=$phase; detail=$detail; restartRequired=$routingRestart; at=(Get-Date).ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $routingStatus -Encoding UTF8
}
Start-Transcript -LiteralPath $routingLog -Append | Out-Null
try {
    if (-not (Test-Path -LiteralPath $routingMsi)) { throw 'Download runtime/wsl.x64.msi from microsoft/WSL releases first.' }
    $routingSignature = Get-AuthenticodeSignature -LiteralPath $routingMsi
    if ($routingSignature.Status -ne 'Valid' -or $routingSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw 'The WSL installer does not have a valid Microsoft Authenticode signature.'
    }
    foreach ($routingFeature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        Set-RoutingSetupStatus 'enabling-feature' $routingFeature
        $routingState = Get-WindowsOptionalFeature -Online -FeatureName $routingFeature
        if ($routingState.State -eq 'EnablePending') { $routingRestart = $true }
        elseif ($routingState.State -ne 'Enabled') {
            $routingResult = Enable-WindowsOptionalFeature -Online -FeatureName $routingFeature -All -NoRestart
            $routingRestart = $routingRestart -or $routingResult.RestartNeeded
        }
    }
    Set-RoutingSetupStatus 'installing-wsl' 'Microsoft WSL MSI; automatic restart disabled'
    $routingInstall = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', "`"$routingMsi`"", '/qn', '/norestart', '/L*v', "`"$(Join-Path $routingRuntime 'wsl-msi.log')`"") -WindowStyle Hidden -PassThru -Wait
    if ($routingInstall.ExitCode -notin @(0,3010)) { throw "WSL installer failed: $($routingInstall.ExitCode)" }
    $routingRestart = $routingRestart -or $routingInstall.ExitCode -eq 3010
    Set-RoutingSetupStatus $(if ($routingRestart) {'restart-required'} else {'wsl-installed'}) 'No automatic reboot was performed. OSRM is not running yet.'
} catch {
    Set-RoutingSetupStatus 'error' $_.Exception.Message
    throw
} finally { Stop-Transcript | Out-Null }
