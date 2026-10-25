param(
    [ValidateRange(1024,65504)][int]$Port = 8765,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mapRoot = Join-Path $packageRoot 'hospital-map'
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (!(Test-Path -LiteralPath (Join-Path $mapRoot 'index.html')) -or !(Test-Path -LiteralPath (Join-Path $mapRoot 'viewer-data.js'))) {
    throw 'Extract the complete ZIP archive before running START.cmd.'
}
$sha = [Security.Cryptography.SHA256]::Create()
try { $rootIdentity = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($packageRoot.ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
finally { $sha.Dispose() }
$identity = 'tula-hospital-map:' + $manifest.build + ':' + $rootIdentity
Add-Type -Path (Join-Path $PSScriptRoot 'LocalMapServer.cs')
$server = $null
$mapUrl = $null
foreach ($candidatePort in $Port..($Port + 31)) {
    $candidate = New-Object HospitalMap.LocalMapServer($mapRoot, $candidatePort, $identity)
    try {
        $candidate.Start()
        $server = $candidate
        $mapUrl = "http://localhost:$candidatePort/"
        break
    }
    catch {
        $candidate.Stop()
        # Reuse only the exact package/folder already running, not another site.
        try {
            $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$candidatePort/.well-known/hospital-map")
            $request.Proxy = $null
            $request.Timeout = 500
            $response = $request.GetResponse()
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            try { $existing = $reader.ReadToEnd() | ConvertFrom-Json }
            finally { $reader.Dispose(); $response.Dispose() }
            if ($existing.identity -eq $identity) {
                $mapUrl = "http://localhost:$candidatePort/"
                break
            }
        }
        catch { }
    }
}
if (!$mapUrl) { throw 'Cannot start the local map server: no free local port was found.' }
Write-Host "Map: $mapUrl"
if (!$NoBrowser) { Start-Process $mapUrl }
if (!$server) {
    Write-Host 'The same map is already running. Reusing the existing server.'
    exit 0
}
Write-Host 'Keep this window open. Press Ctrl+C to stop the map server.'
try { while ($server.IsRunning) { Start-Sleep -Milliseconds 250 } }
finally { $server.Stop() }
