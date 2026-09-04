#!/usr/bin/env bash
# Unattended end-to-end run against the user's real Chrome.
#
# One human action is still required, exactly once ever: load .output/chrome-mv3 unpacked
# at chrome://extensions. After that this script closes the whole loop --
#
#   pnpm build  ->  nb-reload  ->  nb-status  ->  nb-run  ->  assert + collect errors
#
# -- with no click on chrome://extensions and no DevTools window, because nb-reload drives
# chrome.runtime.reload() through the host and every extension-side error is forwarded to
# ext.log (docs/host-protocol.md).
#
# Defaults run the read-only Hyperagent threads task. Everything is overridable by flag or
# environment; see usage() below.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEFAULT_PROMPT="Read-only task. Look at the Threads sidebar on this Hyperagent page and report the titles and statuses of the 3 most recent threads. Do not create, send, edit, or delete anything; only click to reveal the list if it is collapsed. When you have the three titles and statuses, call done with them listed."

PROMPT="${NB_E2E_PROMPT:-$DEFAULT_PROMPT}"
URL="${NB_E2E_URL:-https://hyperagent.com}"
LEADER="${NB_E2E_LEADER:-nvidia/nemotron-3-ultra-550b-a55b:free}"
FOLLOWER="${NB_E2E_FOLLOWER:-nvidia/nemotron-3.5-lightning:free}"
OBSERVE="${NB_E2E_OBSERVE:-dom}"
FIDELITY="${NB_E2E_FIDELITY:-in-page}"
RELOAD_TIMEOUT="${NB_E2E_RELOAD_TIMEOUT:-30}"
SKIP_BUILD="${NB_E2E_SKIP_BUILD:-0}"
EXPECT="${NB_E2E_EXPECT:-done}"
EXPECT_FILE="${NB_E2E_EXPECT_FILE:-}"

usage() {
  cat <<'USAGE'
usage: scripts/e2e.sh [options]

  --prompt <text>        task prompt            (env NB_E2E_PROMPT)
  --url <url>            page to start on       (env NB_E2E_URL)
  --leader <model>       leader model id        (env NB_E2E_LEADER)
  --follower <model>     follower model id      (env NB_E2E_FOLLOWER)
  --observe <dom|pixels|both>                   (env NB_E2E_OBSERVE)
  --fidelity <in-page|escalated>                (env NB_E2E_FIDELITY)
  --reload-timeout <s>   seconds to wait for the reloaded extension
  --skip-build           reuse .output/chrome-mv3 as it stands
  --expect <status>      run.ended status to require (default done; e.g. blocked)
  --expect-file <name>   require ~/.local/share/nanobrowser/artifacts/<runId>/<name> to exist
  -h, --help

Exit codes: 0 run ended with the expected status (default `done`) and no forwarded errors, 1 anything else.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prompt) PROMPT="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --leader) LEADER="$2"; shift 2 ;;
    --follower) FOLLOWER="$2"; shift 2 ;;
    --observe) OBSERVE="$2"; shift 2 ;;
    --fidelity) FIDELITY="$2"; shift 2 ;;
    --reload-timeout) RELOAD_TIMEOUT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --expect) EXPECT="$2"; shift 2 ;;
    --expect-file) EXPECT_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "e2e: jq is required" >&2; exit 2; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROOT/runs"
STREAM="$ROOT/runs/e2e-$STAMP.jsonl"
# The window ext.log errors are attributed to. Taken before the build, so an error
# thrown while the reloaded worker starts up is inside it.
SINCE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

step() { printf '\n=== %s\n' "$1"; }

# ---------------------------------------------------------------- 1. build
if [ "$SKIP_BUILD" = "1" ]; then
  step "build (skipped)"
else
  step "build"
  pnpm build >/dev/null || { echo "e2e: pnpm build failed" >&2; exit 1; }
  echo "built .output/chrome-mv3"
fi

# ---------------------------------------------------------------- 2. reload
step "reload the extension in place"
host/bin/nb-reload --timeout "$RELOAD_TIMEOUT"
case $? in
  0) ;;
  2)
    cat >&2 <<'MSG'
e2e: no extension is connected to the host.
     Load .output/chrome-mv3 unpacked once at chrome://extensions, then re-run.
MSG
    exit 1 ;;
  *) echo "e2e: nb-reload failed" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- 3. readiness
step "host status"
if ! host/bin/nb-status; then
  echo "e2e: the host is up but the OpenRouter key is not ready (R-11); see the status above" >&2
  exit 1
fi

# ---------------------------------------------------------------- 4. run
step "run"
echo "prompt:   $PROMPT"
echo "url:      $URL"
echo "models:   leader=$LEADER follower=$FOLLOWER"
echo "observe:  $OBSERVE   fidelity: $FIDELITY"
echo "stream:   $STREAM"

host/bin/nb-run "$PROMPT" \
  --url "$URL" \
  --option "leaderModel=$LEADER" \
  --option "followerModel=$FOLLOWER" \
  --option "observe=$OBSERVE" \
  --option "inputFidelity=$FIDELITY" \
  >"$STREAM"
RUN_RC=$?

# ---------------------------------------------------------------- 5. verdict
step "result"
FAILED=0

# The worker navigates the active tab before it starts. If that tab belongs to
# chrome:// the run never begins, and the reason is worth saying plainly rather than
# leaving as a generic "status: error".
REFUSAL="$(jq -rs '[.[] | select(.type == "run.end" or .kind == "run.ended") | .message // empty]
                   | map(select(test("refusing to run on|could not open"))) | last // empty' "$STREAM" 2>/dev/null)"
if [ -n "$REFUSAL" ]; then
  cat >&2 <<MSG
e2e: the run was refused before it started --
       $REFUSAL
     The active tab of the last focused normal window must be an ordinary web page,
     not chrome:// or the extensions page. Focus a normal tab and re-run.
MSG
  FAILED=1
fi

STATUS="$(jq -rs '[.[] | select(.kind == "run.ended")] | last | .status // empty' "$STREAM" 2>/dev/null)"
if [ -z "$STATUS" ]; then
  STATUS="$(jq -rs '[.[] | select(.type == "run.end")] | last | .status // empty' "$STREAM" 2>/dev/null)"
fi

if [ "$STATUS" = "$EXPECT" ]; then
  echo "run.ended.status = $STATUS (as expected)"
else
  echo "run.ended.status = ${STATUS:-<none>} (expected $EXPECT)" >&2
  [ "$RUN_RC" -ne 0 ] && echo "nb-run exited $RUN_RC" >&2
  MESSAGE="$(jq -rs '[.[] | select(.kind == "run.ended" or .type == "run.end")] | last | .message // empty' "$STREAM" 2>/dev/null)"
  [ -n "$MESSAGE" ] && echo "message: $MESSAGE" >&2
  FAILED=1
fi

step "done summary"
SUMMARY="$(jq -rs '[.[] | select(.kind == "tool.call" and (.call.name == "done" or .call.name == "blocked"))] | last | .call.args.summary // .call.args.reason // empty' "$STREAM" 2>/dev/null)"
if [ -n "$SUMMARY" ]; then
  echo "$SUMMARY"
else
  echo "(the agent never called done or blocked)"
fi

# ---------------------------------------------------------------- 5b. saved file
if [ -n "$EXPECT_FILE" ]; then
  step "saved file"
  RUN_ID="$(jq -rs '[.[] | .runId // empty] | last // empty' "$STREAM" 2>/dev/null)"
  ART="${XDG_DATA_HOME:-$HOME/.local/share}/nanobrowser/artifacts/$RUN_ID/$EXPECT_FILE"
  if [ -n "$RUN_ID" ] && [ -s "$ART" ]; then
    echo "$ART ($(wc -c <"$ART") bytes)"
    if [[ "$EXPECT_FILE" == *.json ]]; then
      jq -e 'if type == "array" then length else 1 end' "$ART" >/dev/null 2>&1 \
        && echo "valid JSON, $(jq -r 'if type == "array" then "\(length) items" else "object" end' "$ART")" \
        || { echo "e2e: $ART is not valid JSON" >&2; FAILED=1; }
    fi
  else
    echo "e2e: expected artifact missing: $ART" >&2
    FAILED=1
  fi
fi

# ---------------------------------------------------------------- 6. extension errors
step "extension errors during this run"
ERRORS="$(host/bin/nb-logs --since "$SINCE" --level error 2>/dev/null)"
if [ -n "$ERRORS" ]; then
  echo "$ERRORS"
  # A run that "succeeded" while the worker was throwing is not a pass: the whole point
  # of forwarding is that these stop being invisible.
  echo "e2e: extension errors were logged during the run" >&2
  FAILED=1
else
  echo "(none)"
fi

step "stream saved to $STREAM"
exit "$FAILED"
