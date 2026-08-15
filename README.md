# dsh-feishu-gateway

[![npm version](https://img.shields.io/npm/v/@kriskwok/dsh-feishu-gateway)](https://www.npmjs.com/package/@kriskwok/dsh-feishu-gateway)
[![License: MIT](https://img.shields.io/npm/l/@kriskwok/dsh-feishu-gateway)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/kriskwok/dsh-feishu-gateway)](https://github.com/kriskwok/dsh-feishu-gateway)

English | [中文](README.zh.md)

Chat with your **DeepSeek Harness (DSH)** agent from **Feishu (Lark)**.

A DSH plugin bundle that mounts a Feishu long-connection listener; every Feishu
message is routed to a **stable DSH session** (resumed via the `agents` service,
so multi-turn chats stay in the same session), and the agent's answer is
replied as a Markdown-rich post message. It also supports `/new` to start a
fresh session, a native **Typing reaction** while the answer is being produced,
**live streaming progress cards** for long tasks, **click-to-answer cards** for
permission approvals and the model's `ask_user_question` tool, and proactive
push.

## Features

- 💬 **Full conversation** — Feishu private chat / group @bot → DSH agent → reply
- 🔁 **Persistent sessions** — each Feishu conversation maps to one DSH session
  (`agents.resume` / `agents.create`); `/new` (or "另起会话" / "新会话" /
  "重新开始" / "换个话题") starts a fresh one
- ⌨️ **Native Typing indicator** — while the agent works, the bot adds a
  `Typing` reaction to your message (like [hermes-agent's Feishu gateway](https://github.com/NousResearch/hermes-agent));
  it stays until the answer is done, and is swapped for a `CrossMark` reaction
  on failure. No more "thinking…" hint text by default.
- 🎞 **Streaming progress** — long tasks report continuously: a live interactive
  card streams the agent's **thinking, tool calls, and answer draft** as they
  happen (`reporting.mode: 'stream'`, default). Set `reporting.mode: 'final'`
  to only receive the final result.
- 🃏 **Click-to-answer cards** — permission approvals (`approval/request`, e.g.
  sandbox escalation) and the model's `ask_user_question` tool render as Feishu
  interactive cards: click **✅ 允许一次 / 🚫 拒绝** or an option button to answer.
- ✍️ **Markdown replies** — plain rich-text (`post`) messages with the `md`
  tag: bold, inline code, lists and links render natively, no cards needed
- 🤖 **Full agent capability** — the DSH agent runs with its own model and
  tools (bash, files, subagents…), fully autonomous
- 📨 **Proactive push** — optional admin HTTP API (`/api/push`) to push text /
  Markdown / cards to any user or group
- 🔌 **No public network required** — Feishu long connection, no webhook URL
- 🗂 **Persistence** — Feishu↔DSH session mapping survives restarts

## Requirements

- DeepSeek Harness installed and built (`dsh` CLI), with `DEEPSEEK_API_KEY`
  configured (the agent's model is used as-is)
- A Feishu open-platform **self-built app** with the bot capability enabled
  (see below)

## Feishu app setup

1. [Feishu Open Platform](https://open.feishu.cn/app) → create a
   **self-built app**.
2. Enable the **bot** capability.
3. Grant permissions: `im:message`, `im:message:send_as_bot` (+
   `im:message:send_as_bot:readonly` to read content). Publish a version.
4. Under **Events & callbacks**, choose **long connection** and subscribe to
   **`im.message.receive_v1`** (no public URL needed). The same long
   connection also delivers **card button clicks** (`card.action.trigger`,
   used by the approval / Q&A cards) — no webhook URL required.
5. In Feishu, search the app name and add the bot as a contact.

> The `Typing` reaction indicator and card buttons need the bot to be able to
> interact with messages in the chat (`im:message`). If the reaction API is
> denied, the gateway automatically falls back to the `hintText` message.

## Installation (as a DSH plugin)

Prerequisite: this package is published on npm and `dsh` is on your PATH.

The recommended setup **mounts the gateway into the web profile**: it runs in
the same process as the DSH Web UI, so starting the Web UI also starts the
Feishu gateway, and both share the same DSH agent. A standalone profile is also
supported (see "Alternative" at the end).

### Option 1 (recommended): mount into the web profile

The web profile is DSH's default GUI profile (`dsh --profile web`).

1. Edit `~/.dsh/profiles/web/package.json` to add the dependency and bundle:

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

2. Install dependencies in the web profile directory:

```bash
cd ~/.dsh/profiles/web && pnpm install
```

3. Edit `~/.dsh/profiles/web/cordis.patch.yml` and fill in your Feishu app
   credentials:

```yaml
- id: feishu-gateway
  config:
    feishu:
      appId: cli_xxxxxxxxxxxxxxxx
      appSecret: xxxxxxxxxxxxxxxxxxxxxxxx
    http:
      port: 3100      # optional admin API
      token: your-token
```

4. Start (or restart) the web profile:

```bash
dsh --profile web
```

> You can also use the one-shot script from this repository:
> `./scripts/create-profile.sh` (mounts into the web profile by default;
> `--standalone` creates a standalone feishu profile instead).

### Alternative: standalone feishu profile

To run the gateway without the Web UI, use a standalone profile:

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
# then create ~/.dsh/profiles/feishu/cordis.patch.yml with your app credentials
dsh --profile feishu
```

## Configuration

All settings live in the `feishu-gateway` namespace (profile patch row or
`~/.dsh/settings.yaml`):

| Field | Default | Description |
|---|---|---|
| `feishu.appId` | — | Feishu app id (required) |
| `feishu.appSecret` | — | Feishu app secret (required) |
| `feishu.domain` | `feishu` | `feishu` (CN) or `lark` (international) |
| `feishu.botOpenId` | `` | Optional; @-detection works without it |
| `feishu.replyMode` | `at` | Group policy: `at` or `all` |
| `workspace` | `~/Documents/DSH-Workspace` | Agent working directory |
| `hintText` | `爸爸，我正在努力处理中……` | Fallback "processing" text (only when the Typing reaction is disabled/unavailable) |
| `reporting.mode` | `stream` | `stream` = live streaming progress card; `final` = only the final answer |
| `reporting.typingReaction` | `true` | Show the native Feishu `Typing` reaction while working |
| `reporting.showReasoning` | `true` | Stream the model's reasoning in the card |
| `reporting.showToolCalls` | `true` | Stream tool-call activity in the card |
| `reporting.patchIntervalMs` | `700` | Min interval between card patches (Feishu rate limit) |
| `reporting.maxBodyChars` | `900` | Max rendered card body length |
| `reporting.failureReaction` | `CrossMark` | Reaction added on failure (after removing `Typing`) |
| `interactions.approvalCards` | `true` | Answer permission approvals with clickable cards |
| `interactions.userQuestionsCards` | `true` | Answer `ask_user_question` with clickable cards |
| `newSessionPatterns` | `/new` + Chinese phrases | Regexes that reset the session |
| `sessionsFile` | `data/dsh-feishu-sessions.json` | Session mapping persistence |
| `http.port` | `0` | Admin API port (`0` disables) |
| `http.token` | `` | Admin API bearer token |

> **Q&A cards in the web profile**: `ask_user_question` answers go through the
> single `ctx.userQuestions` provider slot. When the DSH Web UI runs in the
> same process (recommended setup), the Web UI owns that slot, so
> `ask_user_question` is answered there; permission-approval cards still work
> from Feishu in every setup. In a standalone feishu profile, both
> `ask_user_question` and approvals are answered from Feishu cards.

## Admin HTTP API (optional)

Enable by setting `http.port`. Endpoints:

- `GET /health` — status
- `POST /api/push` — proactive push
  `{ "receive_id": "ou_xxx", "receive_id_type": "open_id", "msg_type": "text", "content": "{\"text\":\"hi\"}" }`
- `GET /api/sessions` — Feishu↔DSH session mapping overview

## Development

```bash
pnpm install
pnpm build     # tsc → lib/
pnpm test      # offline self-tests
```

> Note: `@deepseek-ai/*` packages are provided by the DSH host at runtime; for
> local type-checking they are symlinked from your deepseek-harness checkout
> (see the publish checklist).

## License

MIT
