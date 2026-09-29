#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected="$repo_root/internal/services/testdata/mispricing_active_universe.txt"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# Product policy: only xyz HIP-3 markets are loaded (no para/mkts/etc.).
curl -fsS -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' \
  -d '{"type":"metaAndAssetCtxs","dex":"xyz"}' |
  jq -r '.[0].universe[] | select(.isDelisted != true) | .name' |
  sort -u >"$scratch/live.txt"

sort -u "$expected" >"$scratch/expected.txt"
if ! diff -u "$scratch/expected.txt" "$scratch/live.txt"; then
  echo "MISPRICE universe drift detected; verify each new/removed product before updating its session." >&2
  exit 1
fi

echo "MISPRICE registry fixture matches the active xyz HIP-3 universe."
