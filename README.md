# dsh-feishu-gateway

English | [中文](README.zh.md)

Chat with your **DeepSeek Harness (DSH)** agent from **Feishu (Lark)**.

A DSH plugin bundle that mounts a Feishu long-connection listener; every Feishu
message is routed to a **stable DSH session** (resumed via the `agents` service,
so multi-turn chats stay in the same session), and the agent's final answer is
replied as a Markdown-rich post message. It also supports `/new` to start a
fresh session, a configurable "processing" hint, and proactive push.

## Features

- 💬 **Full conversation** — Feishu private chat / group @bot → DSH agent → reply
- 🔁 **Persistent sessions** — each Feishu conversation maps to one DSH session
  (`agents.resume` / `agents.create`); `/new` (or "另起会话" / "新会话" /
  "重新开始" / "换个话题") starts a fresh one
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
   **`im.message.receive_v1`** (no public URL needed).
5. In Feishu, search the app name and add the bot as a contact.

## Installation (as a DSH plugin)

Prerequisite: this package is published on npm and `dsh` is on your PATH.

Run the one-shot script from this repository (or follow the manual steps below):

```bash
./scripts/create-profile.sh
```

Then edit the generated user config
`~/.dsh/profiles/feishu/cordis.patch.yml` and fill in your Feishu app
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

Start the gateway:

```bash
dsh --profile feishu
```

### Manual installation

```bash
mkdir -p ~/.dsh/profiles/feishu && cd ~/.dsh/profiles/feishu

cat > package.json <<'EOF'
{
  "name": "dsh-profile-feishu",
  "private": true,
  "dependencies": {
    "@kriskwok/dsh-feishu-gateway": "^0.1.0"
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
| `hintText` | `爸爸，我正在努力处理中……` | "processing" hint text |
| `newSessionPatterns` | `/new` + Chinese phrases | Regexes that reset the session |
| `sessionsFile` | `data/dsh-feishu-sessions.json` | Session mapping persistence |
| `http.port` | `0` | Admin API port (`0` disables) |
| `http.token` | `` | Admin API bearer token |

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
