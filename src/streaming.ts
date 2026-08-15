/**
 * Live streaming progress card for long DSH turns.
 *
 * When `reporting.mode` is `'stream'` (default), one interactive card is
 * replied to the user's message and patched as the turn's session events
 * arrive: the agent's reasoning (thinking), tool-call activity, and the answer
 * draft stream in near real time, ending with a completion summary card. The
 * final full answer is still delivered as a Markdown post by the chat handler.
 *
 * Card patches are throttled (`reporting.patchIntervalMs`) because Feishu
 * rate-limits card updates, and the rendered body is truncated
 * (`reporting.maxBodyChars`) because the card payload is size-limited. The
 * card uses Feishu's native `streaming_mode` so the client shows a live
 * "generating" state while patches keep coming.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CardBody, FeishuClient } from './feishu.js'
import type { FeishuGatewayConfig } from './config.js'
import { logger } from './logger.js'

export interface TurnReporterOptions {
  /** The user message this turn answers; the card is replied to it. */
  replyToMessageId: string
}

export interface TurnReporterDeps {
  feishu: FeishuClient
  config: FeishuGatewayConfig
}

/** Keep only this much of the reasoning/answer tail in memory. */
const MAX_BUFFER = 4000

export class TurnReporter {
  private cardMessageId: string | undefined
  private status = '🧠 正在思考…'
  private reasoning = ''
  private answer = ''
  private toolLine = ''
  private stepCount = 0
  /** callId → tool name, so `tool/result` can label the completed tool. */
  private readonly callNames = new Map<string, string>()
  private lastPatchAt = 0
  private patchTimer: ReturnType<typeof setTimeout> | undefined
  private pendingPatch = false
  private finished = false
  private readonly startedAt = Date.now()
  private readonly patchIntervalMs: number
  private readonly maxBodyChars: number
  private readonly showReasoning: boolean
  private readonly showToolCalls: boolean
  private readonly titleStreaming: string
  private readonly titleDone: string

  constructor(
    private readonly deps: TurnReporterDeps,
    private readonly opts: TurnReporterOptions,
  ) {
    const reporting = deps.config.reporting ?? {}
    this.patchIntervalMs = Math.max(200, reporting.patchIntervalMs ?? 700)
    this.maxBodyChars = Math.max(200, reporting.maxBodyChars ?? 900)
    this.showReasoning = reporting.showReasoning ?? true
    this.showToolCalls = reporting.showToolCalls ?? true
    this.titleStreaming = reporting.cardTitleStreaming ?? '🤖 DSH 处理中…'
    this.titleDone = reporting.cardTitleDone ?? '🤖 DSH 处理完成'
  }

  /** Send the initial card and stream a brief "starting" state. */
  async begin(): Promise<void> {
    const card = this.buildCard(true)
    this.cardMessageId = await this.deps.feishu.replyCard(this.opts.replyToMessageId, card)
  }

  /** Feed one session event; schedules a throttled card patch. */
  onEvent(event: SessionEvent): void {
    if (this.finished) return
    let changed = false
    switch (event.type) {
      case 'turn/start':
        this.status = '🧠 开始处理…'
        changed = true
        break
      case 'step/start':
        this.stepCount += 1
        this.status = `🔄 第 ${this.stepCount} 步 · 思考中…`
        changed = true
        break
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'reasoning-delta' && this.showReasoning) {
          this.reasoning = tail(this.reasoning + chunk.text, MAX_BUFFER)
          changed = true
        } else if (chunk.type === 'text-delta') {
          this.answer = tail(this.answer + chunk.text, MAX_BUFFER)
          changed = true
        } else if (chunk.type === 'tool-call-delta' && this.showToolCalls && chunk.name) {
          this.toolLine = `🔧 正在调用工具 \`${chunk.name}\`…`
          changed = true
        }
        break
      }
      case 'assistant/message': {
        const blocks = event.data.message.content
        const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text?: string }).text ?? '').join('')
        if (text !== '') {
          this.answer = tail(text, MAX_BUFFER)
          changed = true
        }
        if (this.showReasoning) {
          const thinking = blocks.filter((b) => b.type === 'reasoning').map((b) => (b as { text?: string }).text ?? '').join('')
          if (thinking !== '') {
            this.reasoning = tail(thinking, MAX_BUFFER)
            changed = true
          }
        }
        break
      }
      case 'tool/call':
        if (this.showToolCalls) {
          this.callNames.set(String(event.data.callId), event.data.name)
          this.toolLine = `🔧 调用工具 \`${event.data.name}\``
          this.status = `🔧 调用 \`${event.data.name}\`…`
          changed = true
        }
        break
      case 'tool/result': {
        if (this.showToolCalls) {
          const block = event.data.message.content[0]
          const name = block !== undefined ? this.callNames.get(String(block.toolCallId)) : undefined
          const ok = event.data.error === undefined
          this.toolLine = `${ok ? '✅' : '❌'} 工具 \`${name ?? '未知'}\` 完成`
          changed = true
        }
        break
      }
      default:
        break
    }
    if (changed) this.schedulePatch()
  }

  /** Final patch: stop streaming, show the completion summary. */
  async finish(outcome: { text: string; error?: boolean }): Promise<void> {
    this.finished = true
    if (this.patchTimer !== undefined) {
      clearTimeout(this.patchTimer)
      this.patchTimer = undefined
    }
    const elapsedSec = ((Date.now() - this.startedAt) / 1000).toFixed(1)
    if (outcome.error) {
      this.status = '😵 DSH 处理失败'
    } else {
      const chars = outcome.text.trim().length
      this.status = `✅ 完成 · 用时 ${elapsedSec}s · 输出 ${chars} 字`
    }
    const card = this.buildCard(false)
    if (this.cardMessageId !== undefined) {
      await this.deps.feishu.patchCard(this.cardMessageId, card).catch((err) => {
        logger.warn('streaming', 'final card patch failed:', err)
      })
    }
  }

  dispose(): void {
    this.finished = true
    if (this.patchTimer !== undefined) clearTimeout(this.patchTimer)
    this.patchTimer = undefined
  }

  // ---------------------------------------------------------------------------

  private schedulePatch(): void {
    if (this.pendingPatch || this.finished) return
    this.pendingPatch = true
    const elapsed = Date.now() - this.lastPatchAt
    const delay = Math.max(0, this.patchIntervalMs - elapsed)
    this.patchTimer = setTimeout(() => {
      this.patchTimer = undefined
      this.pendingPatch = false
      void this.flush()
    }, delay)
  }

  private async flush(): Promise<void> {
    if (this.finished || this.cardMessageId === undefined) return
    const card = this.buildCard(true)
    try {
      await this.deps.feishu.patchCard(this.cardMessageId, card)
      this.lastPatchAt = Date.now()
    } catch (err) {
      logger.debug('streaming', 'card patch failed:', err)
    }
  }

  private buildCard(streaming: boolean): CardBody {
    const elements: CardBody['elements'] = []
    let budget = this.maxBodyChars

    const pushDiv = (content: string): void => {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content } })
    }

    const statusLine = this.status + (streaming ? ' ▍' : '')
    pushDiv(statusLine)
    budget -= statusLine.length

    if (this.showToolCalls && this.toolLine !== '' && budget > 0) {
      const line = tail(this.toolLine, budget)
      pushDiv(line)
      budget -= line.length
    }
    if (this.showReasoning && this.reasoning !== '' && budget > 0) {
      const body = tail(this.reasoning, budget)
      pushDiv(`🧠 **思考**\n${body}`)
      budget -= body.length
    }
    if (this.answer !== '' && budget > 0) {
      const body = tail(this.answer, budget)
      pushDiv(`✍️ **输出**\n${body}`)
      budget -= body.length
    }
    if (streaming) {
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '🔄 实时更新中，请稍候…' }],
      })
    }
    return {
      config: { wide_screen_mode: true, streaming_mode: streaming },
      header: {
        title: { tag: 'plain_text', content: streaming ? this.titleStreaming : this.titleDone },
        // 处理中：黄色；完成：绿色。
        template: streaming ? 'yellow' : 'green',
      },
      elements,
    }
  }
}

/** Keep the last `max` chars, prefixing with an ellipsis when truncated. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text
  return `…${text.slice(text.length - max)}`
}
