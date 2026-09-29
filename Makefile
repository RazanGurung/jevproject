.PHONY: all test vet build run clean clean-caches fmt tidy lint vendor deps-check deps-verify web-build web-perf web-perf-soak release mispricing-audit

all: vet test build

test:
	@cache=$$(mktemp -d); \
	trap 'rm -rf "$$cache"' EXIT; \
	GOCACHE="$$cache" go test ./... -count=1

vet:
	go vet ./...

build:
	@cache=$$(mktemp -d); root=$$(pwd); \
	trap 'rm -rf "$$cache"' EXIT; \
	GOCACHE="$$cache" GOFLAGS=-mod=vendor GOPROXY=off GOSUMDB=off \
		go build -trimpath -asmflags=all=-trimpath="$$root" \
		-o hyperliquid-server ./cmd/server; \
	BUILD_ROOT="$$root" perl -0pi -e \
		'$$root = $$ENV{"BUILD_ROOT"}; $$replacement = "." x length($$root); s/\Q$$root\E/$$replacement/g' \
		hyperliquid-server; \
	if command -v codesign >/dev/null 2>&1; then \
		codesign --force --sign - hyperliquid-server; \
	fi

# Bundle the frontend into web/dist via the vendored esbuild (offline, no network).
# The server prefers web/dist/index.html + the hashed /dist bundle when present.
web-build:
	cd web && npm run build

# Requires a running app. Opera/Chromium CDP auto-launches if :9222 is down.
# Every exchange-mutating request is intercepted and fulfilled by a local fixture.
web-perf:
	cd web && npm run perf:ui

# Twenty-minute navigation soak. Fails if DOM nodes, event listeners, heap, or
# documents grow by more than 10% after forced garbage collection.
web-perf-soak:
	cd web && PEZ_PERF_SOAK_MS=1200000 PEZ_PERF_REPORT_DIR=../performance-results/soak npm run perf:ui

# Production build: bundled frontend + server binary. Use this for deploys so a
# cold reload fetches one cached bundle instead of ~150 raw modules.
release: web-build build

run: build
	PORT=5001 ./hyperliquid-server

clean:
	rm -f hyperliquid-server
	rm -rf web/dist
	rm -rf .cache/gocache
	@rmdir .cache 2>/dev/null || true

# Post-edit disposable leftovers. Does not touch the live snapshot, web/dist,
# node_modules, vendor, or the running server binary.
clean-caches:
	rm -rf web/node_modules/.vite
	rm -f data/candle-snapshot.json.gz.tmp-*
	rm -f .DS_Store
	rm -rf .cache
	rm -rf /tmp/pez-opera-smoke

fmt:
	go fmt ./...

tidy:
	go mod tidy
	go mod vendor

# Refresh the committed vendor/ tree from go.mod (run after any dependency bump).
vendor:
	go mod vendor

# Verify downloaded module archives, then independently regenerate and compare
# the committed vendor tree. go mod verify alone does not inspect vendor/.
deps-verify:
	go mod verify
	./scripts/verify-vendor.sh

# Report pinned-vs-latest versions for Go + npm, core packages first. Read-only.
deps-check:
	./scripts/deps-check.sh

# Read-only drift check against the active xyz HIP-3 universe (only xyz is
# loaded as markets). The Go registry completeness test binds this fixture to
# the exact runtime session registry.
mispricing-audit:
	./scripts/audit-mispricing-universe.sh

lint:
	golangci-lint run ./...
