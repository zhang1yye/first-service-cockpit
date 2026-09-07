#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
cd "$ROOT/server"

exec "$NODE_BIN" --import tsx --test --test-concurrency=1 \
  ../tests/r193-five-books-formal-activation.test.mjs \
  ../tests/r194-five-books-member-read.test.mjs \
  ../tests/r195-relaxed-password-creation.test.mjs \
  ../tests/r197-fsoc-brand-lockups.test.mjs \
  ../tests/r198-fsoc-cockpit-title-fix.test.mjs \
  ../tests/r200-ai-presentation.test.mjs \
  ../tests/r201-presentation-entry.test.mjs \
  ../tests/r202-presentation-hard-navigation.test.mjs \
  ../tests/r203-presentation-hd-video.test.mjs \
  ../tests/r199-five-books-live-api.test.mjs \
  ../tests/r204-five-books-live-api.test.mjs \
  ../tests/r205-five-books-compact-loading.test.mjs \
  ../tests/r207-five-books-moma-demo-snapshot.test.mjs \
  ../tests/r208-five-books-north-china-snapshot.test.mjs \
  tests/authenticated-home-parity.integration.test.ts \
  tests/five-books-formal-activation.integration.test.ts \
  tests/user-management-security.integration.test.ts \
  tests/daily-collection-trends.integration.test.ts \
  tests/data-pipeline-quality.test.ts \
  tests/projects-p46-production-contract.test.ts \
  tests/login-rate-limit.test.ts \
  tests/login-shell-performance.test.ts \
  tests/r156-known-defects.test.ts \
  tests/r157-refresh-route-preservation.test.ts \
  tests/live-collection-publication.integration.test.ts \
  tests/regional-assistant.test.ts \
  tests/regional-assistant-truth-gates.integration.test.ts \
  tests/quarantine-demo-chain.integration.test.ts \
  tests/production-operations-release.test.ts \
  tests/daily-reconciliation.integration.test.ts \
  tests/daily-reconciliation-route.integration.test.ts \
  tests/daily-reconciliation-full-entry.integration.test.ts \
  tests/daily-cross-field-gate.integration.test.ts
