#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
cd "$ROOT/server"

exec "$NODE_BIN" --import tsx --test --test-concurrency=1 tests/*.test.ts
