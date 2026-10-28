#!/usr/bin/env bash
# push_w1_2026-10-28.sh — Handoff Vol IV §5.1 PAT runbook, executed end-to-end.
#   1. identity gate: /user must return sethoshi18 / 55265644
#   2. push via GIT_ASKPASS (env-only GH_TOKEN; never printed/stored/embedded)
#   3. three-way head gate: ls-remote == local == API
#   4. API commit-author check (owner identity)
#   5. CI listing on the pushed SHAs
# Usage: GH_TOKEN=<token> bash push_w1_2026-10-28.sh
set -euo pipefail
export GIT_ASKPASS=/home/z/my-project/scripts/git-askpass.sh
API=https://api.github.com
ORG=GraveYield
declare -A REPO_SHA=(
  [graveyield-protocol]="$(git -C /home/z/my-project/graveyield-protocol rev-parse HEAD)"
  [salvor-bots]="$(git -C /home/z/my-project/salvor-bots rev-parse HEAD)"
)

api() { curl -sS -H @- "$@" << EOF
Authorization: Bearer ${GH_TOKEN}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
EOF
}

echo "== 1. identity gate =="
USER_JSON=$(api "$API/user")
LOGIN=$(printf "%s" "$USER_JSON" | grep -o '"login": *"[^"]*"' | head -1 | sed 's/.*"login": *"\([^"]*\)"/\1/')
UID=$(printf "%s" "$USER_JSON" | grep -o '"id": *[0-9]*' | head -1 | sed 's/.*: //')
echo "authenticated as $LOGIN ($UID)"
[[ "$LOGIN" == "sethoshi18" && "$UID" == "55265644" ]] || { echo "IDENTITY GATE FAILED"; exit 1; }

for REPO in graveyield-protocol salvor-bots; do
  SHA="${REPO_SHA[$REPO]}"
  echo
  echo "== 2. push $REPO @ ${SHA:0:7} =="
  git -C "/home/z/my-project/$REPO" -c credential.helper= push "https://github.com/$ORG/$REPO" main:main 2>&1 | grep -vE "^$"
  echo
  echo "== 3. three-way head gate ($REPO) =="
  LSREMOTE=$(git ls-remote "https://github.com/$ORG/$REPO" refs/heads/main | awk '{print $1}')
  LOCAL=$(git -C "/home/z/my-project/$REPO" rev-parse HEAD)
  APIHEAD=$(api "$API/repos/$ORG/$REPO/commits/main" | grep -o '"sha": *"[0-9a-f]\{40\}"' | head -1 | sed 's/.*"\([0-9a-f]\{40\}\)"/\1/')
  echo "ls-remote=$LSREMOTE"
  echo "local    =$LOCAL"
  echo "api      =$APIHEAD"
  [[ "$LSREMOTE" == "$LOCAL" && "$LOCAL" == "$APIHEAD" ]] || { echo "THREE-WAY GATE FAILED for $REPO"; exit 1; }
  echo
  echo "== 4. author check ($REPO) =="
  api "$API/repos/$ORG/$REPO/commits/$SHA" | grep -E '"name": "sethoshi.eth"|"email": "55265644\+sethoshi18@users.noreply.github.com"' | head -2
  echo
  echo "== 5. CI on $REPO @ ${SHA:0:7} =="
  api "$API/repos/$ORG/$REPO/actions/runs?head_sha=$SHA&per_page=6" | grep -oE '"name": "[^"]+"|"status": "[^"]+"|"conclusion": "[^"]+"' | head -18
done
echo
echo "PUSH RUNBOOK COMPLETE"
