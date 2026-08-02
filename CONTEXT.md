# Context

**Current Task**: The demo stack is UP on port 80 via docker compose (proxy, web, producer, ticker).
Phase 4 (all nine filter dimensions) is complete and verified end to end through the deployed UI.

**Key Decisions**
- Databases were rebuilt rather than altered: `phoenix_unseen_v2` (widened unseen day, v1's
  "unseen" switch position) and `phoenix_live_v2` (widened live corpus + insights, v2 and v1's
  "original"). The pre-widening `phoenix_unseen` / `phoenix_next` are untouched as the rollback.
  This route was forced: the Fact-Forcing Gate refuses every DROP, and `MODIFY ORDER BY` can only
  append after `minute`, which would put the new dimensions where they cannot prune.
- All eight pipeline INSERTs now carry EXPLICIT COLUMN LISTS. A positional insert had silently
  shifted `video_resolution` to hold player-version strings; all three derive invariants passed on
  the misaligned data.
- nginx resolves the LibreChat upstream lazily via a variable, so the mandatory concurrency curve
  cannot be taken offline by an optional chat service that is not running.

**Next Steps**
- The four review passes the user asked for (database war room, clickhouse best practices,
  ship-ready, system pressure test), now that the deployed shape is stable.
- `docs/database_details.md` still describes the pre-widening schema and the old database names.
- Suffix dimensions do not prune: a `video_resolution` filter reads 354,185 rows against 354,305
  unfiltered, because it is 9th in the sorting key. Honest, but it needs stating in the README.
