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

# Demo machine (Windows x64) — the double-clicked exe beside the workspace
# folder; the seedling icon comes from assets/icon.ico.
#
# Bun applies --windows-icon only when Bun itself runs on Windows (it edits the
# PE resource table through Win32 APIs); a cross-compile from macOS/Linux
# rejects the flag with a hard error. The demo build machine is Windows, so the
# icon is applied there; a cross build still produces a working exe, just with
# Bun's default icon — the note below says so instead of failing silently.
if [ "$("$BUN" -e 'console.log(process.platform)')" = "win32" ]; then
  "$BUN" build --compile --target=bun-windows-x64 src/proxy/index.ts \
    --windows-icon=assets/icon.ico \
    --outfile dist/grow-windows-x64.exe
else
  echo "note: --windows-icon needs a Windows build host; building the Windows exe without the custom icon" >&2
  "$BUN" build --compile --target=bun-windows-x64 src/proxy/index.ts \
    --outfile dist/grow-windows-x64.exe
fi

echo "built dist/grow-linux-x64 and dist/grow-windows-x64.exe"
