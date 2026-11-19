# TuneBridge 音桥

把 QQ 音乐和 Apple Music 的歌单互相搬运。授权目标平台、粘贴来源歌单链接，剩下的搜索、匹配、创建歌单交给音桥。

> 2026 Qoder 高校创造力大赛 · LifeHack 生活娱乐赛道

## 为什么做

换一个音乐 App，不应该意味着重新收藏几百首歌。QQ 音乐与 Apple Music 之间没有官方迁移工具，手动逐首搜索重建歌单要花几十分钟。TuneBridge 用一个浏览器页面解决这件事，并给出逐首匹配报告。

## 功能（MVP）

- QQ 音乐 → Apple Music、Apple Music → QQ 音乐双向迁移；QQ → 网易云音乐本机试用接入。
- 演示模式：无需账号和开发者凭据，30 秒跑通完整流程。
- 目标平台授权：QQ Cookie 连接 / Apple MusicKit 授权 / 网易云本机 CLI 配对连接。
- 歌单链接解析、预览、逐首匹配、批量写入、迁移报告。
- 歌单备份：读取 QQ 歌单、粘贴曲目或导入 CSV/JSON，预览并导出 CSV/JSON；也可把备份恢复到任意已连接平台。
- QQ / Apple 凭据仅存在服务端会话内存；网易云本机模式使用 CLI 自行管理的登录态，可能保存在本机。

## 快速开始

环境：JDK 21、Maven 3.6.3+（建议 3.9.x）。

```bash
mvn spring-boot:run
```

打开 <http://localhost:8080>。

### 60 秒体验演示迁移

1. 点击「一键体验」，系统自动连接两个演示账号、解析内置歌单并开始迁移。
2. 等待进度条跑完，查看逐首匹配报告与版本差异提示。
3. 打开「演示音乐库」的 Apple Music 标签，点击「作为来源」，工作台自动切换为 Apple Music → QQ 音乐。
4. 点击「开始迁移」，查看回迁报告。
5. 迁移完成后可继续用演示库歌单反复体验，不需要任何真实凭据。

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

## 文档

- [产品需求文档（PRD）](docs/PRD.md)
- [技术方案](docs/TECH_DESIGN.md)

## 技术栈

- Java 21、Spring Boot 3.4、Spring RestClient
- 原生 HTML / CSS / JavaScript（无前端构建）
- 服务端内存会话 + 虚拟线程迁移任务
- JUnit 5 测试

## 项目结构

```
src/main/java/com/tunebridge/
├── config/     # 配置、HTTP 客户端、线程池
├── domain/     # 领域模型
├── provider/   # QQ / Apple / 网易云 / 演示适配器
├── service/    # 连接、迁移、匹配
└── web/        # REST API
src/main/resources/static/  # 单页前端
```

## 测试

```bash
mvn test
node --test src/test/js/playlist-backup.test.js
```

前端格式测试需要 Node.js。

## 安全与合规

- QQ / Apple 凭据不落库，服务端日志不记录 Cookie / Token；网易云 CLI 的本机凭据由 CLI 自行管理。
- 只创建新歌单，不修改或删除用户已有歌单。
- 不提供下载、破解或版权绕过能力，仅用于用户本人歌单备份迁移。
- 演示模式明确标注，不会触达真实平台。
- 接口可能随平台策略变化；失败时产品会明确说明，不伪造成功。

## 许可

本项目为比赛作品，仅用于学习与个人歌单迁移。QQ 音乐、Apple Music 及相关商标归各自所有者。
