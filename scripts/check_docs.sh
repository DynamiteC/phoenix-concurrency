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

# House style, enforced rather than remembered: no emoji, no em-dashes, no section sign.
# Scoped to files this team authors. docs/problem/ is supplied by the organisers, TASK.md and
# the validation checklist are handed to us, and rewriting someone else's document to satisfy
# our own style rule would be worse than the violation.
style=0
#
# frontend/ is in scope as of this session and was not before. It arrived by merge carrying 28
# em-dashes, which is not the author's fault: nothing told them, because this scan did not look
# there. It looks there now, so the next person finds out from a failing check rather than from
# a reviewer.
authored="$(git ls-files 'docs/*.md' 'scripts/*.sh' 'sql/**/*.sql' 'README.md' \
                         'frontend/src/**' 'frontend/*.md' 2>/dev/null \
             | grep -v '^docs/problem/' || true)"
for f in $authored; do
  [ -f "$f" ] || continue
  if LC_ALL=C grep -nP '\xc2\xa7|\xe2\x80\x94|[\x{1F300}-\x{1FAFF}]|[\x{2600}-\x{27BF}]' "$f" 2>/dev/null; then
    echo "FAIL: $f contains an emoji, em-dash, or section sign (spell out 'section')" >&2
    style=1
  fi
done
[ "$style" -eq 0 ] && echo "ok: no emoji, em-dashes, or section signs in authored files" || fail=1

# An artifact whose file has been deleted or renamed leaves the ledger pointing at nothing.
dangling=0
while IFS=$'\t' read -r _ _ _ path _; do
  case "$path" in artifact_path|'') continue;; esac
  [ -f "$path" ] || { echo "FAIL: ledger points at a missing artifact: $path" >&2; dangling=$((dangling + 1)); }
done < evidence/LEDGER.tsv
[ "$dangling" -eq 0 ] && echo "ok: every ledger row points at a file that exists" || fail=1

# Every ledger row has the same number of fields as the header.
#
# Added because the ledger went ragged and nothing noticed. A column was inserted into the data
# before the writer in scripts/lib/evidence.sh knew about it, so 14 rows came out one field short
# and their verified_at_sha sat in the fail_kind column. The check above passed throughout, because
# it reads artifact_path at column 4 and everything to the LEFT of the inserted column was fine.
# A check that only looks at the first four fields cannot see damage in the last four.
cols="$(head -1 evidence/LEDGER.tsv | awk -F'\t' '{print NF}')"
ragged="$(awk -F'\t' -v n="$cols" 'NF != n {print NR": "NF" fields ("$1")"}' evidence/LEDGER.tsv)"
if [ -n "$ragged" ]; then
  echo "FAIL: ledger rows do not match the $cols-column header:" >&2
  printf '  %s\n' "$ragged" >&2
  fail=1
else
  echo "ok: every ledger row has $cols fields"
fi

# One source of truth for shipped query text. Separate script because it asserts a different
# kind of property, but run from here so there is a single command to remember.
./scripts/check_query_sources.sh || fail=1

# Does the server still match sql/schema/? This is the only check here that needs the network,
# and it earns the ten seconds: phoenix was found carrying an index that no file in the repo
# created, and rebuild_swap.sh builds its shadow from these files and then EXCHANGEs it into
# production, so the next rebuild would have deleted that index with every existing gate still
# green. Drift is invisible precisely until it destroys something.
#
# SKIP_DRIFT=1 for an offline run. phoenix carries a deliberate generation gap and passes with
# an allowlist; phoenix_next is what sql/schema/ actually describes and must be clean.
if [ "${SKIP_DRIFT:-0}" = "1" ]; then
  echo "skipped: schema drift (SKIP_DRIFT=1)"
else
  DRIFT_QUIET=1 DRIFT_ALLOW='arrival_timestamp,mv_body raw_events_mv' \
    ./scripts/schema_drift.sh phoenix      2>&1 | grep -v 'Unknown settings' || fail=1
  DRIFT_QUIET=1 INSIGHTS=1 \
    ./scripts/schema_drift.sh phoenix_next 2>&1 | grep -v 'Unknown settings' || fail=1
fi

exit "$fail"
