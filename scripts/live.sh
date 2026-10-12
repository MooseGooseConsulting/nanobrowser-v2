#!/usr/bin/env bash
# Live testing in the user's real Chrome, in one command.
#
#   scripts/live.sh setup              build, register the host, get the extension connected
#   scripts/live.sh test [task,...]    run fixture tasks in real Chrome and score each one
#   scripts/live.sh activities [id,...] [--repeat N]   the agent performs real activities: by default
#                                      browse; deep jobs (filter_sort, site_median, compare_sites)
#                                      rotate across shop sites the same way; live telemetry, verdict, waste.
#                                      Positional ids accumulate across arguments (commas work too)
#   scripts/live.sh run "<prompt>" [--url <url>]   one ad-hoc run with the free pair
#   scripts/live.sh status | logs
#
# `setup` is safe to re-run at any time and needs no click once the extension has been
# loaded unpacked one time ever. It wakes the extension by opening one of its own pages,
# which starts the service worker, which spawns the host. Only a profile that has never
# loaded the extension falls back to chrome://extensions, which Chrome reserves for a human.
#
# `test` reuses the harness's fixture server, prompts and scorers (scripts/harness/), but
# against this Chrome instead of a harness-owned one. Fixture pages are served on
# 127.0.0.1. The eBay task runs from the harness tier (see below).
#
# Environment: NB_LIVE_CHROME, NB_LIVE_CHROME_DIR (browser and its config dir),
# NB_LIVE_LEADER, NB_LIVE_FOLLOWER (model ids; setting either pins the pair — unset, the
# pair rotates across the ones runs/history.jsonl has seen, least recently used first),
# NB_LIVE_TIMEOUT (seconds per run), NB_LIVE_CONNECT_WAIT, and NB_LIVE_REINSTALL_HOST=1 to
# point the registered dev host at this checkout when setup reports it runs from another one.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
HARNESS="$ROOT/scripts/harness"
# Same rule as host/src/paths.ts dataDir(), so the verdict reads the logs the host wrote.
if [ -n "${NB_HOME:-}" ]; then DATA="$NB_HOME/.local/share/nanobrowser"
else DATA="${XDG_DATA_HOME:-$HOME/.local/share}/nanobrowser"; fi
EXT_DIR="$ROOT/.output/chrome-mv3"
CHROME="${NB_LIVE_CHROME:-$(command -v google-chrome-stable || command -v google-chrome || true)}"
CHROME_DIR="${NB_LIVE_CHROME_DIR:-$HOME/.config/google-chrome}"
LEADER="${NB_LIVE_LEADER:-nvidia/nemotron-3-ultra-550b-a55b:free}"
FOLLOWER="${NB_LIVE_FOLLOWER:-nvidia/nemotron-3.5-lightning:free}"
# Without a pinned pair, rotate across the pairs runs/history.jsonl has already seen,
# least recently used first: the everyday runs spread over models the way the site
# rotation spreads them over sites, and no pair owns the default by inertia. Setting
# either environment variable above pins the pair instead.
rotate_pair() {
  local file="$ROOT/runs/history.jsonl" pair
  [ -f "$file" ] || return 1
  pair="$(jq -rs '
    [to_entries[]
     | .value.telemetry.byRole as $r
     | select($r.leader.models[0] != null and $r.follower.models[0] != null)
     | {l: $r.leader.models[0], f: $r.follower.models[0], i: .key}]
    | select(length > 0)
    | group_by(.l + "|" + .f)
    | map({l: .[0].l, f: .[0].f, last: (map(.i) | max)})
    | sort_by(.last)
    | .[0] | (.l, .f)
  ' "$file" 2>/dev/null)" || return 1
  [ -n "$pair" ] || return 1
  LEADER="$(sed -n 1p <<<"$pair")"
  FOLLOWER="$(sed -n 2p <<<"$pair")"
}
if [ -z "${NB_LIVE_LEADER:-}" ] && [ -z "${NB_LIVE_FOLLOWER:-}" ]; then rotate_pair; fi
RUN_TIMEOUT="${NB_LIVE_TIMEOUT:-600}"
CONNECT_WAIT="${NB_LIVE_CONNECT_WAIT:-300}"
# The local fixture tasks. ebay runs from `just harness`, which can read the page itself.
DEFAULT_TASKS="inventory,userscript_debug,escalation,readonly,login,redaction,stall,download"

step() { printf '\n== %s\n' "$*"; }
die() { echo "live: $*" >&2; exit 1; }

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

# Same derivation as host/install.sh: the manifest key pins the id across rebuilds.
ext_id() {
  grep -oE "'MII[A-Za-z0-9+/=]+'" wxt.config.ts | head -n1 | tr -d "'" \
    | base64 -d | sha256sum | head -c 32 | tr '0-9a-f' 'a-p'
}

# "<profile>\t<path>\t<user_scripts_enabled>" for every profile that has the extension.
# Chrome rewrites Preferences lazily, so this can lag a click in chrome://extensions.
registrations() {
  python3 -I - "$CHROME_DIR" "$(ext_id)" <<'PY'
import glob, json, os, sys
root, ext = sys.argv[1], sys.argv[2]
for prefs in sorted(glob.glob(os.path.join(root, '*', 'Preferences'))):
    try:
        s = json.load(open(prefs))['extensions']['settings'][ext]
    except Exception:
        continue
    print(f"{os.path.basename(os.path.dirname(prefs))}\t{s.get('path', '')}\t{s.get('user_scripts_enabled', False)}")
PY
}

# True once the extension's service worker has spawned the dev host and it answers.
# nb-status exits 1 both for "key not ready" and "no host", so read what it printed instead.
# Captured rather than piped: `grep -q` exits early, and under pipefail the SIGPIPE it
# leaves on nb-status would read as "no host".
host_up() { local out; out="$(timeout 30 host/bin/nb-status 2>/dev/null)"; [[ "$out" == *'"op"'* ]]; }

wait_for_extension() {
  local limit="$1" waited=0
  while ! host_up; do
    [ "$waited" -ge "$limit" ] && return 1
    [ "$waited" -gt 0 ] && [ $((waited % 30)) -eq 0 ] && echo "   waiting for the extension to connect... (${waited}s)"
    sleep 2; waited=$((waited + 2))
  done
}

cmd_setup() {
  step "prerequisites"
  for bin in node jq doppler python3 rsync; do
    command -v "$bin" >/dev/null || die "$bin is not on PATH"
  done
  [ -n "$CHROME" ] || die "no google-chrome-stable on PATH (set NB_LIVE_CHROME)"
  pgrep -x 'chrome|chromium|chromium-browser' >/dev/null || die "Chrome is not running; start it normally, then re-run"
  echo "node $(node --version), chrome $("$CHROME" --version | awk '{print $NF}')"

  step "dependencies"
  # pnpm 10, as CI uses: pnpm 11+ ignores package.json's "pnpm.overrides" and would
  # rewrite the lockfile without the security overrides.
  [ -d node_modules ] || npx -y pnpm@10 install --frozen-lockfile || die "pnpm install failed"
  [ -d host/node_modules ] || (cd host && npx -y pnpm@10 install --frozen-lockfile) || die "host pnpm install failed"
  echo "ok"

  step "build"
  node_modules/.bin/wxt build >/dev/null || die "wxt build failed"
  echo "built $EXT_DIR"

  # Chrome loads from wherever "Load unpacked" pointed, which may be another checkout
  # (a worktree builds into its own .output). Copy this build there so a reload sees it.
  # Every profile that has it gets the build: the CLI cannot tell which profile's worker
  # answers the socket, and a reload of an unsynced profile would test stale code.
  local reg profile path us
  reg="$(registrations)"
  while IFS=$'\t' read -r profile path us; do
    [ -n "$profile" ] || continue
    echo "registered in Chrome profile \"$profile\" from $path"
    if [ "$path" != "$EXT_DIR" ]; then
      # rsync --delete empties whatever is there, so only overwrite a directory that still
      # holds a nanobrowser build. A stale registration may now point at something else.
      if [ "$(jq -r .key "$path/manifest.json" 2>/dev/null)" != "$(jq -r .key "$EXT_DIR/manifest.json")" ]; then
        echo "   NOTE: $path no longer holds a nanobrowser build; not touching it. Load unpacked again from $EXT_DIR"
        continue
      fi
      rsync -a --delete "$EXT_DIR/" "$path/" || die "could not copy the build to $path"
      echo "copied this build there"
    fi
    [ "$us" = "True" ] || echo "   NOTE: \"Allow User Scripts\" is off in \"$profile\"; userscript tasks fail until you turn it on in the extension's Details"
  done <<<"$reg"

  step "native host"
  # The wrapper bakes in an absolute path, so only install when it is missing or is not the
  # dev build: reinstalling from a worktree would point Chrome at a tree that may vanish.
  local manifest="$CHROME_DIR/NativeMessagingHosts/com.nanobrowser.host.json" wrapper
  wrapper="$(jq -r .path "$manifest" 2>/dev/null || true)"
  if [ -z "${NB_LIVE_REINSTALL_HOST:-}" ] && [ -x "$wrapper" ] && grep -q NANOBROWSER_DEV=1 "$wrapper"; then
    echo "already registered: $wrapper"
    # Host changes in this tree are not live until the wrapper points here; say so rather
    # than let a run silently exercise another checkout's host.
    grep -qF "\"$ROOT/host/src/main.ts\"" "$wrapper" \
      || echo "   NOTE: the host runs from another checkout ($(grep -o '"[^"]*main.ts"' "$wrapper")). NB_LIVE_REINSTALL_HOST=1 points it at this one."
  else
    bash host/install.sh --dev | sed 's/^/   /' || die "host/install.sh failed"
    # install.sh writes only under ${NB_HOME:-$HOME}'s default Chrome and Chromium config
    # dirs; a Chrome with another config dir would otherwise keep a stale registration.
    local installed="${NB_HOME:-$HOME}/.config/google-chrome/NativeMessagingHosts/com.nanobrowser.host.json"
    if [ "$installed" != "$manifest" ]; then
      mkdir -p "$(dirname "$manifest")" && cp "$installed" "$manifest" \
        || die "could not register the host under $CHROME_DIR"
      echo "   installed: $manifest"
    fi
  fi

  step "extension"
  if host_up; then
    host/bin/nb-reload --timeout 30 >/dev/null 2>&1 || die "nb-reload failed (host/bin/nb-logs)"
    echo "reloaded in place"
  elif [ -n "$reg" ]; then
    # An idle MV3 worker does not run until something wakes it; one of its own pages does.
    "$CHROME" "chrome-extension://$(ext_id)/sidepanel.html" >/dev/null 2>&1 &
    # The host binds the socket only after its Doppler lookups, which may take their full
    # 20 s timeout, so wait past that before calling the extension broken.
    if wait_for_extension 45; then
      host/bin/nb-reload --timeout 30 >/dev/null 2>&1 || die "woke the extension but nb-reload failed, so it may still run the old build (host/bin/nb-logs)"
      echo "woke the extension through its own page and reloaded it"
    else
      die "the extension is registered but did not start; it may be disabled or in an error state at chrome://extensions"
    fi
  else
    local copied=""
    printf '%s' "$EXT_DIR" | wl-copy 2>/dev/null && copied=" (also on your clipboard)"
    "$CHROME" chrome://extensions >/dev/null 2>&1 &
    cat <<MSG
   This Chrome profile has never loaded nanobrowser, and Chrome only allows that by hand:
     1. In the chrome://extensions tab that just opened, turn Developer mode ON.
     2. Click "Load unpacked" and choose this folder${copied}:
          $EXT_DIR
     3. Open nanobrowser's Details and turn on "Allow User Scripts".
   This is needed once per profile, ever.
MSG
    wait_for_extension "$CONNECT_WAIT" || die "the extension never connected after ${CONNECT_WAIT}s"
    echo "extension connected"
  fi

  step "readiness"
  local status reason
  status="$(host/bin/nb-status 2>&1)"; echo "$status"
  if jq -e '.key.ready' <<<"$status" >/dev/null 2>&1; then
    echo; echo "ready. Next: scripts/live.sh test"
  else
    reason="$(jq -r '.key.reason // empty' <<<"$status" 2>/dev/null)"
    case "$reason" in
      *401*) die "OpenRouter rejected the key (401). Rotate OPENROUTER_API_KEY in Doppler ai-automation/dev, then re-run setup" ;;
      *) die "the extension is connected but the key is not ready: ${reason:-see the status above}" ;;
    esac
  fi
}

FIXTURE_PID=""
ACTIVE_RUN=""
RUN_PID=""

cleanup_test() {
  if [ -n "$ACTIVE_RUN" ]; then
    echo "cancelling in-flight run $ACTIVE_RUN"
    host/bin/nb-cancel "$ACTIVE_RUN" >/dev/null 2>&1 || true
  fi
  [ -n "$RUN_PID" ] && kill "$RUN_PID" 2>/dev/null
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
  return 0
}

cmd_test() {
  local list=() task
  # Deduplicated: per-task evidence files are named by task, so a repeat would score the
  # first invocation's download. Repeated trials belong to #40.
  read -ra list <<<"$(tr ',' '\n' <<<"${1:-$DEFAULT_TASKS}" | awk 'NF && !seen[$0]++' | tr '\n' ' ')"
  [ "${#list[@]}" -gt 0 ] || die "no tasks given (default: $DEFAULT_TASKS)"
  # The eBay verdict compares against listings scraped independently of the agent, which
  # needs a second reader of the page. The harness-owned Chrome has one (CDP); this one
  # deliberately does not, so the task could only ever fail here.
  for task in "${list[@]}"; do
    [ "$task" = ebay ] && die "ebay needs independent page ground truth; run it with: just harness --live-only --live-tasks ebay"
  done
  host_up || die "the extension is not connected; run scripts/live.sh setup first"
  host/bin/nb-status >/dev/null || die "the OpenRouter key is not ready (host/bin/nb-status)"

  # Chrome opens a command-line URL in its last-used profile. With one registration that
  # is pinned; with several, the CLI cannot tell which profile's worker owns the socket.
  local prof_args=() regs
  # Without --user-data-dir a non-default Chrome dir would get the URL in the default instance.
  [ -n "${NB_LIVE_CHROME_DIR:-}" ] && prof_args+=(--user-data-dir="$CHROME_DIR")
  regs="$(registrations)"
  if [ "$(grep -c . <<<"$regs")" -eq 1 ]; then
    prof_args+=(--profile-directory="$(cut -f1 <<<"$regs")")
  elif [ -n "$regs" ]; then
    echo "NOTE: nanobrowser is in several Chrome profiles; keep the one you set up frontmost."
  fi

  mkdir -p "$ROOT/runs"
  local out; out="$(mktemp -d "$ROOT/runs/live-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")" || die "could not create a results dir"
  mkdir -p "$out/fixture"
  step "fixture server"
  node "$HARNESS/live-fixture-server.mjs" --seed "$RANDOM" --out "$out/fixture" >"$out/fixture.log" 2>&1 &
  FIXTURE_PID=$!
  # Closing nb-run does not stop the run in the extension, so an interrupted test would
  # leave the agent acting in your browser. Cancel whatever run is in flight on the way out.
  trap cleanup_test EXIT
  trap 'exit 130' INT TERM
  for _ in $(seq 50); do [ -f "$out/fixture/ready.json" ] && break; sleep 0.1; done
  [ -f "$out/fixture/ready.json" ] || die "fixture server did not start (see $out/fixture.log)"
  local base; base="$(jq -r .baseUrl "$out/fixture/ready.json")"
  echo "$base   results -> $out"
  echo "models: leader=$LEADER follower=$FOLLOWER"
  echo "Each task opens its own tab. Leave it frontmost until the task finishes:"
  echo "a run acts on whichever tab is active."

  : >"$out/summary.txt"
  local pass=0 fail=0
  for task in "${list[@]}"; do
    step "task $task"
    local tj="$out/$task-task.json"
    node "$HARNESS/live-tasks.mjs" --task "$task" --expected "$out/fixture/expected.json" \
      --base-url "$base" --leader "$LEADER" --follower "$FOLLOWER" >"$tj" || { echo "unknown task $task"; fail=$((fail + 1)); continue; }
    local url prompt; url="$(jq -r .url "$tj")"; prompt="$(jq -r .prompt "$tj")"
    echo "$(jq -r .title "$tj")  ($url)"

    # Pin everything the panel also stores, or its last choice leaks in: a Kilo source
    # would route the Nemotron ids to the wrong gateway, a read-only toggle would block
    # the writes a task's verdict requires.
    # closeTabWhenDone: every task opens a fresh tab; the extension closes it after the run.
    local opt_args=(--option leaderModelSource=openrouter --option followerModelSource=openrouter --option closeTabWhenDone=true)
    while IFS= read -r kv; do opt_args+=(--option "$kv"); done \
      < <(jq -r '.options | {readOnly: false} + . | to_entries[] | "\(.key)=\(.value)"' "$tj")

    local hits0 host0 ext0
    hits0="$(wc -l <"$out/fixture/hits.jsonl" 2>/dev/null || echo 0)"
    host0="$(wc -l <"$DATA/host.log" 2>/dev/null || echo 0)"
    ext0="$(wc -l <"$DATA/ext.log" 2>/dev/null || echo 0)"

    # A fresh tab, so the run never takes over the page you were reading.
    # With Chrome running, this hands the URL to it and exits; a failure here means the
    # run would take over whatever tab is active instead, so the task is not started.
    touch "$out/$task.start"
    if ! timeout 15 "$CHROME" "${prof_args[@]}" "$url" >/dev/null 2>&1; then
      echo "could not open a fresh tab for $task; not starting it"
      fail=$((fail + 1)); echo "FAIL  $task  (no fresh tab)" >>"$out/summary.txt"; continue
    fi
    sleep 2

    # Chosen here rather than read back from nb-run, so an interrupt that lands before
    # nb-run reports the id can still cancel the run the extension already accepted.
    local run_id="live-$(date +%s)-$RANDOM-$task"
    ACTIVE_RUN="$run_id"
    # In the background and waited on: `timeout` puts itself in its own process group, so
    # Ctrl-C never reaches it, and bash runs no trap while a foreground child is running.
    # `wait` returns on the signal at once, so the trap cancels the run straight away.
    timeout "$RUN_TIMEOUT" host/bin/nb-run "$prompt" --url "$url" --run-id "$run_id" "${opt_args[@]}" \
      >"$out/$task-stream.jsonl" 2>"$out/$task-nb-run.stderr" &
    RUN_PID=$!
    wait "$RUN_PID"
    local rc=$?
    RUN_PID=""
    ACTIVE_RUN=""
    if [ "$rc" -eq 124 ]; then
      echo "timed out after ${RUN_TIMEOUT}s; cancelling $run_id"
      host/bin/nb-cancel "$run_id" >/dev/null 2>&1 || true
    fi
    local runlog="$out/$task-runlog.jsonl"
    cp "$DATA/runs/$run_id.jsonl" "$runlog" 2>/dev/null || cp "$out/$task-stream.jsonl" "$runlog"

    tail -n +"$((hits0 + 1))" "$out/fixture/hits.jsonl" >"$out/$task-hits.jsonl" 2>/dev/null || : >"$out/$task-hits.jsonl"
    tail -n +"$((host0 + 1))" "$DATA/host.log" >"$out/$task-host.log" 2>/dev/null || : >"$out/$task-host.log"
    tail -n +"$((ext0 + 1))" "$DATA/ext.log" >"$out/$task-ext.log" 2>/dev/null || : >"$out/$task-ext.log"

    # Only files this task wrote count: Downloads may already hold a matching report from
    # an earlier run with the same seed. Give an in-progress Chrome download time to land.
    # Only the fixture's file name (Chrome may add " (1)") is copied, so nothing else that
    # lands in Downloads meanwhile ends up in the results bundle.
    local dl="$out/$task-downloads" want stem
    want="$(jq -r '.download.filename' "$out/fixture/expected.json")"; stem="${want%.*}"
    mkdir -p "$dl"
    for _ in $(seq 10); do
      find "$HOME/Downloads" -maxdepth 1 -name '*.crdownload' -newer "$out/$task.start" 2>/dev/null | grep -q . || break
      sleep 1
    done
    find "$HOME/Downloads" "$DATA/artifacts" -type f -newer "$out/$task.start" -name "$stem*.${want##*.}" \
      -exec cp --backup=numbered -t "$dl" {} + 2>/dev/null || true

    if node "$HARNESS/live-verdict.mjs" --task "$task" --stream "$runlog" \
         --expected "$out/fixture/expected.json" \
         --host-log "$out/$task-host.log" --ext-log "$out/$task-ext.log" \
         --download-dirs "$dl" --hits "$out/$task-hits.jsonl" \
         --json "$out/$task-verdict.json" | tee "$out/$task-verdict.txt"; then
      pass=$((pass + 1)); echo "PASS  $task  run=$run_id" >>"$out/summary.txt"
    else
      fail=$((fail + 1)); echo "FAIL  $task  run=$run_id  ($out/$task-verdict.txt)" >>"$out/summary.txt"
    fi
  done

  step "summary"
  cat "$out/summary.txt"
  echo "$pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

# The agent performs each activity for real (scripts/harness/activities.mjs): real eBay,
# the free pair, your Chrome. Each step prints as it happens; the verdict comes only from
# what the run log shows, and the report names the workflow and token waste it saw.
cmd_activities() {
  local list=() repeat=1 a pin=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --repeat) repeat="$2"; shift 2 ;;
      # Pin browse to one site and query, e.g. to compare model pairs on the same page.
      --site) pin+=(--site "$2"); shift 2 ;;
      --query) pin+=(--query "$2"); shift 2 ;;
      # Positional ids accumulate across arguments; commas and spaces split within one.
      *) read -ra names <<<"$(tr ',' ' ' <<<"$1")"; list+=("${names[@]}"); shift ;;
    esac
  done
  # The everyday loop is browse, rotating across sites; deep jobs by name (filter_sort,
  # site_median, compare_sites) rotate across shop sites the same way. eBay activities are
  # the exception: they run on ebay.com every time, so a repeat is a batch on one site.
  [ "${#list[@]}" -gt 0 ] || list=(browse)
  host_up || die "the extension is not connected; run scripts/live.sh setup first"
  host/bin/nb-status >/dev/null || die "the OpenRouter key is not ready (host/bin/nb-status)"
  if [ "$repeat" -gt 1 ] && [[ " ${list[*]} " == *' ebay_'* ]]; then
    echo "NOTE: eBay activities are pinned to ebay.com every run; repeating one hammers a single site. One or two runs, then return to the rotating rungs."
  fi

  local prof_args=() regs
  [ -n "${NB_LIVE_CHROME_DIR:-}" ] && prof_args+=(--user-data-dir="$CHROME_DIR")
  regs="$(registrations)"
  [ "$(grep -c . <<<"$regs")" -eq 1 ] && prof_args+=(--profile-directory="$(cut -f1 <<<"$regs")")

  mkdir -p "$ROOT/runs"
  local out; out="$(mktemp -d "$ROOT/runs/activities-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")" || die "could not create a results dir"
  local history="$ROOT/runs/history.jsonl"
  trap cleanup_test EXIT
  trap 'exit 130' INT TERM
  echo "models: leader=$LEADER follower=$FOLLOWER   results -> $out"
  : >"$out/summary.txt"
  local pass=0 fail=0 invalid=0 trial
  for a in "${list[@]}"; do
    for trial in $(seq "$repeat"); do
      step "activity $a ($trial/$repeat)"
      local tj="$out/$a-$trial-task.json"
      # M1's gate (3dd8e64) makes `task` refuse a legacy eBay activity without --legacy;
      # naming one here is the opt-in, so pass it for ebay_* and nothing else.
      local legacy=()
      [[ "$a" == ebay_* ]] && legacy+=(--legacy)
      # The redirection below creates $tj before the command runs; a failed or partial
      # task file would be found by `board`, which JSON.parses every *-task.json, so
      # delete it rather than leave an empty one behind.
      node "$HARNESS/activities.mjs" task --activity "$a" --history "$history" "${legacy[@]}" "${pin[@]}" >"$tj" \
        || { rm -f "$tj"; fail=$((fail + 1)); continue; }
      local url prompt; url="$(jq -r .url "$tj")"; prompt="$(jq -r .prompt "$tj")"
      echo "$(jq -r .title "$tj")  ($url)"
      local opt_args=(--option leaderModelSource=openrouter --option followerModelSource=openrouter
        --option "leaderModel=$LEADER" --option "followerModel=$FOLLOWER" --option closeTabWhenDone=true)
      while IFS= read -r kv; do opt_args+=(--option "$kv"); done \
        < <(jq -r '.options | {readOnly: false} + . | to_entries[] | "\(.key)=\(.value)"' "$tj")

      if ! timeout 15 "$CHROME" "${prof_args[@]}" "$url" >/dev/null 2>&1; then
        echo "could not open a fresh tab for $a; not starting it"
        fail=$((fail + 1)); echo "FAIL     $a  (no fresh tab)" >>"$out/summary.txt"; continue
      fi
      sleep 3

      local run_id="act-$(date +%s)-$RANDOM-$a"
      ACTIVE_RUN="$run_id"
      # Backgrounded and waited on, as in cmd_test, so Ctrl-C cancels the run at once.
      # pipefail is on, so the wait status keeps nb-run's own exit through the pipe
      # (`activities.mjs live` ends 0 on EOF); 124 means the timeout fired. Closing
      # nb-run does not stop the run in the extension, so cancel it exactly as cmd_test
      # does, and keep ACTIVE_RUN set until that is done: an interrupt landing before
      # the handling can still reach the cleanup trap.
      { timeout "$RUN_TIMEOUT" host/bin/nb-run "$prompt" --url "$url" --run-id "$run_id" "${opt_args[@]}" \
          2>"$out/$a-$trial-nb-run.stderr" \
          | node "$HARNESS/activities.mjs" live --log "$out/$a-$trial-stream.jsonl"; } &
      RUN_PID=$!
      wait "$RUN_PID"
      local rc=$?
      RUN_PID=""
      if [ "$rc" -eq 124 ]; then
        echo "timed out after ${RUN_TIMEOUT}s; cancelling $run_id"
        host/bin/nb-cancel "$run_id" >/dev/null 2>&1 || true
      fi
      ACTIVE_RUN=""
      local runlog="$out/$a-$trial-runlog.jsonl"
      cp "$DATA/runs/$run_id.jsonl" "$runlog" 2>/dev/null || cp "$out/$a-$trial-stream.jsonl" "$runlog"

      node "$HARNESS/activities.mjs" score --activity "$a" --task "$tj" --runlog "$runlog" \
        --artifacts "$DATA/artifacts/$run_id" --json "$out/$a-$trial-report.json" --history "$history" \
        | tee "$out/$a-$trial-report.txt"
      case "${PIPESTATUS[0]}" in
        0) pass=$((pass + 1)); echo "PASS     $a #$trial  $(jq -r .title "$tj")  run=$run_id" >>"$out/summary.txt" ;;
        3) invalid=$((invalid + 1)); echo "INVALID  $a #$trial  $(jq -r .title "$tj")  run=$run_id" >>"$out/summary.txt" ;;
        *) fail=$((fail + 1)); echo "FAIL     $a #$trial  $(jq -r .title "$tj")  run=$run_id" >>"$out/summary.txt" ;;
      esac
    done
  done
  step "summary"
  cat "$out/summary.txt"
  echo "$pass passed, $fail failed, $invalid invalid   (history: $history)"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  setup) cmd_setup ;;
  test) shift; cmd_test "${1:-}" ;;
  activities) shift; cmd_activities "$@" ;;
  run) shift
       exec scripts/e2e.sh --skip-build --leader "$LEADER" --follower "$FOLLOWER" \
         --leader-source openrouter --follower-source openrouter --prompt "$@" ;;
  status) exec host/bin/nb-status ;;
  logs) exec host/bin/nb-logs ;;
  -h|--help|"") usage ;;
  *) usage; exit 2 ;;
esac
