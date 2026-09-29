#!/usr/bin/env bash
# Periodic dependency version check.
#
# Reports pinned-vs-latest versions for Go modules and npm packages, surfacing
# the core packages (the ones tied to the exchange / signing / chart runtime)
# first so important updates are not buried. Read-only: it never bumps anything.
#
# Usage: make deps-check   (or)   ./scripts/deps-check.sh
#
# After reviewing, bump deliberately:
#   go get <module>@<version> && go mod tidy && go mod vendor && make test
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Core packages to watch closely. See docs/DEPENDENCIES.md for rationale.
CORE_GO=(
  "github.com/ethereum/go-ethereum"
  "github.com/vmihailenco/msgpack/v5"
  "golang.org/x/crypto"
)
CORE_NPM=("lightweight-charts")

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
note()  { printf '  %s\n' "$1"; }

is_core_go() {
  local mod="$1"
  for c in "${CORE_GO[@]}"; do [[ "$mod" == "$c" ]] && return 0; done
  return 1
}

bold "== Go modules with available updates =="
note "(lines below are modules where a newer version exists)"
# `go list -mod=readonly -m -u all` annotates upgradable modules as: path current [latest]
GO_UPDATES="$(go list -mod=readonly -m -u all 2>/dev/null | grep '\[' || true)"

if [[ -z "$GO_UPDATES" ]]; then
  note "All Go modules are at their latest known versions."
else
  echo
  bold "  CORE:"
  printed_core=0
  while IFS= read -r line; do
    mod="${line%% *}"
    if is_core_go "$mod"; then note "$line"; printed_core=1; fi
  done <<< "$GO_UPDATES"
  [[ "$printed_core" == 0 ]] && note "(none of the core Go packages have updates)"

  echo
  bold "  OTHER:"
  while IFS= read -r line; do
    mod="${line%% *}"
    is_core_go "$mod" || note "$line"
  done <<< "$GO_UPDATES"
fi

echo
bold "== npm packages (web/) =="
if command -v npm >/dev/null 2>&1; then
  # npm outdated exits non-zero when anything is outdated; that is expected.
  ( cd web && npm outdated ) || true
  echo
  note "Core npm packages to watch: ${CORE_NPM[*]}"
else
  note "npm not found on PATH; skipping frontend check."
fi

echo
bold "== Reminder =="
note "Exchange-side releases can introduce new actions/schemas. Review upstream docs:"
note "  https://github.com/hyperliquid-dex/hyperliquid-python-sdk"
note "  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api"
note "  https://app.hyperliquid.xyz/announcements"
note "See docs/DEPENDENCIES.md for the full watch list and update procedure."
