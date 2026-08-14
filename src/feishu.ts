import * as lark from '@larksuiteoapi/node-sdk'
import { logger } from './logger.js'

/**
 * Feishu client wrapper: long-connection event subscription (WSClient +
 * EventDispatcher), message replies (text / Markdown post), and proactive push.
 */

export interface FeishuClientOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  verificationToken?: string
  encryptKey?: string
}

/** Lark API response shape. */
interface LarkResponse<T = unknown> {
  code?: number
  msg?: string
  data?: T
}

export interface CardBody {
  config?: { streaming_mode?: boolean; update_multi?: boolean; wide_screen_mode?: boolean }
  header?: {
    title: { tag: 'plain_text'; content: string }
    template?: string
  }
  elements: Array<{
    tag: string
    content?: string
    [k: string]: unknown
  }>
}

export type MessageType = 'text' | 'post' | 'interactive' | 'image' | 'file' | 'audio' | 'media'
export type ReceiveIdType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id'

export interface PushOptions {
  receiveId: string
  receiveIdType: ReceiveIdType
  msgType: MessageType
  content: string
  uuid?: string
}

/** Feishu im.message.receive_v1 event (relevant fields). */
export interface FeishuMessageEvent {
  event_id?: string
  sender: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string }
    sender_type: string
  }
  message: {
    message_id: string
    create_time: string
    chat_id: string
    chat_type: string // "p2p" | "group"
    message_type: string // "text" | "post" | ...
    content: string // JSON string
    mentions?: Array<{
      key: string
      id: { union_id?: string; user_id?: string; open_id?: string }
      mentioned_type?: string
      name: string
      tenant_key?: string
    }>
  }
}

export class FeishuClient {
  readonly client: lark.Client
  private wsClient: lark.WSClient | null = null

  constructor(private readonly opts: FeishuClientOptions) {
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    })
  }

  /** Start the long-connection event subscription. */
  async startEventSubscription(handlers: {
    'im.message.receive_v1'?: (data: FeishuMessageEvent) => Promise<void> | void
    [eventName: string]: ((data: any) => Promise<void> | void) | undefined
  }): Promise<void> {
    const dispatcher = new lark.EventDispatcher({
      verificationToken: this.opts.verificationToken || undefined,
      encryptKey: this.opts.encryptKey || undefined,
    }).register(handlers)

    this.wsClient = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
      autoReconnect: true,
      handshakeTimeoutMs: 30_000,
    })
    await this.wsClient.start({ eventDispatcher: dispatcher })
    logger.info('feishu', 'long-connection event subscription started')
  }

  getWSStatus(): { state: string; reconnectAttempts: number } {
    if (!this.wsClient) return { state: 'idle', reconnectAttempts: 0 }
    const s = this.wsClient.getConnectionStatus()
    return { state: s.state, reconnectAttempts: s.reconnectAttempts }
  }

  close(): void {
    if (this.wsClient) {
      try {
        this.wsClient.close()
      } catch (err) {
        logger.warn('feishu', 'close ws error:', err)
      }
      this.wsClient = null
    }
  }

  /** Reply with a plain-text message. */
  async replyText(messageId: string, text: string): Promise<void> {
    await this.reply(messageId, 'text', JSON.stringify({ text }))
  }

  /**
   * Reply with a Markdown-rich post message (md tag): Feishu renders bold /
   * inline code / lists / links without using cards. Long text is chunked
   * (≤1800 chars per md paragraph, ≤10 paragraphs per message).
   */
  async replyMarkdown(messageId: string, text: string): Promise<void> {
    const chunks = splitMarkdown(text, 1800)
    const MAX_CHUNKS_PER_MSG = 10
    for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_MSG) {
      const batch = chunks.slice(i, i + MAX_CHUNKS_PER_MSG)
      const content = JSON.stringify({
        zh_cn: {
          title: '',
          content: batch.map((c) => [{ tag: 'md', text: c }]),
        },
      })
      await this.reply(messageId, 'post', content)
    }
  }

  /** Reply with an arbitrary message type. */
  async reply(messageId: string, msgType: MessageType, content: string): Promise<void> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: msgType, content },
    })
    this.assertOk(res, 'reply')
  }

  /** Proactively push a message to a user/group. */
  async push(opts: PushOptions): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: opts.receiveIdType },
      data: {
        receive_id: opts.receiveId,
        msg_type: opts.msgType,
        content: opts.content,
        ...(opts.uuid ? { uuid: opts.uuid } : {}),
      },
    })
    this.assertOk(res, 'push')
    return res.data?.message_id ?? ''
  }

  /** Update an already-sent card message (used for streaming replies). */
  async patchCard(messageId: string, card: CardBody): Promise<void> {
    const res = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
    this.assertOk(res, 'patchCard')
  }

  private assertOk(res: LarkResponse, scope: string): void {
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(`Feishu API error [${scope}]: code=${res.code}, msg=${res.msg}`)
    }
  }
}

/**
 * Split long text into Markdown chunks: prefer line breaks; never split a ```
 * fenced code block.
 */
export function splitMarkdown(text: string, maxLen: number): string[] {
  if (!text) return ['']
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen)
    let cut = window.lastIndexOf('\n')
    if (cut <= 0) cut = maxLen
    const fences = (rest.slice(0, Math.min(rest.length, maxLen + 3)).match(/```/g) ?? []).length
    if (fences % 2 === 1) {
      const fenceEnd = rest.indexOf('```', 3)
      if (fenceEnd > 0 && fenceEnd < rest.length) cut = fenceEnd + 3
    }
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}
