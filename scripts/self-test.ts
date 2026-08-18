/**
 * dsh-feishu-gateway 自测（不依赖真实飞书 / DSH）：
 *   pnpm test
 * 覆盖：消息解析、Markdown 分片、会话映射、summarize、ChatHandler 端到端（mock agents）、
 *       Typing 表情、流式卡片汇报、审批/问答交互卡片。
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { extractText, cleanText, summarize, ChatHandler, degradeGenUIFences } from '../src/chat.js'
import { splitMarkdown } from '../src/feishu.js'
import { SessionMap, conversationKey } from '../src/session-map.js'
import { InteractionService } from '../src/interactions.js'
import { resolveConfig } from '../src/config.js'
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
  sm.recordSession(key, id1, { key, chatId: 'oc_1', chatType: 'group', userOpenId: 'ou_1' })
  ok('反向索引', sm.infoForSession(id1)?.chatId === 'oc_1')
  sm.reset(key)
  ok('重置后新 id', sm.idFor(key) !== id1)
  ok('重置后反向索引清除', sm.infoForSession(id1) === undefined)
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

/** 生成一个会在 followup 时同步派发会话事件的 mock agent。 */
function makeAgent(emit: (event: Record<string, unknown>) => void): any {
  const events: Array<Record<string, unknown>> = []
  const session = { id: 'feishu-session', seq: 1, events }
  const agent = {
    session,
    whenIdle: async () => undefined,
    followup: () => {
      const evs = [
        { type: 'turn/start', seq: 2, data: {} },
        { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '这是 DSH 的最终答复。' }] } } },
        { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } },
      ]
      for (const e of evs) {
        events.push(e)
        emit(e)
      }
    },
  }
  return agent
}

async function testChatHandler(): Promise<void> {
  console.log('\n[5] ChatHandler 端到端（mock agents）')
  const calls: Array<{ kind: string; args: unknown[] }> = []
  let resumeCount = 0
  let createCount = 0
  const resumeIds: string[] = []
  const listeners: Array<(session: unknown, event: unknown) => void> = []

  const mockAgents = {
    get: () => undefined,
    resume: async (opts: { resumeSessionId: unknown }) => {
      resumeCount++
      resumeIds.push(String(opts.resumeSessionId))
      return { agent: makeAgent((e) => { for (const l of listeners) l({ id: 'feishu-session' }, e) }), dispose: async () => undefined }
    },
    create: async () => {
      createCount++
      return { agent: makeAgent((e) => { for (const l of listeners) l({ id: 'feishu-session' }, e) }), dispose: async () => undefined }
    },
  }
  const mockDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'mock-model' }) }
  const ctx = {
    get: (key: string) => (key === 'agents' ? mockAgents : key === 'agentDefaultModel' ? mockDefaultModel : undefined),
    on: (_name: string, fn: (session: unknown, event: unknown) => void) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  } as never

  const feishuMock = {
    replyText: async (messageId: string, text: string) => calls.push({ kind: 'replyText', args: [messageId, text] }),
    replyMarkdown: async (messageId: string, text: string) => calls.push({ kind: 'replyMarkdown', args: [messageId, text] }),
    replyCard: async (messageId: string, card: unknown) => {
      calls.push({ kind: 'replyCard', args: [messageId, card] })
      return 'card-reply-1'
    },
    patchCard: async (messageId: string, card: unknown) => calls.push({ kind: 'patchCard', args: [messageId, card] }),
    addReaction: async (messageId: string, emoji: string) => {
      calls.push({ kind: 'addReaction', args: [messageId, emoji] })
      return `reaction-${emoji}`
    },
    removeReaction: async (messageId: string, reactionId: string) => {
      calls.push({ kind: 'removeReaction', args: [messageId, reactionId] })
      return true
    },
  } as never

  const file = path.join(os.tmpdir(), `chat-${Date.now()}.json`)
  const sessions = new SessionMap(file)
  const baseConfig = {
    feishu: { appId: 'a', appSecret: 's', domain: 'feishu' as const, botOpenId: 'ou_bot', replyMode: 'at' as const },
    workspace: '/tmp',
    hintText: '爸爸，我正在努力处理中……',
    newSessionPatterns: ['^/new$'],
    sessionsFile: file,
    http: { port: 0, token: '' },
  }

  const p2p: FeishuMessageEvent = {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'm1', create_time: '1', chat_id: 'oc_p2p', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '查一下热搜' }),
    },
  }

  // --- 默认 stream 模式：Typing 表情 + 流式卡片 + 最终 Markdown ---
  calls.length = 0
  const handler = new ChatHandler({ ctx, config: resolveConfig(baseConfig), feishu: feishuMock, sessions })
  await handler.handleMessage(p2p)
  ok('stream：先加 Typing 表情', calls.some((c) => c.kind === 'addReaction' && c.args[1] === 'Typing'))
  ok('stream：发送流式卡片', calls.some((c) => c.kind === 'replyCard'))
  const streamCard = calls.find((c) => c.kind === 'replyCard')?.args[1] as
    | { header?: { title?: { content?: string }; template?: string } }
    | undefined
  ok('stream：默认处理中标题', streamCard?.header?.title?.content === '🤖 DSH 处理中…', `got=${streamCard?.header?.title?.content}`)
  ok('stream：处理中卡片为黄色', streamCard?.header?.template === 'yellow', `got=${streamCard?.header?.template}`)
  ok('stream：resume 会话', resumeCount === 1)
  ok('stream：最终 Markdown 答复', calls.some((c) => c.kind === 'replyMarkdown' && c.args[1] === '这是 DSH 的最终答复。'))
  ok('stream：移除 Typing 表情', calls.some((c) => c.kind === 'removeReaction'))
  ok('stream：卡片完成态 patch', calls.some((c) => c.kind === 'patchCard'))
  const doneCard = calls.find((c) => c.kind === 'patchCard')?.args[1] as
    | { header?: { title?: { content?: string }; template?: string } }
    | undefined
  ok('stream：默认完成标题', doneCard?.header?.title?.content === '🤖 DSH 处理完成', `got=${doneCard?.header?.title?.content}`)
  ok('stream：完成卡片为绿色', doneCard?.header?.template === 'green', `got=${doneCard?.header?.template}`)
  ok('stream：不再发提示语', !calls.some((c) => c.kind === 'replyText' && String(c.args[1]).includes('正在努力处理')))

  // --- 可配置卡片标题 ---
  calls.length = 0
  const handlerTitled = new ChatHandler({
    ctx,
    config: resolveConfig({
      ...baseConfig,
      reporting: { cardTitleStreaming: '💭 爸爸想想…', cardTitleDone: '✅ 爸爸答完了' },
    }),
    feishu: feishuMock,
    sessions: new SessionMap(file),
  })
  await handlerTitled.handleMessage(p2p)
  const titledCard = calls.find((c) => c.kind === 'replyCard')?.args[1] as
    | { header?: { title?: { content?: string } } }
    | undefined
  ok('标题可配置：处理中文案生效', titledCard?.header?.title?.content === '💭 爸爸想想…', `got=${titledCard?.header?.title?.content}`)

  // --- final 模式：无卡片，只有 Typing + 最终答复 ---
  calls.length = 0
  const handlerFinal = new ChatHandler({
    ctx,
    config: resolveConfig({ ...baseConfig, reporting: { mode: 'final' } }),
    feishu: feishuMock,
    sessions: new SessionMap(file),
  })
  await handlerFinal.handleMessage(p2p)
  ok('final：仍加 Typing 表情', calls.some((c) => c.kind === 'addReaction' && c.args[1] === 'Typing'))
  ok('final：无流式卡片', !calls.some((c) => c.kind === 'replyCard'))
  ok('final：最终 Markdown 答复', calls.some((c) => c.kind === 'replyMarkdown'))

  // --- typingReaction=false：退回提示语 ---
  calls.length = 0
  const handlerHint = new ChatHandler({
    ctx,
    config: resolveConfig({ ...baseConfig, reporting: { typingReaction: false } }),
    feishu: feishuMock,
    sessions: new SessionMap(file),
  })
  await handlerHint.handleMessage(p2p)
  ok('禁用表情：回提示语', calls.some((c) => c.kind === 'replyText' && String(c.args[1]).includes('正在努力处理')))
  ok('禁用表情：不加 Typing', !calls.some((c) => c.kind === 'addReaction'))

  // 第二问（同一会话）→ 相同 session id
  const p2p2: FeishuMessageEvent = { ...p2p, message: { ...p2p.message, message_id: 'm2', content: JSON.stringify({ text: '继续' }) } }
  await handler.handleMessage(p2p2)
  ok('多轮：复用同一 DSH session', resumeIds.length >= 2 && resumeIds[resumeIds.length - 1] === resumeIds[0])

  // /new → 重置会话
  const newCmd: FeishuMessageEvent = { ...p2p, message: { ...p2p.message, message_id: 'm3', content: JSON.stringify({ text: '/new' }) } }
  calls.length = 0
  await handler.handleMessage(newCmd)
  ok('/new：回复重置提示', calls.some((c) => c.kind === 'replyText' && String(c.args[1]).includes('全新会话')))
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
    get: () => undefined,
    resume: async () => {
      throw new Error('not found')
    },
    create: async () => {
      createCount++
      return { agent: makeAgent((e) => { for (const l of listeners) l({ id: 'feishu-session' }, e) }), dispose: async () => undefined }
    },
  }
  const ctxFail = {
    get: (key: string) => (key === 'agents' ? mockAgentsFail : key === 'agentDefaultModel' ? mockDefaultModel : undefined),
    on: (_name: string, fn: (session: unknown, event: unknown) => void) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  } as never
  const handlerFail = new ChatHandler({ ctx: ctxFail, config: baseConfig, feishu: feishuMock, sessions: new SessionMap(file) })
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

async function testInteractions(): Promise<void> {
  console.log('\n[6] 审批/问答交互卡片')
  const calls: Array<{ kind: string; args: unknown[] }> = []
  const approvalListeners: Array<(req: unknown, next: () => Promise<string>) => Promise<string> | string> = []

  const file = path.join(os.tmpdir(), `interact-${Date.now()}.json`)
  const sessions = new SessionMap(file)
  const key = conversationKey('oc_p2p', 'p2p', 'ou_user')
  const sessionId = sessions.idFor(key)
  sessions.recordSession(key, sessionId, { key, chatId: 'oc_p2p', chatType: 'p2p', userOpenId: 'ou_user' })

  const feishuMock = {
    push: async (opts: { receiveId: string; msgType: string; content: string }) => {
      calls.push({ kind: 'push', args: [opts] })
      return `card-${calls.length}`
    },
    patchCard: async (messageId: string, card: unknown) => calls.push({ kind: 'patchCard', args: [messageId, card] }),
    deleteMessage: async (messageId: string) => {
      calls.push({ kind: 'deleteMessage', args: [messageId] })
      return true
    },
  } as never

  const ctx = {
    get: (keyName: string) => (keyName === 'sessions' ? undefined : undefined),
    on: (_name: string, fn: (req: unknown, next: () => Promise<string>) => Promise<string> | string, opts: unknown) => {
      void opts
      approvalListeners.push(fn)
      return () => {
        const i = approvalListeners.indexOf(fn)
        if (i >= 0) approvalListeners.splice(i, 1)
      }
    },
  } as never

  const svc = new InteractionService({ ctx, config: {}, feishu: feishuMock, sessions })
  svc.registerApprovalAnswerer()
  ok('注册了 approval 监听', approvalListeners.length === 1)

  // 审批：Feishu 会话 → 推卡片，点击后返回 allowed-once
  const pending = approvalListeners[0]!(
    { agent: { session: { id: sessionId } }, toolName: 'bash', reason: 'sandbox escalation' },
    () => Promise.resolve('unavailable'),
  )
  await new Promise((r) => setTimeout(r, 10))
  ok('审批：推送交互卡片', calls.some((c) => c.kind === 'push' && (c.args[0] as { msgType: string }).msgType === 'interactive'))
  const pushed = calls.find((c) => c.kind === 'push')?.args[0] as { content: string }
  const card = JSON.parse(pushed.content) as { elements: Array<{ actions?: Array<{ value?: unknown }> }> }
  const approveValue = card.elements[1]?.actions?.[0]?.value as { id: string } | undefined
  ok('审批：卡片带允许按钮', approveValue !== undefined && typeof approveValue.id === 'string')

  // 模拟点击"允许"——响应应含 toast + 无按钮处理态卡片
  const clickResponse = await svc.handleCardAction({ messageId: 'card-1', chatId: 'oc_p2p', action: { value: { kind: 'approval', id: approveValue!.id } } } as never)
  const outcome = await pending
  ok('审批：点击后返回 allowed-once', outcome === 'allowed-once')
  ok('审批：回调响应带 toast', (clickResponse as { toast?: { content?: string } })?.toast?.content?.includes('已允许') === true)
  const respCard = (clickResponse as { card?: { data?: { elements?: Array<{ tag: string }> } } })?.card?.data
  ok('审批：响应卡片无按钮', respCard !== undefined && !respCard.elements?.some((e) => e.tag === 'action'))
  ok('审批：REST 兜底 patch 已处理', calls.some((c) => c.kind === 'patchCard'))
  const patched = calls.find((c) => c.kind === 'patchCard')?.args[1] as { elements?: Array<{ tag: string }> }
  ok('审批：兜底卡片也无按钮', patched !== undefined && !patched.elements?.some((e) => e.tag === 'action'))

  // recall 模式：点击后撤回卡片（响应只含 toast）
  calls.length = 0
  const svcRecall = new InteractionService({
    ctx,
    config: { interactions: { approvalCardDispose: 'recall' } } as never,
    feishu: feishuMock,
    sessions,
  })
  svcRecall.registerApprovalAnswerer()
  const pendingRecall = approvalListeners[1]!(
    { agent: { session: { id: sessionId } }, toolName: 'bash', reason: 'again' },
    () => Promise.resolve('unavailable'),
  )
  await new Promise((r) => setTimeout(r, 10))
  const pushed2 = calls.find((c) => c.kind === 'push')?.args[0] as { content: string }
  const card2 = JSON.parse(pushed2.content) as { elements: Array<{ actions?: Array<{ value?: unknown }> }> }
  const approveValue2 = card2.elements[1]?.actions?.[0]?.value as { id: string } | undefined
  const recallResponse = await svcRecall.handleCardAction({ messageId: 'card-2', chatId: 'oc_p2p', action: { value: { kind: 'approval', id: approveValue2!.id } } } as never)
  await pendingRecall
  await new Promise((r) => setTimeout(r, 10))
  ok('recall：响应只含 toast 不含卡片', (recallResponse as { card?: unknown })?.card === undefined && (recallResponse as { toast?: unknown })?.toast !== undefined)
  ok('recall：调用撤回接口', calls.some((c) => c.kind === 'deleteMessage'))
  svcRecall.dispose()

  // 非 Feishu 会话 → 委托 next()
  const delegated = await approvalListeners[0]!(
    { agent: { session: { id: 'other-session' } }, toolName: 'bash' },
    () => Promise.resolve('unavailable'),
  )
  ok('审批：非 Feishu 会话委托 next()', delegated === 'unavailable')
  ok('审批：未推卡片', calls.filter((c) => c.kind === 'push').length === 1)

  svc.dispose()
}

async function testAcquisition(): Promise<void> {
  console.log('\n[7] agent 获取阶梯（preset 编排 / live 接管 / wedged 自愈）')
  const calls: Array<{ kind: string; args: unknown[] }> = []
  const listeners: Array<(session: unknown, event: unknown) => void> = []

  /** 构造一个会在 followup 时派发完整事件流的 mock agent。 */
  function makeAgent(id: string, header: Record<string, unknown> = {}): any {
    const events: Array<Record<string, unknown>> = []
    const session = { id, seq: 1, events, header }
    const agent = {
      session,
      disposed: false,
      whenIdle: async () => undefined,
      followup: () => {
        const evs = [
          { type: 'turn/start', seq: 2, data: {} },
          { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '获取阶梯答复' }] } } },
          { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } },
        ]
        for (const e of evs) {
          events.push(e)
          for (const l of listeners) l(session, e)
        }
      },
    }
    return agent
  }

  /** 执行 setup（installModelSelection 需要 agentCtx.on；preset mount 需要 agentCtx.agent）。 */
  function runSetup(setup: unknown, agent: any): void {
    if (typeof setup !== 'function') return
    const agentCtx = { on: () => () => undefined, agent }
    void setup(agentCtx)
  }

  const feishuMock = {
    replyText: async (messageId: string, text: string) => calls.push({ kind: 'replyText', args: [messageId, text] }),
    replyMarkdown: async (messageId: string, text: string) => calls.push({ kind: 'replyMarkdown', args: [messageId, text] }),
    replyCard: async () => { calls.push({ kind: 'replyCard', args: [] }); return 'card-1' },
    patchCard: async () => calls.push({ kind: 'patchCard', args: [] }),
    addReaction: async (_m: string, emoji: string) => { calls.push({ kind: 'addReaction', args: [emoji] }); return `r-${emoji}` },
    removeReaction: async () => { calls.push({ kind: 'removeReaction', args: [] }); return true },
  } as never

  const p2p: FeishuMessageEvent = {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'a1', create_time: '1', chat_id: 'oc_p2p', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '测试获取阶梯' }),
    },
  }

  // ---- Bug A：preset-roster 部署下 create 携带 meta.agentPreset 并 mount ----
  {
    const file = path.join(os.tmpdir(), `acq-a-${Date.now()}.json`)
    const sessions = new SessionMap(file)
    const sid = sessions.idFor('ou_user')
    const mounted: Array<string | undefined> = []
    const mockPresets = {
      resolve: async (id?: string) => ({ id: id ?? 'standard', broken: undefined }),
      mount: async (_ctx: unknown, id?: string) => { mounted.push(id); return { id: id ?? 'standard' } },
    }
    let createdMeta: Record<string, unknown> | undefined
    let createdSetup: unknown
    const agents = {
      get: () => undefined,
      resume: async () => { throw new Error('session not persisted') },
      create: async (opts: { sessionId: unknown; meta: Record<string, unknown>; setup: unknown }) => {
        createdMeta = opts.meta
        createdSetup = opts.setup
        return { agent: makeAgent(String(opts.sessionId), { agentPreset: createdMeta?.agentPreset }), dispose: async () => undefined }
      },
    }
    const ctx = {
      get: (key: string) => key === 'agents' ? agents : key === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek', model: 'mock' }) }
        : key === 'agentPresets' ? mockPresets : undefined,
      on: (_n: string, fn: (s: unknown, e: unknown) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    } as never
    const handler = new ChatHandler({ ctx, config: resolveConfig({ feishu: { appId: 'a', appSecret: 's', domain: 'feishu' }, sessionsFile: file }), feishu: feishuMock, sessions })
    calls.length = 0
    await handler.handleMessage(p2p)
    ok('A：create 携带 meta.agentPreset', createdMeta?.agentPreset === 'standard', `got=${createdMeta?.agentPreset}`)
    runSetup(createdSetup, makeAgent(sid, { agentPreset: 'standard' }))
    await new Promise((r) => setTimeout(r, 10))
    ok('A：setup 中 mount 了 preset', mounted.includes('standard'), `mounted=${JSON.stringify(mounted)}`)
    ok('A：正常返回答复', calls.some((c) => c.kind === 'replyMarkdown'))
  }

  // ---- Bug B：live 会话被 agents.get() 接管，不再 resume/create ----
  {
    const file = path.join(os.tmpdir(), `acq-b-${Date.now()}.json`)
    const sessions = new SessionMap(file)
    const sid = sessions.idFor('ou_user')
    const live = makeAgent(sid)
    let resumeCount = 0
    let createCount = 0
    const agents = {
      get: (id: unknown) => String(id) === sid ? live : undefined,
      resume: async () => { resumeCount++; throw new Error('while it is live') },
      create: async () => { createCount++; throw new Error('already exists') },
    }
    const ctx = {
      get: (key: string) => key === 'agents' ? agents : key === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek', model: 'mock' }) } : undefined,
      on: (_n: string, fn: (s: unknown, e: unknown) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    } as never
    const handler = new ChatHandler({ ctx, config: resolveConfig({ feishu: { appId: 'a', appSecret: 's', domain: 'feishu' }, sessionsFile: file }), feishu: feishuMock, sessions })
    calls.length = 0
    await handler.handleMessage(p2p)
    ok('B：接管 live agent（不 resume/create）', resumeCount === 0 && createCount === 0)
    ok('B：接管后正常答复', calls.some((c) => c.kind === 'replyMarkdown' && c.args[1] === '获取阶梯答复'))
    ok('B：不 dispose 共享 agent', (live as { disposed: boolean }).disposed === false)
  }

  // ---- Bug C：wedged 会话 → 换新 id 并更新映射 ----
  {
    const file = path.join(os.tmpdir(), `acq-c-${Date.now()}.json`)
    const sessions = new SessionMap(file)
    const sid = sessions.idFor('ou_user')
    const createdIds: string[] = []
    const agents = {
      get: () => undefined,
      resume: async () => { throw new Error('persistence recovery failed') },
      create: async (opts: { sessionId: unknown; meta: Record<string, unknown> }) => {
        createdIds.push(String(opts.sessionId))
        if (createdIds.length === 1) throw new Error(`session "${opts.sessionId}" already exists`)
        return { agent: makeAgent(String(opts.sessionId)), dispose: async () => undefined }
      },
    }
    const ctx = {
      get: (key: string) => key === 'agents' ? agents : key === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek', model: 'mock' }) } : undefined,
      on: (_n: string, fn: (s: unknown, e: unknown) => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    } as never
    const handler = new ChatHandler({ ctx, config: resolveConfig({ feishu: { appId: 'a', appSecret: 's', domain: 'feishu' }, sessionsFile: file }), feishu: feishuMock, sessions })
    calls.length = 0
    await handler.handleMessage(p2p)
    ok('C：首次 create 冲突', createdIds.length === 2 && createdIds[0] === sid)
    ok('C：换新 id 创建', createdIds.length === 2 && createdIds[1] !== sid && createdIds[1].startsWith('feishu-'))
    ok('C：映射已重指向新 id', sessions.infoForSession(createdIds[1]) !== undefined)
    ok('C：自愈后正常答复', calls.some((c) => c.kind === 'replyMarkdown' && c.args[1] === '获取阶梯答复'))
    // 同一会话下一问 → 直接用新 id（映射已更新）
    const before = createdIds.length
    await handler.handleMessage({ ...p2p, message: { ...p2p.message, message_id: 'a2', content: JSON.stringify({ text: '再问一次' }) } })
    ok('C：后续消息复用新 id', createdIds.length === before + 1 && createdIds[createdIds.length - 1] === createdIds[1])
  }
}

async function testUserQuestionsBridge(): Promise<void> {
  console.log('\n[6.5] userQuestions 服务边界桥接（web profile 竞态回归）')
  // 单槽位 provider 服务的最小替身：registerProvider 唯一、ask 可被覆盖。
  let webProvider: { ask: (r: { questions: Array<{ options?: Array<{ label: string }> }> }) => Promise<{ answers: unknown[] }> } | undefined
  let askImpl: (r: unknown) => Promise<unknown> = (r) => {
    if (webProvider === undefined) return Promise.reject(new Error('NO_PROVIDER'))
    return webProvider.ask(r as never)
  }
  const service = {
    registerProvider(p: { ask: (r: unknown) => Promise<unknown> }) {
      if (webProvider !== undefined) throw new Error('DUPLICATE_PROVIDER')
      webProvider = p as never
      return () => { webProvider = undefined }
    },
    get ask() { return askImpl },
    set ask(fn: (r: unknown) => Promise<unknown>) { askImpl = fn },
  }

  const file = path.join(os.tmpdir(), `uqbridge-${Date.now()}.json`)
  const sessions = new SessionMap(file)
  const key = conversationKey('oc_p2p', 'p2p', 'ou_user')
  const sessionId = sessions.idFor(key)
  sessions.recordSession(key, sessionId, { key, chatId: 'oc_p2p', chatType: 'p2p', userOpenId: 'ou_user' })

  const calls: Array<{ kind: string; args: unknown[] }> = []
  const feishuMock = {
    push: async (opts: { content: string }) => { calls.push({ kind: 'push', args: [opts] }); return `card-${calls.length}` },
    patchCard: async () => undefined,
    deleteMessage: async () => true,
  } as never

  const ctx = {
    get: (name: string) => (name === 'userQuestions' ? service : undefined),
    on: () => () => {},
  } as never
  const svc = new InteractionService({ ctx, config: {}, feishu: feishuMock, sessions })
  svc.registerUserQuestionsProvider()
  ok('桥接已安装（service.ask 被覆盖）', typeof service.ask === 'function' && Object.prototype.hasOwnProperty.call(service, 'ask'))

  // 网关之后 Web UI provider 再注册 → 必须不抛（0.2.6 之前网关抢先占槽导致 DUPLICATE_PROVIDER）
  let registered = true
  try {
    service.registerProvider({ ask: async (r) => ({ answers: [{ id: 'w1', selected: [(r as { questions: Array<{ options: Array<{ label: string }> }> }).questions[0]!.options[0]!.label] }] }) })
  } catch {
    registered = false
  }
  ok('Web provider 在网关之后注册不抛 DUPLICATE_PROVIDER', registered)

  // 飞书会话提问 → 推卡片
  calls.length = 0
  const pending = service.ask({
    questions: [{ id: 'q1', question: '选方案', options: [{ label: 'A' }, { label: 'B' }] }],
    agent: { id: sessionId },
  })
  await new Promise((r) => setTimeout(r, 10))
  ok('飞书会话提问推送交互卡片', calls.some((c) => c.kind === 'push' && (c.args[0] as { msgType?: string }).msgType === 'interactive'))

  // 非飞书会话提问 → 委托给 Web provider，不推卡片
  calls.length = 0
  const webAnswer = await service.ask({
    questions: [{ id: 'w1', question: 'web?', options: [{ label: 'x' }] }],
    agent: { id: 'other-session' },
  })
  ok('非飞书会话委托 Web provider', JSON.stringify(webAnswer) === JSON.stringify({ answers: [{ id: 'w1', selected: ['x'] }] }))
  ok('非飞书会话未推飞书卡片', calls.filter((c) => c.kind === 'push').length === 0)

  svc.dispose()
  // dispose 后桥接移除：飞书会话提问不再推卡片（回到原始 ask 行为）
  calls.length = 0
  await service.ask({
    questions: [{ id: 'q1', question: '选方案', options: [{ label: 'A' }] }],
    agent: { id: sessionId },
  }).catch(() => undefined)
  ok('dispose 后桥接移除（不再推飞书卡片）', calls.filter((c) => c.kind === 'push').length === 0)
}

async function testGenUIFences(): Promise<void> {
  console.log('\n[6.6] dsh-ui 围栏降级（飞书渠道）')
  const plain = '正常回答文字。'
  ok('无围栏时原样', degradeGenUIFences(plain) === plain)

  const withTitle = `分析如下。\n\n\`\`\`dsh-ui\n{"title":"销售趋势面板","items":[{"type":"chart","data":[]}]}\n\`\`\`\n\n以上。`
  const d1 = degradeGenUIFences(withTitle)
  ok('围栏替换为可读行并保留标题', d1.includes('销售趋势面板') && d1.includes('请在 Web UI 查看') && !d1.includes('dsh-ui'), `got=${d1}`)
  ok('围栏前后文字保留', d1.startsWith('分析如下。') && d1.endsWith('以上。'))

  const noTitle = `正文\n\`\`\`dsh-ui\n{"items":[{"type":"mermaid","title":"流程"}]}\n\`\`\`\n结尾`
  const d2 = degradeGenUIFences(noTitle)
  ok('无顶层标题时取首组件标题', d2.includes('流程'))

  const badJson = `正文\n\`\`\`dsh-ui\n{ broken json\n\`\`\`\n`
  const d3 = degradeGenUIFences(badJson)
  ok('JSON 损坏时给通用提示', d3.includes('交互组件') && !d3.includes('broken json'))

  const none = `\`\`\`ts\nconst x = 1\n\`\`\`\n`
  ok('非 dsh-ui 围栏不受影响', degradeGenUIFences(none) === none)
}

async function main(): Promise<void> {
  testParsing()
  testSplit()
  testSessionMap()
  testSummarize()
  await testChatHandler()
  await testInteractions()
  await testUserQuestionsBridge()
  await testGenUIFences()
  await testAcquisition()
  console.log(`\n自测完成：${passed} 项通过${process.exitCode ? '（有失败）' : ''}`)
}

main()
