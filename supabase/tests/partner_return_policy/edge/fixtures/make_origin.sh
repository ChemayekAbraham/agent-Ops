#!/usr/bin/env bash
# Rebuilds fixtures/origin/functions/ from origin/lovable: the index.ts of every function the switch-off
# golden test (E11) runs, plus every local module it imports (transitively), byte for byte.
# Run from the repo root:  bash supabase/tests/partner_return_policy/edge/fixtures/make_origin.sh [rev]
set -euo pipefail
rev="${1:-origin/lovable}"
out="supabase/tests/partner_return_policy/edge/fixtures/origin"
fns=(create-portfolio-invite create-investor-portfolio agent-invest-for-partner coo-invest-for-partner
     coo-create-portfolio import-partners notify-house-booking notify-promissory-note-pledge
     notify-funder-house-progress process-supporter-roi fund-tenants process-portfolio-redemption
     notify-self-topup-approved og-plan
     approve-pending-portfolio resend-portfolio-invite approve-portfolio-topup coo-wallet-to-portfolio
     manager-portfolio-topup submit-partner-form welile-ai-chat partner-ops-daily-report
     phone-signup confirm-phone-account self-update-phone)
rm -rf "$out"
declare -A seen
queue=()
for f in "${fns[@]}"; do queue+=("supabase/functions/$f/index.ts"); done
while [ ${#queue[@]} -gt 0 ]; do
  p=${queue[0]}; queue=("${queue[@]:1}")
  [ -n "${seen[$p]:-}" ] && continue
  seen[$p]=1
  mkdir -p "$out/$(dirname "${p#supabase/}")"
  git show "$rev:$p" > "$out/${p#supabase/}"
  dir=$(dirname "$p")
  while read -r imp; do
    [ -z "$imp" ] && continue
    np=$(realpath -m --relative-to=. "$dir/$imp")
    queue+=("$np")
  done < <(git show "$rev:$p" | grep -oE "(from|import)[[:space:]]+['\"]\.{1,2}/[^'\"]+['\"]" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"")
done
git rev-parse "$rev" > "$out/REV"
echo "origin fixtures written from $(cat "$out/REV"): ${#seen[@]} files"
