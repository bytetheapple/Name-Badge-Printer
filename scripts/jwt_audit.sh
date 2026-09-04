#!/usr/bin/env bash
# Which Edge Functions require a JWT, as deployed.
#
# Not readable from SQL — it is deployment metadata, not data. So ask each
# function directly, with no Authorization header at all:
#
#   401 UNAUTHORIZED_NO_AUTH_HEADER  -> the platform refused it; JWT required
#   anything else                    -> the function itself answered; JWT off
#
# Every request sends an empty body, so functions that do run fail their own
# validation and change nothing.
set -u
BASE="https://xesgdkwwhszdtcgcdjjw.supabase.co/functions/v1"

FUNCS="bridge-complete bridge-poll bridge-release google-oauth-begin
google-oauth-callback google-oauth-check google-sheet-sync google-sync
invite-member invite-operator job-status pi-claim print-badge public-config
shulcloud-scan shulcloud-sync submit-badge upload-selfie"

printf '%-24s %-6s %s\n' "FUNCTION" "HTTP" "VERDICT"
printf '%-24s %-6s %s\n' "------------------------" "----" "-------------------------"
for f in $FUNCS; do
  body=$(curl -sS -X POST "$BASE/$f" \
           -H "Content-Type: application/json" -d '{}' \
           --max-time 20 -w $'\n%{http_code}' 2>/dev/null)
  code=$(printf '%s' "$body" | tail -1)
  text=$(printf '%s' "$body" | sed '$d' | tr -d '\n' | cut -c1-70)
  case "$text" in
    *UNAUTHORIZED_NO_AUTH_HEADER*|*"Missing authorization header"*)
      verdict="JWT REQUIRED" ;;
    *) verdict="jwt off — function answered" ;;
  esac
  printf '%-24s %-6s %s\n' "$f" "$code" "$verdict"
done
