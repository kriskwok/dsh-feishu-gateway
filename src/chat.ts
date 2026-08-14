import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FeishuClient, FeishuMessageEvent } from './feishu.js'
import { SessionMap, conversationKey } from './session-map.js'
import type { FeishuGatewayConfig } from './config.js'
import { logger } from './logger.js'

/** Simple LRU of recently handled message ids (dedupe repeated events). */
class RecentMessageSet {
  private readonly map = new Map<string, number>()
  constructor(
    private readonly max = 2000,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  hasAndAdd(id: string): boolean {
    const now = Date.now()
    const ts = this.map.get(id)
    if (ts !== undefined && now - ts < this.ttlMs) return true
    this.map.delete(id)
    this.map.set(id, now)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    return false
  }
}

interface TurnOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Aggregate the final assistant text from session events since firstSeq. */
export function summarize(events: readonly SessionEvent[], firstSeq: number): TurnOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Extract plain text from a Feishu message content JSON. */
export function extractText(messageType: string, contentJson: string): string {
  try {
    const obj = JSON.parse(contentJson) as Record<string, unknown>
    if (messageType === 'text') return typeof obj.text === 'string' ? obj.text : ''
    if (messageType === 'post') {
      const lang = (obj.zh_cn ?? obj.en_us ?? {}) as { content?: Array<Array<{ text?: string }>> }
      if (Array.isArray(lang.content)) {
        return lang.content.flatMap((seg) => seg.map((e) => e.text ?? '')).join(' ').trim()
      }
    }
    return ''
  } catch {
    return ''
  }
}

/** Strip Feishu @ tags etc. */
export function cleanText(text: string): string {
  return text
    .replace(/<at[^>]*>.*?<\/at>/g, '')
    .replace(/<at[^>]*\/>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ChatHandlerDeps {
  ctx: Context
  config: FeishuGatewayConfig
  feishu: FeishuClient
  sessions: SessionMap
}

/**
 * Chat handler: Feishu messages → DSH agent (resume/create on a stable
 * session id) → reply with Markdown post.
 */
export class ChatHandler {
  private readonly recent = new RecentMessageSet()
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: ChatHandlerDeps) {}

  handleMessage = async (data: FeishuMessageEvent): Promise<void> => {
    try {
      await this.process(data)
    } catch (err) {
      logger.error('chat', 'handle message error:', err)
    }
  }

  private async process(data: FeishuMessageEvent): Promise<void> {
    const message = data.message
    if (!message) return
    if (data.sender?.sender_type === 'bot') return
    if (this.recent.hasAndAdd(message.message_id)) return

    const chatType = message.chat_type === 'group' ? 'group' : 'p2p'
    const userId = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id ?? ''
    if (!userId) return

    if (chatType === 'group' && !this.shouldReplyInGroup(data)) return

    const text = cleanText(extractText(message.message_type, message.content))
    if (!text) return

    const key = conversationKey(message.chat_id, chatType, userId)
    logger.info('chat', `[${chatType}] ${userId}: ${text.slice(0, 120)}`)

    // /new or natural-language "start a new session"
    if (this.isNewSessionCommand(text)) {
      this.deps.sessions.reset(key)
      await this.deps.feishu.replyText(message.message_id, '🧹 已开启全新会话，我们重新开始。')
      return
    }

    // Serialize turns per conversation to avoid interleaving.
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(() => this.respond(data, key, text))
    this.chains.set(key, next)
    try {
      await next
    } finally {
      if (this.chains.get(key) === next) this.chains.delete(key)
    }
  }

  private isNewSessionCommand(text: string): boolean {
    const t = text.trim().toLowerCase()
    const patterns = this.deps.config.newSessionPatterns ?? []
    return patterns.some((p) => new RegExp(p).test(t))
  }

  private shouldReplyInGroup(data: FeishuMessageEvent): boolean {
    const mode = this.deps.config.feishu?.replyMode ?? 'at'
    if (mode === 'all') return true
    const mentions = data.message.mentions ?? []
    if (mentions.some((m) => m.mentioned_type === 'app')) return true
    const botOpenId = this.deps.config.feishu?.botOpenId ?? ''
    if (botOpenId && mentions.some((m) => m.id.open_id === botOpenId || m.id.user_id === botOpenId)) return true
    if (botOpenId) {
      try {
        const parsed = JSON.parse(data.message.content) as { text?: string }
        if (parsed.text?.includes(`<at user_id="${botOpenId}`)) return true
      } catch {
        // ignore
      }
    }
    return false
  }

  private async respond(data: FeishuMessageEvent, key: string, text: string): Promise<void> {
    const { feishu, sessions, config } = this.deps
    try {
      await feishu.replyText(data.message.message_id, config.hintText ?? '爸爸，我正在努力处理中……')

      const sessionId = sessions.idFor(key)
      const cwd = this.expandWorkspace(config.workspace ?? '~/Documents/DSH-Workspace')
      const outcome = await this.runTurn(sessionId, text, cwd)

      if (outcome.reason?.kind === 'error') {
        await feishu.replyText(
          data.message.message_id,
          `😵 DSH 处理失败：${outcome.reason.error.code}: ${outcome.reason.error.message}`,
        )
        return
      }
      const answer = outcome.text.trim()
      if (!answer) {
        await feishu.replyText(data.message.message_id, '😶 DSH 没有返回内容，请再试一次。')
        return
      }
      await feishu.replyMarkdown(data.message.message_id, answer)
    } catch (err) {
      logger.error('chat', 'turn failed:', err)
      await feishu
        .replyText(
          data.message.message_id,
          `😵 DSH 处理失败：${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`,
        )
        .catch(() => undefined)
    }
  }

  /** Run one turn on a stable DSH session (resume, or create as fallback). */
  private async runTurn(sessionId: string, text: string, cwd: string): Promise<TurnOutcome> {
    const ctx = this.deps.ctx
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    if (!agents || !defaultModel) throw new Error('agents / agentDefaultModel services unavailable')

    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context): void => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }

    let handle: { agent: any; dispose(): Promise<void> }
    try {
      handle = await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })
    } catch (err) {
      logger.warn('chat', `resume ${sessionId} failed (${err instanceof Error ? err.message : String(err)}), creating fresh`)
      handle = await agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd },
        agentOptions,
        setup,
      })
    }

    const { agent } = handle
    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      )
      await agent.whenIdle()
      return summarize(agent.session.events, firstSeq)
    } finally {
      // Release the live handle; the persisted session stays for the next resume.
      await handle.dispose().catch((err) => logger.warn('chat', 'dispose agent error:', err))
    }
  }

  private expandWorkspace(ws: string): string {
    return ws.startsWith('~') ? ws.replace(/^~/, process.env.HOME ?? '/') : ws
  }
}
