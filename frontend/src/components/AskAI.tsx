'use client'

import {useEffect, useRef, useState} from 'react'
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

/** Natural-language fallback for questions with no fixed query to hardcode. Calls the real
 *  LibreChat agent (LLM + clickhouse MCP tool) through /api/ask rather than duplicating a chat
 *  UI here — every other mode on this dashboard answers a known question fast and without an
 *  LLM; this is the one place that trades that speed for an open-ended question. */
export default function AskAI() {
  const [thread, setThread] = useState<AskMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({top: listRef.current.scrollHeight})
  }, [thread, pending])

  async function send() {
    const text = input.trim()
    if (!text || pending) return
    const next: AskMessage[] = [...thread, {role: 'user', content: text}]
    setThread(next)
    setInput('')
    setError('')
    setPending(true)
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({messages: next}),
      })
      const body = await safeJson(res)
      if (!res.ok) throw new Error(body.error || '/api/ask failed')
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
          Backed by the LibreChat agent with a live <code>clickhouse</code> MCP tool, not a canned
          query. Slower than the other tabs and it can be wrong — verify anything load-bearing
          against the curve.
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
        <button className={styles.send} onClick={send} disabled={pending || !input.trim()}>
          {pending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
