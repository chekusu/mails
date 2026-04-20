/**
 * Full end-to-end test: self-hosted (open-source worker) mode.
 *
 * Tests the complete lifecycle against the deployed OSS worker at test.mails.dev:
 *   1. Send email TO e2e@test.mails.dev (from kimeeru.com)
 *   2. Email arrives via Cloudflare Email Routing → OSS Worker → D1
 *   3. CLI queries via remote provider (worker_url + worker_token)
 *   4. Search inbox
 *   5. Query verification code
 *
 * Requires .env with:
 *   RESEND_API_KEY=re_xxx              (kimeeru key, for sending TO test.mails.dev)
 *   OSS_WORKER_URL=https://mails-oss-test.o-u-turing.workers.dev
 *   OSS_WORKER_TOKEN=oss_e2e_xxx       (AUTH_TOKEN set on the worker)
 *   OSS_MAILBOX=e2e@test.mails.dev
 *
 * Run: bun test test/e2e/full-selfhosted.test.ts
 */
import { describe, expect, test, beforeAll } from 'bun:test'
import { createRemoteProvider } from '../../src/providers/storage/remote'
import { createResendProvider } from '../../src/providers/send/resend'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const OSS_WORKER_URL = process.env.OSS_WORKER_URL || 'https://mails-oss-test.o-u-turing.workers.dev'
const OSS_WORKER_TOKEN = process.env.OSS_WORKER_TOKEN || ''
const OSS_MAILBOX = process.env.OSS_MAILBOX || 'e2e@test.mails.dev'

const skip = !RESEND_API_KEY || !OSS_WORKER_TOKEN

const VERIFICATION_CODE = String(Math.floor(100000 + Math.random() * 900000))

describe.skipIf(skip)('Full E2E: self-hosted OSS worker', () => {
  beforeAll(() => {
    console.log(`  Worker: ${OSS_WORKER_URL}`)
    console.log(`  Mailbox: ${OSS_MAILBOX}`)
    console.log(`  Code: ${VERIFICATION_CODE}`)
  })

  test('1. send email TO self-hosted mailbox', async () => {
    const resend = createResendProvider(RESEND_API_KEY!)
    const result = await resend.send({
      from: 'mails oss-e2e <noreply@kimeeru.com>',
      to: [OSS_MAILBOX],
      subject: `[oss-e2e] code: ${VERIFICATION_CODE}`,
      text: `Your verification code is ${VERIFICATION_CODE}. Self-hosted E2E test.`,
    })

    console.log(`  Sent to ${OSS_MAILBOX}: ${result.id}`)
    expect(result.id).toBeTruthy()
  })

  test('2. wait for email to arrive via Email Routing', async () => {
    // Poll the worker API directly (with AUTH_TOKEN)
    const deadline = Date.now() + 30000
    let arrived = false

    while (Date.now() < deadline) {
      const res = await fetch(`${OSS_WORKER_URL}/api/inbox?to=${encodeURIComponent(OSS_MAILBOX)}&limit=1`, {
        headers: OSS_WORKER_TOKEN ? { Authorization: `Bearer ${OSS_WORKER_TOKEN}` } : {},
      })
      const data = await res.json() as { emails: Array<{ subject: string }> }
      if (data.emails.some(e => e.subject.includes(VERIFICATION_CODE))) {
        console.log(`  Email arrived: ${data.emails[0]!.subject}`)
        arrived = true
        break
      }
      await new Promise(r => setTimeout(r, 3000))
    }

    expect(arrived).toBe(true)
  }, 35000)

  test('3. query inbox via remote provider (worker_url + worker_token)', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const emails = await provider.getEmails(OSS_MAILBOX, { limit: 5 })
    console.log(`  Inbox: ${emails.length} email(s)`)
    expect(emails.length).toBeGreaterThanOrEqual(1)

    const latest = emails[0]!
    expect(latest.mailbox).toBe(OSS_MAILBOX)
  })

  test('4. search inbox via remote provider', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const results = await provider.searchEmails(OSS_MAILBOX, { query: VERIFICATION_CODE })
    console.log(`  Search '${VERIFICATION_CODE}': ${results.length} result(s)`)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.subject).toContain(VERIFICATION_CODE)
  })

  test('5. query verification code via remote provider', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const result = await provider.getCode(OSS_MAILBOX, { timeout: 5 })
    expect(result).not.toBeNull()
    console.log(`  Code: ${result!.code}`)
    expect(result!.code).toBe(VERIFICATION_CODE)
  })

  test('6. get email detail via remote provider', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const emails = await provider.getEmails(OSS_MAILBOX, { limit: 1 })
    const detail = await provider.getEmail(emails[0]!.id)
    expect(detail).not.toBeNull()
    expect(detail!.body_text).toContain(VERIFICATION_CODE)
    console.log(`  Detail: ${detail!.id} — ${detail!.subject}`)
  })

  test('7. getEmails with direction filter', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const inbound = await provider.getEmails(OSS_MAILBOX, { direction: 'inbound' })
    expect(inbound.length).toBeGreaterThanOrEqual(1)
    expect(inbound.every(e => e.direction === 'inbound')).toBe(true)
    console.log(`  Direction filter: inbound=${inbound.length}`)
  })

  test('8. getEmails with pagination', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const page1 = await provider.getEmails(OSS_MAILBOX, { limit: 1 })
    expect(page1).toHaveLength(1)

    const page2 = await provider.getEmails(OSS_MAILBOX, { limit: 1, offset: 1 })
    if (page2.length > 0) {
      expect(page2[0]!.id).not.toBe(page1[0]!.id)
    }
    console.log(`  Pagination: page1=${page1.length}, page2=${page2.length}`)
  })

  test('9. send email via OSS Worker /api/send', async () => {
    const res = await fetch(`${OSS_WORKER_URL}/api/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OSS_WORKER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `mails oss-e2e <noreply@kimeeru.com>`,
        to: ['o.u.turing@gmail.com'],
        subject: `[oss-send-e2e] ${VERIFICATION_CODE}`,
        text: `Sent via OSS /api/send. Code: ${VERIFICATION_CODE}`,
      }),
    })

    const data = await res.json() as { id?: string; provider?: string; error?: string }
    expect(res.ok).toBe(true)
    expect(data.id).toBeTruthy()
    expect(data.provider).toBeTruthy()
    console.log(`  Sent via /api/send: ${data.id} (provider=${data.provider})`)
  })

  test('10. outbound email appears in inbox after /api/send', async () => {
    // The send in test 9 recorded outbound in D1
    // mailbox = body.from (full "Name <email>" string)
    const outboundMailbox = 'mails oss-e2e <noreply@kimeeru.com>'
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: outboundMailbox,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const outbound = await provider.getEmails(outboundMailbox, { direction: 'outbound' })
    expect(outbound.length).toBeGreaterThanOrEqual(1)
    expect(outbound[0]!.direction).toBe('outbound')
    expect(outbound[0]!.status).toBe('sent')
    console.log(`  Outbound emails: ${outbound.length}`)
  })

  test('11. sync emails from Worker to local sqlite', async () => {
    const { existsSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { createSqliteProvider } = await import('../../src/providers/storage/sqlite')

    const testDb = join(import.meta.dir, '..', '.oss-sync-test.db')
    for (const f of [testDb, testDb + '-wal', testDb + '-shm']) {
      if (existsSync(f)) rmSync(f)
    }

    // Sync from /api/sync
    const res = await fetch(
      `${OSS_WORKER_URL}/api/sync?to=${encodeURIComponent(OSS_MAILBOX)}&since=1970-01-01T00:00:00Z&limit=50`,
      { headers: { Authorization: `Bearer ${OSS_WORKER_TOKEN}` } },
    )

    expect(res.ok).toBe(true)
    const data = await res.json() as { emails: any[]; total: number; has_more: boolean }
    expect(data.emails.length).toBeGreaterThanOrEqual(1)
    console.log(`  Sync: ${data.emails.length} emails from Worker (total: ${data.total})`)

    // Save to local sqlite
    const sqlite = createSqliteProvider(testDb)
    await sqlite.init()

    for (const email of data.emails) {
      await sqlite.saveEmail(email)
    }

    // Verify local count matches
    const localEmails = await sqlite.getEmails(OSS_MAILBOX)
    expect(localEmails.length).toBe(data.emails.length)
    console.log(`  Local sqlite: ${localEmails.length} emails`)

    // Verify email fields are complete
    const first = localEmails[0]!
    expect(first.mailbox).toBe(OSS_MAILBOX)
    expect(first.from_address).toBeTruthy()
    expect(first.subject).toBeTruthy()
    expect(first.body_text).toBeTruthy()
    expect(first.direction).toBe('inbound')

    // Verify local search works on synced data
    const searchResults = await sqlite.searchEmails(OSS_MAILBOX, { query: VERIFICATION_CODE })
    expect(searchResults.length).toBeGreaterThanOrEqual(1)
    console.log(`  Local search '${VERIFICATION_CODE}': ${searchResults.length} result(s)`)

    // Verify local code polling works on synced data
    const codeResult = await sqlite.getCode(OSS_MAILBOX, { timeout: 1 })
    expect(codeResult).not.toBeNull()
    console.log(`  Local code: ${codeResult!.code}`)

    // Verify email detail
    const detail = await sqlite.getEmail(first.id)
    expect(detail).not.toBeNull()
    expect(detail!.subject).toBe(first.subject)

    // If synced email has attachments, verify they came through
    const withAtt = localEmails.find(e => e.has_attachments)
    if (withAtt) {
      const attDetail = await sqlite.getEmail(withAtt.id)
      expect(attDetail!.attachments!.length).toBeGreaterThanOrEqual(1)
      console.log(`  Synced attachments: ${attDetail!.attachments!.length} on email ${withAtt.id.slice(0, 8)}`)
    }

    // Cleanup
    for (const f of [testDb, testDb + '-wal', testDb + '-shm']) {
      if (existsSync(f)) rmSync(f)
    }
  })
})
