#!/usr/bin/env bash
set -euo pipefail
cd -- "$1"
mkdir -p runtime osrm
exec > >(tee -a runtime/osrm-setup.log) 2>&1
trap 'echo "OSRM setup failed at line $LINENO. Existing browser data was not changed."' ERR
echo "$(date -Is) Starting local OSRM setup"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 || ! command -v osmium >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y docker.io docker-compose-v2 osmium-tool ca-certificates curl
fi
if ! docker info >/dev/null 2>&1; then service docker start; fi
input=osrm/downloads/central-fed-district.osm.pbf
test -s "$input" || { echo "Run download-assets.py first."; exit 1; }
# About 50 km beyond the Tula bounding box; retain complete ways at the edge.
bbox='35.0,52.4,39.8,55.4'
input_stamp="$(sha256sum "$input" | cut -d ' ' -f 1):$bbox"
if [[ ! -s osrm/region.osm.pbf || ! -f osrm/region.source || "$(cat osrm/region.source)" != "$input_stamp" ]]; then
  echo "Cropping OpenStreetMap to Tula plus a buffer: $bbox"
  if [[ -s osrm/region.osm.pbf && ! -f osrm/region.source && ! -f osrm/region.before-setup.osm.pbf ]]; then
    cp -- osrm/region.osm.pbf osrm/region.before-setup.osm.pbf
  fi
  osmium extract --bbox "$bbox" --strategy complete_ways "$input" --output osrm/region.part.osm.pbf --overwrite
  osmium check-refs osrm/region.part.osm.pbf
  mv -- osrm/region.part.osm.pbf osrm/region.osm.pbf
  printf '%s\n' "$input_stamp" > osrm/region.source
fi
if [[ -s runtime/osrm-image.txt ]]; then
  OSRM_IMAGE="$(cat runtime/osrm-image.txt)"
else
  docker pull ghcr.io/project-osrm/osrm-backend:latest
  OSRM_IMAGE="$(docker image inspect ghcr.io/project-osrm/osrm-backend:latest --format '{{index .RepoDigests 0}}')"
  [[ "$OSRM_IMAGE" == ghcr.io/project-osrm/osrm-backend@sha256:* ]] || { echo 'Missing official OSRM image digest'; exit 1; }
  printf '%s\n' "$OSRM_IMAGE" > runtime/osrm-image.txt
fi
export OSRM_IMAGE
docker image inspect "$OSRM_IMAGE" >/dev/null 2>&1 || docker pull "$OSRM_IMAGE"
graph_stamp="$(sha256sum osrm/region.osm.pbf | cut -d ' ' -f 1):$OSRM_IMAGE"
rebuild=false
for mode in car foot; do
  if [[ ! -f "osrm/$mode/prepared.txt" || "$(cat "osrm/$mode/prepared.txt")" != "$graph_stamp:$mode" || ! -s "osrm/$mode/region.osrm.cell_metrics" ]]; then rebuild=true; fi
done
if $rebuild; then
  docker compose stop osrm-car osrm-foot
  for mode in car foot; do
    mkdir -p "osrm/$mode"
    if [[ -f "osrm/$mode/prepared.txt" && "$(cat "osrm/$mode/prepared.txt")" == "$graph_stamp:$mode" && -s "osrm/$mode/region.osrm.cell_metrics" ]]; then continue; fi
    if [[ -f "osrm/$mode/prepared.txt" ]]; then mv -- "osrm/$mode/prepared.txt" "osrm/$mode/previous-prepared.txt"; fi
    cp -- osrm/region.osm.pbf "osrm/$mode/region.osm.pbf"
    echo "$(date -Is) Preparing $mode graph"
    docker compose run --rm --no-deps "osrm-$mode" osrm-extract --threads 2 -p "/opt/$mode.lua" /data/region.osm.pbf
    docker compose run --rm --no-deps "osrm-$mode" osrm-partition --threads 2 /data/region.osrm
    docker compose run --rm --no-deps "osrm-$mode" osrm-customize --threads 2 /data/region.osrm
    printf '%s\n' "$graph_stamp:$mode" > "osrm/$mode/prepared.txt"
  done
fi
docker compose up -d osrm-car osrm-foot
docker compose ps
echo 'Local endpoints: http://localhost:5000/route/v1/driving and http://localhost:5001/route/v1/foot'
