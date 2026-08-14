import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from './logger.js'

/**
 * Maps a Feishu conversation to a stable DSH session id so multi-turn chats
 * stay in the same DSH session until the user explicitly starts a new one.
 * Persisted to JSON so the mapping survives gateway restarts.
 */
export class SessionMap {
  private readonly map = new Map<string, string>()

  constructor(private readonly file: string) {
    this.load()
  }

  /** Get or create the DSH session id for a Feishu conversation key. */
  idFor(key: string): string {
    let id = this.map.get(key)
    if (!id) {
      id = `feishu-${randomUUID()}`
      this.map.set(key, id)
      this.persist()
    }
    return id
  }

  /** Drop the mapping; the next message starts a fresh DSH session (/new). */
  reset(key: string): void {
    this.map.delete(key)
    this.persist()
    logger.info('session-map', `conversation ${key} reset`)
  }

  list(): Array<{ key: string; sessionId: string }> {
    return [...this.map.entries()].map(([k, v]) => ({ key: k, sessionId: v }))
  }

  flush(): void {
    this.persist()
  }

  private persist(): void {
    if (!this.file) return
    try {
      const dir = path.dirname(this.file)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      logger.error('session-map', 'persist failed:', err)
    }
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) {
        if (k && typeof v === 'string') this.map.set(k, v)
      }
      logger.info('session-map', `loaded ${this.map.size} mappings from ${this.file}`)
    } catch (err) {
      logger.error('session-map', 'load failed:', err)
    }
  }
}

/** Feishu conversation key: p2p = open_id; group = chatId:openId. */
export function conversationKey(chatId: string, chatType: string, userId: string): string {
  return chatType === 'group' ? `${chatId}:${userId}` : userId
}
