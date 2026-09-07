#!/usr/bin/env bash
set -euo pipefail
HOST="${CLOUD_CI_HOST:-cloud-hermes}"
ssh "$HOST" 'set -eu; CI=/home/ubuntu/ci/first-service-cockpit; test -f "$CI/latest/status.json"; cat "$CI/latest/status.json"; echo "--- log tail ---"; tail -30 "$CI/latest/build.log"'
