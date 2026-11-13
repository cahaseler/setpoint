#!/usr/bin/env bash
# Deploy a release by handover: the running setpoint keeps serving while the
# new one connects every account in standby, then hands over in seconds.
#
#   scripts/deploy-release.sh [commit] [reason...]
#
# commit defaults to origin/main. Each release runs from its own worktree
# under ~/projects/setpoint-releases/<sha>, sharing config, data and logs
# through SETPOINT_HOME (this checkout). ~/projects/setpoint-release is a
# symlink to the live release — the client projects link to it — and is moved
# only once the new release reports READY.
#
# If the running setpoint predates handover, the new one waits in standby and
# this script says which pid to stop; it takes over the moment it can.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"                 # the git repository releases come from
HOME_DIR="${SETPOINT_HOME:-$REPO}"                        # config/, data/, logs/ shared by every release
RELEASES="${SETPOINT_RELEASES:-$(dirname "$REPO")/setpoint-releases}"
LIVE_LINK="${SETPOINT_RELEASE_LINK:-$(dirname "$REPO")/setpoint-release}"
PORT="${SM_PORT:-7580}"

commit="${1:-origin/main}"
shift || true
reason="${*:-deploying a new setpoint release}"

git -C "$REPO" fetch -q origin
sha="$(git -C "$REPO" rev-parse --short "$commit")"
dir="$RELEASES/$sha"

if [ ! -d "$dir" ]; then
	mkdir -p "$RELEASES"
	git -C "$REPO" worktree add -q --detach "$dir" "$sha"
fi
(cd "$dir" && bun install --frozen-lockfile >/dev/null)
echo "release $sha prepared in $dir"

# Warn the sessions that watch daemon.log. The cutover itself is seconds.
curl -sf -X POST "localhost:$PORT/lifecycle/restart-notice" \
	-H 'Content-Type: application/json' \
	-d "{\"inSeconds\":300,\"reason\":$(printf '%s' "$reason" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
	>/dev/null || echo "(running setpoint did not take the restart notice — it may predate it)"

# The process serving now, so "READY" can mean a different one is serving.
old_pid="$(curl -s -m 2 "localhost:$PORT/health" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("lifecycle",{}).get("pid",""))
except Exception: print("")' || true)"
[ -z "$old_pid" ] && old_pid="$(pgrep -f '^bun run src/index.ts$' | head -1 || true)"
(cd "$dir" && SETPOINT_HOME="$HOME_DIR" SM_PORT="$PORT" nohup bun run src/index.ts >/dev/null 2>&1 &)
echo "release $sha started; connecting every account in standby (watch: curl -s localhost:$((PORT + 1))/health)"

# Wait for the new release to be the one serving. A fleet connect takes
# minutes; an incumbent that predates handover must be stopped by hand.
told=""
ready=""
for _ in $(seq 1 3600); do
	health="$(curl -s -m 2 "localhost:$PORT/health" || true)"
	serving_pid="$(printf '%s' "$health" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("lifecycle",{}).get("pid",""))
except Exception: print("")')"
	if printf '%s' "$health" | grep -q "\"release\":\"$sha\"" && printf '%s' "$health" | grep -q '"phase":"active"' \
		&& [ -n "$serving_pid" ] && [ "$serving_pid" != "$old_pid" ]; then
		echo "release $sha is READY"
		ready=yes
		break
	fi
	standby="$(curl -s -m 2 "localhost:$((PORT + 1))/health" || true)"
	if [ -z "$told" ] && printf '%s' "$health" | grep -q '"status":"ok"' && ! printf '%s' "$health" | grep -q '"lifecycle"' \
		&& printf '%s' "$standby" | grep -q '"status":"standby"'; then
		echo "the running setpoint (pid ${old_pid:-?}) predates handover; once standby holds every account, stop it: kill -TERM ${old_pid:-<pid>}"
		told=yes
	fi
	sleep 1
done

if [ -z "$ready" ]; then
	echo "release $sha did not take over within an hour; leaving $LIVE_LINK where it is" >&2
	exit 1
fi

previous=""
# One-time migration: the release link started life as a plain worktree.
# Move it in with the others so it can become a symlink.
if [ -d "$LIVE_LINK" ] && [ ! -L "$LIVE_LINK" ]; then
	legacy_sha="$(git -C "$LIVE_LINK" rev-parse --short HEAD)"
	if [ "$legacy_sha" = "$sha" ]; then
		git -C "$REPO" worktree remove --force "$LIVE_LINK"
	else
		mkdir -p "$RELEASES"
		git -C "$REPO" worktree move "$LIVE_LINK" "$RELEASES/$legacy_sha"
		previous="$RELEASES/$legacy_sha"
	fi
fi

# Point the client projects at the live release, then retire the old one.
if [ -L "$LIVE_LINK" ]; then previous="$(readlink -f "$LIVE_LINK")"; fi
ln -sfn "$dir" "$LIVE_LINK.tmp" && mv -T "$LIVE_LINK.tmp" "$LIVE_LINK"
echo "$LIVE_LINK -> $dir"
if [ -n "$previous" ] && [ "$previous" != "$dir" ] && [ -d "$previous" ] && [ "$(dirname "$previous")" = "$RELEASES" ]; then
	git -C "$REPO" worktree remove --force "$previous" && echo "retired $previous"
fi
