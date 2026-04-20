# Cloudflare Email Service 集成设计

**Date**: 2026-04-17
**Status**: approved
**Scope**: `mails` (OSS) + `~/Codes/mails.dev` 两仓的 worker 发送链路

## 背景

Cloudflare 4/16 发布 [Email for Agents](https://blog.cloudflare.com/email-for-agents/)，提供 Workers 原生 `env.EMAIL.send()` binding，自动配置 SPF/DKIM/DMARC。

当前状态：两个 worker 都直接 `fetch('https://api.resend.com/emails')` 发信。目标是引入 provider 抽象层，同时支持 Cloudflare Email Service 与 Resend。

## 目标

1. 引入 provider 抽象层，OSS 与 mails.dev 使用**同一套路由逻辑**
2. 部署期通过 `EMAIL_PROVIDERS` 环境变量声明优先级链
3. 按能力（attachment/cc/bcc）自动跳过不支持的 provider，失败时按链降级
4. 向后兼容：现有 Resend-only 部署升级后行为不变（自动检测缺失配置）

## 非目标（YAGNI）

- 熔断 / 动态 capability 探测
- 每请求级的 provider override
- CLI 新 config 键
- CF 原生收信（receive 路径本期不改）
- 提升免费额度（后续单独决策）

## 架构

### Provider 抽象层

新建 `worker/src/providers/`，导出：

```ts
// types.ts
export interface SendRequest {
  from: string
  to: string[]
  subject: string
  text?: string
  html?: string
  reply_to?: string
  cc?: string[]
  bcc?: string[]
  attachments?: Array<{ filename: string; content: string; content_type?: string }>
}

export interface SendResult {
  id: string
  provider: 'cloudflare' | 'resend'
}

export interface EmailProvider {
  name: 'cloudflare' | 'resend'
  supports(req: SendRequest): boolean
  send(req: SendRequest): Promise<SendResult>
}

export class UnsupportedFeatureError extends Error {}
export class AllProvidersFailedError extends Error {
  constructor(public attempts: Array<{ provider: string; error: string }>) {
    super(`All providers failed: ${attempts.map(a => `${a.provider}: ${a.error}`).join('; ')}`)
  }
}
```

### 能力表

```ts
// cloudflare.ts
const CF_CAPS = { html: true, replyTo: true, attachments: false, cc: false, bcc: false }

class CloudflareProvider implements EmailProvider {
  name = 'cloudflare' as const
  supports(req: SendRequest): boolean {
    if (req.attachments?.length) return false
    if (req.cc?.length) return false
    if (req.bcc?.length) return false
    return true
  }
  // …
}
```

`html` / `reply_to` 按"支持"假设，若实测 CF 不支持再在 `supports()` 收紧。

### Chain 构建与分发

```ts
// chain.ts
export function buildProviderChain(env: ChainEnv): EmailProvider[] {
  const names = (env.EMAIL_PROVIDERS ?? 'cloudflare,resend')
    .split(',').map(s => s.trim()).filter(Boolean)
  const chain: EmailProvider[] = []
  for (const name of names) {
    if (name === 'cloudflare' && env.EMAIL?.send) chain.push(new CloudflareProvider(env.EMAIL))
    if (name === 'resend' && env.RESEND_API_KEY) chain.push(new ResendProvider(env.RESEND_API_KEY))
  }
  return chain
}

export async function sendWithChain(chain: EmailProvider[], req: SendRequest): Promise<SendResult> {
  if (chain.length === 0) throw new Error('No email provider configured')
  const attempts: Array<{ provider: string; error: string }> = []
  let anySupports = false
  for (const p of chain) {
    if (!p.supports(req)) continue
    anySupports = true
    try {
      return await p.send(req)
    } catch (err) {
      attempts.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!anySupports) throw new UnsupportedFeatureError(
    `No provider in chain supports request features (attachments/cc/bcc)`
  )
  throw new AllProvidersFailedError(attempts)
}
```

### handleSend 改造

**OSS `worker/src/index.ts`**:
```ts
async function handleSend(request, env, authorizedMailbox) {
  const chain = buildProviderChain(env)
  if (chain.length === 0) {
    return Response.json({ error: 'No email provider configured' }, { status: 503 })
  }
  const body = await request.json() as SendRequest & { from?: string }
  // … 现有参数校验 + mailbox 授权 …
  try {
    const { id, provider } = await sendWithChain(chain, body)
    // D1 outbound 写入（新增 provider 列）
    return Response.json({ id, from: body.from, provider })
  } catch (err) {
    if (err instanceof UnsupportedFeatureError)
      return Response.json({ error: err.message }, { status: 400 })
    if (err instanceof AllProvidersFailedError)
      return Response.json({ error: err.message, attempts: err.attempts }, { status: 502 })
    throw err
  }
}
```

**mails.dev `worker/src/send.ts`**:
- 配额 / x402 / DB9 所有业务逻辑不动
- `sendViaResend(...)` 调用替换为 `sendWithChain(buildProviderChain(env), {...body, from: mailbox})`
- outbound 记录写入时携带 `provider` 字段

### Schema 迁移

```sql
-- mails/worker/schema.sql
ALTER TABLE emails ADD COLUMN provider TEXT;

-- mails.dev/worker/migrations/NNNN_add_provider_column.sql
ALTER TABLE emails ADD COLUMN provider TEXT;

-- mails.dev db9-schema.sql
ALTER TABLE emails ADD COLUMN provider TEXT;
```

`provider` 允许 NULL 兼容历史数据；下游 SDK 类型字段设为可选。

### Env / Binding 配置

OSS `wrangler.toml` 注释示例：
```toml
# ---- Email sending providers ----
# Option A: Resend only (current default)
#   wrangler secret put RESEND_API_KEY
#
# Option B: Cloudflare Email Service (private beta)
#   [[send_email]]
#   name = "EMAIL"
#
# Option C: Both (CF preferred, Resend fallback)
#   同时配 EMAIL binding + RESEND_API_KEY secret
#
# 默认优先级 = "cloudflare,resend"，缺失配置的 provider 会自动跳过
# 显式覆盖：
#   wrangler secret put EMAIL_PROVIDERS  # 例如 "resend" 强制只用 Resend
```

## 响应契约

`POST /api/send`、`POST /v1/send` 返回体新增：
```json
{ "id": "...", "from": "...", "provider": "cloudflare" }
```

SDK `SendResult.provider?: 'cloudflare' | 'resend'`，可选字段，老客户端忽略。

## CLI 影响

- 默认输出不变：`✓ Sent: <id>`
- `--verbose` / `MAILS_VERBOSE=1` 时追加 `via cloudflare`
- `mails inbox <id>` 详情页：若 `provider` 非空，显示 `Provider: cloudflare`

## 向后兼容

- 部署时不设 `EMAIL_PROVIDERS` → 默认 `"cloudflare,resend"`
- 无 EMAIL binding + 有 `RESEND_API_KEY` → chain=[resend]，等同现状
- `provider` 列可为 NULL，现有 outbound 记录不迁移

## 部署策略

- **OSS**：新版 tag 发布后，升级的部署零配置继续跑 Resend；设置 EMAIL binding 后自动加入链
- **mails.dev**：Stage 1 部署抽象层，env `EMAIL_PROVIDERS=resend` 强制保持现状；CF 切换等私有 beta 稳定后单独决策，不在本期

## 测试

**单元测试**（两仓镜像）：
- `supports()` 能力表覆盖
- `buildProviderChain`：解析 / 默认值 / 缺失配置剔除
- `sendWithChain`：supports 短路、失败降级、全挂聚合错误、空链错

**Worker E2E**（OSS）：
- 对部署的 `mails-oss-test` worker 发送各种 provider 组合的 `/api/send` 请求
- 断言 response 中的 `provider` 字段
- 通过 `/api/inbox?direction=outbound` 验证 D1 落库

**Live 测试**：
- Resend live 保持现有
- CF live 加 `MAILS_LIVE_CF=1` 标志；beta 期间默认 skip

## 代码共享

OSS 与 mails.dev 两个独立仓，短期**镜像复制** `providers/` 目录（~200 行）。第三个依赖者出现时再抽 npm package（YAGNI）。

## 交付物清单

| 项 | 路径 | 新建/改动 |
|---|---|---|
| 类型 & 接口 | `mails/worker/src/providers/types.ts` | 新建 |
| CF provider | `mails/worker/src/providers/cloudflare.ts` | 新建 |
| Resend provider | `mails/worker/src/providers/resend.ts` | 新建（迁移现有） |
| Chain & 分发 | `mails/worker/src/providers/chain.ts` | 新建 |
| OSS handleSend | `mails/worker/src/index.ts` | 改动 |
| mails.dev providers | `mails.dev/worker/src/providers/*` | 镜像复制 |
| mails.dev handleSend | `mails.dev/worker/src/send.ts` | 改动 |
| OSS Schema | `mails/worker/schema.sql` | ALTER TABLE |
| mails.dev Schema | `mails.dev/worker/migrations/` + `db9-schema.sql` | ALTER TABLE |
| SDK 类型 | `mails/src/types.ts` | `provider?` 可选 |
| CLI 显示 | `mails/src/commands/send.ts` | `--verbose` 输出 |
| 单测 OSS | `mails/test/unit/email-providers.test.ts` | 新建 |
| 单测 mails.dev | `mails.dev/worker/test/…` | 新建 |
| Live 测试 | `mails/test/live/` | 加 `MAILS_LIVE_CF` 标志 |
| Wrangler 示例 | `mails/worker/wrangler.toml` | 改动注释 |
| 文档 | README / README.zh / README.ja | 改动 |
