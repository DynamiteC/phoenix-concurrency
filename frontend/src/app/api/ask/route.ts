// Forwards the dashboard's Ask AI thread to LibreChat's OpenAI-compatible remote-agent endpoint
// (api/server/routes/agents/openai.js), so the "Project Assistant" agent (LLM + clickhouse MCP
// tool) answers directly over HTTP with API-key auth — no LibreChat frontend, no cookies/JWT.
// The full message thread is resent every turn (standard OpenAI convention); LibreChat's
// conversation_id/checkpointer continuity is intentionally not used, see plan notes.
import {NextRequest, NextResponse} from 'next/server'
import {LIBRECHAT_URL, LIBRECHAT_API_KEY, LIBRECHAT_AGENT_ID} from '@/lib/env'
import type {AskMessage, AskResponse, ApiError} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TIMEOUT_MS = 60_000

export async function POST(req: NextRequest): Promise<NextResponse<AskResponse | ApiError>> {
  if (!LIBRECHAT_API_KEY || !LIBRECHAT_AGENT_ID) {
    return NextResponse.json(
      {
        error:
          'LIBRECHAT_API_KEY / LIBRECHAT_AGENT_ID are not set. Create an API key in the LibreChat ' +
          'UI (Settings -> API Keys) and copy the Project Assistant agent id, then fill both into ' +
          'the repo-root .env and restart the frontend dev server.',
      },
      {status: 400},
    )
  }

  const t0 = Date.now()
  const {messages} = (await req.json()) as {messages: AskMessage[]}

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${LIBRECHAT_URL}/api/agents/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LIBRECHAT_API_KEY}`,
      },
      body: JSON.stringify({model: LIBRECHAT_AGENT_ID, messages, stream: false}),
      signal: controller.signal,
      cache: 'no-store',
    })

    const body = await res.text()
    if (!res.ok) {
      return NextResponse.json({error: body.slice(0, 500)}, {status: res.status})
    }

    let data: {choices?: {message?: {content?: string}}[]}
    try {
      data = JSON.parse(body)
    } catch {
      return NextResponse.json(
        {error: `LibreChat returned non-JSON: ${body.slice(0, 200)}`},
        {status: 500},
      )
    }

    const content = data.choices?.[0]?.message?.content
    if (!content) {
      return NextResponse.json(
        {error: `LibreChat response had no message content: ${body.slice(0, 200)}`},
        {status: 500},
      )
    }

    return NextResponse.json({content, ms: Date.now() - t0})
  } catch (e) {
    const message = e instanceof Error && e.name === 'AbortError' ? 'LibreChat agent timed out' : (e as Error).message
    return NextResponse.json({error: message}, {status: 500})
  } finally {
    clearTimeout(timeout)
  }
}
