#!/usr/bin/env bash
# =====================================================================
# AI Workshop — one-command backend setup.
#
#   ./setup.sh            full setup + end-to-end smoke test
#   ./setup.sh --test     only re-run the smoke test
#
# Re-runnable: every step is idempotent.
# Needs: curl, jq, supabase CLI. No Docker needed.
#
# Values can come from the environment instead of prompts:
#   SUPABASE_ACCESS_TOKEN  (supabase.com/dashboard/account/tokens)
#   PROJECT_REF            (or "new" to create a project)
#   ANTHROPIC_API_KEY
#   SITE_URL               (where the site will live, e.g. https://you.github.io/ai-workshop/)
#   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM   (optional, recommended)
# Saved non-secret answers go in .setup.env (git-ignored).
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

API="https://api.supabase.com/v1"
STATE=".setup.env"
[ -f "$STATE" ] && . "./$STATE"

# Secrets can also live in private files (chmod 600) so they never touch chat or git.
SECRETS_DIR="$HOME/.config/ai-workshop"
[ -z "${SUPABASE_ACCESS_TOKEN:-}" ] && [ -s "$SECRETS_DIR/supabase-token" ] && SUPABASE_ACCESS_TOKEN=$(cat "$SECRETS_DIR/supabase-token")
[ -z "${SMTP_PASS:-}" ] && [ -s "$SECRETS_DIR/smtp-pass" ] && SMTP_PASS=$(cat "$SECRETS_DIR/smtp-pass")
[ -z "${ANTHROPIC_API_KEY:-}" ] && [ -s "$SECRETS_DIR/anthropic-key" ] && ANTHROPIC_API_KEY=$(cat "$SECRETS_DIR/anthropic-key")

c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
c_step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die()    { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask()    { local v; read -r -p "$1${2:+ [$2]}: " v; echo "${v:-${2:-}}"; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; echo "$v"; }

for b in curl jq supabase; do command -v "$b" >/dev/null || die "Missing '$b'. Install it first."; done

# --- Management API helper ---------------------------------------------
mgmt() { # mgmt METHOD PATH [JSON]
  local out code
  out=$(curl -sS -w $'\n%{http_code}' -X "$1" "$API$2" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    ${3:+--data "$3"})
  code=${out##*$'\n'}; out=${out%$'\n'*}
  if [ "$code" -ge 400 ]; then echo "$out" >&2; return 1; fi
  echo "$out"
}

save_state() {
  cat > "$STATE" <<EOF
PROJECT_REF="$PROJECT_REF"
SITE_URL="$SITE_URL"
EOF
}

# --- 1. Supabase access -----------------------------------------------
c_step "Supabase access"
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "Create a personal access token at https://supabase.com/dashboard/account/tokens"
  SUPABASE_ACCESS_TOKEN=$(ask_secret "Paste Supabase access token (sbp_...)")
fi
export SUPABASE_ACCESS_TOKEN
PROJECTS=$(mgmt GET /projects) || die "Supabase rejected the access token."
c_ok "Token works ($(echo "$PROJECTS" | jq length) project(s) visible)"

# --- 2. Project --------------------------------------------------------
c_step "Project"
if [ -z "${PROJECT_REF:-}" ]; then
  echo "$PROJECTS" | jq -r '.[] | "  \(.id)  \(.name)  (\(.region), \(.status))"'
  PROJECT_REF=$(ask "Project ref to use, or 'new' to create one" "new")
fi
if [ "$PROJECT_REF" = "new" ]; then
  ORGS=$(mgmt GET /organizations)
  echo "$ORGS" | jq -r '.[] | "  \(.id)  \(.name)"'
  ORG=$(ask "Organization id" "$(echo "$ORGS" | jq -r '.[0].id')")
  REGION=$(ask "Region" "us-west-1")
  DBPASS=$(openssl rand -hex 16)
  NEW=$(mgmt POST /projects "$(jq -n --arg o "$ORG" --arg r "$REGION" --arg p "$DBPASS" \
    '{name:"ai-workshop", organization_id:$o, region:$r, db_pass:$p}')") || die "Could not create project."
  PROJECT_REF=$(echo "$NEW" | jq -r .id)
  mkdir -p "$SECRETS_DIR" && (umask 077; printf %s "$DBPASS" > "$SECRETS_DIR/db-password-$PROJECT_REF")
  echo "  Database password saved to $SECRETS_DIR/db-password-$PROJECT_REF"
fi
printf "  Waiting for %s to be healthy" "$PROJECT_REF"
for i in $(seq 1 90); do
  ST=$(mgmt GET "/projects/$PROJECT_REF" | jq -r .status) || die "Project $PROJECT_REF not found."
  [ "$ST" = "ACTIVE_HEALTHY" ] && break
  printf "."; sleep 5
done; echo
[ "$ST" = "ACTIVE_HEALTHY" ] || die "Project status is $ST. Try again in a minute."
SB_URL="https://$PROJECT_REF.supabase.co"
c_ok "Project $PROJECT_REF ($SB_URL)"

KEYS=$(mgmt GET "/projects/$PROJECT_REF/api-keys?reveal=true")
# Prefer the legacy anon/service_role keys; fall back to the new publishable/secret keys.
ANON=$(echo "$KEYS" | jq -r '([.[] | select(.name=="anon")] + [.[] | select(.type=="publishable")])[0].api_key')
SERVICE=$(echo "$KEYS" | jq -r '([.[] | select(.name=="service_role")] + [.[] | select(.type=="secret")])[0].api_key')
[ -n "$ANON" ] && [ "$ANON" != null ] || die "Could not read the anon key."

if [ "${1:-}" != "--test" ]; then
  # --- 3. Database -----------------------------------------------------
  c_step "Database (tables, security rules, USF-only signup, storage bucket)"
  for f in supabase/migrations/*.sql; do
    mgmt POST "/projects/$PROJECT_REF/database/query" \
      "$(jq -n --rawfile q "$f" '{query:$q}')" >/dev/null || die "Migration $f failed."
    c_ok "Applied $(basename "$f")"
  done

  # --- 4. Auth ---------------------------------------------------------
  c_step "Auth (email code sign-in)"
  [ -n "${SITE_URL:-}" ] || SITE_URL=$(ask "Public URL of the site (ending in /ai-workshop/)" "https://danil-theuser.github.io/ai-workshop/")
  TEMPLATE=$(cat supabase/templates/code.html)
  AUTH=$(jq -n --arg site "$SITE_URL" --arg t "$TEMPLATE" '{
    site_url: $site,
    uri_allow_list: ($site + "**,http://localhost:8000/**,http://127.0.0.1:8000/**"),
    external_email_enabled: true,
    disable_signup: false,
    mailer_otp_length: 6,
    mailer_otp_exp: 3600,
    mailer_subjects_magic_link: "Your AI Workshop sign-in code",
    mailer_subjects_confirmation: "Your AI Workshop sign-in code",
    mailer_templates_magic_link_content: $t,
    mailer_templates_confirmation_content: $t
  }')
  if [ -z "${SMTP_HOST:-}" ]; then
    echo "  Custom SMTP: Supabase's built-in sender only allows a few emails per hour,"
    echo "  which is NOT enough for a room. Gmail works: host smtp.gmail.com, port 465,"
    echo "  user = your gmail, pass = an app password (myaccount.google.com/apppasswords)."
    SMTP_HOST=$(ask "SMTP host (leave blank to skip for now)" "")
  fi
  if [ -n "$SMTP_HOST" ]; then
    SMTP_PORT=${SMTP_PORT:-$(ask "SMTP port" "465")}
    SMTP_USER=${SMTP_USER:-$(ask "SMTP username")}
    SMTP_PASS=${SMTP_PASS:-$(ask_secret "SMTP password / app password")}
    SMTP_FROM=${SMTP_FROM:-$(ask "From address" "$SMTP_USER")}
    AUTH=$(echo "$AUTH" | jq --arg h "$SMTP_HOST" --arg p "$SMTP_PORT" --arg u "$SMTP_USER" \
      --arg pw "$SMTP_PASS" --arg f "$SMTP_FROM" \
      '. + {smtp_host:$h, smtp_port:$p, smtp_user:$u, smtp_pass:$pw, smtp_admin_email:$f,
            smtp_sender_name:"AI Workshop", smtp_max_frequency:1, rate_limit_email_sent:300}')
  fi
  mgmt PATCH "/projects/$PROJECT_REF/config/auth" "$AUTH" >/dev/null || die "Auth config failed."
  c_ok "Email code template, site URL${SMTP_HOST:+, custom SMTP + 300 emails/hour}"
  [ -n "$SMTP_HOST" ] || echo "  ⚠ No custom SMTP yet: fine for testing, set it up before the event (re-run this script)."
  save_state

  # --- 5. Anthropic key -----------------------------------------------
  c_step "Anthropic API key (stored only as a Supabase secret)"
  HAS_KEY=$(mgmt GET "/projects/$PROJECT_REF/secrets" | jq '[.[] | select(.name=="ANTHROPIC_API_KEY")] | length')
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ "$HAS_KEY" = "1" ]; then
    [ "$(ask "A key is already stored. Replace it? (y/N)" "n")" = "y" ] && ANTHROPIC_API_KEY=$(ask_secret "Paste Anthropic API key (sk-ant-...)")
  elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "Create one at https://console.anthropic.com/settings/keys (and set a spend limit)."
    ANTHROPIC_API_KEY=$(ask_secret "Paste Anthropic API key (sk-ant-...)")
  fi
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models \
      -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01")
    [ "$code" = 200 ] || die "Anthropic rejected that key (HTTP $code)."
    mgmt POST "/projects/$PROJECT_REF/secrets" \
      "$(jq -n --arg v "$ANTHROPIC_API_KEY" '[{name:"ANTHROPIC_API_KEY", value:$v}]')" >/dev/null
    c_ok "Key verified and stored"
  else
    c_ok "Keeping the stored key"
  fi

  # --- 6. Edge function -----------------------------------------------
  c_step "Deploy the 'generate' function"
  supabase functions deploy generate --project-ref "$PROJECT_REF" --no-verify-jwt --use-api
  c_ok "Deployed"

  # --- 7. Site config -------------------------------------------------
  c_step "Site config"
  CFG=site/ai-workshop/config.js
  sed -i '' -E \
    -e "s|^export const SUPABASE_URL = .*|export const SUPABASE_URL = \"$SB_URL\";|" \
    -e "s|^export const SUPABASE_ANON_KEY = .*|export const SUPABASE_ANON_KEY = \"$ANON\";|" "$CFG"
  c_ok "Wrote $CFG"
fi

# --- 8. Smoke test ------------------------------------------------------
c_step "End-to-end smoke test"
AUTHH=(-H "apikey: $SERVICE" -H "Content-Type: application/json")
case "$SERVICE" in sb_*) ;; *) AUTHH+=(-H "Authorization: Bearer $SERVICE") ;; esac
STAMP=$(date +%s)
PW="T$(openssl rand -hex 12)a1!"

# 8a. non-USF email must be rejected by the database
code=$(curl -s -o /dev/null -w '%{http_code}' "$SB_URL/auth/v1/admin/users" "${AUTHH[@]}" \
  --data "$(jq -n --arg e "smoke$STAMP@gmail.com" --arg p "$PW" '{email:$e,password:$p,email_confirm:true}')")
[ "$code" -ge 400 ] || die "A gmail.com account was allowed! The USF-only trigger is not working."
c_ok "gmail.com signup rejected (HTTP $code)"

# 8b. a USF account works end to end
EMAIL="ai-workshop-smoke-$STAMP@usfca.edu"
UID_=$(curl -sS "$SB_URL/auth/v1/admin/users" "${AUTHH[@]}" \
  --data "$(jq -n --arg e "$EMAIL" --arg p "$PW" '{email:$e,password:$p,email_confirm:true}')" | jq -r .id)
[ -n "$UID_" ] && [ "$UID_" != null ] || die "Could not create a usfca.edu test user."
cleanup() { curl -s -o /dev/null -X DELETE "$SB_URL/auth/v1/admin/users/$UID_" "${AUTHH[@]}"; }
trap cleanup EXIT
c_ok "usfca.edu test user created"

JWT=$(curl -sS "$SB_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  --data "$(jq -n --arg e "$EMAIL" --arg p "$PW" '{email:$e,password:$p}')" | jq -r .access_token)
[ -n "$JWT" ] && [ "$JWT" != null ] || die "Test user could not sign in."
USERH=(-H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H "Content-Type: application/json")

code=$(curl -s -o /dev/null -w '%{http_code}' "$SB_URL/rest/v1/profiles" "${USERH[@]}" \
  --data "$(jq -n --arg i "$UID_" --arg u "smoke-$STAMP" '{id:$i, username:$u}')")
[ "$code" = 201 ] || die "Profile insert failed (HTTP $code)."
c_ok "Signed in and picked a username"

SETTINGS=$(curl -sS "$SB_URL/rest/v1/settings?select=*" -H "apikey: $ANON")
echo "$SETTINGS" | jq -e '.[0].model' >/dev/null || die "Settings row not readable: $SETTINGS"
c_ok "Settings readable: $(echo "$SETTINGS" | jq -c '.[0]')"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SB_URL/storage/v1/object/references/$UID_/smoke.txt" \
  -H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H "Content-Type: text/plain" --data "Brand color: #1d6b4f")
[ "$code" = 200 ] || die "File upload failed (HTTP $code)."
c_ok "Reference file uploaded"

code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$SB_URL/functions/v1/generate" \
  -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST")
[ "$code" = 200 ] || die "CORS preflight failed (HTTP $code). Was the function deployed with --no-verify-jwt?"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SB_URL/functions/v1/generate" -H "apikey: $ANON" \
  -H "Content-Type: application/json" --data '{}')
[ "$code" = 401 ] || die "Function should reject anonymous calls with 401, got $code."
c_ok "Function reachable, CORS ok, rejects anonymous calls"

echo "  Generating a tiny practice product with Claude (takes ~10-60s)..."
OUT=$(curl -sS -N --max-time 170 -X POST "$SB_URL/functions/v1/generate" "${USERH[@]}" \
  --data "$(jq -n --arg u "$UID_" '{kind:"test", prompt:"Smoke test: a tiny page with one big button that counts clicks, using the brand color from my reference file. Keep it under 60 lines.", attachments:[($u + "/smoke.txt")]}')" || true)
echo "$OUT" | grep -q '"type":"done"' || die "Generation did not finish. Response: $(echo "$OUT" | grep -v '"type":"delta"' | head -c 600)"
RUN=$(curl -sS "$SB_URL/rest/v1/runs?select=status,error,input_tokens,output_tokens,output_html&user_id=eq.$UID_" "${USERH[@]}")
echo "$RUN" | jq -e '.[0].status=="done" and (.[0].output_html|test("</html>";"i"))' >/dev/null \
  || die "Run was not saved correctly: $(echo "$RUN" | jq -c '.[0] | del(.output_html)')"
c_ok "Claude generated a product and it was saved ($(echo "$RUN" | jq -r '.[0] | "\(.input_tokens) in / \(.output_tokens) out tokens"'))"

c_step "All good 🎉"
echo "  Test user cleaned up. Next: publish site/ai-workshop/ (see README step 5)."
echo "  Try it locally: (cd site/ai-workshop && python3 -m http.server 8000) → http://localhost:8000"
