#!/bin/sh
# Relay M0 demo rig (DESIGN.md §12 M0): two terminals, one Mac, the real plugin
# install path, PGlite hub on 127.0.0.1:8787. POSIX sh only.
#
#   scripts/demo.sh up [--plugin-dir] [--build|--no-build] [--force]   build if needed, start the hub,
#                                                                    create /tmp/relay-demo, print the script
#   scripts/demo.sh check      curl the hub + inspect local state: are the six moments visible?
#   scripts/demo.sh status     is the hub up, what exists
#   scripts/demo.sh script     print the two-terminal script again
#   scripts/demo.sh stop|down [--keep]   stop the hub, unregister the demo marketplace, delete /tmp/relay-demo
#
# Environment: RELAY_DEMO_DIR (default /tmp/relay-demo), RELAY_DEMO_PORT (default 8787, or the next
# free port when 8787 is held by something else; remembered in $RELAY_DEMO_DIR/port),
# ANTHROPIC_API_KEY (passed to the hub: enables LLM handoff synthesis), CLAUDE_CONFIG_DIR.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEMO="${RELAY_DEMO_DIR:-/tmp/relay-demo}"
# port: RELAY_DEMO_PORT, else the port of the current rig ($DEMO/port), else 8787; `up` moves to
# the next free port when 8787 is held by something that is not a Relay hub.
PORT="${RELAY_DEMO_PORT:-$(cat "$DEMO/port" 2>/dev/null || echo 8787)}"
HUB="http://127.0.0.1:$PORT"
TOKEN=demo
ADMIN_TOKEN=demo-admin
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MKT_URL="file://$DEMO/mkt.git"
PLUGIN_SRC="$ROOT/packages/plugin"

say() { printf '%s\n' "$*"; }
warn() { printf 'demo: %s\n' "$*" >&2; }
die() { printf 'demo: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH"; }

hub_alive() { curl -s -m 2 "$HUB/health" 2>/dev/null | grep -q '"db"'; }
port_busy() { curl -s -m 2 -o /dev/null "$HUB/health" 2>/dev/null; }
pid_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

hub_pid() { [ -r "$DEMO/hub.pid" ] && cat "$DEMO/hub.pid" 2>/dev/null; }

# Every `rm -rf` below goes through these two guards (review): RELAY_DEMO_DIR must never be a
# home directory, `/`, or a directory the rig did not create (the `port` + `mode` markers written by `up`).
guard_demo_path() {
  case "$DEMO" in
    ""|/|"$HOME"|"$HOME/"|.|..|*/..|*/../*) die "refusing to operate on '$DEMO' (RELAY_DEMO_DIR must be a dedicated directory, not / or your home)" ;;
    /*) ;;
    *) die "RELAY_DEMO_DIR must be an absolute path (got '$DEMO')" ;;
  esac
  # well-known roots that would be catastrophic to wipe
  case "$DEMO" in
    /Users|/Users/*/Documents|/Users/*/Desktop|/home|/tmp|/var|/etc|/usr|/opt|/private|/private/tmp|/private/var) die "refusing to operate on '$DEMO'" ;;
  esac
}
is_demo_rig() { [ -f "$DEMO/port" ] && [ -f "$DEMO/mode" ]; }
# `up` creates $DEMO itself (0700) and refuses one it does not own: hooks exec the interpreter path
# cached under $DEMO/home-<dev>, so another local account must not be able to pre-create it (review).
own_demo_dir() {
  if [ -e "$DEMO" ]; then
    [ -d "$DEMO" ] || die "$DEMO exists and is not a directory"
    [ -O "$DEMO" ] || die "$DEMO exists but is not owned by $USER; choose another RELAY_DEMO_DIR"
    chmod 700 "$DEMO" 2>/dev/null || true
  else
    mkdir -m 700 -p "$DEMO" || die "could not create $DEMO"
    chmod 700 "$DEMO" 2>/dev/null || true
  fi
}
confirm_tty() {
  # $1 = question; only a TTY can answer, so unattended runs never get past a --force
  [ -t 0 ] || die "$1 needs an interactive terminal (refusing under --force without a TTY)"
  printf '%s [type yes to continue] ' "$1"
  read -r ans
  [ "$ans" = yes ] || die "aborted"
}

# ---------------------------------------------------------------- build
build_if_needed() {
  bmode="$1"
  [ "$bmode" = "no" ] && return 0
  stale=0
  for f in hook.mjs mcp.mjs; do
    b="$PLUGIN_SRC/dist/$f"
    if [ ! -s "$b" ] || [ "$(wc -c < "$b" | tr -d ' ')" -lt 1000 ]; then stale=1; fi
  done
  if [ "$stale" = 0 ] && [ "$bmode" != "force" ]; then
    # any source newer than the hook bundle -> rebuild
    if [ -n "$(find "$ROOT/packages/core/src" "$ROOT/packages/hooks/src" "$ROOT/packages/mcp/src" -type f -newer "$PLUGIN_SRC/dist/hook.mjs" 2>/dev/null | head -n 1)" ]; then stale=1; fi
  fi
  if [ "$stale" = 1 ] || [ "$bmode" = "force" ]; then
    say "==> building the plugin bundles (pnpm build)"
    (cd "$ROOT" && pnpm build) || die "pnpm build failed"
  else
    say "==> plugin bundles are up to date"
  fi
  for f in hook.mjs mcp.mjs; do
    [ "$(wc -c < "$PLUGIN_SRC/dist/$f" | tr -d ' ')" -ge 1000 ] || warn "dist/$f is tiny ($(wc -c < "$PLUGIN_SRC/dist/$f" | tr -d ' ') bytes): the hooks/mcp packages may not be implemented yet; the rig still works but hooks will do nothing"
  done
}

# ---------------------------------------------------------------- hub
start_hub() {
  mkdir -p "$DEMO"
  if hub_alive; then
    printf '%s\n' "$PORT" > "$DEMO/port"
    p=$(hub_pid)
    if pid_alive "$p"; then say "==> hub already running on $HUB (pid $p)"; return 0; fi
    warn "a Relay hub is already listening on $HUB (not started by this script); reusing it"
    return 0
  fi
  if port_busy; then
    if [ -n "${RELAY_DEMO_PORT:-}" ]; then die "port $PORT is taken by something that is not a Relay hub; pick another RELAY_DEMO_PORT"; fi
    orig="$PORT"; n=0
    while port_busy && [ $n -lt 12 ]; do PORT=$((PORT + 1)); HUB="http://127.0.0.1:$PORT"; n=$((n + 1)); done
    port_busy && die "ports $orig-$PORT are all busy; set RELAY_DEMO_PORT=<free port>"
    warn "port $orig is held by something that is not a Relay hub; using $PORT instead"
  fi
  printf '%s\n' "$PORT" > "$DEMO/port"
  say "==> starting the hub on $HUB (PGlite in $DEMO/hub-data, log $DEMO/hub.log)"
  [ -x "$ROOT/node_modules/.bin/tsx" ] || die "node_modules/.bin/tsx missing: run pnpm install first"
  mkdir -p "$DEMO/hub-data"
  (
    cd "$ROOT/apps/api" || exit 1
    RELAY_DATA_DIR="$DEMO/hub-data" RELAY_TEAM_TOKEN="$TOKEN" RELAY_ADMIN_TOKEN="$ADMIN_TOKEN" \
    RELAY_PORT="$PORT" RELAY_HOST=127.0.0.1 \
    nohup "$ROOT/node_modules/.bin/tsx" scripts/dev.ts >"$DEMO/hub.log" 2>&1 &
    echo $! > "$DEMO/hub.pid"
  )
  i=0
  while [ $i -lt 60 ]; do
    if hub_alive; then say "    hub is up: $(curl -s -m 2 "$HUB/health")"; return 0; fi
    p=$(hub_pid)
    pid_alive "$p" || { tail -n 20 "$DEMO/hub.log" >&2; die "hub exited early; see $DEMO/hub.log"; }
    sleep 1; i=$((i + 1))
  done
  tail -n 20 "$DEMO/hub.log" >&2
  die "hub did not answer on $HUB within 60 s; see $DEMO/hub.log"
}

stop_hub() {
  p=$(hub_pid)
  if pid_alive "$p"; then
    say "==> stopping the hub (pid $p)"
    kill "$p" 2>/dev/null
    i=0; while [ $i -lt 10 ] && pid_alive "$p"; do sleep 1; i=$((i + 1)); done
    pid_alive "$p" && kill -9 "$p" 2>/dev/null
  fi
  rm -f "$DEMO/hub.pid"
  # a tsx child that outlived its parent
  if hub_alive && command -v lsof >/dev/null 2>&1; then
    for q in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do
      if ps -p "$q" -o command= 2>/dev/null | grep -q 'scripts/dev.ts'; then kill "$q" 2>/dev/null; fi
    done
  fi
}

# ---------------------------------------------------------------- plugin state in ~/.claude
# Returns the registered source of marketplace "relay" ("" when unregistered).
relay_mkt_source() {
  f="$CLAUDE_DIR/plugins/known_marketplaces.json"
  [ -r "$f" ] || { printf ''; return 0; }
  node -e '
    const fs = require("fs");
    try {
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const e = m && m.relay && m.relay.source;
      if (!e) process.exit(0);
      process.stdout.write(e.url || e.repo || e.path || JSON.stringify(e));
    } catch {}
  ' "$f"
}

unregister_demo_plugin() {
  uforce="$1"
  src=$(relay_mkt_source)
  if [ -n "$src" ]; then
    case "$src" in
      "$MKT_URL"|*relay-demo*) ;;
      *)
        if [ "$uforce" != 1 ]; then
          die "marketplace 'relay' is registered from '$src' (not this demo). Unregister it yourself (claude plugin marketplace remove relay) or re-run with --force to let the demo remove it"
        fi
        warn "about to remove marketplace 'relay' registered from '$src' and its plugin cache (--force)"
        confirm_tty "Remove the non-demo 'relay' marketplace from '$src'?"
        ;;
    esac
    say "==> unregistering the previous demo plugin (claude plugin marketplace remove relay)"
    if command -v claude >/dev/null 2>&1; then
      claude plugin uninstall relay@relay >/dev/null 2>&1 || true
      claude plugin marketplace remove relay >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$CLAUDE_DIR/plugins/cache/relay" "$CLAUDE_DIR/plugins/marketplaces/relay" "$CLAUDE_DIR/plugins/data/relay-relay" 2>/dev/null
  # belt and braces: drop leftover entries the CLI did not remove
  for f in known_marketplaces.json installed_plugins.json; do
    p="$CLAUDE_DIR/plugins/$f"
    [ -r "$p" ] || continue
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      let j; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
      let changed = false;
      if (j && j.relay) { delete j.relay; changed = true; }
      if (j && j.plugins && j.plugins["relay@relay"]) { delete j.plugins["relay@relay"]; changed = true; }
      if (changed) fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    ' "$p"
  done
}

# ---------------------------------------------------------------- marketplace + plugin copy
make_marketplace() {
  say "==> building the local marketplace repo ($DEMO/mkt -> $MKT_URL)"
  guard_demo_path
  rm -rf "$DEMO/mkt" "$DEMO/mkt.git"
  mkdir -p "$DEMO/mkt/.claude-plugin"
  cp -R "$PLUGIN_SRC" "$DEMO/mkt/plugin"
  rm -f "$DEMO/mkt/plugin/team.json.example"
  cat > "$DEMO/mkt/plugin/team.json" <<JSON
{
  "hub": "$HUB",
  "team": "exampleteam",
  "token": "$TOKEN",
  "marketplace": "your-org/relay-plugin",
  "members": {
    "priya": { "name": "Priya", "emails": ["priya@demo"] },
    "arjun": { "name": "Arjun", "emails": ["arjun@demo"] }
  }
}
JSON
  # A version stamp on the MARKETPLACE entry (never in plugin.json, §2.3) so the cache
  # directory ~/.claude/plugins/cache/relay/relay/<version> changes on every run (B.13).
  stamp="0.$(date -u +%Y%m%d).$(date -u +%H%M%S | sed 's/^0*//')"
  [ -n "$stamp" ] || stamp="0.0.1"
  cat > "$DEMO/mkt/.claude-plugin/marketplace.json" <<JSON
{
  "name": "relay",
  "owner": { "name": "Parallel Connect" },
  "description": "Relay demo marketplace (local, disposable)",
  "plugins": [
    {
      "name": "relay",
      "source": "./plugin",
      "version": "$stamp",
      "description": "Team presence, collision warnings, contract impact routing and automatic handoffs"
    }
  ]
}
JSON
  (
    cd "$DEMO/mkt" || exit 1
    git init -q -b main 2>/dev/null || git init -q
    git -c user.name='Relay Demo' -c user.email='demo@relay.local' -c commit.gpgsign=false add -A
    git -c user.name='Relay Demo' -c user.email='demo@relay.local' -c commit.gpgsign=false commit -q -m "relay plugin $stamp (demo)"
  ) || die "could not create the marketplace repo"
  git clone -q --bare "$DEMO/mkt" "$DEMO/mkt.git" || die "could not create $DEMO/mkt.git"
  if command -v claude >/dev/null 2>&1; then
    if claude plugin validate "$DEMO/mkt" >/dev/null 2>&1; then say "    marketplace validates (claude plugin validate)"; else warn "claude plugin validate reported problems for $DEMO/mkt (run it yourself to see them)"; fi
  fi
}

# ---------------------------------------------------------------- origin + clones
write_settings() {
  # $1 = dev, $2 = clone dir, $3 = mode (marketplace|plugin-dir)
  DEV="$1" CLONE="$2" MODE="$3" RELAY_HOME_DIR="$DEMO/home-$1" HUB_URL="$HUB" MKT="$MKT_URL" TOK="$TOKEN" node -e '
    const fs = require("fs"), path = require("path");
    const e = process.env;
    const s = {};
    if (e.MODE === "marketplace") {
      s.extraKnownMarketplaces = { relay: { source: { source: "git", url: e.MKT }, autoUpdate: true } };
      s.enabledPlugins = { "relay@relay": true };
    }
    s.permissions = { allow: ["mcp__plugin_relay_relay", "mcp__plugin_relay_relay__*"] };
    s.statusLine = {
      type: "command",
      command: "/bin/sh -c '\''f=\"${RELAY_HOME:-$HOME/.relay}/statusline.sh\"; [ -r \"$f\" ] && exec /bin/sh \"$f\" || true'\''",
      refreshInterval: 10,
    };
    s.env = {
      RELAY_HOME: e.RELAY_HOME_DIR,
      RELAY_DEV: e.DEV,
      RELAY_HUB: e.HUB_URL,
      RELAY_TOKEN: e.TOK,
      RELAY_SNAPSHOT_TTL_MS: "15000",
    };
    fs.mkdirSync(path.join(e.CLONE, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(e.CLONE, ".claude", "settings.json"), JSON.stringify(s, null, 2) + "\n");
  ' || die "could not write .claude/settings.json for $1"
}

make_repos() {
  rmode="$1"
  say "==> creating origin.git and the two clones"
  guard_demo_path
  rm -rf "$DEMO/origin.git" "$DEMO/seed" "$DEMO/app-priya" "$DEMO/app-arjun" "$DEMO/home-priya" "$DEMO/home-arjun"
  git init -q --bare "$DEMO/origin.git" || die "git init --bare failed"
  cp -R "$ROOT/examples/demo-repo" "$DEMO/seed"
  (
    cd "$DEMO/seed" || exit 1
    git init -q -b main 2>/dev/null || git init -q
    git -c user.name='Demo Seed' -c user.email='seed@demo' -c commit.gpgsign=false add -A
    git -c user.name='Demo Seed' -c user.email='seed@demo' -c commit.gpgsign=false commit -q -m "acme-portal demo seed"
    git remote add origin "$DEMO/origin.git"
    git push -q origin HEAD:main
  ) || die "could not seed origin.git"
  rm -rf "$DEMO/seed"
  for dev in priya arjun; do
    d="$DEMO/app-$dev"
    git clone -q "$DEMO/origin.git" "$d" || die "clone failed for $dev"
    git -C "$d" config user.name "$(printf '%s' "$dev" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
    git -C "$d" config user.email "$dev@demo"
    git -C "$d" config commit.gpgsign false
    git -C "$d" config pull.rebase false
    write_settings "$dev" "$d" "$rmode"
    printf '%s\n' '.claude/' >> "$d/.git/info/exclude"
    mkdir -p "$DEMO/home-$dev"
  done
}

# ---------------------------------------------------------------- the script
print_script() {
  pmode="$1"
  if [ "$pmode" = "plugin-dir" ]; then
    LAUNCH_A="cd $DEMO/app-priya && claude --plugin-dir $DEMO/mkt/plugin"
    LAUNCH_B="cd $DEMO/app-arjun && claude --plugin-dir $DEMO/mkt/plugin"
    INSTALL_NOTE="  (--plugin-dir variant: the plugin loads from $DEMO/mkt/plugin in the same session; accept the trust dialog so the project env block applies)"
  else
    LAUNCH_A="cd $DEMO/app-priya && claude"
    LAUNCH_B="cd $DEMO/app-arjun && claude"
    INSTALL_NOTE="  Accept the workspace trust dialog (the one install prompt). Claude Code registers the local marketplace
  from .claude/settings.json and caches the plugin. Experiment B.1 showed the plugin becomes live on a
  later session in the headless path: if the status line does not show 'relay' after the first prompt,
  type /reload-plugins, or /exit and run claude again (at most twice). 'scripts/demo.sh check' tells you
  whether the plugin is cached and whether hooks have fired."
  fi
  cat <<TXT

================================================================================================
Relay M0 demo — two terminals, one Mac (DESIGN.md §12)
hub $HUB (team token "$TOKEN", PGlite in $DEMO/hub-data, log $DEMO/hub.log)
clones: $DEMO/app-priya (priya, area app)   $DEMO/app-arjun (arjun, area dashboard)
state:  $DEMO/home-priya  $DEMO/home-arjun  (RELAY_HOME per developer; set by .claude/settings.json "env")
verify any time from a third terminal:  scripts/demo.sh check
================================================================================================

Terminal A (priya)
  $LAUNCH_A
$INSTALL_NOTE
  > Add an optional \`status: OrderStatus\` field to OrderFilter in packages/contracts/src/orders.ts and use it in apps/app/src/api/orders.ts. Commit.

Terminal B (arjun), while A works
  $LAUNCH_B
  1 PRESENCE   status line shows "relay ● priya contracts (+app) main HH:MM" (absolute UTC time).
               > What is priya working on right now, and does it touch my area?
               Claude answers from the digest/snapshot; /relay:status agrees.
  > Add a status column to apps/dashboard/src/OrdersTable.tsx — first check whether any contract I depend on changed.
  2 IMPACT     A's commit routed the change set (committed = no debounce). It reaches B either in the digest
               (if it landed before B started) or as <relay-inbox> at this prompt (snapshot TTL 15 s), never both;
               the just-in-time note on B's first Read/Edit of a dependent appears only if the prompt did not
               already deliver it. Claude names OrderFilter.status.
  > Now rename status to orderStatus in packages/contracts/src/orders.ts
  3 COLLISION  permission prompt: "Relay: priya is editing packages/contracts/src/orders.ts (branch main,
               last edit HH:MM:SSZ ...). Allow this edit?"  -> answer No
  > Tell priya to keep \`status\`; the dashboard already consumes it
  4 NOTIFY     Terminal A's status line shows "· 1 note"; at A's next prompt:
               > Any messages from arjun?
               Claude relays the note.

Terminal A
  /exit
  5 HANDOFF    synthesized within ~10 s (SessionEnd worker + hub; heuristic at once, LLM when the hub has
               ANTHROPIC_API_KEY). scripts/demo.sh check lists it.

Terminal B
  > Show priya's latest handoff
               (handoffs tool)
  /exit, then relaunch B
  6 DIGEST     the session-start digest lists the handoff, the change set (committed, not in your branch)
               and decisions.

Tear down:  scripts/demo.sh stop          (stops the hub, unregisters the demo marketplace, deletes $DEMO)
Notes: use 'printenv RELAY_DEV' rather than 'echo \$RELAY_DEV' in demo prompts (B.10); Desktop-launched
sessions need the same two folders opened as projects.
================================================================================================
TXT
}

# ---------------------------------------------------------------- commands
cmd_up() {
  mode=marketplace; build=auto; force=0
  for a in "$@"; do
    case "$a" in
      --plugin-dir) mode=plugin-dir ;;
      --build) build=force ;;
      --no-build) build=no ;;
      --force) force=1 ;;
      -h|--help) sed -n 2,15p "$0"; exit 0 ;;
      *) die "unknown option for up: $a" ;;
    esac
  done
  need git; need node; need curl; need pnpm
  command -v claude >/dev/null 2>&1 || warn "claude CLI not on PATH; the rig will be created but you need Claude Code to run the script"
  nv=$(node -e 'process.stdout.write(String(+process.versions.node.split(".")[0]))')
  [ "$nv" -ge 18 ] || die "node >= 18 required (found $(node --version))"
  guard_demo_path
  own_demo_dir
  build_if_needed "$build"
  start_hub
  # always: a plugin left registered by a previous marketplace-mode run would load twice under --plugin-dir
  unregister_demo_plugin "$force"
  make_marketplace
  make_repos "$mode"
  printf '%s\n' "$mode" > "$DEMO/mode"
  print_script "$mode" | tee "$DEMO/SCRIPT.txt" >/dev/null
  print_script "$mode"
}

cmd_stop() {
  keep=0
  for a in "$@"; do case "$a" in --keep) keep=1 ;; *) ;; esac; done
  stop_hub
  unregister_demo_plugin 0 2>/dev/null || warn "could not fully unregister the demo marketplace; run: claude plugin marketplace remove relay"
  if [ "$keep" = 1 ]; then say "==> kept $DEMO"
  elif [ ! -e "$DEMO" ]; then say "==> $DEMO already absent"
  else
    guard_demo_path
    is_demo_rig || die "$DEMO is not a demo rig (no port/mode markers written by 'up'); not deleting it"
    rm -rf "$DEMO"; say "==> removed $DEMO"
  fi
  say "done."
}

cmd_status() {
  if hub_alive; then say "hub: up on $HUB ($(curl -s -m 2 "$HUB/health"))"; else say "hub: down ($HUB)"; fi
  p=$(hub_pid); if pid_alive "$p"; then say "hub pid: $p"; fi
  [ -d "$DEMO" ] && say "demo dir: $DEMO ($(ls "$DEMO" 2>/dev/null | tr '\n' ' '))" || say "demo dir: absent"
  src=$(relay_mkt_source); [ -n "$src" ] && say "marketplace 'relay': $src" || say "marketplace 'relay': not registered"
  ls -d "$CLAUDE_DIR"/plugins/cache/relay/relay/* 2>/dev/null | sed 's/^/plugin cache: /'
}

cmd_check() {
  need node
  RELAY_DEMO_DIR="$DEMO" RELAY_DEMO_HUB="$HUB" RELAY_DEMO_TOKEN="$TOKEN" CLAUDE_DIR="$CLAUDE_DIR" exec node "$ROOT/scripts/demo-check.mjs" "$@"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  stop|down) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  check) shift; cmd_check "$@" ;;
  script) mode=$(cat "$DEMO/mode" 2>/dev/null || echo marketplace); print_script "$mode" ;;
  *) sed -n 2,15p "$0"; exit 1 ;;
esac
