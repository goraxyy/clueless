#!/usr/bin/env bash
# Takes Clueless live from the keys in .env (each key's comment says where it comes from).
# Safe to run again: every step checks or updates rather than duplicating.
#
#   scripts/go-live.sh            everything the .env has keys for
#   scripts/go-live.sh supabase   sign-in, database, server functions, invite code
#   scripts/go-live.sh website    the website on Vercel
#
# It never prints a key.
set -euo pipefail
cd "$(dirname "$0")/.."

VERCEL_CLI=vercel@65.2.0
API=https://api.supabase.com/v1

# Read .env without letting the shell expand anything inside the values.
[ -f .env ] || { echo "No .env here. See the template in the repo root."; exit 1; }
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '#'* | '') continue ;; esac
  key=${line%%=*}
  value=${line#*=}
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && export "$key=$value"
done < .env

missing() { local out=(); for v; do [ -n "${!v:-}" ] || out+=("$v"); done; echo "${out[*]:-}"; }
step() { printf '\n== %s\n' "$1"; }
skip() { printf '   skipped: %s\n' "$1"; }

supabase_api() { # method path [json body]
  curl -fsS -X "$1" "$API$2" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' ${3:+--data "$3"}
}

sql() { # run SQL on the project as its owner
  supabase_api POST "/projects/$SUPABASE_PROJECT_REF/database/query" "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")" >/dev/null
}

go_supabase() {
  step "Supabase"
  local need; need=$(missing SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF SUPABASE_DB_PASSWORD ANTHROPIC_API_KEY)
  if [ -n "$need" ]; then skip "fill in $need"; return; fi
  export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  local ref=$SUPABASE_PROJECT_REF

  echo "-- linking the project and creating the tables"
  supabase link --project-ref "$ref" --yes >/dev/null
  supabase db push --linked --yes

  echo "-- server secrets (Claude, and voice if set)"
  local secrets; secrets=$(mktemp); chmod 600 "$secrets"
  trap 'rm -f "$secrets"' RETURN
  for v in ANTHROPIC_API_KEY DEEPGRAM_API_KEY ELEVENLABS_API_KEY; do
    [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}" >> "$secrets"
  done
  supabase secrets set --env-file "$secrets" --project-ref "$ref" >/dev/null
  echo "   set: $(cut -d= -f1 "$secrets" | tr '\n' ' ')"

  echo "-- server functions"
  for dir in supabase/functions/*/; do
    name=$(basename "$dir")
    [ "$name" = _shared ] && continue
    supabase functions deploy "$name" --project-ref "$ref" --use-api >/dev/null && echo "   deployed: $name"
  done

  echo "-- sign-in settings"
  if [ -z "$(missing GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET)" ]; then
    SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=$GOOGLE_CLIENT_SECRET \
      supabase config push --project-ref "$ref" --yes >/dev/null
    echo "   Google sign-in and the app's return addresses are set"
  else
    skip "Google sign-in (fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)"
  fi
  if [ -z "$(missing RESEND_API_KEY EMAIL_FROM)" ]; then
    supabase_api PATCH "/projects/$ref/config/auth" "$(python3 -c '
import json, os
print(json.dumps({
  "smtp_host": "smtp.resend.com", "smtp_port": "465", "smtp_user": "resend",
  "smtp_pass": os.environ["RESEND_API_KEY"], "smtp_admin_email": os.environ["EMAIL_FROM"],
  "smtp_sender_name": "Clueless", "rate_limit_email_sent": 100}))')" >/dev/null
    echo "   email sign-in links go out through Resend"
  else
    skip "email sign-in for students (fill in RESEND_API_KEY and EMAIL_FROM)"
  fi

  echo "-- invite code"
  if [ -n "${INVITE_CODE:-}" ]; then
    [[ "$INVITE_CODE" =~ ^[A-Za-z0-9-]+$ ]] || { echo "   INVITE_CODE may only have letters, digits and dashes"; exit 1; }
    local uses=${INVITE_USES:-60}
    [[ "$uses" =~ ^[0-9]+$ ]] || uses=60
    sql "insert into public.invite_codes (code, note, max_uses) values (upper('$INVITE_CODE'), 'first beta code', $uses)
         on conflict (code) do update set max_uses = excluded.max_uses"
    echo "   $(echo "$INVITE_CODE" | tr '[:lower:]' '[:upper:]') works for $uses students"
  else
    skip "invite code (fill in INVITE_CODE)"
  fi

  echo "-- pointing the app at the project"
  local key
  key=$(supabase_api GET "/projects/$ref/api-keys" | python3 -c '
import json, sys
keys = json.load(sys.stdin)
print(next((k["api_key"] for k in keys if k.get("type") == "publishable"), next((k["api_key"] for k in keys if k.get("name") == "anon"), "")))')
  [ -n "$key" ] || { echo "   couldn't read the project's publishable key"; exit 1; }
  python3 - "$ref" "$key" <<'PY'
import re, sys
ref, key = sys.argv[1], sys.argv[2]
path = 'app/src/main/account/project.ts'
src = open(path).read()
src = re.sub(r"export const PROJECT = \{[^}]*\}", f"export const PROJECT = {{ url: 'https://{ref}.supabase.co', publishableKey: '{key}' }}", src)
open(path, 'w').write(src)
PY
  echo "   app/src/main/account/project.ts now names https://$ref.supabase.co (the publishable key is safe to ship)"
}

go_website() {
  step "Website"
  local need; need=$(missing VERCEL_TOKEN CONTACT_EMAIL)
  if [ -n "$need" ]; then skip "fill in $need"; return; fi
  local out; out=$(mktemp -d)
  trap 'rm -rf "$out"' RETURN
  mkdir "$out/clueless" # the folder's name becomes the Vercel project's name
  cp website/*.html website/*.css website/*.js website/*.png website/vercel.json "$out/clueless/"
  python3 - "$out/clueless" <<'PY'
import os, sys, glob
for page in glob.glob(os.path.join(sys.argv[1], '*.html')):
    text = open(page).read().replace('CONTACT_EMAIL', os.environ['CONTACT_EMAIL'])
    open(page, 'w').write(text)
PY
  local url
  url=$(npx --yes "$VERCEL_CLI" deploy --prod --yes --token "$VERCEL_TOKEN" --cwd "$out/clueless" 2>/dev/null | tail -1)
  echo "   live at $url"
}

case "${1:-all}" in
  supabase) go_supabase ;;
  website) go_website ;;
  all) go_supabase; go_website ;;
  *) echo "usage: scripts/go-live.sh [supabase|website|all]"; exit 1 ;;
esac
