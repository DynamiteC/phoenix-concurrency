// The provider presets, split out so the Ask panel can import them in the BROWSER.
//
// lib/ask.ts is server-only: it imports lib/env.ts, which reads ../.env with node:fs at module
// scope. Importing it from a client component puts node:fs in the browser chunk and the
// production build fails. Same split, and the same reason, as lib/datasets.ts against
// lib/datasets.server.ts.
export type LlmProvider = 'anthropic' | 'google' | 'openai'

export interface LlmPreset {
  id: LlmProvider
  label: string
  /** Where to get a key, so the panel can link it rather than assuming the reader knows. */
  keyUrl: string
  /** The LibreChat endpoint this maps to; it must carry `userProvidedKey: true`. */
  endpoint: string
}

export const LLM_PRESETS: Record<LlmProvider, LlmPreset> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    endpoint: 'anthropic',
  },
  google: {
    id: 'google',
    label: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    endpoint: 'google',
  },
  openai: {
    id: 'openai',
    label: 'Codex (OpenAI)',
    keyUrl: 'https://platform.openai.com/api-keys',
    endpoint: 'openAI',
  },
}
