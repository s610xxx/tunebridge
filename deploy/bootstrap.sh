#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/tunebridge
ETC_DIR=/etc/tunebridge
RUN_USER=tunebridge
JAR=""
GIT_URL=""
GIT_REF=feat/wk
IP=""
PORT=443
ORIGIN=""

log() { echo "[+] $*"; }
die() { echo "[x] $*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
用法：bash bootstrap.sh --ip <公网IP> (--jar <jar路径> | --git <仓库地址>) [--port 443] [--origin https://...]

  --ip    服务器公网 IP，用于自签证书与默认访问地址（必填）
  --jar   已在本机构建好的 fat jar，直接安装
  --git   在服务器上克隆源码并用 Maven 构建（需 git + maven）
  --ref   克隆分支，默认 feat/wk
  --port  监听端口，默认 443；若被备案拦截改 8443
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --ip) IP=${2:-}; shift 2 ;;
        --jar) JAR=${2:-}; shift 2 ;;
        --git) GIT_URL=${2:-}; shift 2 ;;
        --ref) GIT_REF=${2:-}; shift 2 ;;
        --port) PORT=${2:-}; shift 2 ;;
        --origin) ORIGIN=${2:-}; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage; die "未知参数：$1" ;;
    esac
done

[ "$(id -u)" = 0 ] || die "请用 root 运行"
[ -n "$IP" ] || die "缺少 --ip"
[ -n "$JAR" ] || [ -n "$GIT_URL" ] || die "必须给 --jar 或 --git"
[ -n "$GIT_URL" ] || [ -f "$JAR" ] || die "找不到 jar：$JAR"
command -v openssl >/dev/null || die "缺少 openssl"

if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
else die "只支持 apt 或 dnf 发行版"; fi

install_pkgs() {
    if [ "$PM" = apt ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
    else
        dnf -y -q install "$@"
    fi
}

java_major() {
    java -XshowSettings:properties -version 2>&1 \
        | sed -n 's/.*java\.version = \([0-9]*\).*/\1/p' | head -1
}

JV=$(java_major || echo 0)
if [ "${JV:-0}" -lt 21 ]; then
    log "安装 JDK 21（当前 major=${JV:-none}）"
    if [ "$PM" = apt ]; then install_pkgs openjdk-21-jdk-headless; else install_pkgs java-21-openjdk-devel; fi
fi
command -v keytool >/dev/null || die "缺少 keytool，请安装 JDK 而非仅 JRE"

if [ -z "$JAR" ]; then
    command -v git >/dev/null || install_pkgs git
    command -v mvn >/dev/null || install_pkgs maven
    if [ ! -f /root/.m2/settings.xml ]; then
        log "配置 Maven 阿里云镜像（国内直连 Central 很慢）"
        mkdir -p /root/.m2
        cat > /root/.m2/settings.xml <<'MVN'
<settings><mirrors><mirror>
  <id>aliyun</id><name>aliyun public</name>
  <url>https://maven.aliyun.com/repository/public</url>
  <mirrorOf>central</mirrorOf>
</mirror></mirrors></settings>
MVN
    fi
    SRC=/opt/tunebridge-src
    if [ -d "$SRC/.git" ]; then
        log "更新源码 $SRC"
        git -C "$SRC" fetch --depth 1 origin "$GIT_REF"
        git -C "$SRC" reset --hard FETCH_HEAD
    else
        log "克隆 $GIT_URL ($GIT_REF)"
        git clone --depth 1 -b "$GIT_REF" "$GIT_URL" "$SRC"
    fi
    log "构建 jar（跳过测试）"
    (cd "$SRC" && mvn -q -B -DskipTests package)
    JAR=$(ls "$SRC"/target/*.jar | head -1)
    [ -f "$JAR" ] || die "构建未产出 jar"
fi

systemctl stop tunebridge 2>/dev/null || true

id -u "$RUN_USER" >/dev/null 2>&1 \
    || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$APP_DIR/data" "$ETC_DIR"
install -m 0644 "$JAR" "$APP_DIR/tunebridge.jar"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR/data"

prev() {
    [ -f "$ETC_DIR/tunebridge.env" ] && sed -n "s/^$1=//p" "$ETC_DIR/tunebridge.env" | head -1 || true
}

KS_HOST=$IP
if [ -z "$ORIGIN" ]; then
    if [ "$PORT" = "443" ]; then ORIGIN="https://$IP"; else ORIGIN="https://$IP:$PORT"; fi
fi
KS_HOST=${ORIGIN#https://}
KS_HOST=${KS_HOST%%:*}
AUTHORITY=${ORIGIN#https://}

KS_PASS=$(prev SERVER_SSL_KEY_STORE_PASSWORD)
KS_PASS=${KS_PASS:-$(openssl rand -hex 24)}
REG_CODE=$(prev TUNEBRIDGE_REGISTRATION_CODE)
REG_CODE=${REG_CODE:-$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | cut -c1-40)}
[ "${#REG_CODE}" -ge 32 ] && [ "${#REG_CODE}" -le 128 ] || die "邀请码长度不合规"

if [ ! -f "$ETC_DIR/keystore.p12" ]; then
    log "生成自签证书（SAN=$KS_HOST，397 天）"
    keytool -genkeypair -alias tunebridge -keyalg RSA -keysize 2048 -validity 397 \
        -dname "CN=$KS_HOST" -ext "SAN=dns:$KS_HOST,ip:$KS_HOST" \
        -keystore "$ETC_DIR/keystore.p12" -storetype PKCS12 -storepass "$KS_PASS" >/dev/null 2>&1
fi
chown "root:$RUN_USER" "$ETC_DIR/keystore.p12"
chmod 640 "$ETC_DIR/keystore.p12"

umask 077
cat > "$ETC_DIR/tunebridge.env" <<ENV
TUNEBRIDGE_SECURITY_MODE=PUBLIC
TUNEBRIDGE_PUBLIC_ORIGIN=$ORIGIN
TUNEBRIDGE_REGISTRATION_CODE=$REG_CODE
SERVER_ADDRESS=0.0.0.0
PORT=$PORT
SERVER_SSL_ENABLED=true
SERVER_SSL_KEY_STORE=$ETC_DIR/keystore.p12
SERVER_SSL_KEY_STORE_TYPE=PKCS12
SERVER_SSL_KEY_STORE_PASSWORD=$KS_PASS
SERVER_SSL_KEY_ALIAS=tunebridge
SESSION_COOKIE_SECURE=true
TUNEBRIDGE_DATABASE_URL=jdbc:h2:file:$APP_DIR/data/tunebridge;DB_CLOSE_ON_EXIT=FALSE;WRITE_DELAY=0
ENV
chmod 600 "$ETC_DIR/tunebridge.env"
umask 022

cat > /etc/systemd/system/tunebridge.service <<'UNIT'
[Unit]
Description=TuneBridge 音桥
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tunebridge
Group=tunebridge
WorkingDirectory=/opt/tunebridge
EnvironmentFile=/etc/tunebridge/tunebridge.env
Environment="JAVA_OPTS=-Xms128m -Xmx640m"
ExecStart=/usr/bin/java ${JAVA_OPTS} -jar /opt/tunebridge/tunebridge.jar
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
MemoryMax=1G
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=/opt/tunebridge/data
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0027

[Install]
WantedBy=multi-user.target
UNIT

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null \
        && log "firewalld 已放行 $PORT/tcp"
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$PORT/tcp" >/dev/null && log "ufw 已放行 $PORT/tcp"
fi

systemctl daemon-reload
systemctl enable tunebridge >/dev/null 2>&1
systemctl start tunebridge

OK=0
for _ in $(seq 1 40); do
    if curl -sk --max-time 3 -H "Host: $AUTHORITY" "https://127.0.0.1:$PORT/api/auth" \
            | grep -q '"mode":"public"'; then OK=1; break; fi
    sleep 1
done
if [ "$OK" != 1 ]; then
    journalctl -u tunebridge --no-pager -n 40
    die "服务未在预期端口上返回 PUBLIC 状态，见上方日志"
fi

cat <<DONE

部署完成。
  访问地址 : $ORIGIN
  邀请码   : $REG_CODE
  健康检查 : curl -sk -H "Host: $AUTHORITY" "https://127.0.0.1:$PORT/api/auth"
  实时日志 : journalctl -u tunebridge -f
  证书     : $ETC_DIR/keystore.p12（自签，浏览器会告警一次）
  数据     : $APP_DIR/data/tunebridge.mv.db（H2 文件库，只有音桥账号与报告快照）

还需要人工确认两件事：
  1. 阿里云安全组入方向放行 $PORT/tcp，否则公网打不开。
  2. 邀请码只放在 /etc/tunebridge/tunebridge.env（600），不要提交进仓库。
DONE
