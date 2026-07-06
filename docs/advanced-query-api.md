# 高级查询 API（mails.dev 托管服务）

状态：托管 HTTP API 已提供；尚未接入 `mails` CLI / SDK

## 概述

mails.dev 托管服务基于 DB9（PostgreSQL）提供高级邮件查询能力，超越基础的关键词搜索。

这些能力通过托管 API 的 `GET /v1/inbox` 与 `GET /v1/stats/senders` 查询参数暴露。

> **重要**：以下高级过滤参数与发件人统计目前**仅在托管 HTTP API 上可用**。
> 本仓库的 `mails` CLI（`src/cli/commands/inbox.ts`）与 SDK 只透传 `query`、
> `direction`、`limit`（搜索时另加 `query`）；其他参数会被静默忽略。自部署 Worker
> （`worker/src/index.ts` 的 `/api/inbox`）同样只支持 `query`（`LIKE` 匹配）、
> `direction`、`limit`、`offset`。若需要下述高级能力，请直接调用托管 HTTP API。

## API 参数

### GET /v1/inbox

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `query` | string | FTS 全文搜索（权重：subject > from > body > 附件文本） | `query=password reset` |
| `direction` | string | 方向过滤 | `direction=inbound` |
| `has_attachments` | bool | 只返回有附件的邮件 | `has_attachments=true` |
| `attachment_type` | string | 按附件文件类型过滤（匹配文件名） | `attachment_type=pdf` |
| `from` | string | 按发件人地址模糊匹配 | `from=github.com` |
| `since` | string | 起始时间（ISO 8601） | `since=2026-03-01` |
| `until` | string | 截止时间（ISO 8601） | `until=2026-03-20` |
| `header` | string | 按邮件头 JSONB 字段匹配（`Key:value` 格式） | `header=X-Mailer:sendgrid` |
| `limit` | number | 返回数量上限（默认 20，最大 100） | `limit=50` |
| `offset` | number | 分页偏移 | `offset=20` |

### GET /v1/stats/senders

按发件人聚合统计，返回频率最高的前 50 个发件人。

```json
{
  "senders": [
    { "from_address": "noreply@github.com", "count": 42 },
    { "from_address": "notifications@slack.com", "count": 17 }
  ]
}
```

## HTTP 用法（托管 API）

调用需带 `Authorization: Bearer mk_YOUR_API_KEY`。所有参数可自由组合。

### 基础搜索

```bash
# FTS 全文搜索（按相关性排序）
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?query=password+reset"
```

### 附件过滤

```bash
# 只看有附件的邮件
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?has_attachments=true"

# 按附件类型过滤
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?attachment_type=pdf"

# 组合：带 PDF 附件且包含 "invoice"
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?query=invoice&attachment_type=pdf"
```

### 发件人过滤

```bash
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?from=github.com"
```

### 时间范围

```bash
# 指定区间
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?since=2026-03-01&until=2026-03-20"

# 组合：上周来自 GitHub 的带附件邮件
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?from=github.com&has_attachments=true&since=2026-03-13"
```

### 邮件头查询

```bash
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?header=X-Mailer:sendgrid"
```

### 发件人统计

```bash
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/stats/senders"
```

## FTS 搜索权重

全文搜索使用 PostgreSQL `websearch_to_tsquery` + 四级权重：

| 权重 | 字段 | 说明 |
|------|------|------|
| A（最高） | `subject` | 邮件主题 |
| B | `from_name` | 发件人名称 |
| C | `body_text` | 邮件正文 |
| D（最低） | `attachment_search_text` | 附件提取的文本内容 |

搜索结果按 `ts_rank` 相关性排序，同分按 `received_at DESC`。

支持 PostgreSQL websearch 语法：
- `"exact phrase"` — 精确短语
- `word1 word2` — AND（同时包含）
- `word1 OR word2` — OR
- `-word` — 排除

## 回退行为

当 DB9 不可用时，托管服务的查询自动回退到 D1（Cloudflare SQLite）：
- FTS 降级为 `LIKE` 模糊匹配
- 高级过滤参数不可用
- 排序固定为 `received_at DESC`

## CLI / SDK 现状

- CLI（`src/cli/commands/inbox.ts`）：仅解析并转发 `query`、`direction`、`limit`；
  `has_attachments`、`attachment_type`、`from`、`since`、`until`、`header` 会被忽略。
- Remote provider（`src/providers/storage/remote.ts`）：`getEmails` 仅发送
  `limit`、`offset`、`direction`；`searchEmails` 额外发送 `query`。
- 因此上述高级参数暂时只能通过直接调用托管 HTTP API 使用。若未来要接入 CLI/SDK，
  需要扩展 `EmailQueryOptions`（`src/core/types.ts`）并在 CLI 与各 provider 中打通。

## 实现位置

| 组件 | 位置 |
|------|------|
| 自部署 Worker API 路由 | `worker/src/index.ts`（所有路由集中于此，无独立 `routes.ts`） |
| DB9 查询引擎 / Schema | mails.dev 托管服务基础设施（不在本仓库中） |
| 本仓库存储 provider | `src/providers/storage/{sqlite,remote,db9}.ts` |
