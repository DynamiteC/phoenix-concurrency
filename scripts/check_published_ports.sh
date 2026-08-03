#!/usr/bin/env bash
# THE DEPLOYMENT CLAIM, AS A TEST.
#
# The security group opens exactly 80 (https redirect), 443 (the site), and 3080 (LibreChat
# direct). This asserts compose publishes nothing beyond those, so the SG list and the compose
# reality cannot drift apart silently. Loopback bindings are allowed: 127.0.0.1:X is reachable
# from the host for debugging and from nowhere else.
set -euo pipefail
cd "$(dirname "$0")/.."

bad="$(docker compose --profile chat config --format json 2>/dev/null \
  | python3 -c '
import json, sys
ALLOWED = {"80", "443", "3080"}
cfg = json.load(sys.stdin)
out = []
for name, svc in (cfg.get("services") or {}).items():
    for p in (svc.get("ports") or []):
        published, host_ip = str(p.get("published", "")), p.get("host_ip", "")
        if not published:
            continue
        if published in ALLOWED and host_ip in ("", "0.0.0.0"):
            continue                       # intended public ports
        if host_ip in ("127.0.0.1", "::1"):
            continue                       # loopback only, not exposed
        shown = host_ip or "0.0.0.0"
        out.append(name + "\t" + shown + ":" + published)
print("\n".join(out))
')"

if [ -n "$bad" ]; then
  echo "FAIL: ports published beyond 80/443/3080" >&2
  echo "$bad" >&2
  echo "Bind them to 127.0.0.1, or use expose: instead of ports:" >&2
  exit 1
fi
echo "ok: 80, 443, 3080 are the only publicly published ports"
