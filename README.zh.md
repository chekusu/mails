# mails

面向 AI Agent 的邮件基础设施。通过编程方式收发邮件。

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)

[English](https://github.com/chekusu/mails/blob/main/README.md) | [日本語](https://github.com/chekusu/mails/blob/main/README.ja.md)

## 工作原理

```
                        发送                                        接收

  Agent                                               外部发件人
    |                                                   |
    |  mails send --to user@example.com                 |  发送邮件到 agent@mails.dev
    |                                                   |
    v                                                   v
+--------+                                    +-------------------+
|  CLI   |                                    | Cloudflare Email  |
|  /SDK  |                                    |     Routing       |
+--------+                                    +-------------------+
    |                                                   |
    |  /v1/send                                         |  email() handler
    |  /api/send                                        |
    v                                                   v
+-----------------------------------------------------------+
|                       Worker                              |
|                                                           |
|  provider 链：Cloudflare Email Service → Resend           |
|                                                           |
|  mails.dev（托管）            或      自己部署（自部署）     |
|  +-----------------------------------------+              |
|  |  +----------+    +----------------+     |  +---------+ |
|  |  |  db9.ai  |    |  fs9（文件）    |     |  |   D1    | |
|  |  | 全文搜索  |    | （附件存储）    |     |  | （存储） | |
|  |  | 高级查询  |    +----------------+     |  +---------+ |
|  |  +----------+                           |              |
|  +-----------------------------------------+              |
+-----------------------------------------------------------+
          |                           |
   通过 CLI/SDK 查询            mails sync
    （remote provider）       （拉取到本地）
          |                           |
          v                     +-----+------+
       Agent                    |            |
                          +---------+  +-----------+
                          | SQLite  |  |  db9.ai   |
                          | （本地） |  | （云端）   |
                          +---------+  +-----------+
                           离线查询     全文搜索
                           本地备份     高级过滤
```

## 特性

- **发送邮件** — 多 provider 链：Cloudflare Email Service（原生 `env.EMAIL.send()` binding，公开 beta）与 Resend 互为兜底，默认顺序 `cloudflare,resend`，通过 `EMAIL_PROVIDERS` 覆盖
- **接收邮件** — 通过 Cloudflare Email Routing Worker
- **搜索收件箱** — 按关键词搜索主题、正文、发件人、验证码
- **验证码自动提取** — 自动从邮件中提取验证码（支持中/英/日/韩）
- **附件** — CLI `--attach` 或 SDK 发送，Worker 自动解析 MIME 附件
- **存储 Provider** — 本地 SQLite、[db9.ai](https://db9.ai) 云端 PostgreSQL、或远程 Worker API
- **Provider 可见性** — `/api/send` 响应与 `/api/inbox` 的 outbound 行携带 `provider` 字段（`cloudflare`/`resend`），知道是谁真正投递的
- **零运行时依赖** — provider 全部走 Workers binding 或原生 `fetch()`，不引 SDK
- **托管服务** — 通过 `mails claim` 免费获取 `@mails.dev` 邮箱
- **自部署** — 部署自己的 Worker，并使用 mailbox 级 token 鉴权

## 安装

```bash
npm install -g mails
# 或
bun install -g mails
# 或直接使用
npx mails
```

## 快速开始

### 托管模式 (mails.dev)

```bash
mails claim myagent                  # 免费认领 myagent@mails.dev
mails send --to user@example.com --subject "Hello" --body "World"  # 每月 100 封免费
mails inbox                          # 查看收件箱
mails inbox --query "密码"            # 搜索邮件
mails code --to myagent@mails.dev    # 等待验证码
```

无需 Resend key — 托管用户每月 100 封免费发件。无限发送请配置自己的 key：`mails config set resend_api_key re_YOUR_KEY`

### 自部署模式

```bash
cd worker && wrangler deploy             # 部署你自己的 Worker
# 至少配置一个发送 provider：
wrangler secret put RESEND_API_KEY       # 选项 A：Resend
#   选项 B：Cloudflare Email Service（公开 beta）— 在 wrangler.toml 中添加：
#   [[send_email]]
#   name = "EMAIL"
# 同时配置时，默认链顺序 cloudflare → resend。
# 强制指定顺序 / 禁用某个：
#   wrangler secret put EMAIL_PROVIDERS   # 例如 "resend" 或 "cloudflare,resend"
#
# 单邮箱：
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# 多邮箱：
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_MAILBOX_TOKEN
mails config set mailbox agent@yourdomain.com
mails send --to user@example.com --subject "Hello" --body "Hi"  # 通过 Worker 发送
mails inbox                              # 查询 Worker API
mails sync                               # 下载邮件到本地 SQLite
```

## CLI 参考

### claim

```bash
mails claim <name>                   # 认领 name@mails.dev（每人最多 10 个）
```

### send

```bash
mails send --to <email> --subject <subject> --body <text>
mails send --to <email> --subject <subject> --html "<h1>Hello</h1>"
mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
mails send --to <email> --subject "Report" --body "See attached" --attach report.pdf
```

### inbox

```bash
mails inbox                                  # 最近邮件列表
mails inbox --mailbox agent@test.com         # 指定邮箱
mails inbox --query "password reset"         # 全文搜索（按相关性排序）
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <id>                             # 查看邮件详情 + 附件

# 高级过滤（mails.dev 托管 / db9）
mails inbox --has-attachments                # 只看带附件的邮件
mails inbox --attachment-type pdf            # 按附件类型过滤
mails inbox --from github.com               # 按发件人过滤
mails inbox --since 2026-03-01 --until 2026-03-20  # 时间范围
mails inbox --header "X-Mailer:sendgrid"    # 按邮件头过滤

# 任意组合
mails inbox --from github.com --has-attachments --since 2026-03-13
mails inbox --query "deploy" --attachment-type log --direction inbound
```

### stats

```bash
mails stats senders                          # 按发件人频率排行
```

### code

```bash
mails code --to agent@test.com              # 等待验证码（默认 30 秒）
mails code --to agent@test.com --timeout 60 # 自定义超时
```

验证码输出到 stdout，方便管道使用：`CODE=$(mails code --to agent@test.com)`

### config

```bash
mails config                    # 查看所有配置
mails config set <key> <value>  # 设置配置项
mails config get <key>          # 获取配置项
```

### sync

```bash
mails sync                              # 从 Worker 同步邮件到本地存储
mails sync --since 2026-03-01           # 从指定日期同步
mails sync --from-scratch               # 全量重新同步
```

从 Worker（托管或自部署）拉取邮件到本地 SQLite。适用于离线访问或本地备份。

## SDK 用法

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// 发送
const result = await send({
  to: 'user@example.com',
  subject: 'Hello',
  text: 'World',
})

// 发送附件
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// 收件箱列表
const emails = await getInbox('agent@mails.dev', { limit: 10 })

// 搜索收件箱（全文搜索，按相关性排序）
const results = await searchInbox('agent@mails.dev', {
  query: 'password reset',
  direction: 'inbound',
})

// 高级过滤（mails.dev 托管 / db9）
const pdfs = await getInbox('agent@mails.dev', {
  has_attachments: true,
  attachment_type: 'pdf',
  since: '2026-03-01',
})

// 等待验证码
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## Email Worker

`worker/` 目录包含用于接收邮件的 Cloudflare Email Routing Worker。

### 部署

```bash
cd worker
bun install
wrangler d1 create mails
# 编辑 wrangler.toml — 设置你的 D1 数据库 ID
wrangler d1 execute mails --file=schema.sql
wrangler deploy
```

然后在 Cloudflare Email Routing 中配置转发到该 Worker。

### 安全配置

```bash
# 单邮箱：
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# 多邮箱：
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
```

所有 `/api/*` 端点都需要 `Authorization: Bearer <mailbox-token>`。这个 token 必须和 `?to=`、被读取的邮件、或发送时的 `from` 邮箱一致。`/health` 始终公开。若未配置 mailbox token，访问 `/api/*` 会返回 `503`。

### Worker API

| 端点 | 说明 |
|------|------|
| `GET /api/inbox?to=<addr>&limit=20` | 邮件列表 |
| `GET /api/inbox?to=<addr>&query=<text>` | 搜索邮件 |
| `GET /api/code?to=<addr>&timeout=30` | 长轮询等待验证码 |
| `GET /api/email?id=<id>` | 邮件详情（含附件） |
| `POST /api/send` | 通过 provider 链发送邮件（Cloudflare Email Service、Resend） |
| `GET /api/sync?to=<addr>&since=<iso>` | 增量邮件同步（含附件） |
| `GET /health` | 健康检查（始终公开） |

## 存储 Provider

CLI 自动检测存储 Provider：
- 配置了 `api_key` → 远程（mails.dev 托管）
- 配置了 `worker_url` → 远程（自部署 Worker）
- 否则 → 本地 SQLite

### SQLite（默认）

本地数据库，路径 `~/.mails/mails.db`。零配置。

### db9.ai

面向 AI Agent 的云端 PostgreSQL。支持全文搜索（按相关性排序）、附件内容搜索和高级过滤。

```bash
mails config set storage_provider db9
mails config set db9_token YOUR_TOKEN
mails config set db9_database_id YOUR_DB_ID
```

使用 db9 后可获得：
- **加权全文搜索** — 主题（最高权重）> 发件人 > 正文 > 附件文本
- **附件过滤** — 按类型、按名称、有/无附件
- **发件人 & 时间过滤** — `--from`、`--since`、`--until`
- **邮件头查询** — 搜索 JSONB 邮件头
- **发件人统计** — 所有发件人的频率排行

### Remote（Worker API）

直接查询 Worker HTTP API。配置了 `api_key` 或 `worker_url` 时自动启用。

## 配置项

| 键 | 默认值 | 说明 |
|---|--------|------|
| `mailbox` | | 接收邮箱地址 |
| `api_key` | | mails.dev 托管服务 API key |
| `worker_url` | | 自部署 Worker URL |
| `worker_token` | | 自部署 Worker 的 mailbox token |
| `resend_api_key` | | Resend API 密钥 |
| `default_from` | | 默认发件人地址 |
| `storage_provider` | auto | `sqlite`、`db9` 或 `remote` |

## 测试

```bash
bun test              # 单元 + E2E 测试（无需外部依赖）
bun test:coverage     # 附带覆盖率报告
bun test:live         # 实时 E2E 测试（需要 .env 配置）
bun test:all          # 全部测试（包括实时 E2E）
```

198 个单元测试 + 27 个 E2E 测试 = **225 个测试**，覆盖全部 Provider。

### 各 Provider E2E 覆盖情况

|                           | SQLite | db9   | Remote (OSS) | Remote (托管) |
|---------------------------|--------|-------|--------------|---------------|
| 存储 inbound 邮件         | ✅     | ✅    | N/A          | N/A           |
| 存储邮件 + 附件           | ✅     | ✅    | N/A          | N/A           |
| 发送 → 接收（真实链路）    | ✅     | —     | ✅           | ✅            |
| 收件箱列表                | ✅     | ✅    | ✅           | ✅            |
| has_attachments 标记      | ✅     | ✅    | ✅           | ✅            |
| 方向过滤                  | ✅     | ✅    | ✅           | ✅            |
| 分页                      | ✅     | ✅    | ✅           | ✅            |
| 邮件详情                  | ✅     | ✅    | ✅           | ✅            |
| 附件元数据                | ✅     | ✅    | ✅           | ✅            |
| 搜索                      | ✅     | ✅    | ✅           | ✅            |
| 附件内容搜索              | ✅     | ✅    | —            | —             |
| 验证码                    | ✅     | ✅    | ✅           | ✅            |
| 附件下载                  | ✅     | ✅    | —            | ✅            |
| 保存到磁盘 (--save)       | ✅     | —     | —            | ✅            |
| 邮箱隔离                  | ✅     | ✅    | —            | —             |
| Outbound 记录             | ✅     | —     | ✅           | N/A           |
| 通过 Worker 发送 (/api/send)| —   | —     | ✅           | —             |
| 同步到本地                 | —     | —     | ✅           | —             |

## 许可证

MIT
