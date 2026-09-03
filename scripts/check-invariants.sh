#!/usr/bin/env bash
# Stealth invariants (R-02). Each one is a grep, each closes a whole family of
# extension-detection signals. See docs/research/bot-detection-research.md § Recommendation.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST=".output/chrome-mv3/manifest.json"
FAILED=0

fail() {
  echo "INVARIANT FAILED: $1"
  FAILED=1
}

pass() {
  echo "ok: $1"
}

if [ ! -f "$MANIFEST" ]; then
  echo "no build found at $MANIFEST — building..."
  pnpm exec wxt build >/dev/null || { echo "build failed"; exit 1; }
fi

# 1. No web_accessible_resources: any listed resource is fetchable by the page and
#    turns the extension into an enumerable, fingerprintable surface.
if grep -q '"web_accessible_resources"' "$MANIFEST"; then
  fail 'manifest declares web_accessible_resources'
else
  pass 'manifest has no web_accessible_resources'
fi

# 2. No externally_connectable: it advertises the extension ID to every allowed origin.
if grep -q '"externally_connectable"' "$MANIFEST"; then
  fail 'manifest declares externally_connectable'
else
  pass 'manifest has no externally_connectable'
fi

# 3. No declared content_scripts: page code is injected on demand with
#    chrome.scripting.executeScript into the ISOLATED world, never standing.
if grep -q '"content_scripts"' "$MANIFEST"; then
  fail 'manifest declares content_scripts'
else
  pass 'manifest has no content_scripts'
fi

# 4. No MAIN-world execution anywhere in source. Userscripts go through
#    chrome.userScripts, a separate API with its own isolation story.
SRC_HITS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -e 'world: *"MAIN"' -e "world: *'MAIN'" \
  entrypoints src scripts 2>/dev/null || true)"
if [ -n "$SRC_HITS" ]; then
  fail 'source uses world: "MAIN"'
  echo "$SRC_HITS"
else
  pass 'no world: "MAIN" in source'
fi

if [ "$FAILED" -ne 0 ]; then
  echo "stealth invariants: FAILED"
  exit 1
fi
echo "stealth invariants: all clear"
