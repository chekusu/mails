# mails

Email infrastructure for AI agents. Send and receive emails programmatically.

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)

[日本語](https://github.com/chekusu/mails/blob/main/README.ja.md) | [中文](https://github.com/chekusu/mails/blob/main/README.zh.md)

## How it works

```
                       SENDING                                     RECEIVING

  Agent                                               External
    |                                                   |
    |  mails send --to user@example.com                 |  email to agent@mails.dev
    |                                                   |
    v                                                   v
+--------+         +----------+              +-------------------+
|  CLI   |-------->|  Resend  |              | Cloudflare Email  |
|  /SDK  |         |  (ext.)  |              |     Routing       |
+--------+         +----------+              +-------------------+
    |                    ^                              |
    |  /v1/send          |  send API                    |  email() handler
    |  /api/send         |                              |
    v                    |                              v
+-----------------------------------------------------------+
|                       Worker                              |
|                                                           |
|  mails.dev (hosted)        or     your own (self-hosted)  |
|  +-----------------------------------------+              |
|  |  +----------+    +----------------+     |  +---------+ |
|  |  |  db9.ai  |    |  fs9 (files)   |     |  |   D1    | |
|  |  | FTS, adv |    | (attachments)  |     |  | (store) | |
|  |  |  queries |    +----------------+     |  +---------+ |
|  |  +----------+                           |              |
|  +-----------------------------------------+              |
+-----------------------------------------------------------+
          |                           |
    query via CLI/SDK           mails sync
     (remote provider)        (pull to local)
          |                           |
          v                     +-----+------+
       Agent                    |            |
                          +---------+  +-----------+
                          | SQLite  |  |  db9.ai   |
                          | (local) |  |  (cloud)  |
                          +---------+  +-----------+
                           offline      FTS search
                           backup       adv. filters
```

## Features

- **Send emails** via Resend with attachment support
- **Receive emails** via Cloudflare Email Routing Worker
- **Search inbox** — keyword search across subject, body, sender, code
- **Verification code extraction** — auto-extracts codes from emails (EN/ZH/JA/KO)
- **Attachments** — send files via CLI (`--attach`) or SDK, receive and parse MIME attachments
- **Storage providers** — local SQLite, [db9.ai](https://db9.ai) cloud PostgreSQL, or remote Worker API
- **Zero runtime dependencies** — Resend provider uses raw `fetch()`
- **Hosted service** — free `@mails.dev` mailboxes via `mails claim`
- **Self-hosted** — deploy your own Worker with mailbox-scoped auth tokens

## Install

```bash
npm install -g mails
# or
bun install -g mails
# or use directly
npx mails
```

## Quick Start

### Hosted (mails.dev)

```bash
mails claim myagent                  # Claim myagent@mails.dev (free)
mails send --to user@example.com --subject "Hello" --body "World"  # 100 free/month
mails inbox                          # List received emails
mails inbox --query "password"       # Search emails
mails code --to myagent@mails.dev    # Wait for verification code
```

No Resend key needed — hosted users get 100 free sends/month. For unlimited sending, set your own key: `mails config set resend_api_key re_YOUR_KEY`

### Self-Hosted

```bash
cd worker && wrangler deploy             # Deploy your own Worker
# Choose at least one outbound provider:
wrangler secret put RESEND_API_KEY       # Option A: Resend
#   Option B: Cloudflare Email Service (public beta) — add to wrangler.toml:
#   [[send_email]]
#   name = "EMAIL"
# Both can be configured; default chain tries cloudflare → resend.
# Force order / disable one via:
#   wrangler secret put EMAIL_PROVIDERS   # e.g. "resend" or "cloudflare,resend"
#
# Single mailbox:
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# Multi mailbox:
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_MAILBOX_TOKEN
mails config set mailbox agent@yourdomain.com
mails send --to user@example.com --subject "Hello" --body "Hi"  # Sends via Worker
mails inbox                              # Queries Worker API
mails sync                               # Download emails to local SQLite
```

## CLI Reference

### claim

```bash
mails claim <name>                   # Claim name@mails.dev (max 10 per user)
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
mails inbox                                  # List recent emails
mails inbox --mailbox agent@test.com         # Specific mailbox
mails inbox --query "password reset"         # Full-text search (ranked by relevance)
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <id>                             # View email details + attachments

# Advanced filters (mails.dev hosted / db9)
mails inbox --has-attachments                # Only emails with attachments
mails inbox --attachment-type pdf            # Filter by attachment type
mails inbox --from github.com               # Filter by sender
mails inbox --since 2026-03-01 --until 2026-03-20  # Time range
mails inbox --header "X-Mailer:sendgrid"    # Filter by email header

# Combine any filters
mails inbox --from github.com --has-attachments --since 2026-03-13
mails inbox --query "deploy" --attachment-type log --direction inbound
```

### stats

```bash
mails stats senders                          # Top senders by frequency
```

### code

```bash
mails code --to agent@test.com              # Wait for code (default 30s)
mails code --to agent@test.com --timeout 60 # Custom timeout
```

The code is printed to stdout for easy piping: `CODE=$(mails code --to agent@test.com)`

### config

```bash
mails config                    # Show all config
mails config set <key> <value>  # Set a value
mails config get <key>          # Get a value
```

### sync

```bash
mails sync                              # Sync emails from Worker to local storage
mails sync --since 2026-03-01           # Sync from specific date
mails sync --from-scratch               # Full re-sync
```

Pulls emails from your Worker (hosted or self-hosted) into local SQLite. Useful for offline access or local backup.

## SDK Usage

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// Send
const result = await send({
  to: 'user@example.com',
  subject: 'Hello',
  text: 'World',
})

// Send with attachment
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// List inbox
const emails = await getInbox('agent@mails.dev', { limit: 10 })

// Search inbox (full-text search with relevance ranking)
const results = await searchInbox('agent@mails.dev', {
  query: 'password reset',
  direction: 'inbound',
})

// Advanced filters (mails.dev hosted / db9)
const pdfs = await getInbox('agent@mails.dev', {
  has_attachments: true,
  attachment_type: 'pdf',
  since: '2026-03-01',
})

// Wait for verification code
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## Email Worker

The `worker/` directory contains a Cloudflare Email Routing Worker for receiving emails.

### Setup

```bash
cd worker
bun install
wrangler d1 create mails
# Edit wrangler.toml — set your D1 database ID
wrangler d1 execute mails --file=schema.sql
wrangler deploy
```

Then configure Cloudflare Email Routing to forward to this worker.

### Secure the Worker

```bash
# Single mailbox:
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# Multi mailbox:
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
```

All `/api/*` endpoints require `Authorization: Bearer <mailbox-token>`. The token must belong to the mailbox in `?to=`, the email being fetched, or the `from` address being sent. `/health` is always public. If no mailbox token config is present, `/api/*` returns `503`.

### Worker API

| Endpoint | Description |
|----------|-------------|
| `GET /api/inbox?to=<addr>&limit=20` | List emails |
| `GET /api/inbox?to=<addr>&query=<text>` | Search emails |
| `GET /api/code?to=<addr>&timeout=30` | Long-poll for verification code |
| `GET /api/email?id=<id>` | Get email by ID (with attachments) |
| `POST /api/send` | Send email via configured provider chain (Cloudflare Email Service, Resend) |
| `GET /api/sync?to=<addr>&since=<iso>` | Incremental email sync (with attachments) |
| `GET /health` | Health check (always public) |

## Storage Providers

The CLI auto-detects the storage provider:
- `api_key` in config → remote (mails.dev hosted)
- `worker_url` in config → remote (self-hosted Worker)
- Otherwise → local SQLite

### SQLite (default)

Local database at `~/.mails/mails.db`. Zero config.

### db9.ai

Cloud PostgreSQL for AI agents. Full-text search with relevance ranking, attachment content search, and advanced filtering.

```bash
mails config set storage_provider db9
mails config set db9_token YOUR_TOKEN
mails config set db9_database_id YOUR_DB_ID
```

With db9, you get:
- **Weighted FTS** — subject (highest) > sender > body > attachment text
- **Attachment filters** — by type, by name, with/without attachments
- **Sender & time filters** — `--from`, `--since`, `--until`
- **Header queries** — search JSONB email headers
- **Sender stats** — frequency ranking of all senders

### Remote (Worker API)

Queries the Worker HTTP API directly. Auto-enabled when `api_key` or `worker_url` is configured.

## Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `mailbox` | | Your receiving address |
| `api_key` | | API key for mails.dev hosted service |
| `worker_url` | | Self-hosted Worker URL |
| `worker_token` | | Mailbox token for self-hosted Worker |
| `resend_api_key` | | Resend API key |
| `default_from` | | Default sender address |
| `storage_provider` | auto | `sqlite`, `db9`, or `remote` |

## Testing

```bash
bun test              # Unit + E2E tests (no external deps)
bun test:coverage     # With coverage report
bun test:live         # Live E2E with real Resend + Cloudflare (requires .env)
bun test:all          # All tests including live E2E
```

198 unit tests + 27 E2E tests = **225 tests** across all providers.

### E2E Coverage by Provider

|                           | SQLite | db9   | Remote (OSS) | Remote (Hosted) |
|---------------------------|--------|-------|--------------|-----------------|
| Save inbound email        | ✅     | ✅    | N/A          | N/A             |
| Save email + attachments  | ✅     | ✅    | N/A          | N/A             |
| Send → receive (real)     | ✅     | —     | ✅           | ✅              |
| Inbox list                | ✅     | ✅    | ✅           | ✅              |
| has_attachments flag      | ✅     | ✅    | ✅           | ✅              |
| Direction filter          | ✅     | ✅    | ✅           | ✅              |
| Pagination                | ✅     | ✅    | ✅           | ✅              |
| Email detail              | ✅     | ✅    | ✅           | ✅              |
| Attachment metadata       | ✅     | ✅    | ✅           | ✅              |
| Search                    | ✅     | ✅    | ✅           | ✅              |
| Attachment content search | ✅     | ✅    | —            | —               |
| Verification code         | ✅     | ✅    | ✅           | ✅              |
| Download attachment       | ✅     | ✅    | —            | ✅              |
| Save to disk (--save)     | ✅     | —     | —            | ✅              |
| Mailbox isolation         | ✅     | ✅    | —            | —               |
| Outbound recording        | ✅     | —     | ✅           | N/A             |
| Send via Worker (/api/send)| —     | —     | ✅           | —               |
| Sync to local             | —      | —     | ✅           | —               |

## License

MIT
