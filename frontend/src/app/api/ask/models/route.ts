// The provider's live model list for the Ask panel's picker, fetched server-side with the
// visitor's own key so the browser never talks to the provider directly (their CORS policies
// differ) and the key rides the same X-LLM-* headers as a question does, never a URL.
//
// One route for both consoles: which database a question may read is a per-console concern, which
// models a KEY can call is not.
import {NextRequest, NextResponse} from 'next/server'
import {AskCredentialError, listProviderModels, requestCredential} from '@/lib/ask'
import type {ApiError} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse<{models: string[]} | ApiError>> {
  let cred
  try {
    cred = requestCredential(req)
  } catch (e) {
    if (e instanceof AskCredentialError) return NextResponse.json({error: e.message}, {status: 400})
    throw e
  }
  if (!cred.provider) {
    return NextResponse.json({error: 'model listing needs a provider key'}, {status: 400})
  }
  try {
    return NextResponse.json({models: await listProviderModels(cred.provider, cred.key)})
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 502})
  }
}
