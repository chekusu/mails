# Implementation Plan: Cloudflare Email Service 集成

**Design**: [`docs/plans/2026-04-17-cloudflare-email-service-design.md`](docs/plans/2026-04-17-cloudflare-email-service-design.md)
**Status**: ✅ shipped 2026-04-19，CF public-beta 能力校准 2026-04-22

## Checklist

### Phase 1 — OSS provider 抽象层

- [x] 1.1 新建 `worker/src/providers/types.ts`（接口 + 错误类）
- [x] 1.2 新建 `worker/src/providers/cloudflare.ts`（CF binding 封装）
- [x] 1.3 新建 `worker/src/providers/resend.ts`（迁移现有 Resend 调用）
- [x] 1.4 新建 `worker/src/providers/chain.ts`（`buildProviderChain` + `sendWithChain`）
- [x] 1.5 新建 `worker/src/providers/index.ts`（re-export）

### Phase 2 — OSS 集成

- [x] 2.1 改造 `worker/src/index.ts::handleSend` 用 `sendWithChain`
- [x] 2.2 `worker/src/index.ts::Env` 新增 `EMAIL`、`EMAIL_PROVIDERS` 字段
- [x] 2.3 `worker/schema.sql` 新增 `provider TEXT` 列
- [x] 2.4 `handleSend` D1 INSERT 写入 provider
- [x] 2.5 `toInboxEmail` / `toDetailEmail` 透传 provider 字段
- [x] 2.6 `worker/wrangler.toml` 加 CF binding 注释示例

### Phase 3 — OSS 单元测试

- [x] 3.1 新建 `test/unit/email-providers.test.ts`
    - `CloudflareProvider.supports()` 各特性组合（public-beta 后全部返回 true）
    - `ResendProvider.supports()` 恒真
    - `buildProviderChain` 解析 / 默认 / 剔除
    - `sendWithChain` supports 短路 / 失败降级 / 全挂 / 空链
- [x] 3.2 更新 `test/unit/worker.test.ts` handleSend 断言（provider 字段）
- [x] 3.3 `bun test` 全绿（250 pass）

### Phase 4 — SDK & CLI

- [x] 4.1 `src/core/types.ts` Email `provider?` 可选字段
- [x] 4.2 `src/cli/commands/send.ts` 已有 `Sent via ${provider}` 输出（无需 `--verbose`）
- [x] 4.3 `src/providers/send/oss.ts` 透传 worker 报告的 provider
- [x] 4.4 `test/unit/oss-send.test.ts` 加 propagates-provider 用例

### Phase 5 — mails.dev 镜像

- [x] 5.1 复制 providers/ 到 `~/Codes/mails.dev/worker/src/providers/`
- [x] 5.2 改造 `~/Codes/mails.dev/worker/src/send.ts` 用 `sendWithChain`
- [x] 5.3 `~/Codes/mails.dev/worker/src/types.ts::Env` 加 `EMAIL`、`EMAIL_PROVIDERS`
- [x] 5.4 `~/Codes/mails.dev/worker/migrations/005_add_provider_column.sql`
- [x] 5.5 `~/Codes/mails.dev/worker/db9-schema.sql` + `schema.sql` ALTER TABLE
- [x] 5.6 `handleSend` 写 D1 + DB9 outbound 带 provider
- [x] 5.7 mails.dev 无 worker test 目录 — 共享单测覆盖

### Phase 6 — E2E 验证（部署测试 worker）

- [x] 6.1 `wrangler deploy --config deploy/oss-test/wrangler.toml`
- [x] 6.2 `wrangler d1 execute mails-oss-test --remote --file=worker/migrations/0001_add_provider_column.sql`
- [x] 6.3 curl + `test/e2e/full-selfhosted.test.ts#9` 断言 `provider` 字段
- [x] 6.4 curl + test #12 CF 原生处理 attachment（public-beta 校准后，CF 直接发送不降级）
- [x] 6.5 curl + test #10 outbound D1 落 `provider`
- [x] 6.6 test #14 502 attempts 包含 CF+Resend 两跳，test #13/#15/#16 覆盖 403/401 路径

### Phase 7 — 文档

- [x] 7.1 更新 `README.md` 加 CF Email Service 配置章节
- [x] 7.2 同步 `README.zh.md` + `README.ja.md`
- [x] 7.3 `skill.md` 未涉及发送能力，跳过

### Phase 8 — 提交

- [x] 8.1 mails: 8 commits（feat/test/docs/chore 分类）
- [x] 8.2 mails.dev: 2 commits（feat/worker 主实现 + CF public-beta 校准）
- [ ] 8.3 Push（等用户确认）

## 关键约束

- **不修改**：CLI 外部契约（send 输出、config 键）、receive/email() 处理、db9/storage API
- **向后兼容**：`EMAIL_PROVIDERS` 默认 `cloudflare,resend` 但缺配置自动剔除；老 outbound 记录 provider=NULL
- **mails.dev 生产保守**：部署时显式 `EMAIL_PROVIDERS=resend` 保持现状直到观察稳定
- **方向错就 revert**：抽象层若证明比直写 Resend 复杂度性价比低，回滚到 origin
