#!/usr/bin/env bash
# Deploy the built plugin into a DSH profile - safely, and reversibly.
#
# WHY THIS EXISTS. This plugin ships no client half (the probes assert lib/client.js
# is absent), so the page is host-rendered: a UI change needs a server RESTART, not a
# hard refresh. That makes the deploy the risky step, and a deploy with no way back is
# the one failure here that could cost a working install. So: snapshot first, verify
# by hash, and never restart anything - the operator decides when their session ends.
#
# EVERY STAGE IS A SEPARATE CHECKED STATEMENT. Chaining them with `&&` would let a
# failing typecheck sail into a deploy: under `set -e` a failed `A && B` does not
# abort, it just evaluates to false and execution continues.
#
#   scripts/deploy.sh                # snapshot, verify, build, deploy, verify
#   scripts/deploy.sh --check        # report drift cheaply, change nothing
#   scripts/deploy.sh --rollback     # restore the newest snapshot
#   scripts/deploy.sh --skip-tests   # for a docs-only or CSS-only change
#   scripts/deploy.sh --first-install  # allow a target that does not exist yet
#
# Targets are overridable, because a machine's layout is not this repo's business:
#   PLANNER_HOME      default ~/dsh-planner
#   DSH_PROFILE       default web
#   PORT              default 3099
#
# IT IS NOT CALLED DSH_HOME, ON PURPOSE. `DSH_HOME` is set in the environment of
# every process the harness spawns - including an agent session, which is exactly
# how this script was being run when the bug was found. `${DSH_HOME:-~/dsh-planner}`
# therefore resolved to the REAL home, `~/.dsh`, and pointed the deploy at the live
# profile. The copy step was never reached that time; on a faster run it would have
# installed into the profile the operator had explicitly decided not to touch. A
# variable nothing else sets, plus the refusal below, makes that unreachable.
set -u

PKG=dsh-daily-progress-tab
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLANNER_HOME=${PLANNER_HOME:-$HOME/dsh-planner}
DSH_PROFILE=${DSH_PROFILE:-web}
PORT=${PORT:-3099}
PROFILE_DIR="$PLANNER_HOME/profiles/$DSH_PROFILE"
TARGET="$PROFILE_DIR/node_modules/$PKG"
SNAPSHOTS="$PLANNER_HOME/snapshots"
KEEP=5

MODE=deploy
SKIP_TESTS=0
ALLOW_NEW=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --rollback) MODE=rollback ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --first-install) ALLOW_NEW=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step () { printf '\n== %s\n' "$*"; }
ok ()   { printf '   ok    %s\n' "$*"; }
die ()  { printf '   FAIL  %s\n' "$*" >&2; exit 1; }

# A tree hash over the files that are actually deployed, so "is this the same build"
# is a fact rather than an impression. Sorted, so file order cannot change it.
tree_hash () {
  local dir=$1
  [ -d "$dir" ] || { echo 'missing'; return; }
  ( cd "$dir" && find . -type f | LC_ALL=C sort | xargs sha256sum 2>/dev/null | sha256sum | cut -c1-16 )
}

step "targets - CHECK THIS LINE BEFORE ANYTHING ELSE"
echo "   repo     $REPO"
echo "   home     $PLANNER_HOME"
echo "   profile  $PROFILE_DIR"
echo "   target   $TARGET"

# The guard that makes the near miss unreachable: whatever the environment says,
# this script will not write into the real harness home.
case "$PROFILE_DIR" in
  "$HOME/.dsh"|"$HOME/.dsh"/*) die "refusing to deploy into the real harness home ($PROFILE_DIR).
         Set PLANNER_HOME to a scratch home. Installing into ~/.dsh is a deliberate act." ;;
esac
[ -d "$PROFILE_DIR" ] || die "no profile at $PROFILE_DIR - set PLANNER_HOME, or let DSH provision one first"
if [ ! -d "$TARGET" ] && [ "$MODE" != check ] && [ "$ALLOW_NEW" -eq 0 ]; then
  die "nothing is deployed at $TARGET yet, so this would be a FIRST INSTALL.
         That is the risky act, not a routine deploy. Re-run with --first-install once
         you are sure $TARGET is the home you mean."
fi
ok "the target is a scratch home, not the real one"

# ------------------------------------------------------------------ rollback
if [ "$MODE" = rollback ]; then
  step "rollback"
  [ -d "$SNAPSHOTS" ] || die "no snapshots in $SNAPSHOTS"
  newest=$(find "$SNAPSHOTS" -maxdepth 1 -mindepth 1 -type d | LC_ALL=C sort | tail -1)
  [ -n "$newest" ] || die "no snapshots in $SNAPSHOTS"
  echo "   restoring $newest"
  rm -rf "$TARGET"
  mkdir -p "$(dirname "$TARGET")"
  cp -a "$newest" "$TARGET"
  ok "restored $(tree_hash "$TARGET") (was deployed as $(basename "$newest"))"
  echo "   restart to make it live: kill \$(cat $PLANNER_HOME/dsh-planner.pid) && DSH_HOME=$PLANNER_HOME setsid nohup node /usr/local/bin/dsh web --port $PORT >> $PLANNER_HOME/boot.log 2>&1 &"
  exit 0
fi

# ------------------------------------------------------------------ the gates
step "typecheck"
( cd "$REPO" && node_modules/.bin/tsc -p tsconfig.json --noEmit ) || die "typecheck failed - not deploying"

if [ "$MODE" = check ]; then
  step "unit tests (skipped: --check only reports drift, and must stay cheap)"
elif [ "$SKIP_TESTS" -eq 0 ]; then
  step "unit tests"
  ( cd "$REPO" && node --test tests/*.test.ts > /tmp/deploy-tests.log 2>&1 ) || {
    tail -25 /tmp/deploy-tests.log >&2; die "unit tests failed - not deploying"; }
  grep -E '^# (pass|fail)|^ℹ (pass|fail)' /tmp/deploy-tests.log | sed 's/^/   /' || true
  ok "tests passed"
else
  step "unit tests (skipped on request)"
fi

step "build"
( cd "$REPO" && node_modules/.bin/tsc -p tsconfig.json ) || die "build failed - not deploying"
ok "built"

# ------------------------------------------------------------------ drift
step "drift"
built=$(tree_hash "$REPO/lib")
deployed=$(tree_hash "$TARGET/lib")
echo "   built     $built"
echo "   deployed  $deployed"
if [ "$built" = "$deployed" ]; then
  ok "already up to date - nothing to copy"
  [ "$MODE" = check ] && exit 0
  if [ "$MODE" = deploy ]; then
    echo "   (no restart needed: the deployed code is already this build)"
    exit 0
  fi
fi
if [ "$MODE" = check ]; then
  echo "   DRIFT: the deployed copy is not this build"; exit 1
fi

# ------------------------------------------------------------------ deploy
step "snapshot"
mkdir -p "$SNAPSHOTS"
stamp="$(date +%Y-%m-%dT%H-%M-%S)"
if [ -d "$TARGET" ]; then
  cp -a "$TARGET" "$SNAPSHOTS/$stamp"
  ok "saved $SNAPSHOTS/$stamp ($(tree_hash "$TARGET"))"
else
  ok "nothing deployed yet, so nothing to save"
fi
# Prune, oldest first, so the disk cannot fill with old builds.
count=$(find "$SNAPSHOTS" -maxdepth 1 -mindepth 1 -type d | wc -l)
if [ "$count" -gt "$KEEP" ]; then
  find "$SNAPSHOTS" -maxdepth 1 -mindepth 1 -type d | LC_ALL=C sort | head -n "$((count - KEEP))" | while read -r old; do
    rm -rf "$old"; echo "   pruned $(basename "$old")"
  done
fi

step "copy"
mkdir -p "$TARGET"
rm -rf "$TARGET/lib"
cp -a "$REPO/lib" "$TARGET/lib"
cp -a "$REPO/package.json" "$TARGET/package.json"
ok "copied lib/ and package.json"

step "verify"
after=$(tree_hash "$TARGET/lib")
echo "   built     $built"
echo "   deployed  $after"
[ "$built" = "$after" ] || die "the copied tree does not match the build - investigate before restarting"
ok "the deployed tree is byte-for-byte the build"

step "guards"
# A second copy of @deepseek-ai under a profile splits a Symbol and kills every tool
# call with "reading 'prepare'". This must print nothing.
stray=$(find "$PLANNER_HOME/profiles" -type d -path '*/node_modules/@deepseek-ai/*' 2>/dev/null | head -3)
if [ -n "$stray" ]; then
  printf '   FAIL  a duplicate @deepseek-ai tree exists in a profile:\n%s\n' "$stray" >&2
  exit 1
fi
ok "no duplicate @deepseek-ai tree in any profile"
if [ -e "$TARGET/lib/client.js" ]; then
  ok "client half present (a hard refresh is enough after a restart)"
else
  ok "no client half, as expected: this build needs a full server restart"
fi

step "next"
cat <<EOF
   The code is deployed and verified. It is NOT live yet - a host-rendered page
   only changes after a restart, and the restart ends the session talking to it.

     kill \$(cat $PLANNER_HOME/dsh-planner.pid)
     DSH_HOME=$PLANNER_HOME setsid nohup node /usr/local/bin/dsh web --port $PORT >> $PLANNER_HOME/boot.log 2>&1 &
     echo \$! > $PLANNER_HOME/dsh-planner.pid

   Then:  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:$PORT/daily-progress-tab/ui

   To undo this deploy:  scripts/deploy.sh --rollback
EOF
