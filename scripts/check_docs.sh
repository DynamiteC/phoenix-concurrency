#!/usr/bin/env bash
# Enforce the tag discipline in docs/. Exits non-zero if it is broken.
#
#   ./scripts/check_docs.sh
#
# Two rules, both from TASK.md and both cheap enough to run before every commit:
#
#   1. No unverified-tag marker anywhere in docs/. It means "I did not check this", and a
#      claim nobody checked is exactly what cost this project a day. Resolve it, downgrade
#      it to an assumption, or delete the sentence. Deleting is free.
#
#   2. Every [V:<id>] resolves to a row in evidence/LEDGER.tsv. The promise the tag makes is
#      that a reader can get from any sentence to the command that produced it in one hop.
#      A dangling id breaks that promise silently, which is worse than not making it.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# Built from parts so this script does not match itself when it greps the tree.
unverified="[$(printf 'U')]"

if grep -rn --include='*.md' -F "$unverified" docs/ 2>/dev/null; then
  echo "FAIL: unverified-tag markers above. Resolve, downgrade to [A], or delete." >&2
  fail=1
else
  echo "ok: no unverified tags in docs/"
fi

missing=0
for id in $(grep -rho --include='*.md' '\[V:[A-Za-z0-9_]*\]' docs/ | sed 's/\[V:\(.*\)\]/\1/' | sort -u); do
  if ! cut -f1 evidence/LEDGER.tsv 2>/dev/null | grep -qx "$id"; then
    echo "FAIL: [V:$id] has no row in evidence/LEDGER.tsv" >&2
    missing=$((missing + 1))
  fi
done
if [ "$missing" -eq 0 ]; then
  echo "ok: every [V:id] resolves to a ledger row"
else
  fail=1
fi

# An artifact whose file has been deleted or renamed leaves the ledger pointing at nothing.
dangling=0
while IFS=$'\t' read -r _ _ _ path _; do
  case "$path" in artifact_path|'') continue;; esac
  [ -f "$path" ] || { echo "FAIL: ledger points at a missing artifact: $path" >&2; dangling=$((dangling + 1)); }
done < evidence/LEDGER.tsv
[ "$dangling" -eq 0 ] && echo "ok: every ledger row points at a file that exists" || fail=1

exit "$fail"
