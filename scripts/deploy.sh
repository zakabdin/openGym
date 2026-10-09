#!/bin/sh
# Redeploy with (almost) no downtime. Run from the repo root on the server:  ./scripts/deploy.sh
#
#   1. Build the new images while the old containers keep serving.
#   2. Roll the api: start a second container, wait until it is healthy, then stop the old one.
#      web re-resolves `api` through Docker DNS every 10s, so requests keep flowing.
#   3. Recreate web (static nginx, under a second) and anything else that changed.
#
# Needs the docker-rollout plugin for step 2 (https://github.com/Wowu/docker-rollout):
#   mkdir -p ~/.docker/cli-plugins
#   curl -fsSL https://raw.githubusercontent.com/wowu/docker-rollout/main/docker-rollout \
#     -o ~/.docker/cli-plugins/docker-rollout && chmod +x ~/.docker/cli-plugins/docker-rollout
# Without it the script falls back to a plain `up -d` (a few seconds of downtime).
#
# Schema changes must be backward compatible: old and new api run against the same database
# for a few seconds.
set -eu

docker compose build

if docker compose ps --status running --services | grep -qx api && docker info --format '{{range .ClientInfo.Plugins}}{{.Name}} {{end}}' 2>/dev/null | grep -qw rollout; then
  docker rollout api
else
  echo "docker-rollout not available or api not running — falling back to up -d" >&2
fi

docker compose up -d --remove-orphans
docker compose ps
