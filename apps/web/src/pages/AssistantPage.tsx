import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, request } from '../api.js'
import {
  AssistantActionsPanel,
  HistorySearch,
  MemoryPanel,
  ProjectNotesPanel,
  ScheduledPanel,
  deleteMemory,
} from '../components/assistant-panels.js'
import type { MemoryItem } from '../components/assistant-panels.js'
import { Composer } from '../components/Composer.js'
import { Mascot, MascotMark } from '../components/Mascot.js'
import { AgentProse, UserBubble } from '../components/Thread.js'
import { Button, Icon, IconButton } from '../components/ui.js'
import { useDraft } from '../storage.js'
import type { ConversationSummary } from '../types.js'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  memoryIds?: string[]
}

/** Chat with the assistant (T3.1). The conversation list lives in the main sidebar; this is one conversation. */
export function AssistantPage({
  conversationId,
  onSelectConversation,
  onConversationsChanged,
  onError,
}: {
  /** The open conversation, or '' for a new one that has no messages yet. */
  conversationId: string
  onSelectConversation: (id: string) => void
  onConversationsChanged: () => void
  onError: (message: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth >= 1100)
  const draftContext = `conversation:${conversationId || 'new'}`
  const [draft, setDraft, clearDraft] = useDraft(draftContext)
  const setDraftRef = useRef(setDraft)
  setDraftRef.current = setDraft
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const loadMemories = useCallback(async (): Promise<void> => {
    const body = await request<{ memories?: MemoryItem[] }>('/api/memories')
    setMemories(Array.isArray(body.memories) ? body.memories : [])
  }, [])

  useEffect(() => {
    void loadMemories().catch(() => undefined)
  }, [loadMemories])

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      return
    }
    let cancelled = false
    const load = () =>
      request<{ messages?: ChatMessage[] }>(`/api/conversations/${encodeURIComponent(conversationId)}`)
        .then((body) => {
          if (!cancelled) setMessages(Array.isArray(body.messages) ? body.messages : [])
        })
        .catch(() => undefined)
    void load()
    // Tasks the assistant started report back here when they finish.
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [conversationId])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages.length, sending])

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    setFailure('')
    setSending(true)
    let id = conversationId
    try {
      if (!id) {
        const created = await request<{ conversation: ConversationSummary }>('/api/conversations', {
          method: 'POST',
          body: '{}',
        })
        id = created.conversation.id
        clearDraft()
        onSelectConversation(id)
      } else {
        clearDraft()
      }
      setMessages((current) => [...current, { id: -Date.now(), role: 'user', content: text }])
      await request(`/api/conversations/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
    } catch (error) {
      setFailure(errorMessage(error, '助理沒有回應'))
      // Give the text back so a failed send loses nothing.
      setDraftRef.current(text)
    } finally {
      setSending(false)
      if (id) {
        const body = await request<{ messages?: ChatMessage[] }>(
          `/api/conversations/${encodeURIComponent(id)}`,
        ).catch(() => ({ messages: undefined }))
        if (Array.isArray(body.messages)) setMessages(body.messages)
      }
      onConversationsChanged()
      // Joy may have learned something from this message; extraction runs in the background.
      window.setTimeout(() => void loadMemories().catch(() => undefined), 3000)
    }
  }

  const report = (message: string) => {
    setFailure(message)
    onError(message)
  }

  return (
    <main className="assistant-page" data-testid="assistant-page">
      <section className="assistant-chat" aria-label="對話">
        <header className="page-header">
          <HistorySearch onOpen={onSelectConversation} />
          <Button
            icon="book"
            aria-pressed={sideOpen}
            onClick={() => setSideOpen((open) => !open)}
            aria-label={sideOpen ? '收合記憶與排程' : '展開記憶與排程'}
          >
            記憶與排程
          </Button>
        </header>
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-column">
            <AssistantActionsPanel onError={report} onDecided={() => undefined} />
            <ProjectNotesPanel onError={report} />
            {messages.length === 0 ? (
              <div className="empty-state">
                <Mascot mood="sleeping" size={72} decorative />
                <h2>跟 Joy 聊聊</h2>
              </div>
            ) : (
              messages.map((message) =>
                message.role === 'user' ? (
                  <UserBubble key={message.id} text={message.content} />
                ) : message.role === 'assistant' ? (
                  <div key={message.id} className="chat-assistant">
                    <MascotMark size={20} className="chat-avatar" />
                    <AgentProse text={message.content} />
                    {message.memoryIds?.length ? (
                      <div className="memory-chips" aria-label="用到的記憶">
                        {message.memoryIds.map((id) => {
                          const memory = memories.find((m) => m.id === id)
                          return memory ? (
                            <span key={id} className="chip">
                              {memory.content}
                              <IconButton
                                icon="x"
                                label={`忘記：${memory.content}`}
                                className="icon-btn-inline"
                                onClick={() => void deleteMemory(id, loadMemories, report)}
                              />
                            </span>
                          ) : (
                            <span key={id} className="chip chip-muted">
                              已刪除的記憶
                            </span>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p
                    key={message.id}
                    className={message.role === 'system' ? 'chat-note chat-error' : 'chat-note'}
                  >
                    {message.role === 'system' ? <Icon name="alert" size={14} /> : null}
                    {message.content}
                  </p>
                ),
              )
            )}
            {sending ? (
              <div className="running-indicator" role="status">
                <Mascot mood="thinking" size={36} decorative />
                <span>Joy 正在想…</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="chat-composer">
          {failure ? <p className="form-error">{failure}</p> : null}
          <Composer
            className="composer-chat"
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            placeholder="傳訊息給 Joy"
            textareaLabel="訊息"
            sendLabel="送出"
            busy={sending}
          />
        </div>
      </section>
      {sideOpen ? (
        <aside className="assistant-side" aria-label="記憶與排程">
          <div className="pane-header side-header">
            <h2>記憶與排程</h2>
            <IconButton icon="x" label="關閉面板" onClick={() => setSideOpen(false)} />
          </div>
          <ScheduledPanel onError={report} />
          <MemoryPanel memories={memories} onChange={loadMemories} onError={report} />
        </aside>
      ) : null}
    </main>
  )
}
