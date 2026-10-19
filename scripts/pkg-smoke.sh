#!/bin/sh
# Bundles test/package/cjs-smoke.cjs into a @yao-pkg/pkg binary the way EmailEngine bundles
# ioredfour, from the packed tarball installed into a scratch project, then runs the binary
# against Redis. pkg snapshots a CommonJS module graph, so an ES module anywhere in the graph or a
# file missing from the tarball fails here.
#
# pkg follows the exports map only for ES modules, so it warns that it cannot find the
# ioredfour/lib/* deep requires of the smoke test. They still load in the binary: Node resolves
# them through the exports map at runtime, to files the entry point already pulled in (checked by
# test/package/package-test.ts).
#
#   npm run test:pkg
#
# PKG_VERSION (default: the version EmailEngine's CI uses) and PKG_TARGET (default node24, the
# Node.js line of the EmailEngine binaries, for the host platform) select the build.
# REDIS_STANDALONE_URL is passed on to the binary.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG_VERSION="${PKG_VERSION:-6.23.0}"
PKG_TARGET="${PKG_TARGET:-node24}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ioredfour-pkg.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

TARBALL=$(cd "$ROOT" && npm pack --silent --ignore-scripts --pack-destination "$WORK")

cd "$WORK"
echo '{ "name": "ioredfour-pkg-smoke", "version": "1.0.0", "private": true }' > package.json
npm install --silent --no-audit --no-fund --omit=dev "./$TARBALL"
cp "$ROOT/test/package/cjs-smoke.cjs" smoke.cjs

npx --yes "@yao-pkg/pkg@$PKG_VERSION" --targets "$PKG_TARGET" --output smoke-bin smoke.cjs

OUTPUT=$(./smoke-bin)
echo "$OUTPUT"
echo "$OUTPUT" | grep -q 'CommonJS smoke test passed'
