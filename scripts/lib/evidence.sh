#!/usr/bin/env bash
# Evidence writer. Every script that produces a number calls this, so the number lands in a
# committed file stamped with when it ran and which code produced it.
#
#   . scripts/lib/evidence.sh
#   some_command | evidence parity_batch "oracle vs serving, batch path"
#
# Reads stdin, writes evidence/<name>__<UTC-ts>__<sha>.tsv, echoes the path on stdout and
# stderr (stderr so a caller that captures the path still shows it in the console).
#
# The sha carries a -dirty suffix when the tree has uncommitted changes: an artifact that
# claims a clean sha but came from unstaged code is exactly the failure this repo is fixing.
evidence() {
  local name="$1" desc="${2:-}"
  local ts sha out
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  # --porcelain, not `diff --quiet`: an untracked script is uncommitted code too
  [ -z "$(git status --porcelain 2>/dev/null)" ] || sha="${sha}-dirty"
  out="evidence/${name}__${ts}__${sha}.tsv"
  mkdir -p evidence
  {
    echo "# evidence: ${name}"
    [ -n "$desc" ] && echo "# what: ${desc}"
    echo "# run_utc: $(date -u +'%Y-%m-%d %H:%M:%S')"
    echo "# git: ${sha}"
    echo "# host: $(uname -n)"
    cat
  } > "$out"
  echo "wrote $out" >&2
  echo "$out"
}
