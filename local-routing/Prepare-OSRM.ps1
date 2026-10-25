$ErrorActionPreference = 'Stop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with Linux containers first.' }
$routingRoot = $PSScriptRoot
$routingInput = Join-Path $routingRoot 'osrm/region.osm.pbf'
if (-not (Test-Path -LiteralPath $routingInput)) { throw "Missing OSM PBF: $routingInput" }
Push-Location -LiteralPath $routingRoot
try {
    foreach ($routingMode in @('car', 'foot')) {
        $routingData = Join-Path $routingRoot "osrm/$routingMode"
        New-Item -ItemType Directory -Path $routingData -Force | Out-Null
        Copy-Item -LiteralPath $routingInput -Destination (Join-Path $routingData 'region.osm.pbf')
        foreach ($routingArgs in @(
            @('osrm-extract', '-p', "/opt/$routingMode.lua", '/data/region.osm.pbf'),
            @('osrm-partition', '/data/region.osrm'),
            @('osrm-customize', '/data/region.osrm')
        )) {
            & docker compose run --rm --no-deps "osrm-$routingMode" @routingArgs
            if ($LASTEXITCODE -ne 0) { throw "OSRM preprocessing failed: $routingMode" }
        }
    }
    & docker compose up -d osrm-car osrm-foot
    if ($LASTEXITCODE -ne 0) { throw 'Cannot start local OSRM.' }
} finally { Pop-Location }
