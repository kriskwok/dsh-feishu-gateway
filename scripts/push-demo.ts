#!/usr/bin/env tsx
/**
 * 主动推送演示：在任意 DSH 环境外也可用（读取环境变量配置）。
 *   FEISHU_APP_ID=xx FEISHU_APP_SECRET=xx pnpm push:demo -- --to <open_id|chat_id> --text "内容"
 */
import { FeishuClient } from '../src/feishu.js'
import { PushService } from '../src/push.js'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--to' || a === '--text' || a === '--type' || a === '--uuid') {
      out[a.slice(2)] = argv[i + 1] ?? ''
      i++
    } else if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] ?? ''
      i++
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const to = args.to
  const text = args.text ?? '👋 这是来自 dsh-feishu-gateway 的主动推送测试消息！'
  if (!to) {
    console.error('用法: pnpm push:demo -- --to <open_id|chat_id> --text "内容" [--type open_id|chat_id]')
    process.exit(1)
  }
  const appId = process.env.FEISHU_APP_ID ?? ''
  const appSecret = process.env.FEISHU_APP_SECRET ?? ''
  if (!appId || !appSecret) {
    console.error('请设置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量')
    process.exit(1)
  }

  const feishu = new FeishuClient({ appId, appSecret, domain: 'feishu' })
  const push = new PushService(feishu)
  const type = (args.type === 'chat_id' ? 'chat_id' : 'open_id') as 'open_id' | 'chat_id'
  const messageId = await push.pushText(to, text, type, `demo-${Date.now()}`)
  console.log(`推送成功 message_id=${messageId}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('推送失败:', err)
  process.exit(1)
})
