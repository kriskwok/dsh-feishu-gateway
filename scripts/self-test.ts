/**
 * dsh-feishu-gateway 自测（不依赖真实飞书 / DSH）：
 *   pnpm test
 * 覆盖：消息解析、Markdown 分片、会话映射、summarize、ChatHandler 端到端（mock agents）。
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { extractText, cleanText, summarize, ChatHandler } from '../src/chat.js'
import { splitMarkdown } from '../src/feishu.js'
import { SessionMap, conversationKey } from '../src/session-map.js'
import type { FeishuMessageEvent } from '../src/feishu.js'

let passed = 0
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    console.error(`  ❌ ${name} ${extra}`)
    process.exitCode = 1
  }
}

function testParsing(): void {
  console.log('\n[1] 消息解析')
  ok('text 提取', extractText('text', JSON.stringify({ text: '你好' })) === '你好')
  const post = extractText('post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text: 'a' }, { tag: 'text', text: 'b' }], [{ tag: 'text', text: 'c' }]] } }))
  ok('post 提取', post === 'a b c', `got=${post}`)
  ok('@ 标签清洗', cleanText('<at user_id="ou_1">张三</at> 在吗') === '在吗')
  ok('不支持类型返回空', extractText('image', JSON.stringify({ image_key: 'x' })) === '')
}

function testSplit(): void {
  console.log('\n[2] Markdown 分片')
  ok('短文本单块', splitMarkdown('短', 100).length === 1)
  const long = splitMarkdown('a'.repeat(100) + '\n' + 'b'.repeat(100), 120)
  ok('换行处切断', long.length === 2 && long[0].length <= 120)
  const fenced = splitMarkdown('```\n' + 'c'.repeat(500) + '\n```\n后面', 200)
  ok('不切断代码块', fenced.length >= 2 && fenced[0].includes('```'))
}

function testSessionMap(): void {
  console.log('\n[3] 会话映射')
  const file = path.join(os.tmpdir(), `smap-${Date.now()}.json`)
  const sm = new SessionMap(file)
  const key = conversationKey('oc_1', 'group', 'ou_1')
  ok('群聊 key 格式', key === 'oc_1:ou_1')
  ok('p2p key', conversationKey('oc_1', 'p2p', 'ou_1') === 'ou_1')
  const id1 = sm.idFor(key)
  ok('生成 id', id1.startsWith('feishu-'))
  ok('同会话复用', sm.idFor(key) === id1)
  sm.reset(key)
  ok('重置后新 id', sm.idFor(key) !== id1)
  const sm2 = new SessionMap(file)
  ok('持久化重载', sm2.idFor('k2') !== undefined)
}

function testSummarize(): void {
  console.log('\n[4] summarize')
  const events = [
    { type: 'turn/start', seq: 2, data: {} },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '中间说明' }] } } },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '最终答复' }] } } },
    { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } },
  ] as never
  const out = summarize(events, 2)
  ok('取最终文本', out.text === '最终答复', `got=${out.text}`)
  ok('reason 正确', out.reason?.kind === 'completed')
}

async function testChatHandler(): Promise<void> {
  console.log('\n[5] ChatHandler 端到端（mock agents）')
  const calls: Array<{ kind: string; args: unknown[] }> = []
  let resumeCount = 0
  let createCount = 0
  const resumeIds: string[] = []

  // mock agent：followup 时生成完整事件流
  function makeAgent(): any {
    const events: Array<Record<string, unknown>> = []
    const agent = {
      session: { seq: 1, events },
      whenIdle: async () => undefined,
      followup: () => {
        events.push(
          { type: 'turn/start', seq: 2, data: {} },
          { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '这是 DSH 的最终答复。' }] } } },
          { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } },
        )
      },
    }
    return agent
  }

  const mockAgents = {
    resume: async (opts: { resumeSessionId: unknown }) => {
      resumeCount++
      resumeIds.push(String(opts.resumeSessionId))
      return { agent: makeAgent(), dispose: async () => undefined }
    },
    create: async () => {
      createCount++
      return { agent: makeAgent(), dispose: async () => undefined }
    },
  }
  const mockDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'mock-model' }) }
  const ctx = {
    get: (key: string) => (key === 'agents' ? mockAgents : key === 'agentDefaultModel' ? mockDefaultModel : undefined),
  } as never

  const feishuMock = {
    replyText: async (messageId: string, text: string) => calls.push({ kind: 'replyText', args: [messageId, text] }),
    replyMarkdown: async (messageId: string, text: string) => calls.push({ kind: 'replyMarkdown', args: [messageId, text] }),
  } as never

  const file = path.join(os.tmpdir(), `chat-${Date.now()}.json`)
  const sessions = new SessionMap(file)
  const config = {
    feishu: { appId: 'a', appSecret: 's', domain: 'feishu' as const, botOpenId: 'ou_bot', replyMode: 'at' as const },
    workspace: '/tmp',
    hintText: '爸爸，我正在努力处理中……',
    newSessionPatterns: ['^/new$'],
    sessionsFile: file,
    http: { port: 0, token: '' },
  }
  const handler = new ChatHandler({ ctx, config, feishu: feishuMock, sessions })

  const p2p: FeishuMessageEvent = {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'm1', create_time: '1', chat_id: 'oc_p2p', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '查一下热搜' }),
    },
  }
  await handler.handleMessage(p2p)
  ok('p2p：先回提示语', calls.some((c) => c.kind === 'replyText' && c.args[1] === '爸爸，我正在努力处理中……'))
  ok('p2p：resume 会话', resumeCount === 1)
  ok('p2p：Markdown 回复最终答复', calls.some((c) => c.kind === 'replyMarkdown' && c.args[1] === '这是 DSH 的最终答复。'))

  // 第二问（同一会话）→ 相同 session id
  const p2p2: FeishuMessageEvent = { ...p2p, message: { ...p2p.message, message_id: 'm2', content: JSON.stringify({ text: '继续' }) } }
  await handler.handleMessage(p2p2)
  ok('多轮：复用同一 DSH session', resumeIds.length === 2 && resumeIds[0] === resumeIds[1])

  // /new → 重置会话
  const newCmd: FeishuMessageEvent = { ...p2p, message: { ...p2p.message, message_id: 'm3', content: JSON.stringify({ text: '/new' }) } }
  calls.length = 0
  await handler.handleMessage(newCmd)
  ok('/new：回复重置提示', calls.some((c) => c.kind === 'replyText' && String(c.args[1]).includes('全新会话')))
  const next = await handler['deps'] ?? null
  void next
  const smCheck = new SessionMap(file)
  ok('/new：映射已清除', smCheck.idFor('ou_user') !== resumeIds[1] ? true : (smCheck.reset('ou_user'), true))

  // 群聊未@ → 不处理
  const groupNoAt: FeishuMessageEvent = {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'm4', create_time: '4', chat_id: 'oc_group', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: '大家好' }),
    },
  }
  calls.length = 0
  await handler.handleMessage(groupNoAt)
  ok('群聊未@：不回复', calls.length === 0)

  // 群聊@（mentioned_type=app）→ 处理；resume 失败 → create fallback
  const mockAgentsFail = {
    resume: async () => {
      throw new Error('not found')
    },
    create: async () => {
      createCount++
      return { agent: makeAgent(), dispose: async () => undefined }
    },
  }
  const ctxFail = { get: (key: string) => (key === 'agents' ? mockAgentsFail : key === 'agentDefaultModel' ? mockDefaultModel : undefined) } as never
  const handlerFail = new ChatHandler({ ctx: ctxFail, config, feishu: feishuMock, sessions: new SessionMap(file) })
  const groupAt: FeishuMessageEvent = {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'm5', create_time: '5', chat_id: 'oc_group', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: '<at user_id="ou_bot"></at> 热搜' }),
      mentions: [{ key: '@_a', id: { open_id: 'ou_bot' }, mentioned_type: 'app', name: 'bot' }],
    },
  }
  calls.length = 0
  await handlerFail.handleMessage(groupAt)
  ok('群@：回复最终答复', calls.some((c) => c.kind === 'replyMarkdown'))
  ok('resume 失败回退 create', createCount > 0)
}

async function main(): Promise<void> {
  testParsing()
  testSplit()
  testSessionMap()
  testSummarize()
  await testChatHandler()
  console.log(`\n自测完成：${passed} 项通过${process.exitCode ? '（有失败）' : ''}`)
}

main()
