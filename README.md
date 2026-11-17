# TuneBridge 音桥

把 QQ 音乐和 Apple Music 的歌单互相搬运。授权目标平台、粘贴来源歌单链接，剩下的搜索、匹配、创建歌单交给音桥。

> 2026 Qoder 高校创造力大赛 · LifeHack 生活娱乐赛道

## 为什么做

换一个音乐 App，不应该意味着重新收藏几百首歌。QQ 音乐与 Apple Music 之间没有官方迁移工具，手动逐首搜索重建歌单要花几十分钟。TuneBridge 用一个浏览器页面解决这件事，并给出逐首匹配报告。

## 功能（MVP）

- QQ 音乐 → Apple Music、Apple Music → QQ 音乐双向迁移。
- 演示模式：无需账号和开发者凭据，30 秒跑通完整流程。
- 目标平台授权：QQ Cookie 连接 / Apple MusicKit 授权。
- 歌单链接解析、预览、逐首匹配、批量写入、迁移报告。
- 凭据仅存在服务端会话内存，不落库、不写日志。

## 快速开始

环境：JDK 21、Maven 3.6+。

```bash
mvn spring-boot:run
```

打开 <http://localhost:8080>。

### 60 秒体验演示迁移

1. 点击「一键体验」；系统自动连接两个演示账号。
2. 来源选择 QQ 音乐，链接已填入示例歌单。
3. 点击「开始迁移」，观看进度与匹配报告。
4. 点击方向交换按钮，再次迁移，体验 Apple Music → QQ 音乐。
5. 打开「演示音乐库」，查看两次迁移创建的歌单。

演示模式使用内置曲库，不会访问或修改任何真实账号。

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

QQ 公开歌单可直接读取；创建歌单和批量加歌需要有效 Cookie。若上游触发风控或要求签名通道，音桥会如实返回失败原因，并建议使用演示模式。

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
├── provider/   # QQ / Apple / 演示适配器
├── service/    # 连接、迁移、匹配
└── web/        # REST API
src/main/resources/static/  # 单页前端
```

## 测试

```bash
mvn test
```

## 安全与合规

- 不持久化任何账号凭据，服务端日志不记录 Cookie / Token。
- 只创建新歌单，不修改或删除用户已有歌单。
- 不提供下载、破解或版权绕过能力，仅用于用户本人歌单备份迁移。
- 演示模式明确标注，不会触达真实平台。
- 接口可能随平台策略变化；失败时产品会明确说明，不伪造成功。

## 许可

本项目为比赛作品，仅用于学习与个人歌单迁移。QQ 音乐、Apple Music 及相关商标归各自所有者。
