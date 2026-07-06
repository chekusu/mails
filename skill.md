# mails — Email for AI Agents

Send and receive emails. Get a free `@mails.dev` mailbox or use your own domain.

## Onboarding (follow these steps in order)

### Step 1: Install

```bash
npm install -g mails
```

Verify: `mails version` should print a version number.

### Step 2: Claim a mailbox

You need a `@mails.dev` email address. This requires a human to approve (one-time).

```bash
mails claim <pick-a-name>
```

**If you have a browser** (local machine): it will open automatically. The human approves, and the CLI receives the API key.

**If you don't have a browser** (sandbox, SSH, CI): the CLI will print a confirmation URL like this:

```
  Claiming myagent@mails.dev

  Open this link to confirm:

    https://mails.dev?session=<session-id>&claim=myagent&source=cli

  Waiting...
```

Relay the URL to your human user. Once they open it and confirm, the CLI will continue and save the credentials to `~/.mails/config.json`.

Verify: `mails config get mailbox` should print your address. `mails config get api_key` should print `mk_...`.

### Step 3: Test receiving — check your inbox

Your mailbox is ready to receive emails. Check it:

```bash
mails inbox
```

Expected: `No emails found.` (empty inbox is normal for a new mailbox).

### Step 4: Send an email

After claiming, you can send emails immediately — no extra config needed (100 free/month):

```bash
mails send --to user@example.com --subject "Hello" --body "World"
```

Verify: `Sent via mails.dev (id: ...)` confirms the email was sent. The sender address is your claimed mailbox.

To send unlimited emails, configure your own Resend API key:

```bash
mails config set resend_api_key re_YOUR_KEY
```

### Step 5: Test search and verification code

Search your inbox:

```bash
mails inbox --query "test"
```

Wait for a verification code:

```bash
mails code --to YOUR_MAILBOX@mails.dev --timeout 30
```

This long-polls for up to 30 seconds. When an email with a verification code arrives, it prints the code to stdout. If no code arrives, it exits with code 1.

### Onboarding complete

You now have:
- `~/.mails/config.json` with your mailbox, API key, and send config
- A working `@mails.dev` address that receives emails
- The ability to send and search emails

---

## CLI Reference

```
mails claim <name>        Claim name@mails.dev (max 10 per user)
mails send                Send an email (with optional attachments)
mails inbox               List or search received emails
mails code                Wait for a verification code
mails sync                Sync emails from Worker to local storage
mails config              View or modify configuration
mails help                Show help
mails version             Show version
```

### claim

```bash
mails claim myagent
```

Opens browser (or prints a confirmation URL in headless mode) for human approval. On success, saves `mailbox` and `api_key` to config. Each human user can create up to 10 mailboxes.

### send

```bash
mails send --to user@example.com --subject "Subject" --body "Plain text body"
mails send --to user@example.com --subject "Subject" --html "<h1>HTML body</h1>"
mails send --from "Name <email>" --to user@example.com --subject "Subject" --body "Text"
mails send --to user@example.com --subject "Subject" --body "Text" --reply-to replies@example.com
mails send --to user@example.com --subject "Report" --body "See attached" --attach report.pdf
mails send --to user@example.com --subject "Files" --body "Two files" --attach a.txt --attach b.csv
```

Uses `default_from` from config if `--from` is not specified. In hosted mode (`api_key` configured) no Resend key is needed — hosted users get 100 free sends/month. For self-hosted or unlimited sending, set `resend_api_key` in config.

### inbox

```bash
mails inbox                                  # List recent emails
mails inbox --full-id                        # List with full email IDs (default shows 8-char prefix)
mails inbox --mailbox addr@mails.dev         # Specify mailbox
mails inbox --query "password reset"         # Full-text search (ranked by relevance)
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox --direction outbound             # View sent email history
mails inbox <email-id>                       # Show full email details (with attachments)
mails inbox <email-id> --save                # Download attachments to current directory
mails inbox <email-id> --save ./downloads    # Download attachments to a directory
```

Advanced query capabilities (attachment/sender/time/header filters and sender
stats) are provided by the mails.dev hosted HTTP API only (see the **API (Direct
HTTP)** section below); they are not yet wired through the `mails` CLI or SDK.

### code

```bash
mails code --to addr@mails.dev              # Wait 30s (default)
mails code --to addr@mails.dev --timeout 60 # Wait 60s
```

Prints the verification code to stdout (for piping: `CODE=$(mails code --to ...)`). Details go to stderr. Exits with code 1 if no code received within timeout.

### config

```bash
mails config                    # Show all
mails config set <key> <value>  # Set a value
mails config get <key>          # Get a value
mails config path               # Show config file path
```

Config file: `~/.mails/config.json`

### sync

```bash
mails sync                              # Sync from Worker to local storage
mails sync --since 2026-03-01           # Sync from specific date
mails sync --from-scratch               # Full re-sync (ignore last sync time)
```

Pulls emails from your Worker (hosted or self-hosted) into local SQLite. Useful for offline access, local backup, or local search. Tracks last sync time in config — subsequent runs are incremental.

| Key | Set by | Description |
|-----|--------|-------------|
| `mailbox` | `mails claim` | Your receiving address |
| `api_key` | `mails claim` | API key for hosted mails.dev service (mk_...) |
| `resend_api_key` | manual | Resend API key for sending emails |
| `default_from` | manual | Default sender address |
| `storage_provider` | manual | `sqlite`, `db9`, or `remote` (auto-detected) |
| `worker_url` | manual | Self-hosted Worker URL (enables remote provider) |
| `worker_token` | manual | Mailbox token for self-hosted Worker |
| `db9_token` | manual | db9.ai cloud storage token |
| `db9_database_id` | manual | db9.ai database ID |
| `last_sync` | `mails sync` | Timestamp of last sync run (auto-managed) |

## Self-Hosted Setup

Deploy your own Worker instead of using mails.dev:

```bash
cd worker
bun install
wrangler d1 create mails
# Edit wrangler.toml — set your D1 database ID
wrangler d1 execute mails --file=schema.sql
wrangler deploy
wrangler secret put RESEND_API_KEY       # Enable sending via Worker
# Single mailbox:
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# Multi mailbox:
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
```

Then configure Cloudflare Email Routing to forward to this worker.

Configure the CLI to use your Worker:

```bash
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_MAILBOX_TOKEN
mails config set mailbox agent@yourdomain.com
```

Now all commands work through your Worker:
```bash
mails send --to user@example.com --subject "Hello" --body "Hi"  # Sends via Worker
mails inbox                              # Queries Worker API
mails sync                               # Download emails to local SQLite
```

## SDK (Programmatic Usage)

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// Send an email
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
const emails = await getInbox('myagent@mails.dev', { limit: 10 })

// Search inbox (full-text search with relevance ranking)
const results = await searchInbox('myagent@mails.dev', {
  query: 'password reset',
  direction: 'inbound',
  limit: 5,
})

// Wait for verification code
const code = await waitForCode('myagent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## API (Direct HTTP)

For agents that prefer raw HTTP over the CLI/SDK.

### Claim flow (no auth, hosted only)

```bash
# Start session
curl -X POST https://api.mails.dev/v1/claim/start \
  -H "Content-Type: application/json" \
  -d '{"name": "myagent"}'
# → {"session_id": "xxx", "device_code": "ABCD-1234", "expires_in": 600}

# Poll until human confirms (every 2s)
curl "https://api.mails.dev/v1/claim/poll?session=xxx"
# → {"status": "pending"}
# → {"status": "complete", "mailbox": "myagent@mails.dev", "api_key": "mk_xxx"}
```

### Hosted endpoints (mails.dev, requires API key from claim)

```bash
# Send email (100 free/month, then $0.002/email via x402 USDC)
curl -X POST -H "Authorization: Bearer mk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.mails.dev/v1/send" \
  -d '{"to":["user@example.com"],"subject":"Hello","text":"World"}'

# Send with attachment (≤10MB total)
curl -X POST -H "Authorization: Bearer mk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.mails.dev/v1/send" \
  -d '{"to":["user@example.com"],"subject":"Report","text":"See attached","attachments":[{"filename":"report.pdf","content":"<base64>","content_type":"application/pdf"}]}'

# List inbox
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox"

# Search inbox (full-text search with relevance ranking)
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?query=password+reset&direction=inbound"

# Advanced filters (all combinable)
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?has_attachments=true&attachment_type=pdf"
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?from=github.com&since=2026-03-01&until=2026-03-20"
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?header=X-Mailer:sendgrid"

# View sent email history
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?direction=outbound"

# Sender frequency stats
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/stats/senders"

# Wait for verification code
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/code?timeout=30"

# Get email detail (includes attachments)
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/email?id=EMAIL_ID"

# Download attachment
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/attachment?id=ATTACHMENT_ID" -o file.pdf
```

### Self-hosted endpoints (your Worker, mailbox token required)

```bash
# List inbox
curl -H "Authorization: Bearer YOUR_MAILBOX_TOKEN" \
  "https://your-worker.example.com/api/inbox?to=agent@yourdomain.com"

# Search inbox
curl -H "Authorization: Bearer YOUR_MAILBOX_TOKEN" \
  "https://your-worker.example.com/api/inbox?to=agent@yourdomain.com&query=invoice"

# Wait for verification code
curl -H "Authorization: Bearer YOUR_MAILBOX_TOKEN" \
  "https://your-worker.example.com/api/code?to=agent@yourdomain.com&timeout=30"

# Send email (via Worker → Resend, records outbound in D1)
curl -X POST -H "Authorization: Bearer YOUR_MAILBOX_TOKEN" \
  -H "Content-Type: application/json" \
  "https://your-worker.example.com/api/send" \
  -d '{"from":"agent@yourdomain.com","to":["user@example.com"],"subject":"Hello","text":"World"}'

# Sync emails (incremental pull)
curl -H "Authorization: Bearer YOUR_MAILBOX_TOKEN" \
  "https://your-worker.example.com/api/sync?to=agent@yourdomain.com&since=2026-03-01T00:00:00Z"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAILS_API_URL` | `https://api.mails.dev` | Override API base URL |
| `MAILS_CLAIM_URL` | `https://mails.dev` | Override claim page URL |
| `MAILS_NO_UPDATE_CHECK` | `0` | Set to `1` to disable npm update checks (`NO_UPDATE_NOTIFIER=1` or `CI=1` also disable them) |

## Links

- Website: https://mails.dev
- npm: https://www.npmjs.com/package/mails
- GitHub: https://github.com/chekusu/mails
