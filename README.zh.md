# dsh-feishu-gateway

[![npm version](https://img.shields.io/npm/v/@kriskwok/dsh-feishu-gateway)](https://www.npmjs.com/package/@kriskwok/dsh-feishu-gateway)
[![License: MIT](https://img.shields.io/npm/l/@kriskwok/dsh-feishu-gateway)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/kriskwok/dsh-feishu-gateway)](https://github.com/kriskwok/dsh-feishu-gateway)

[English](README.md) | 中文

在**飞书（Feishu/Lark）**里与你的 **DeepSeek Harness（DSH）** agent 对话。

这是一个 DSH 插件 bundle：挂载飞书长连接监听器，每条飞书消息路由到**稳定的 DSH 会话**
（通过 `agents` 服务的 resume 恢复，多轮对话保持在同一个会话），agent 的答复以
Markdown 富文本（post 消息的 md 标签）回复。支持 `/new` 开启全新会话、
原生 **Typing 表情**处理中指示、长任务的**流式进度卡片**、权限审批与
`ask_user_question` 的**点击即答卡片**、以及主动推送。

## 功能

- 💬 **完整对话** — 飞书私聊 / 群聊 @机器人 → DSH agent → 回复
- 🔁 **会话保持** — 每个飞书会话对应一个 DSH 会话（`agents.resume` / `agents.create`）；
  发 `/new`（或"另起会话 / 新会话 / 重新开始 / 换个话题"）开启全新会话
- ⌨️ **原生 Typing 指示** — 处理期间机器人在你的消息上加一个 `Typing` 表情回复
  （同 [hermes-agent 的飞书网关](https://github.com/NousResearch/hermes-agent)），
  回答未结束就一直显示，失败时换成 `CrossMark`。默认不再发"思考中…"提示语。
- 🎞 **流式汇报** — 长任务持续汇报：一张实时交互卡片流式显示 agent 的
  **思考、工具调用、回答草稿**（`reporting.mode: 'stream'`，默认开启）；
  设为 `reporting.mode: 'final'` 则只显示最终结果。
- 🃏 **点击即答卡片** — 权限审批（`approval/request`，如沙箱提权）与模型的
  `ask_user_question` 工具会渲染成飞书交互卡片：点 **✅ 允许一次 / 🚫 拒绝**
  或选项按钮即可作答。
- ✍️ **Markdown 回复** — 用普通富文本（post）消息的 `md` 标签：粗体、行内代码、
  列表、链接原生渲染，无需卡片
- 🤖 **完整 agent 能力** — DSH agent 自带模型与工具（bash、文件、子代理…），完全自主
- 📨 **主动推送** — 可选管理 HTTP API（`/api/push`），随时向用户/群推送文本、Markdown、卡片
- 🔌 **无需公网** — 飞书长连接，不需要回调地址
- 🗂 **持久化** — 飞书↔DSH 会话映射重启不丢

## 环境要求

- 已安装并构建的 DeepSeek Harness（`dsh` CLI），并配置好 `DEEPSEEK_API_KEY`
  （agent 直接使用 DSH 当前模型，无需另配）
- 一个飞书开放平台**企业自建应用**，已开启机器人能力（见下）

## 飞书应用配置

1. [飞书开放平台](https://open.feishu.cn/app) → 创建**企业自建应用**。
2. 开启**机器人**能力。
3. 开通权限：`im:message`、`im:message:send_as_bot`（如需读取消息内容再加
   `im:message:send_as_bot:readonly`），然后创建版本并发布。
4. 事件与回调 → 选择**使用长连接接收事件**，订阅 **`im.message.receive_v1`**（无需公网）。
   审批/问答卡片的**按钮点击**（`card.action.trigger`）也走同一条长连接，无需回调地址。
5. 在飞书客户端搜索应用名，添加机器人为联系人。

> `Typing` 表情与卡片按钮依赖机器人在会话内有消息交互权限（`im:message`）。
> 若表情接口被拒，网关会自动退回发送 `hintText` 提示语。

## 安装（作为 DSH 插件）

前提：本包已发布到 npm，且 `dsh` 命令可用。

推荐把网关**挂载到 web profile**：与 DSH Web UI 同进程运行，启动 Web UI
即同时启动飞书网关，两者共用同一个 DSH agent。也可以用独立 profile 运行
（见文末「备选」）。

方式一（推荐）：挂载到 web profile

web profile 是 DSH 的默认图形界面 profile（`dsh --profile web`）。

1. 编辑 `~/.dsh/profiles/web/package.json`，加入依赖与 bundle：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@kriskwok/dsh-feishu-gateway": "^0.2.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@kriskwok/dsh-feishu-gateway"
      ]
    }
  }
}
```

2. 在 web profile 目录安装依赖：

```bash
cd ~/.dsh/profiles/web && pnpm install
```

3. 编辑 `~/.dsh/profiles/web/cordis.patch.yml`，填入飞书应用凭据：

```yaml
- id: feishu-gateway
  config:
    feishu:
      appId: cli_xxxxxxxxxxxxxxxx
      appSecret: xxxxxxxxxxxxxxxxxxxxxxxx
    http:
      port: 3100      # 可选管理 API
      token: your-token
```

4. 启动（或重启）web profile：

```bash
dsh --profile web
```

> 也可以直接运行本仓库的一键脚本：`./scripts/create-profile.sh`
> （默认挂载到 web profile；`--standalone` 则创建独立 feishu profile）。

### 备选：独立 feishu profile

若不想通过 Web UI 使用，可让网关在独立 profile 中运行：

```bash
mkdir -p ~/.dsh/profiles/feishu && cd ~/.dsh/profiles/feishu

cat > package.json <<'EOF'
{
  "name": "dsh-profile-feishu",
  "private": true,
  "dependencies": {
    "@kriskwok/dsh-feishu-gateway": "^0.2.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@kriskwok/dsh-feishu-gateway"]
    }
  }
}
EOF

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF

pnpm install
# 再创建 ~/.dsh/profiles/feishu/cordis.patch.yml 填入应用凭据
dsh --profile feishu
```

## 配置项

所有配置都在 `feishu-gateway` 命名空间下（profile patch 行或 `~/.dsh/settings.yaml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `feishu.appId` | — | 飞书应用 App ID（必填） |
| `feishu.appSecret` | — | 飞书应用 App Secret（必填） |
| `feishu.domain` | `feishu` | `feishu`（国内）/ `lark`（海外） |
| `feishu.botOpenId` | 空 | 可选；@ 识别可自动完成 |
| `feishu.replyMode` | `at` | 群聊策略：`at` 仅被 @ 回复 / `all` 全部回复 |
| `workspace` | `~/Documents/DSH-Workspace` | agent 工作目录 |
| `hintText` | `爸爸，我正在努力处理中……` | 兜底"处理中"文案（仅当 Typing 表情被禁用/不可用时） |
| `reporting.mode` | `stream` | `stream`=流式进度卡片；`final`=只显示最终结果 |
| `reporting.typingReaction` | `true` | 处理中显示原生 Typing 表情 |
| `reporting.showReasoning` | `true` | 卡片中流式显示模型思考 |
| `reporting.showToolCalls` | `true` | 卡片中流式显示工具调用 |
| `reporting.patchIntervalMs` | `700` | 卡片刷新最小间隔（毫秒，飞书有限流） |
| `reporting.maxBodyChars` | `900` | 卡片正文最大渲染长度 |
| `reporting.failureReaction` | `CrossMark` | 失败时（移除 Typing 后）追加的表情 |
| `interactions.approvalCards` | `true` | 权限审批用可点击卡片回答 |
| `interactions.userQuestionsCards` | `true` | `ask_user_question` 用可点击卡片回答 |
| `newSessionPatterns` | `/new` 及中文短语 | 触发另起会话的正则列表 |
| `sessionsFile` | `data/dsh-feishu-sessions.json` | 会话映射持久化文件 |
| `http.port` | `0` | 管理 API 端口（`0`=禁用） |
| `http.token` | 空 | 管理 API Bearer Token |

> **web profile 下的问答卡片**：`ask_user_question` 的作答走唯一的
> `ctx.userQuestions` provider 槽位。当 Web UI 与网关同进程（推荐部署）时该槽位
> 归 Web UI，因此 `ask_user_question` 在 Web UI 中作答；而**权限审批卡片在任何
> 部署下都从飞书作答**。独立 feishu profile 下，`ask_user_question` 与审批都在
> 飞书卡片中作答。

## 会话共存与自愈

- **预设编排（有工具！）** — 在 preset-roster 部署（如 web profile）下，飞书
  agent 会从部署的 agent preset 编排（`meta.agentPreset` + preset `mount`），
  模型因此拿到工具，而不会把工具调用当成纯文本。
- **与 Web UI 共存** — 会话单 owner。当 Web UI 打开某会话后，飞书侧通过
  `agents.get()` 接管正在运行的 agent 并驱动同一会话，不再报
  "while it is live" / "already exists"；两个界面共享同一段对话。
- **wedged 会话自愈** — 进程中途死亡留下永久冲突的会话（"already exists"）时，
  网关自动换一个新 session id，并把飞书会话映射重指向它，继续对话。

## 管理 HTTP API（可选）

设置 `http.port` 启用。端点：

- `GET /health` — 状态
- `POST /api/push` — 主动推送
  `{ "receive_id": "ou_xxx", "receive_id_type": "open_id", "msg_type": "text", "content": "{\"text\":\"hi\"}" }`
- `GET /api/sessions` — 飞书↔DSH 会话映射概览

## 开发

```bash
pnpm install
pnpm build     # tsc → lib/
pnpm test      # 离线自测
```

> 说明：`@deepseek-ai/*` 运行时由 DSH 宿主提供；本地类型检查从你的
> deepseek-harness 检出目录 symlink（见发布检查清单）。

## 许可

MIT
