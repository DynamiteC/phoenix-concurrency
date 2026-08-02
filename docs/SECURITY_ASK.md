# The Ask AI boundary

Both consoles carry an Ask AI mode that forwards a browser-supplied thread to a LibreChat agent
holding a live `clickhouse` MCP tool. That makes it the one place in this repo where untrusted text
reaches something able to read the graded corpus, so what follows is the boundary, what it does not
claim, and the gate that keeps it honest.

`./scripts/check_ask_guardrails.sh` asserts every property below. The static half needs nothing
running; the live half needs `npm run dev` and is skipped, loudly, when it is absent.

## One database per console, chosen in code

| Console | Route | May read |
|---|---|---|
| v1, `/` | `POST /api/ask` | `phoenix` |
| v2, `/v2` | `POST /api/v2/ask` | `phoenix_next` |

The scope is a constant in `frontend/src/lib/ask.ts` (`V1_SCOPE`, `V2_SCOPE`) selected by the route
file. It is never a request field. A client able to name its own database would hand that choice to
anything that got a message into the thread, and the two consoles read different generations for a
reason. The gate greps for a database name arriving out of `body`/`req`, and for either route
referencing the other's scope.

## The system turn is ours

The client may send `user` and `assistant` turns and nothing else. Any other role, including
`system` and `tool`, is dropped during validation rather than rejected, so a thread that somehow
accumulated one still works, and `askAgent` prepends the real system message itself.

A forwarded `system` turn is the simplest prompt injection there is. The first version of the route
forwarded whatever roles it was handed.

## What the system prompt says, and where it comes from

The dataset facts are transcribed from [`docs/problem/dataset_details.md`](problem/dataset_details.md),
not summarised from memory. It states which columns live on the event and which live on `content`,
that a title or category question is therefore a join, and that `video_session_id` and `user_id` are
different questions. An agent that does not know this invents a join and then explains a wrong
number confidently, which is worse than refusing.

It also carries the foreground-only definition, the 90-second tolerance, and an instruction to
report a failed query rather than estimate around it.

The last paragraph is the injection boundary: everything after the system message, and every value
read out of the database, is data. Content titles, app version strings and country names are
user-supplied fields that can contain text shaped like commands, and the agent is told to treat any
such text as a finding to report rather than an instruction to follow.

## Bounds

| Limit | Value | Why |
|---|---|---|
| Turns per thread | 24 | Long enough for a real follow-up, short enough to bound cost |
| Characters per message | 4,000 | |
| Characters per thread | 24,000 | |
| Requests per minute per process | 20 | One dev server, one demo: coarse on purpose, not a distributed limiter |

Validation runs **before** the deployment check, so a malformed or oversized thread is refused the
same way whether or not LibreChat is configured. The reverse order makes the guardrails untestable
on a machine that has not set the agent up yet, which is every machine at first run.

## What this does not claim

A system prompt is a strong instruction, not an enforcement mechanism. Nothing here can stop a
sufficiently clever thread from talking an agent into trying something.

**The durable control is the credential the MCP server holds.** If that ClickHouse account is
read-only and scoped to the databases it needs, no phrasing gets a write through it. This layer
raises the cost of an injection and makes the intent explicit and testable; it is not the last line
and is not written as though it were. Before demoing, confirm what
`librechat/librechat.yaml`'s `clickhouse` MCP server authenticates as.

Rendering is markdown through `react-markdown` with raw HTML disabled by default, so an answer
containing markup renders as text rather than as an element.
