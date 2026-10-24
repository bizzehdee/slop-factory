#!/bin/sh
# Build Slop Factory installers on this machine.
#
#   scripts/build.sh                  installers for this OS (Linux: deb, rpm, AppImage; macOS: app, dmg)
#   scripts/build.sh --universal      macOS: one app for Apple silicon and Intel
#   scripts/build.sh --version 1.2.3  stamp a version first (the release workflow does this from the tag)
#
# Needs Node 24, Rust, and the Tauri prerequisites for your OS (see CONTRIBUTING.md). The installers
# carry their own Node 24, so the people who install them don't need Node.
# The installers land in src-tauri/target/<target>/release/bundle/.
set -eu

cd "$(dirname "$0")/.."

universal=0
version=""
while [ $# -gt 0 ]; do
    case "$1" in
        --universal) universal=1 ;;
        --version) shift; [ $# -gt 0 ] || { echo "--version needs X.Y.Z" >&2; exit 2; }; version="$1" ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

for tool in node npm cargo; do
    command -v "$tool" >/dev/null 2>&1 || { echo "$tool isn't installed or isn't on PATH." >&2; exit 1; }
done

[ -n "$version" ] && node scripts/set-version.mjs "$version"

npm ci
npm --prefix sidecar ci

set -- --config src-tauri/tauri.release.conf.json
case "$(uname -s)" in
    Darwin)
        if [ "$universal" = 1 ]; then
            rustup target add aarch64-apple-darwin x86_64-apple-darwin
            node scripts/fetch-sdk-binaries.mjs darwin-x64 darwin-arm64
            node scripts/fetch-node.mjs universal-apple-darwin
            set -- "$@" --target universal-apple-darwin
        else
            node scripts/fetch-node.mjs
        fi
        set -- "$@" --bundles app,dmg
        ;;
    Linux)
        [ "$universal" = 1 ] && { echo "--universal is for macOS." >&2; exit 2; }
        # deb, rpm and AppImage are for glibc systems, so the musl engine only adds size.
        if ldd --version 2>&1 | grep -qi musl; then :; else
            rm -rf sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
        fi
        node scripts/fetch-node.mjs
        set -- "$@" --bundles deb,rpm,appimage
        ;;
    *)
        echo "On Windows, use scripts/build.ps1." >&2
        exit 1
        ;;
esac

npx tauri build "$@"
echo
echo "Done. Installers are in src-tauri/target/*/release/bundle/ (or src-tauri/target/release/bundle/)."
