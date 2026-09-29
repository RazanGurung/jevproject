#!/usr/bin/env bash
# Prove that the committed vendor tree is exactly what go.mod/go.sum generate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pez-vendor-verify.XXXXXX")"
STAGE="$TMP_ROOT/src"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM HUP

mkdir -p "$STAGE"

# Stage only Go source and module metadata. This avoids treating JavaScript
# dependencies under web/node_modules as Go import paths while retaining every
# package needed for an exact `go mod vendor` regeneration.
rsync -a --prune-empty-dirs \
  --include='*/' \
  --include='*.go' \
  --include='go.mod' \
  --include='go.sum' \
  --exclude='*' \
  "$ROOT/" "$STAGE/"

(
  cd "$STAGE"
  GOCACHE="$TMP_ROOT/gocache" GOWORK=off GOFLAGS=-mod=mod go mod vendor
)

if ! diff -qr "$ROOT/vendor" "$STAGE/vendor"; then
  echo "vendor/ does not match go.mod/go.sum; run 'make vendor' and review the result." >&2
  exit 1
fi

echo "vendor/ exactly matches a fresh go mod vendor regeneration."
