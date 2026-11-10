#!/usr/bin/env sh
# Post-deployment check, run on the server:  sh deploy/verify.sh qinfang.example.com
set -u
D="${1:?usage: verify.sh <domain>}"
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0
echo "CAM线上琴房 deployment check for $D"
curl -fsS "https://$D/api/health" >/dev/null && ok "HTTPS + app health" || no "https://$D/api/health"
curl -fsS -o /dev/null "http://$D/" -w '%{redirect_url}' | grep -q '^https://' && ok "HTTP → HTTPS redirect" || no "HTTP redirect"
ID=$(curl -fsS -XPOST "https://$D/api/rooms" -H 'Content-Type: application/json' -d '{"name":"verify"}' | sed -n 's/.*"id":"\([A-Z0-9]*\)".*/\1/p')
[ -n "$ID" ] && ok "create room ($ID)" || no "create room"
J=$(curl -fsS -XPOST "https://$D/api/rooms/$ID/join" -H 'Content-Type: application/json' -d '{"name":"verify"}')
P=$(echo "$J" | sed -n 's/.*"peerId":"\([a-f0-9]*\)".*/\1/p'); T=$(echo "$J" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -sN --max-time 4 "https://$D/api/rooms/$ID/events?peer=$P&token=$T" | grep -q 'event: hello' && ok "signalling stream through proxy (SSE not buffered)" || no "SSE stream (check proxy buffering)"
curl -fsS "https://$D/api/config" | grep -q '"username"' && ok "TURN credentials issued" || no "TURN not configured (TURN_SECRET / TURN_URLS)"
if command -v docker >/dev/null; then
  docker compose exec -T coturn turnutils_uclient -y -e 127.0.0.1 -W "$(grep ^TURN_SECRET .env | cut -d= -f2)" -n 5 127.0.0.1 >/dev/null 2>&1 && ok "TURN relay allocates" || no "TURN relay (ports 3478/5349 + UDP 49160-49400 open?)"
fi
echo "Captions configured:"; curl -fsS "https://$D/api/config" | sed -n 's/.*"captions":\(.*\)}$/  \1/p'
echo "Provider reachability from this server:"; curl -fsS "https://$D/api/diag/providers" | tr ',' '\n' | sed 's/^/  /'
echo; echo "Next: open https://$D/diag on a computer in China AND in Russia and send the report."
exit $FAILED
