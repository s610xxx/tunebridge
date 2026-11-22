# TuneBridge 音桥

把 QQ 音乐和 Apple Music 的歌单互相搬运。授权目标平台、粘贴来源歌单链接，剩下的搜索、匹配、创建歌单交给音桥。

> 2026 Qoder 高校创造力大赛 · LifeHack 生活娱乐赛道

## 为什么做

换一个音乐 App，不应该意味着重新收藏几百首歌。QQ 音乐与 Apple Music 之间没有官方迁移工具，手动逐首搜索重建歌单要花几十分钟。TuneBridge 用一个浏览器页面解决这件事，并给出逐首匹配报告。

## 功能（MVP）

- QQ 音乐 → Apple Music、Apple Music → QQ 音乐双向迁移；QQ → 网易云音乐本机试用接入。
- 演示模式：无需平台账号和开发者凭据，跑通完整流程。
- 目标平台授权：QQ Cookie 连接 / Apple MusicKit 授权 / 网易云本机 CLI 配对连接。
- 歌单链接解析、预览、逐首匹配、**人工勾选确认后**批量写入、迁移报告。
- 歌单备份：读取 QQ 歌单、粘贴曲目或导入 CSV/JSON，预览并导出 CSV/JSON；也可把备份恢复到任意已连接平台。
- 音桥账号：本站账号（不是音乐平台账号），任务与历史按账号隔离。
- 任务持久化与迁移历史：报告快照写入本地 H2，服务重启后仍可查看；历史只读，不会自动继续或重试写入。
- 两种部署边界：默认只监听本机的 LOCAL 模式，与需要 TLS 和邀请码的公网 PUBLIC 模式。
- QQ / Apple 凭据仅存在服务端会话内存；网易云本机模式使用 CLI 自行管理的登录态，可能保存在本机。

## 快速开始

环境：JDK 21、Maven 3.6.3+（建议 3.9.x）。

```bash
mvn spring-boot:run
```

打开 <http://localhost:8080>。首次启动会在 `./data/` 下创建 H2 数据库文件（已在 `.gitignore` 中），只保存音桥用户名、密码哈希与迁移报告快照，不保存音乐平台凭据。

### 60 秒体验演示迁移

1. 点右上角「音桥账号登录」→「注册音桥账号」，填写用户名（3–32 位小写字母、数字或下划线）与密码（12–128 位）；注册成功后需再明确点击「登录音桥」。
2. 点击「一键体验匹配」，系统自动连接两个演示账号、解析内置歌单并开始匹配；这一步只读取和匹配，不写入任何平台。
3. 匹配完成后审阅逐首结果与版本差异提示（低置信默认不勾选），勾选后点击「确认迁移」才会创建目标歌单并写入所选歌曲。
4. 打开「演示音乐库」的 Apple Music 标签，点击「作为来源」，工作台自动切换为 Apple Music → QQ 音乐，再跑一次回迁。
5. 点导航「迁移历史」查看本账号的只读报告；历史报告不会重新执行写入，也不能在其中提交确认。

演示模式使用内置曲库，不会访问或修改任何真实账号。

### 备份歌单

1. 在「备份歌单」输入 QQ 音乐歌单链接，或粘贴每行一首的 `歌名 - 歌手`；也可导入 CSV 或本工具导出的 JSON。
2. 预览后下载 JSON 或 CSV。导入文件在浏览器本地处理；歌单链接由服务端读取，不需要 Apple 授权。
3. CSV 表头至少包含 `title`（或 `歌名`），可选 `artist`、`album`、`durationSec`、`id` 和 `artworkUrl`；歌手和专辑也支持中文表头。

导出保留曲目顺序和重复项。CSV 会为可能被表格软件识别为公式的内容添加单引号，完整原文请使用 JSON。QQ 返回的曲目是否完整取决于上游接口。

备份预览下方可选择目标平台并「开始恢复迁移」：音桥会把当前预览的曲目当作迁移来源，在已连接的目标平台搜索匹配并创建新歌单，恢复过程与普通迁移一样输出逐首报告。恢复不依赖来源平台连接，导入的 CSV/JSON 也可以直接恢复；单次恢复提交预览中的前 `max-tracks` 首（默认 200），超出部分会提示且不会提交。

## 真实平台接入

### Apple Music

需要 Apple Developer 账号签发 MusicKit 开发者令牌，配置环境变量后启动：

```bash
export APPLE_DEVELOPER_TOKEN="eyJhbGciOiJFUzI1NiIs..."
mvn spring-boot:run
```

或者提供 `.p8` 私钥，让服务端自动签发（缓存 55 分钟）：

```bash
export APPLE_TEAM_ID="XXXXXXXXXX"
export APPLE_KEY_ID="XXXXXXXXXX"
export APPLE_PRIVATE_KEY_PATH="/path/to/AuthKey_XXXXXXXXXX.p8"
mvn spring-boot:run
```

浏览器中点击「Apple Music 授权」，通过 MusicKit JS 完成授权；也可以手动粘贴 Music-User-Token。

### QQ 音乐

在浏览器登录 <https://y.qq.com>，从开发者工具复制 `y.qq.com` 域的完整 Cookie，粘贴到连接弹窗。服务端会解析账号 UIN 与登录票据，票据约 3 天过期。

现有实现尝试读取 QQ 歌单；真实接口的可用性及第三方使用权限尚需验证。创建歌单和批量加歌需要有效 Cookie，并且可能因上游策略变化而失败。

### 网易云音乐（本机试用）

已接入 QQ → 网易云音乐的搜索、匹配、创建、写入与回读验证，目前为本机试用；完整真实歌单迁移仍需验收。本机模式使用运行服务的系统用户已登录的官方 `@music163/ncm-cli`，不是多用户授权，不能部署到共享服务器、反向代理或容器端口映射。断开音桥连接不会退出 CLI 登录；CLI 可能在本机保存应用凭据和登录态。

需要 Node.js 18+，安装并配置官方 CLI 后，先使用 `ncm-cli login` 扫码登录。Windows PowerShell 中启动：

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$env:NETEASE_PAIRING_CODE = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$env:NETEASE_NODE_EXECUTABLE = (Get-Command node.exe).Source
$env:NETEASE_CLI_ENTRY = Join-Path (npm root -g) '@music163/ncm-cli/dist/index.js'
$env:SERVER_ADDRESS = '127.0.0.1'
$env:PORT = '18081'
$env:NETEASE_PAIRING_CODE
mvn spring-boot:run
```

在同一台电脑打开 `http://127.0.0.1:18081`，选择网易云目标，使用终端显示的本机配对码连接。配对码用于保护当前服务，不是网易云 Key 或 Secret；不要分享或提交任何凭据。重启服务时请重新生成配对码。每次真实迁移都会创建新的网易云歌单；若写入失败或结果不确定，请先到网易云检查，避免重复操作。

## 部署模式与安全边界

音桥有两种互斥的部署形态，启动时校验配置，配置不合规直接拒绝启动，而不是降级运行。

### LOCAL（默认，本机自用）

```bash
mvn spring-boot:run
```

- 只允许 `server.address=127.0.0.1`，监听回环地址；启动时若发现非本机监听或开启转发头策略则拒绝启动。
- 请求必须来自回环地址、`Host` 只能是 `localhost/127.0.0.1/[::1]` 加实际端口；出现 `X-Forwarded-*`、`Forwarded`、`X-Real-IP` 一律拒绝，因此不支持反向代理、Nginx 转发和容器端口映射。
- 注册不需要邀请码，但注册码字段仍保留（PUBLIC 模式使用）。
- 网易云本机 CLI 配对只允许在这种形态下使用。

### PUBLIC（公网多人访问）

```bash
export TUNEBRIDGE_SECURITY_MODE=PUBLIC
export TUNEBRIDGE_PUBLIC_ORIGIN="https://bridge.example"
export TUNEBRIDGE_REGISTRATION_CODE="$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-40)"
export SERVER_SSL_ENABLED=true
export SERVER_SSL_KEY_STORE=/path/to/keystore.p12
export SESSION_COOKIE_SECURE=true
```

- 必须直接提供 TLS（`server.ssl.enabled=true`）与 Secure Cookie；仍然不接受反向代理与转发头，`Origin` 必须是配置中的规范 HTTPS 源。
- 注册需要 32–128 位邀请码；公网模式禁止配置网易云配对码与 CLI 路径，避免把本机账号能力暴露给多人。
- 登录、注册接口按来源地址与全局窗口限流，超限返回 429；请求体上限 64 KB，超限返回 413。

两种模式共用同一套边界规则：写接口必须带会话 CSRF 头，登录成功会更换会话 ID，未登录访问 API 返回 401 `AUTH_REQUIRED`，跨站来源或伪造 `Host` 返回 403 `BOUNDARY_REJECTED`。

## 文档

- [产品需求文档（PRD）](docs/PRD.md)
- [技术方案](docs/TECH_DESIGN.md)

## 技术栈

- Java 21、Spring Boot 3.4、Spring RestClient
- Spring Security（表单登录、会话 CSRF、PBKDF2 密码哈希）+ JDBC / H2 文件数据库
- 原生 HTML / CSS / JavaScript（无前端构建）
- 服务端内存会话 + 虚拟线程迁移任务，任务报告快照落库
- JUnit 5、MockMvc、AssertJ 测试

## 项目结构

```
src/main/java/com/tunebridge/
├── config/      # 配置、HTTP 客户端、线程池
├── domain/      # 领域模型
├── provider/    # QQ / Apple / 网易云 / 演示适配器
├── security/    # 账号、过滤器链、部署边界、限流
├── service/     # 连接、迁移编排、匹配、迁移历史
└── web/         # REST API
src/main/resources/
├── application.yml
├── schema.sql   # app_users、migration_history
└── static/      # 单页前端
```

## 测试

```bash
mvn test
node --test src/test/js/playlist-backup.test.js
```

`mvn test` 覆盖 URL 解析、Cookie、匹配算法、演示链路、备份读取与恢复、账号认证与部署边界、迁移历史与重启恢复，共 83 项；测试使用内存 H2，不会写入 `./data/`。前端格式测试需要 Node.js。

## 安全与合规

- QQ / Apple 凭据不落库、不写日志，服务端会话内存中保存，断开或退出即清除；网易云 CLI 的本机凭据由 CLI 自行管理。
- 数据库只保存音桥用户名、PBKDF2 密码哈希与迁移报告快照（曲目元数据、匹配结果、统计），不保存平台 Cookie / Token。
- 任务与历史按音桥账号隔离：其他账号读取返回 404，同账号的其他会话只能只读查看，确认与放弃只能在创建任务的会话中进行。
- 历史报告只读，服务重启不会自动继续或重试写入；写入阶段中断的任务标注「结果待核查」，需人工到目标平台确认。
- 所有写接口要求会话 CSRF 头，登录成功更换会话 ID，会话 Cookie `HttpOnly`、`SameSite=Lax`、不开启 CORS，仅允许 cookie 跟踪。
- LOCAL 模式只接受回环地址与本机 `Host`，拒绝一切转发头；PUBLIC 模式要求直连 TLS、Secure Cookie、规范 HTTPS 源与邀请码注册。
- 登录与注册按来源地址和全局窗口限流（超限 429），API 写请求体上限 64 KB（超限 413），参数数量与查询长度受限。
- 只创建新歌单，不修改或删除用户已有歌单；不迁移「我喜欢」。
- 不提供下载、破解或版权绕过能力，仅用于用户本人歌单备份迁移。
- 演示模式明确标注，不会触达真实平台。
- 接口可能随平台策略变化；失败时产品会明确说明，不伪造成功。

## 许可

本项目为比赛作品，仅用于学习与个人歌单迁移。QQ 音乐、Apple Music 及相关商标归各自所有者。
