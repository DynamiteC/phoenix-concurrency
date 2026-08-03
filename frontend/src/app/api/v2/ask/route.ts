// Ask AI for the v2 insight console, pinned to `phoenix_live`.
//
// Same handler shape as /api/ask and deliberately so: the only difference between the two consoles'
// assistants is which database they may read and which tables they should reach for first, and both
// of those are one constant in lib/ask.ts. Keeping the scope out of the request body is the point.
// If the console could name its own database, so could anything that got a message into the thread.
import {NextRequest, NextResponse} from 'next/server'
import {
  AskCredentialError,
  askAgent,
  askConfigError,
  requestCredential,
  V2_SCOPE,
  validateAskPrompt,
  validateThread,
  withinRateLimit,
} from '@/lib/ask'
import type {AskResponse, ApiError} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse<AskResponse | ApiError>> {
  if (!withinRateLimit()) {
    return NextResponse.json({error: 'too many questions in the last minute'}, {status: 429})
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({error: 'body must be JSON'}, {status: 400})
  }

  // Validated BEFORE the deployment check, so a malformed or oversized thread is rejected the same
  // way whether or not LibreChat happens to be configured. The reverse order makes the guardrails
  // untestable on a machine that has not set the agent up yet, which is every machine at first run.
  const check = validateThread(body)
  if (!check.ok) return NextResponse.json({error: check.error}, {status: check.status})

  // The injection and off-topic gate, checked on the latest turn only (validateThread guarantees
  // it is role: 'user'). A rejection here returns 200 with the refusal in the normal answer
  // shape, so the UI renders it like any other reply, and never reaches LibreChat: an off-topic
  // or adversarial prompt should not spend the model budget the rate limit above is protecting.
  const lastMessage = check.messages[check.messages.length - 1]
  const promptCheck = validateAskPrompt(lastMessage?.content ?? '')
  if (!promptCheck.ok) return NextResponse.json({content: promptCheck.reason, ms: 0})

  // Read from headers, so the key never enters a URL, an access log or system.query_log.
  // A supplied-but-invalid key now throws rather than silently falling back to the server's
  // credential, so the user is told instead of being billed to someone else's account.
  let cred
  try {
    cred = requestCredential(req)
  } catch (e) {
    if (e instanceof AskCredentialError) return NextResponse.json({error: e.message}, {status: 400})
    throw e
  }
  const configError = askConfigError(cred)
  if (configError) return NextResponse.json({error: configError}, {status: 400})

  try {
    return NextResponse.json(await askAgent(V2_SCOPE, check.messages, cred))
  } catch (e) {
    const message =
      e instanceof Error && e.name === 'AbortError' ? 'LibreChat agent timed out' : (e as Error).message
    return NextResponse.json({error: message}, {status: 500})
  }
}
