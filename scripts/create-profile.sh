#!/bin/bash
# 将 dsh-feishu-gateway 安装到 DSH。
#
# 默认（推荐）：挂载到 web profile —— 与 DSH Web UI 同进程运行。
#   ./scripts/create-profile.sh
#
# 备选：创建独立 feishu profile（开发模式：file: 本地引用）。
#   ./scripts/create-profile.sh --standalone
#
# 发布到 npm 后，可把 package.json 中的依赖改为 "^版本号" 再重新 pnpm install。
set -e
cd "$(dirname "$0")/.."

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="@kriskwok/dsh-feishu-gateway"
PLUGIN_DIR="$(pwd)"

STANDALONE=0
if [ "${1:-}" = "--standalone" ]; then
  STANDALONE=1
fi

if [ "$STANDALONE" = "1" ]; then
  # ---------------------------------------------------------------
  # 独立 feishu profile（不依赖 Web UI）
  # ---------------------------------------------------------------
  PROFILE_DIR="$DSH_HOME/profiles/feishu"
  PROFILE_NAME="feishu"

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
    # hintText: 爸爸，我正在努力处理中……      # 兜底提示语（Typing 表情不可用时）
    # reporting:
    #   mode: stream                # stream=流式进度卡片（默认） final=只显示最终结果
    # interactions:
    #   approvalCards: true         # 权限审批用飞书卡片点击即答
    # http:
    #   port: 3100              # 管理 API 端口（0=禁用）
    #   token: your-token       # 管理 API Bearer Token
EOF
  fi

  echo "==> 安装依赖（pnpm install）"
  cd "$PROFILE_DIR" && pnpm install

  echo ""
  echo "=============================================="
  echo "✅ 独立 profile 已创建: $PROFILE_DIR"
  echo ""
  echo "下一步："
  echo "  1. 编辑 $PROFILE_DIR/cordis.patch.yml，填入飞书应用 App ID / App Secret"
  echo "  2. 启动：dsh --profile feishu"
  echo "     （首次运行会初始化并保持长连接，Ctrl+C 退出）"
  echo "=============================================="
else
  # ---------------------------------------------------------------
  # 挂载到 web profile（与 Web UI 同进程）
  # ---------------------------------------------------------------
  PROFILE_DIR="$DSH_HOME/profiles/web"
  MANIFEST="$PROFILE_DIR/package.json"

  if [ ! -f "$MANIFEST" ]; then
    echo "错误：未找到 $MANIFEST" >&2
    echo "请先运行 dsh --profile web 初始化 web profile，再执行本脚本。" >&2
    exit 1
  fi

  echo "==> 目标 profile: $PROFILE_DIR"

  echo "==> 将 $PLUGIN_NAME 加入 dependencies 与 bundles（保留已有条目）"
  node - "$MANIFEST" "$PLUGIN_NAME" "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const [manifestPath, pluginName, pluginDir] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[pluginName] = 'file:' + pluginDir
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes(pluginName)) {
  pkg.dsh.profile.bundles.push(pluginName)
}
fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n')
NODE

  if [ ! -f "$PROFILE_DIR/pnpm-workspace.yaml" ]; then
    echo "==> 写入 pnpm-workspace.yaml（DSH 约定：不自动安装 peer 依赖）"
    cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<EOF
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
  fi

  PATCH="$PROFILE_DIR/cordis.patch.yml"
  if [ ! -f "$PATCH" ] || ! grep -q "id: feishu-gateway" "$PATCH" 2>/dev/null; then
    echo "==> 在 $PATCH 中追加 feishu-gateway 配置占位（如已有请跳过）"
    cat >> "$PATCH" <<'EOF'

# dsh-feishu-gateway 配置（挂在 web profile 上，Web UI 可见）
- id: feishu-gateway
  config:
    feishu:
      appId: cli_xxxxxxxxxxxxxxxx
      appSecret: xxxxxxxxxxxxxxxxxxxxxxxx
      # domain: feishu          # feishu(国内) | lark(海外)
      # botOpenId: ou_xxx       # 可选，@ 自动识别可留空
      # replyMode: at           # at=仅被@回复 | all=全部回复
    # workspace: ~/Documents/DSH-Workspace   # agent 工作目录
    # hintText: 爸爸，我正在努力处理中……      # 兜底提示语（Typing 表情不可用时）
    # reporting:
    #   mode: stream                # stream=流式进度卡片（默认） final=只显示最终结果
    # interactions:
    #   approvalCards: true         # 权限审批用飞书卡片点击即答
    # http:
    #   port: 3100              # 管理 API 端口（0=禁用）
    #   token: your-token       # 管理 API Bearer Token
EOF
  fi

  echo "==> 安装依赖（pnpm install）"
  cd "$PROFILE_DIR" && pnpm install

  echo ""
  echo "=============================================="
  echo "✅ 插件已挂载到 web profile: $PROFILE_DIR"
  echo ""
  echo "下一步："
  echo "  1. 编辑 $PATCH，填入飞书应用 App ID / App Secret"
  echo "  2. 启动（或重启）：dsh --profile web"
  echo "     （飞书网关与 Web UI 同进程，长连接自动建立）"
  echo "=============================================="
fi
