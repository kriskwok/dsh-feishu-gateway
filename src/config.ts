/**
 * Plugin configuration: Feishu app credentials, reply policy, agent workspace,
 * HTTP admin API, and session persistence. Secrets are stored here for
 * simplicity; a DSH Credential reference can be added later.
 * @module dsh-feishu-gateway/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings document namespace owned by this plugin. */
export const FEISHU_SETTINGS_NAMESPACE = settingsNamespace('feishu-gateway')

/** User-facing configuration; every field defaults at the schema boundary. */
export interface FeishuGatewayConfig {
  feishu?: {
    /** Feishu open-platform app id. */
    appId?: string
    /** Feishu open-platform app secret. */
    appSecret?: string
    /** `feishu` (CN) or `lark` (international). */
    domain?: 'feishu' | 'lark'
    /** The bot's own open_id; optional, @ detection works without it. */
    botOpenId?: string
    /** Group reply policy: `at` replies only when mentioned; `all` replies to every message. */
    replyMode?: 'at' | 'all'
  }
  /** Agent working directory (cwd of the DSH session). */
  workspace?: string
  /** The "processing" hint text shown in Feishu while the agent works. */
  hintText?: string
  /** Regex list that resets the conversation (e.g. `/new`, "另起会话"). */
  newSessionPatterns?: string[]
  /** Persistence file for the Feishu-conversation → DSH-session mapping. */
  sessionsFile?: string
  http?: {
    /** Admin HTTP API port; 0 disables the API. */
    port?: number
    /** Bearer token for the admin API; empty disables auth. */
    token?: string
  }
}

export const Config: Schema<FeishuGatewayConfig> = z.object({
  feishu: z.object({
    appId: z.string().required(),
    appSecret: z.string().required(),
    domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
    botOpenId: z.string().default(''),
    replyMode: z.union([z.const('at'), z.const('all')]).default('at'),
  }),
  workspace: z.string().default('~/Documents/DSH-Workspace'),
  hintText: z.string().default('爸爸，我正在努力处理中……'),
  newSessionPatterns: z
    .array(z.string())
    .default(['^/new$', '^(另起|新开|开启|新建)?\\s*(一个)?\\s*(新|全新)?\\s*会话', '^重新开始$', '^换个话题$']),
  sessionsFile: z.string().default('data/dsh-feishu-sessions.json'),
  http: z.object({
    port: z.number().default(0),
    token: z.string().default(''),
  }),
})

/** Resolve the effective runtime config (defaults applied by the schema). */
export function resolveConfig(config: FeishuGatewayConfig = {}): FeishuGatewayConfig {
  return Config(config)
}
