# Implementation Plan: Cloudflare Email Service 集成

**Design**: [`docs/plans/2026-04-17-cloudflare-email-service-design.md`](docs/plans/2026-04-17-cloudflare-email-service-design.md)

## Checklist

### Phase 1 — OSS provider 抽象层

- [ ] 1.1 新建 `worker/src/providers/types.ts`（接口 + 错误类）
- [ ] 1.2 新建 `worker/src/providers/cloudflare.ts`（CF binding 封装）
- [ ] 1.3 新建 `worker/src/providers/resend.ts`（迁移现有 Resend 调用）
- [ ] 1.4 新建 `worker/src/providers/chain.ts`（`buildProviderChain` + `sendWithChain`）
- [ ] 1.5 新建 `worker/src/providers/index.ts`（re-export）

### Phase 2 — OSS 集成

- [ ] 2.1 改造 `worker/src/index.ts::handleSend` 用 `sendWithChain`
- [ ] 2.2 `worker/src/index.ts::Env` 新增 `EMAIL`、`EMAIL_PROVIDERS` 字段
- [ ] 2.3 `worker/schema.sql` 新增 `provider TEXT` 列
- [ ] 2.4 `handleSend` D1 INSERT 写入 provider
- [ ] 2.5 `toInboxEmail` / `toDetailEmail` 透传 provider 字段
- [ ] 2.6 `worker/wrangler.toml` 加 CF binding 注释示例

### Phase 3 — OSS 单元测试

- [ ] 3.1 新建 `test/unit/email-providers.test.ts`
    - `CloudflareProvider.supports()` 各特性组合
    - `ResendProvider.supports()` 恒真
    - `buildProviderChain` 解析 / 默认 / 剔除
    - `sendWithChain` supports 短路 / 失败降级 / 全挂 / 空链
- [ ] 3.2 更新 `test/unit/worker.test.ts` handleSend 断言（provider 字段）
- [ ] 3.3 `bun test` 全绿

### Phase 4 — SDK & CLI

- [ ] 4.1 `src/types.ts` SendResult 加 `provider?` 字段
- [ ] 4.2 `src/commands/send.ts` `--verbose` 时输出 `via <provider>`
- [ ] 4.3 `src/` 相关 storage provider 类型透传 provider
- [ ] 4.4 SDK 单测补充（若现有覆盖不足）

### Phase 5 — mails.dev 镜像

- [ ] 5.1 复制 providers/ 四个文件到 `~/Codes/mails.dev/worker/src/providers/`
- [ ] 5.2 改造 `~/Codes/mails.dev/worker/src/send.ts` 用 `sendWithChain`
- [ ] 5.3 `~/Codes/mails.dev/worker/src/types.ts::Env` 加 `EMAIL`、`EMAIL_PROVIDERS`
- [ ] 5.4 `~/Codes/mails.dev/worker/migrations/` 新增迁移 SQL
- [ ] 5.5 `~/Codes/mails.dev/worker/db9-schema.sql` ALTER TABLE
- [ ] 5.6 `handleSend` 写 D1 + DB9 outbound 带 provider
- [ ] 5.7 镜像单测到 mails.dev（如有 worker test 目录）

### Phase 6 — E2E 验证（部署测试 worker）

- [ ] 6.1 `cd worker && wrangler deploy --config wrangler.test.toml` 部署 mails-oss-test
- [ ] 6.2 `wrangler d1 execute mails-oss-test --config wrangler.test.toml --file=schema.sql` 应用新 schema
- [ ] 6.3 curl 测试 `/api/send` 纯文本（Resend 路径）断言 `provider=resend`
- [ ] 6.4 curl 测试 `/api/send` 带 attachment（若 chain 含 CF，跳 CF 用 Resend）
- [ ] 6.5 curl `/api/inbox?direction=outbound` 确认 D1 写入 provider
- [ ] 6.6 回归 `mails send` CLI 命令

### Phase 7 — 文档

- [ ] 7.1 更新 `README.md` 加 CF Email Service 配置章节
- [ ] 7.2 同步 `README.zh.md` + `README.ja.md`
- [ ] 7.3 更新 `skill.md`（若涉及发送能力描述）

### Phase 8 — 提交

- [ ] 8.1 OSS commit：`feat(worker): support Cloudflare Email Service via provider chain`
- [ ] 8.2 mails.dev commit：对应改动
- [ ] 8.3 Push（用户确认后）

## 关键约束

- **不修改**：CLI 外部契约（send 输出、config 键）、receive/email() 处理、db9/storage API
- **向后兼容**：`EMAIL_PROVIDERS` 默认 `cloudflare,resend` 但缺配置自动剔除；老 outbound 记录 provider=NULL
- **mails.dev 生产不切 CF**：部署时显式 `EMAIL_PROVIDERS=resend` 保守
- **方向错就 revert**：抽象层若证明比直写 Resend 复杂度性价比低，回滚到 origin
