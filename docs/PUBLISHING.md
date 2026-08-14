# 发布检查清单（发布到 npm / DSH 插件社区）

发布前逐项核对。标记 ✅ 的为已就绪，⚠️ 的需要你处理。

## 1. 代码与构建

- ✅ `pnpm build` 通过（tsc → `lib/`）
- ✅ `pnpm test` 通过（离线自测 24 项）
- ✅ `cordis.patch.yml` 导出（`exports["./cordis.patch.yml"]`）并在 `files` 中
- ✅ `dsh.bundle.patch` 字段指向 `./cordis.patch.yml`

## 2. package.json 元数据

✅ **已完成**：`repository` / `bugs` / `homepage` 已指向
https://github.com/kriskwok/dsh-feishu-gateway

✅ **已完成（peerDependencies）**：已按 DSH 官方 bundle 规范补回：
（与 `@dsh-external/dsh-vision-toolkit` 的声明方式一致。用户 profile 使用
`autoInstallPeers: false`，因此 peer 由 DSH 宿主解析，不会触发 npm 404。）

```jsonc
"peerDependencies": {
  "@deepseek-ai/cordis": ">=4.0.0-rc.7 <5.0.0",
  "@deepseek-ai/dsh-agent": ">=0.0.1-rc.1 <0.2.0",
  "@deepseek-ai/dsh-agent-default-model": ">=0.0.1-rc.1 <0.2.0",
  "@deepseek-ai/dsh-llm": ">=0.0.1-rc.1 <0.2.0",
  "@deepseek-ai/dsh-session": ">=0.0.1-rc.1 <0.2.0",
  "@deepseek-ai/dsh-settings": ">=0.0.1-rc.1 <0.2.0",
  "@deepseek-ai/schemastery": ">=3.18.0 <4.0.0"
}
```

> 与 `@dsh-external/dsh-vision-toolkit` 的声明方式一致。用户 profile 使用
> `autoInstallPeers: false`，因此 peer 由 DSH 宿主解析，不会触发 npm 404。

⚠️ **scope 确认**：包名当前为 `@dsh-external/dsh-feishu-gateway`。
- 若官方插件社区使用 `@dsh-external` scope：需要你拥有该 scope 的发布权限
  （联系社区维护者或按社区指引申请）。
- 若无权限，可改用你自己的 scope（如 `@你的组织/dsh-feishu-gateway`），
  并同步修改 `cordis.patch.yml` 与文档中的包名。

- ✅ `license: MIT`，仓库根有 `LICENSE`
- ✅ `engines.node` / `packageManager` / `type: module` 已设置
- ✅ `keywords` 已包含 deepseek-harness / feishu / lark 等

## 3. 安全核对

- ✅ 代码中不含任何真实密钥（凭据只通过用户配置注入）
- ⚠️ 建议：`feishu.appSecret` 后续可改为引用 DSH Credential
  （`@deepseek-ai/dsh-credentials`），避免明文落盘配置——列入 v0.2 计划
- ⚠️ 发布前确认 `files` 不包含 `data/`、`.env`、`.npmrc`、测试残留

## 4. 版本与发布

```bash
# 发布前
pnpm prepack        # 触发 build
npm publish --dry-run   # 检查发布内容
npm publish --access public
```

版本建议：`0.1.0` → 社区反馈后 `0.1.x` → 稳定后 `1.0.0`。

## 5. 文档

- ✅ `README.md`（EN）+ `README.zh.md`（中文）
- ✅ 安装步骤（create-profile 脚本 + 手动方式）
- ✅ 配置项表格、管理 API、开发说明
- ⚠️ 发布后把 README 中的"file: 本地引用"示例改为 npm 版本引用

## 6. 社区提交（若走官方插件社区）

- [ ] 确认社区仓库/市场的提交规范（示例：vision-toolkit 的
      `repository` + `homepage` + 认领 `@dsh-external` scope）
- [ ] 提供截图/演示：飞书里对话、多轮会话、/new、Markdown 回复、主动推送
- [ ] 说明隐私边界：App Secret 仅存用户本机配置；网关只向已发布应用发消息

## 用户自测清单（发布前请实际跑一遍）

- [ ] `dsh --profile feishu` 能保持长连接（日志 `long-connection event subscription started`）
- [ ] 飞书私聊：回复"爸爸，我正在努力处理中……"→ Markdown 正常渲染
- [ ] 追问第二句：DSH 记得上下文（同一 session）
- [ ] `/new`：回复"🧹 已开启全新会话"，且不再记得旧上下文
- [ ] 群聊：仅 @ 时回复（`replyMode=at`）
- [ ] `POST /api/push` 主动推送成功
