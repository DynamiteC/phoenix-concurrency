'use client'

import {useEffect, useRef, useState} from 'react'
import {LLM_PRESETS, type LlmProvider} from '@/lib/ask.presets'
import ReactMarkdown from 'react-markdown'
import styles from './AskAI.module.css'
import type {AskMessage} from '@/lib/types'

async function safeJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return {error: text.trim().slice(0, 140) || `${res.status} ${res.statusText}`}
  }
}

/** General enough to be true of either console, shown when a caller does not pass its own set. */
const DEFAULT_STARTERS = [
  'What was the peak concurrency in the last 3 hours?',
  'Which platform has the most active sessions right now?',
  'What does this data cover?',
]

interface Props {
  /** Which console is asking. /api/ask is pinned to phoenix_graded, /api/v2/ask to phoenix_live. The
   *  endpoint is the ONLY thing that differs between the two, and the database it may read is
   *  fixed server-side rather than sent from here: a client that could name its own database
   *  would hand that choice to anything able to get a message into the thread. */
  endpoint?: '/api/ask' | '/api/v2/ask'
  /** What this console's assistant reads, named on screen so the answer's source is not a guess. */
  reads?: string
  /** Starter chips shown while the input is empty and the thread hasn't started, grounded in
   *  what the console's own views actually answer rather than generic chat-bot small talk. */
  starterQuestions?: string[]
}

/** Natural-language fallback for questions with no fixed query to hardcode. Calls the real
 *  LibreChat agent (LLM + clickhouse MCP tool) through the API rather than duplicating a chat
 *  UI here: every other mode answers a known question fast and without an LLM, and this is the
 *  one place that trades that speed for an open-ended question. */
export default function AskAI({endpoint = '/api/ask', reads = 'phoenix_graded', starterQuestions = DEFAULT_STARTERS}: Props = {}) {
  const [thread, setThread] = useState<AskMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  // BRING YOUR OWN MODEL. This is the user's own LLM provider key, not a credential on our
  // deployment. Held in component state only: never written to localStorage, never put in a URL,
  // never sent anywhere but the Authorization header this app builds server-side. It is gone the
  // moment the tab closes, which is exactly what the disclaimer below promises.
  // Bring-your-own-key by design: never ship a default. A key baked into the client bundle is
  // public the moment the page loads.
  const [apiKey, setApiKey] = useState('')
  const [provider, setProvider] = useState<LlmProvider>('google')
  const [keyOpen, setKeyOpen] = useState(false)
  // The provider's LIVE model list for THIS key, fetched through /api/ask/models. Hardcoded
  // defaults rot: providers retire entry-tier models for new keys while old keys keep them, so
  // the only list worth showing is the one this key can actually call.
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [modelsError, setModelsError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({top: listRef.current.scrollHeight})
  }, [thread, pending])

  // Debounced: fires once the pasted key stops changing, and again on a provider switch. A stale
  // response for the previous provider/key must not overwrite the current list, hence `gone`.
  useEffect(() => {
    setModels([])
    setModel('')
    setModelsError('')
    const key = apiKey.trim()
    if (!key || key.length < 12) return
    let gone = false
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/ask/models', {
          headers: {'X-LLM-Key': key, 'X-LLM-Provider': provider},
        })
        const body = await safeJson(res)
        if (gone) return
        if (!res.ok) throw new Error(body.error || 'could not list models')
        const list: string[] = body.models ?? []
        setModels(list)
        setModel(list[0] ?? '')
      } catch (e) {
        if (!gone) setModelsError((e as Error).message)
      }
    }, 600)
    return () => {
      gone = true
      clearTimeout(t)
    }
  }, [apiKey, provider])

  /** `override` lets a starter chip submit its own text directly rather than round-tripping
   *  through `input` state, which would not have updated yet in the same tick as the click. */
  async function send(override?: string) {
    const text = (override ?? input).trim()
    if (!text || pending) return
    const next: AskMessage[] = [...thread, {role: 'user', content: text}]
    setThread(next)
    setInput('')
    setError('')
    setPending(true)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // A HEADER, not a query parameter and not the body. Query strings reach access logs and
          // Referer headers; this project also publishes system.query_log extracts as graded
          // evidence, so a key in a URL would be a key in the submission.
          ...(apiKey.trim() ? {'X-LLM-Key': apiKey.trim(), 'X-LLM-Provider': provider} : {}),
          ...(apiKey.trim() && model ? {'X-LLM-Model': model} : {}),
        },
        body: JSON.stringify({messages: next}),
      })
      const body = await safeJson(res)
      if (!res.ok) throw new Error(body.error || `${endpoint} failed`)
      setThread([...next, {role: 'assistant', content: body.content as string}])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.meta}>
        <p className={styles.hint}>
          Backed by a live <code>run_query</code> tool against ClickHouse, not a canned query,
          and scoped to <code>{reads}</code>. Slower than the other tabs and it can be
          wrong: verify anything load-bearing against the curve.
        </p>
        {thread.length > 0 && (
          <button
            className={styles.clear}
            onClick={() => {
              setThread([])
              setError('')
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className={styles.keyBar}>
        <button
          type="button"
          className={styles.keyToggle}
          aria-expanded={keyOpen}
          onClick={() => setKeyOpen((v) => !v)}
        >
          {apiKey.trim() ? `Using your ${LLM_PRESETS[provider].label} key` : 'Use your own AI API key'}
        </button>
        {keyOpen && (
          <div className={styles.keyPanel}>
            <label className={styles.keyLabel} htmlFor="llm-provider">
              Model provider
            </label>
            <div className={styles.providerRow} role="group" aria-label="Model provider">
              {(Object.keys(LLM_PRESETS) as LlmProvider[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={styles.providerButton}
                  aria-pressed={id === provider}
                  onClick={() => setProvider(id)}
                >
                  {LLM_PRESETS[id].label}
                </button>
              ))}
            </div>

            <label className={styles.keyLabel} htmlFor="llm-key">
              Your {LLM_PRESETS[provider].label} API key
            </label>
            <input
              id="llm-key"
              className={styles.keyInput}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`paste your ${LLM_PRESETS[provider].label} key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {models.length > 0 && (
              <>
                <label className={styles.keyLabel} htmlFor="llm-model">
                  Model
                </label>
                <select
                  id="llm-model"
                  className={styles.keyInput}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </>
            )}
            {modelsError && <p className={styles.error}>{modelsError}</p>}
            <p className={styles.keyNote}>
              <strong>Your key stays in this browser tab.</strong> We do not store it, log it,
              write it to any file, or share it with anyone. It is sent only as the authorization
              header on your own question and is discarded the moment you close the tab. Questions
              are billed to your provider account, not ours. Get a key from{' '}
              <a href={LLM_PRESETS[provider].keyUrl} target="_blank" rel="noreferrer">
                {LLM_PRESETS[provider].label}
              </a>
              . Leave this blank to use the demo host&apos;s key if one is configured.
            </p>
            {apiKey.trim() && (
              <button type="button" className={styles.keyClear} onClick={() => setApiKey('')}>
                Forget key
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.listWrap} ref={listRef}>
        {thread.length === 0 && !pending && <p className={styles.empty}>Ask a question about the pipeline below.</p>}
        {thread.map((m, i) => (
          <div key={i} className={m.role === 'user' ? styles.rowUser : styles.rowAssistant}>
            <span className={styles.role}>{m.role === 'user' ? 'you' : 'agent'}</span>
            <div className={styles.bubble}>
              {m.role === 'assistant' ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.content}
            </div>
          </div>
        ))}
        {pending && (
          <div className={styles.rowAssistant}>
            <span className={styles.role}>agent</span>
            <div className={styles.bubble}>
              <span className={styles.thinking}>thinking…</span>
            </div>
          </div>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {/* Starter chips, only while there is nothing typed and nothing asked yet: once a thread
          exists these would be sitting above a real conversation, suggesting questions instead
          of answering the one already asked. */}
      {thread.length === 0 && !input.trim() && starterQuestions.length > 0 && (
        <div className={styles.starters} role="group" aria-label="Starter questions">
          {starterQuestions.map((q) => (
            <button
              key={q}
              type="button"
              className={styles.starterChip}
              disabled={pending}
              onClick={() => send(q)}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <div className={styles.inputRow}>
        <input
          className={styles.input}
          value={input}
          placeholder="e.g. what's driving the concurrency spike today?"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          disabled={pending}
        />
        <button className={styles.send} onClick={() => send()} disabled={pending || !input.trim()}>
          {pending ? '…' : 'Send'}
        </button>
      </div>

      {/* Unobtrusive, not a disclaimer: just where the traces actually go. */}
      <p className={styles.langfuseNote}>Traces logged to Langfuse.</p>
    </div>
  )
}
