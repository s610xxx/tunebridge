#!/usr/bin/env bash
set -euo pipefail

ETC_DIR=/etc/tunebridge
ENV_FILE=$ETC_DIR/tunebridge.env

log() { echo "[+] $*"; }
die() { echo "[x] $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行"

# 1. 安装 Node.js 20+
if ! command -v node >/dev/null 2>&1; then
    log "安装 Node.js 20"
    if command -v apt-get >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y -q module enable nodejs:20
        dnf -y -q install nodejs
    else
        die "只支持 apt 或 dnf 发行版"
    fi
else
    NODE_VER=$(node --version | sed 's/^v//' | cut -d. -f1)
    [ "${NODE_VER:-0}" -ge 20 ] || die "Node.js 版本过低（需要 20+），当前：$(node --version）"
    log "Node.js 已安装：$(node --version)"
fi

# 2. 安装 ncm-cli
if ! command -v ncm-cli >/dev/null 2>&1; then
    log "安装 ncm-cli"
    npm install -g @unblockneteasemusic/ncm-cli 2>/dev/null \
        || npm install -g ncm-cli 2>/dev/null \
        || die "ncm-cli 安装失败，请手动执行：npm install -g @unblockneteasemusic/ncm-cli"
fi

CLI_PATH=$(which ncm-cli)
NODE_PATH=$(which node)
log "ncm-cli 路径：$CLI_PATH"
log "Node 路径：$NODE_PATH"

# 3. 生成配对码
PAIRING_CODE=$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | cut -c1-40)
log "生成的网易云配对码：$PAIRING_CODE"

# 4. 写入 /etc/tunebridge/tunebridge.env
if [ ! -f "$ENV_FILE" ]; then
    die "找不到 $ENV_FILE，请先运行 bootstrap.sh 部署服务"
fi

# 如果已有 NETEASE_PAIRING_CODE，先删除旧行
sed -i '/^NETEASE_PAIRING_CODE=/d' "$ENV_FILE"
sed -i '/^NETEASE_NODE_EXECUTABLE=/d' "$ENV_FILE"
sed -i '/^NETEASE_CLI_ENTRY=/d' "$ENV_FILE"

# 追加新配置
cat >> "$ENV_FILE" <<EOF
NETEASE_PAIRING_CODE=$PAIRING_CODE
NETEASE_NODE_EXECUTABLE=$NODE_PATH
NETEASE_CLI_ENTRY=$CLI_PATH
EOF

chmod 600 "$ENV_FILE"
log "已写入 $ENV_FILE"

# 5. 重启服务
if systemctl is-active tunebridge >/dev/null 2>&1; then
    log "重启 tunebridge 服务"
    systemctl restart tunebridge
    sleep 2
    if ! systemctl is-active tunebridge >/dev/null 2>&1; then
        journalctl -u tunebridge --no-pager -n 30
        die "服务启动失败，见上方日志"
    fi
else
    log "tunebridge 服务未运行，跳过重启"
fi

cat <<DONE

网易云 CLI 配对码已配置完成。

配对码   : $PAIRING_CODE
配置文件 : $ENV_FILE

使用方法：
1. 浏览器打开音桥，选择网易云作为目标平台
2. 在「本机配对码」输入框粘贴上面的配对码
3. 点击连接，成功后即可创建歌单并写入

注意：
- 配对码只存在服务端会话内存，断开即清除
- 重启服务时配对码不变，除非重新运行本脚本
- 配对码不要分享或提交进仓库

DONE
