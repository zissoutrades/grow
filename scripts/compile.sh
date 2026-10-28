#!/usr/bin/env bash
# Compile the Grow proxy into a single self-contained executable (PROTOCOL §1).
#
# src/ui/ is embedded into the binary through the `with { type: "file" }`
# imports in src/proxy/static.ts, so the exe serves the demo UI without any
# files beside it. No `--asset` flag is needed.
#
#   ./scripts/compile.sh
#
# The script uses `bun` from PATH, or ~/.bun/bin/bun (STATUS.md's install).

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

BUN="${BUN:-}"
if [ -z "$BUN" ]; then
  BUN="$(command -v bun || true)"
fi
if [ -z "$BUN" ]; then
  BUN="$HOME/.bun/bin/bun"
fi
if [ ! -x "$BUN" ]; then
  echo "bun not found; install it or set BUN=/path/to/bun" >&2
  exit 1
fi

# Linux x64 — the X1 smoke-test target.
"$BUN" build --compile --target=bun-linux-x64 src/proxy/index.ts \
  --outfile dist/grow-linux-x64

# Demo machine (Windows x64) — the exact command is:
# "$BUN" build --compile --target=bun-windows-x64 src/proxy/index.ts \
#   --outfile dist/grow-windows-x64.exe

echo "built dist/grow-linux-x64"
