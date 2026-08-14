#!/bin/bash
# 在 DSH 中创建 feishu profile 并安装本插件（开发模式：file: 本地引用）。
# 用法：./scripts/create-profile.sh
# 发布到 npm 后，可把 package.json 中的依赖改为 "^版本号" 再重新 pnpm install。
set -e
cd "$(dirname "$0")/.."

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/feishu"
PLUGIN_NAME="@dsh-external/dsh-feishu-gateway"
PLUGIN_DIR="$(pwd)"

echo "==> 创建 profile 目录: $PROFILE_DIR"
mkdir -p "$PROFILE_DIR"

echo "==> 写入 package.json（含 dsh.profile manifest）"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-feishu",
  "private": true,
  "dependencies": {
    "$PLUGIN_NAME": "file:$PLUGIN_DIR"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "$PLUGIN_NAME"
      ]
    }
  }
}
EOF

echo "==> 写入 pnpm-workspace.yaml（DSH 约定：不自动安装 peer 依赖）"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<EOF
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF

if [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  echo "==> 生成 cordis.patch.yml（用户配置层）"
  cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
# dsh-feishu-gateway 用户配置层。
# 把飞书应用凭据填入下方 feishu-gateway 的 config，然后启动 dsh --profile feishu。
# （配置也可放在 $DSH_HOME/settings.yaml 的 feishu-gateway 命名空间。）
- id: feishu-gateway
  config:
    feishu:
      appId: cli_xxxxxxxxxxxxxxxx
      appSecret: xxxxxxxxxxxxxxxxxxxxxxxx
      # domain: feishu          # feishu(国内) | lark(海外)
      # botOpenId: ou_xxx       # 可选，@ 自动识别可留空
      # replyMode: at           # at=仅被@回复 | all=全部回复
    # workspace: ~/Documents/DSH-Workspace   # agent 工作目录
    # hintText: 爸爸，我正在努力处理中……      # 处理中提示语
    # http:
    #   port: 3100              # 管理 API 端口（0=禁用）
    #   token: your-token       # 管理 API Bearer Token
EOF
fi

echo "==> 安装依赖（pnpm install）"
cd "$PROFILE_DIR" && pnpm install

echo ""
echo "=============================================="
echo "✅ profile 已创建: $PROFILE_DIR"
echo ""
echo "下一步："
echo "  1. 编辑 $PROFILE_DIR/cordis.patch.yml，填入飞书应用 App ID / App Secret"
echo "  2. 启动：dsh --profile feishu"
echo "     （首次运行会初始化并保持长连接，Ctrl+C 退出）"
echo "=============================================="
