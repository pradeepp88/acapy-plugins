#!/usr/bin/env bash
# One-shot setup for local kmslite ↔ BouncyHsm development on macOS.
#
# Idempotent: safe to re-run. Does three things:
#   1. Clone/refresh BouncyHsm source at the pinned version.
#   2. Build the native PKCS#11 .dylib (universal: arm64 + x86_64).
#   3. Start the BouncyHsm server container.
#
# After this runs, `poetry run python integration/verify_bouncyhsm.py`
# confirms the round-trip.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Prefer podman, then docker. Both provide compatible `compose` subcommands.
if command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE="podman"
elif command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE="docker"
else
    echo "ERROR: neither podman nor docker is on PATH" >&2
    exit 1
fi
echo "Container engine: $CONTAINER_ENGINE"

BOUNCYHSM_VERSION="v2.3.0"
SRC_DIR="bouncyhsm-src"
LIB_DIR="lib"

echo "[1/3] Fetching BouncyHsm source (${BOUNCYHSM_VERSION})..."
if [[ -d "$SRC_DIR/.git" ]]; then
    ( cd "$SRC_DIR" && git fetch --tags --depth 1 origin "$BOUNCYHSM_VERSION" \
        && git checkout -q "$BOUNCYHSM_VERSION" )
else
    rm -rf "$SRC_DIR"
    git clone --depth 1 --branch "$BOUNCYHSM_VERSION" \
        https://github.com/harrison314/BouncyHsm.git "$SRC_DIR"
fi

echo "[2/3] Building native macOS PKCS#11 client library..."

# Some SDK/toolchain combinations don't match: `xcrun` may resolve to a
# CommandLineTools SDK newer than the active linker understands, giving
# "tapi error: malformed file ... unknown architecture arm64e.x1". Pick the
# newest SDK the linker can actually parse.
if [[ -z "${SDKROOT:-}" ]]; then
    for candidate in \
        "$(xcode-select -p)/Platforms/MacOSX.platform/Developer/SDKs"/MacOSX*.sdk \
        /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk
    do
        [[ -d "$candidate" ]] || continue
        if echo 'int main(void){return 0;}' \
            | clang -isysroot "$candidate" -x c - -o /dev/null 2>/dev/null; then
            export SDKROOT="$candidate"
            break
        fi
    done
fi
if [[ -n "${SDKROOT:-}" ]]; then
    echo "    SDK: $SDKROOT"
else
    echo "    WARNING: no working SDK found; using compiler defaults" >&2
fi

# Only the host architecture is needed. Cross-building the x86_64 slice fails
# on toolchains whose SDK has dropped it, and nothing here runs under Rosetta.
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
    arm64)  LIB_SLICE="BouncyHsm.Pkcs11Lib-arm64.dylib" ;;
    x86_64) LIB_SLICE="BouncyHsm.Pkcs11Lib-x64.dylib" ;;
    *) echo "ERROR: unsupported host architecture $HOST_ARCH" >&2; exit 1 ;;
esac

( cd "$SRC_DIR/build_macos" && make -s "$LIB_SLICE" )
mkdir -p "$LIB_DIR"
cp -f "$SRC_DIR/build_macos/$LIB_SLICE" "$LIB_DIR/"
# verify_bouncyhsm.py and the arg files load the unsuffixed name.
cp -f "$SRC_DIR/build_macos/$LIB_SLICE" "$LIB_DIR/BouncyHsm.Pkcs11Lib.dylib"
echo "    -> $HERE/$LIB_DIR/BouncyHsm.Pkcs11Lib.dylib ($HOST_ARCH)"

echo "[3/3] Starting BouncyHsm server ($CONTAINER_ENGINE)..."
"$CONTAINER_ENGINE" compose -f docker-compose.bouncyhsm.yml up -d --build

echo
echo "Done. Verify with:"
echo "    poetry run python integration/verify_bouncyhsm.py"
echo
echo "Web UI:  http://localhost:8080"
echo "PKCS#11: TCP 127.0.0.1:8765"
