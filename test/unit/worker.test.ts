import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { parseIncomingEmail } from '../../worker/src/mime'
import type { Env } from '../../worker/src/index'
import worker from '../../worker/src/index'

const DEFAULT_AUTH_TOKEN = 'unit_test_auth_token'

function singleMailboxEnv(
  mailbox: string,
  env: Omit<Env, 'AUTH_TOKEN' | 'MAILBOX'> & { AUTH_TOKEN?: string; MAILBOX?: string }
): Env {
  return {
    ...env,
    AUTH_TOKEN: env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    MAILBOX: env.MAILBOX ?? mailbox,
  }
}

function authedRequest(input: string, init: RequestInit = {}, token = DEFAULT_AUTH_TOKEN): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(input, { ...init, headers })
}

describe('worker: MIME parsing', () => {
  test('extracts body and text attachment metadata from multipart email', async () => {
    const attachment = Buffer.from('invoice number 42').toString('base64')
    const raw = [
      'From: "Sender" <sender@test.com>',
      'Subject: Invoice',
      'Message-ID: <msg-42@test.com>',
      'Content-Type: multipart/mixed; boundary="boundary"',
      '',
      '--boundary',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Email body',
      '--boundary',
      'Content-Type: text/plain; name="invoice.txt"',
      'Content-Disposition: attachment; filename="invoice.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--boundary--',
      '',
    ].join('\r\n')

    const parsed = await parseIncomingEmail(
      new TextEncoder().encode(raw).buffer,
      'email-1',
      '2026-03-18T00:00:00.000Z'
    )

    expect(parsed.subject).toBe('Invoice')
    expect(parsed.bodyText.trim()).toBe('Email body')
    expect(parsed.messageId).toContain('msg-42')
    expect(parsed.attachmentCount).toBe(1)
    expect(parsed.attachmentNames).toBe('invoice.txt')
    expect(parsed.attachmentSearchText).toContain('invoice number 42')
    expect(parsed.attachments[0]).toMatchObject({
      email_id: 'email-1',
      filename: 'invoice.txt',
      content_type: 'text/plain',
      content_disposition: 'attachment',
      text_extraction_status: 'done',
      text_content: 'invoice number 42',
      downloadable: false,
    })
  })

  test('marks unsupported binary attachments without failing the email parse', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake').toString('base64')
    const raw = [
      'Subject: PDF',
      'Content-Type: multipart/mixed; boundary="boundary"',
      '',
      '--boundary',
      'Content-Type: text/plain',
      '',
      'Body',
      '--boundary',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--boundary--',
      '',
    ].join('\r\n')

    const parsed = await parseIncomingEmail(
      new TextEncoder().encode(raw).buffer,
      'email-2',
      '2026-03-18T00:00:00.000Z'
    )

    expect(parsed.bodyText.trim()).toBe('Body')
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]!.filename).toBe('invoice.pdf')
    expect(parsed.attachments[0]!.text_extraction_status).toBe('unsupported')
    expect(parsed.attachments[0]!.text_content).toBe('')
  })

  test('falls back to html content when text body is missing', async () => {
    const raw = [
      'Subject: OTP Code',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<p>OTP Code:<strong>114669</strong></p>',
      '',
    ].join('\r\n')

    const parsed = await parseIncomingEmail(
      new TextEncoder().encode(raw).buffer,
      'email-3',
      '2026-03-18T00:00:00.000Z'
    )

    expect(parsed.bodyHtml).toContain('<strong>114669</strong>')
    expect(parsed.bodyText).toContain('OTP Code:')
    expect(parsed.bodyText).toContain('114669')
  })
})

// --- POST /api/send tests ---

function createMockD1() {
  const boundValues: unknown[] = []
  const runMock = mock(() => Promise.resolve({ success: true }))
  const bindMock = mock((...args: unknown[]) => {
    boundValues.push(...args)
    return { run: runMock }
  })
  const prepareMock = mock((_sql: string) => ({
    bind: bindMock,
  }))
  return {
    db: { prepare: prepareMock } as unknown as D1Database,
    prepareMock,
    bindMock,
    runMock,
    boundValues,
  }
}

const SEND_BODY = {
  from: 'me@example.com',
  to: ['you@example.com'],
  subject: 'Hello',
  text: 'World',
}

describe('worker: routing and inbound email', () => {
  test('handles preflight, health, root, and unknown api routes', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db })

    const preflight = await worker.fetch(new Request('http://localhost/api/send', { method: 'OPTIONS' }), env)
    expect(preflight.status).toBe(200)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')

    const health = await worker.fetch(new Request('http://localhost/health'), env)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    const root = await worker.fetch(new Request('http://localhost/'), env)
    const rootJson = await root.json() as { name: string; version: string }
    expect(root.status).toBe(200)
    expect(rootJson.name).toBe('mails-worker')
    expect(rootJson.version).toBe('1.5.6')

    const unknown = await worker.fetch(authedRequest('http://localhost/api/unknown'), env)
    expect(unknown.status).toBe(404)
  })

  test('stores inbound email and attachment rows', async () => {
    const bindCalls: unknown[][] = []
    const prepareMock = mock((_sql: string) => ({
      bind: mock((...args: unknown[]) => {
        bindCalls.push(args)
        return { run: mock(async () => ({ success: true })) }
      }),
    }))
    const batchMock = mock(async (_statements: unknown[]) => ({ success: true }))
    const db = { prepare: prepareMock, batch: batchMock } as unknown as D1Database
    const attachment = Buffer.from('verification notes').toString('base64')
    const raw = [
      'From: "Alice" <alice@example.com>',
      'Subject: Login code',
      'Message-ID: <inbound-1@example.com>',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<p>Your code is <strong>456789</strong></p>',
      '--b',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--b--',
      '',
    ].join('\r\n')
    const message = {
      to: 'Agent@Test.com',
      from: 'bounce@example.com',
      headers: new Headers({
        from: '"Alice" <alice@example.com>',
        subject: 'Login code',
      }),
      raw: new TextEncoder().encode(raw).buffer,
    } as unknown as ForwardableEmailMessage

    await worker.email(message, { DB: db })

    expect(batchMock).toHaveBeenCalledTimes(1)
    expect(prepareMock).toHaveBeenCalledTimes(2)
    expect(bindCalls).toHaveLength(2)
    expect(bindCalls[0]![1]).toBe('agent@test.com')
    expect(bindCalls[0]![2]).toBe('alice@example.com')
    expect(bindCalls[0]![5]).toBe('Login code')
    expect(bindCalls[0]![8]).toBe('456789')
    expect(bindCalls[0]![12]).toBe(1)
    expect(bindCalls[0]![14]).toBe('notes.txt')
    expect(bindCalls[1]![2]).toBe('notes.txt')
    expect(bindCalls[1]![8]).toBe('verification notes')
  })
})

describe('worker: POST /api/send', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(
        Response.json({ id: 'resend-id-123' }, { status: 200 })
      )
    )
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends email via Resend and records outbound', async () => {
    const { db, prepareMock, bindMock } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { id: string; from: string; provider: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('resend-id-123')
    expect(json.from).toBe('me@example.com')
    expect(json.provider).toBe('resend')

    // Verify Resend API was called correctly
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [resendUrl, resendInit] = (fetchMock as any).mock.calls[0]
    expect(resendUrl).toBe('https://api.resend.com/emails')
    expect(resendInit.method).toBe('POST')
    expect(resendInit.headers['Authorization']).toBe('Bearer re_test_key')
    const resendBody = JSON.parse(resendInit.body)
    expect(resendBody.from).toBe('me@example.com')
    expect(resendBody.to).toEqual(['you@example.com'])
    expect(resendBody.subject).toBe('Hello')
    expect(resendBody.text).toBe('World')

    // Verify D1 insert was called
    expect(prepareMock).toHaveBeenCalledTimes(1)
    expect(bindMock).toHaveBeenCalledTimes(1)
    const boundArgs = (bindMock as any).mock.calls[0]
    expect(boundArgs[0]).toBe('resend-id-123') // id
    expect(boundArgs[1]).toBe('me@example.com') // mailbox
    expect(boundArgs[2]).toBe('me@example.com') // from_address
    expect(boundArgs[3]).toBe('') // from_name
    expect(boundArgs[4]).toBe('you@example.com') // to_address
    expect(boundArgs[5]).toBe('Hello') // subject
    expect(boundArgs[6]).toBe('World') // body_text
    expect(boundArgs[7]).toBe('') // body_html
    expect(boundArgs[8]).toBe(0) // has_attachments
    expect(boundArgs[9]).toBe(0) // attachment_count
    expect(boundArgs[10]).toBe('resend') // provider
  })

  test('returns 400 for missing fields', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    // Missing subject
    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me@example.com', to: ['you@example.com'], text: 'hi' }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(json.error).toContain('Missing required fields')

    // Missing text and html
    const request2 = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me@example.com', to: ['you@example.com'], subject: 'Hi' }),
    })

    const response2 = await worker.fetch(request2, env)
    const json2 = await response2.json() as { error: string }

    expect(response2.status).toBe(400)
    expect(json2.error).toContain('text or html')

    // Resend should not have been called
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns 503 when no provider configured', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db }) // no RESEND_API_KEY, no EMAIL binding

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(json.error).toContain('No email provider configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns 503 when AUTH_TOKEN is not configured', async () => {
    const { db } = createMockD1()
    const env: Env = { DB: db, RESEND_API_KEY: 're_test_key' }

    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(json.error).toBe('AUTH_TOKEN not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('requires auth when AUTH_TOKEN set', async () => {
    const { db } = createMockD1()
    const env: Env = { DB: db, RESEND_API_KEY: 're_test_key', AUTH_TOKEN: 'secret123', MAILBOX: 'me@example.com' }

    // No auth header
    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(401)
    expect(json.error).toBe('Unauthorized')

    // With correct auth header
    const request2 = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret123',
      },
      body: JSON.stringify(SEND_BODY),
    })

    const response2 = await worker.fetch(request2, env)
    const json2 = await response2.json() as { id: string }

    expect(response2.status).toBe(200)
    expect(json2.id).toBe('resend-id-123')
  })

  test('sends email with attachments', async () => {
    const { db, bindMock } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const bodyWithAttachments = {
      ...SEND_BODY,
      attachments: [
        { filename: 'report.pdf', content: 'base64data', content_type: 'application/pdf' },
        { filename: 'notes.txt', content: 'dGV4dA==' },
      ],
    }

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyWithAttachments),
    })

    const response = await worker.fetch(request, env)
    expect(response.status).toBe(200)

    // Verify Resend body includes attachments
    const [, resendInit] = (fetchMock as any).mock.calls[0]
    const resendBody = JSON.parse(resendInit.body)
    expect(resendBody.attachments).toHaveLength(2)
    expect(resendBody.attachments[0].filename).toBe('report.pdf')
    expect(resendBody.attachments[0].content_type).toBe('application/pdf')
    expect(resendBody.attachments[1].filename).toBe('notes.txt')
    expect(resendBody.attachments[1].content_type).toBeUndefined()

    // Verify D1 records has_attachments
    const boundArgs = (bindMock as any).mock.calls[0]
    expect(boundArgs[8]).toBe(1) // has_attachments
    expect(boundArgs[9]).toBe(2) // attachment_count
  })

  test('returns 502 when all providers fail', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ message: 'Invalid API key' }, { status: 403 }))
    ) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string; attempts: Array<{ provider: string; error: string }> }

    expect(response.status).toBe(502)
    expect(json.error).toContain('All providers failed')
    expect(json.attempts[0]?.provider).toBe('resend')
    expect(json.attempts[0]?.error).toContain('Invalid API key')
  })

  test('sends via Cloudflare EMAIL binding when configured', async () => {
    const { db, bindMock } = createMockD1()
    const emailSend = mock(() => Promise.resolve({ messageId: 'cf-id-42' }))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { id: string; provider: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('cf-id-42')
    expect(json.provider).toBe('cloudflare')
    expect(emailSend).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const boundArgs = (bindMock as any).mock.calls[0]
    expect(boundArgs[10]).toBe('cloudflare')
  })

  test('Cloudflare provider handles attachments/cc/bcc natively', async () => {
    const { db } = createMockD1()
    const emailSend = mock(() => Promise.resolve({ messageId: 'cf-attach' }))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      RESEND_API_KEY: 're_test_key',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        cc: ['cc@x.com'],
        bcc: ['bcc@x.com'],
        attachments: [{ filename: 'r.pdf', content: 'base64data', content_type: 'application/pdf' }],
      }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('cloudflare')
    expect(emailSend).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const [msg] = (emailSend as any).mock.calls[0]
    expect(msg.cc).toEqual(['cc@x.com'])
    expect(msg.bcc).toEqual(['bcc@x.com'])
    expect(msg.attachments[0].type).toBe('application/pdf')
    expect(msg.attachments[0].disposition).toBe('attachment')
  })

  test('falls back to Resend when Cloudflare binding throws', async () => {
    const { db } = createMockD1()
    const emailSend = mock(() => Promise.reject(new Error('cf binding down')))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      RESEND_API_KEY: 're_test_key',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(emailSend).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('EMAIL_PROVIDERS=resend forces Resend even with EMAIL binding', async () => {
    const { db } = createMockD1()
    const emailSend = mock(() => Promise.resolve({ id: 'cf-id' }))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      RESEND_API_KEY: 're_test_key',
      EMAIL_PROVIDERS: 'resend',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(emailSend).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('returns 405 for non-POST methods', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const request = authedRequest('http://localhost/api/send', { method: 'GET' })
    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(405)
    expect(json.error).toBe('Method not allowed')
  })

  test('rejects sends for a different mailbox', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEND_BODY, from: 'other@example.com' }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })
})

// --- GET /api/sync tests ---

function makeSyncEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sync-e1',
    mailbox: 'user@test.com',
    from_address: 'sender@test.com',
    from_name: 'Sender',
    to_address: 'user@test.com',
    subject: 'Test email',
    body_text: 'Hello world',
    body_html: '<p>Hello world</p>',
    code: '123456',
    headers: '{"x-test":"1"}',
    metadata: '{"source":"test"}',
    message_id: '<msg-1@test.com>',
    has_attachments: 0,
    attachment_count: 0,
    attachment_names: '',
    attachment_search_text: '',
    raw_storage_key: null,
    direction: 'inbound',
    status: 'received',
    received_at: '2026-03-19T10:00:00Z',
    created_at: '2026-03-19T10:00:00Z',
    ...overrides,
  }
}

function makeSyncAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    email_id: 'sync-e1',
    filename: 'report.txt',
    content_type: 'text/plain',
    size_bytes: 42,
    content_disposition: 'attachment',
    content_id: null,
    mime_part_index: 0,
    text_content: 'report content',
    text_extraction_status: 'done',
    storage_key: 's3://bucket/key',
    created_at: '2026-03-19T10:00:00Z',
    ...overrides,
  }
}

function createSyncMockD1(options: {
  total?: number
  emailRows?: Record<string, unknown>[]
  attachmentRows?: Record<string, unknown>[][]
} = {}) {
  const { total = 1, emailRows, attachmentRows } = options
  const defaultEmails = emailRows ?? [makeSyncEmail()]
  const defaultAttachments = attachmentRows ?? defaultEmails.map(() => [])

  let callIndex = 0
  const prepareMock = mock((_sql: string) => {
    const currentCall = callIndex++
    return {
      bind: mock((..._args: unknown[]) => ({
        first: mock(() => {
          // First call is the COUNT query
          return Promise.resolve({ total })
        }),
        all: mock(() => {
          if (currentCall === 1) {
            // Second call: SELECT * FROM emails
            return Promise.resolve({ results: defaultEmails })
          }
          // Subsequent calls: SELECT * FROM attachments for each email
          const attachmentIndex = currentCall - 2
          return Promise.resolve({ results: defaultAttachments[attachmentIndex] ?? [] })
        }),
      })),
    }
  })

  return { db: { prepare: prepareMock } as unknown as D1Database, prepareMock }
}

describe('worker: auth token configuration', () => {
  test('rejects single token config without mailbox', async () => {
    const { db } = createSyncMockD1()
    const response = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=user@test.com', {}, 'secret'),
      { DB: db, AUTH_TOKEN: 'secret' },
    )
    const json = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(json.error).toBe('MAILBOX not configured')
  })

  test('rejects invalid token map configuration', async () => {
    const { db } = createSyncMockD1()

    const invalidJson = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=user@test.com', {}, 'secret'),
      { DB: db, AUTH_TOKENS_JSON: '{bad json' },
    )
    expect(invalidJson.status).toBe(503)
    expect((await invalidJson.json() as { error: string }).error).toBe('AUTH_TOKENS_JSON is invalid')

    const emptyMap = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=user@test.com', {}, 'secret'),
      { DB: db, AUTH_TOKENS_JSON: '{}' },
    )
    expect(emptyMap.status).toBe(503)

    const invalidToken = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=user@test.com', {}, 'secret'),
      { DB: db, AUTH_TOKENS_JSON: '{"user@test.com":""}' },
    )
    expect(invalidToken.status).toBe(503)
  })

  test('supports multi-mailbox token maps and rejects duplicate token matches', async () => {
    const { db } = createSyncMockD1()
    const response = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=agent@test.com', {}, 'agent-token'),
      {
        DB: db,
        AUTH_TOKENS_JSON: JSON.stringify({
          'agent@test.com': 'agent-token',
          'other@test.com': 'other-token',
        }),
      },
    )
    expect(response.status).toBe(200)

    const duplicate = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=agent@test.com', {}, 'same-token'),
      {
        DB: db,
        AUTH_TOKENS_JSON: JSON.stringify({
          'agent@test.com': 'same-token',
          'alias@test.com': 'same-token',
        }),
      },
    )
    const json = await duplicate.json() as { error: string }
    expect(duplicate.status).toBe(503)
    expect(json.error).toBe('Duplicate mailbox tokens are not allowed')
  })
})

describe('worker: GET /api/inbox and /api/code', () => {
  test('returns 400 when inbox or code target mailbox is missing', async () => {
    const { db } = createSyncMockD1()
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const inbox = await worker.fetch(authedRequest('http://localhost/api/inbox'), env)
    expect(inbox.status).toBe(400)

    const code = await worker.fetch(authedRequest('http://localhost/api/code?timeout=0'), env)
    expect(code.status).toBe(400)
  })

  test('returns null when code polling times out', async () => {
    const { db } = createSyncMockD1({ emailRows: [] })
    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/code?to=user@test.com&timeout=0'),
      env,
    )
    const json = await response.json() as { code: string | null }

    expect(response.status).toBe(200)
    expect(json.code).toBeNull()
  })

  test('escapes LIKE wildcards in inbox search', async () => {
    let capturedSql = ''
    let capturedArgs: unknown[] = []
    const db = {
      prepare: mock((sql: string) => {
        capturedSql = sql
        return {
          bind: mock((...args: unknown[]) => {
            capturedArgs = args
            return {
              all: mock(() => Promise.resolve({ results: [] })),
            }
          }),
        }
      }),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/inbox?to=user@test.com&query=100%_done'),
      env,
    )

    expect(response.status).toBe(200)
    expect(capturedSql).toContain("subject LIKE ? ESCAPE '\\'")
    expect(capturedArgs[1]).toBe('%100\\%\\_done%')
  })

  test('recomputes inbox code from html-only body instead of stale stored code', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          all: mock(() => Promise.resolve({
            results: [
              makeSyncEmail({
                subject: 'OTP Code',
                body_text: '',
                body_html: '<p>OTP Code:<strong>114669</strong></p>',
                code: 'Code',
              }),
            ],
          })),
        })),
      })),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/inbox?to=user@test.com'),
      env,
    )
    const json = await response.json() as { emails: Array<{ code: string | null }> }

    expect(response.status).toBe(200)
    expect(json.emails[0]!.code).toBe('114669')
  })

  test('recomputes polled code from html-only body when stored code is stale', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          all: mock(() => Promise.resolve({
            results: [
              {
                id: 'sync-e1',
                from_address: 'sender@test.com',
                subject: 'OTP Code',
                body_text: '',
                body_html: '<p>OTP Code:<strong>114669</strong></p>',
                code: 'Code',
                received_at: '2026-03-19T10:00:00Z',
              },
            ],
          })),
        })),
      })),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/code?to=user@test.com&timeout=1'),
      env,
    )
    const json = await response.json() as { code: string | null }

    expect(response.status).toBe(200)
    expect(json.code).toBe('114669')
  })

  test('rejects code polling for another mailbox', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          first: mock(() => Promise.resolve(null)),
        })),
      })),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/code?to=other@test.com&timeout=1'),
      env,
    )
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })
})

describe('worker: GET /api/email', () => {
  test('returns 400 when id is missing and 404 when email is not found', async () => {
    const prepareMock = mock((_sql: string) => ({
      bind: mock(() => ({
        first: mock(() => Promise.resolve(null)),
        all: mock(() => Promise.resolve({ results: [] })),
      })),
    }))
    const env = singleMailboxEnv('user@test.com', { DB: { prepare: prepareMock } as unknown as D1Database })

    const missing = await worker.fetch(authedRequest('http://localhost/api/email'), env)
    expect(missing.status).toBe(400)

    const notFound = await worker.fetch(authedRequest('http://localhost/api/email?id=missing'), env)
    const json = await notFound.json() as { error: string }
    expect(notFound.status).toBe(404)
    expect(json.error).toBe('Email not found')
  })

  test('returns email for a unique short id prefix', async () => {
    let callIndex = 0
    const prepareMock = mock((_sql: string) => {
      const currentCall = callIndex++
      return {
        bind: mock((..._args: unknown[]) => ({
          first: mock(() => {
            if (currentCall === 0) return Promise.resolve(null)
            return Promise.resolve(null)
          }),
          all: mock(() => {
            if (currentCall === 1) return Promise.resolve({ results: [makeSyncEmail({ id: 'sync-e1-full' })] })
            if (currentCall === 2) return Promise.resolve({ results: [] })
            return Promise.resolve({ results: [] })
          }),
        })),
      }
    })

    const env = singleMailboxEnv('user@test.com', { DB: { prepare: prepareMock } as unknown as D1Database })
    const response = await worker.fetch(authedRequest('http://localhost/api/email?id=sync-e1'), env)
    const json = await response.json() as { id: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('sync-e1-full')
  })

  test('returns 409 for ambiguous short id prefix', async () => {
    let callIndex = 0
    const prepareMock = mock((_sql: string) => {
      const currentCall = callIndex++
      return {
        bind: mock((..._args: unknown[]) => ({
          first: mock(() => Promise.resolve(null)),
          all: mock(() => {
            if (currentCall === 1) {
              return Promise.resolve({ results: [makeSyncEmail({ id: 'sync-e1' }), makeSyncEmail({ id: 'sync-e2' })] })
            }
            return Promise.resolve({ results: [] })
          }),
        })),
      }
    })

    const env = singleMailboxEnv('user@test.com', { DB: { prepare: prepareMock } as unknown as D1Database })
    const response = await worker.fetch(authedRequest('http://localhost/api/email?id=sync-e'), env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(409)
    expect(json.error).toContain('Ambiguous email id: sync-e')
  })
})

describe('worker: GET /api/sync', () => {
  test('returns emails since timestamp', async () => {
    const email1 = makeSyncEmail({ id: 'e1', received_at: '2026-03-19T10:00:00Z' })
    const email2 = makeSyncEmail({ id: 'e2', received_at: '2026-03-19T11:00:00Z', subject: 'Second' })

    const { db } = createSyncMockD1({
      total: 2,
      emailRows: [email1, email2],
      attachmentRows: [[], []],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync?to=user@test.com&since=2026-03-19T00:00:00Z')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { emails: any[]; total: number; has_more: boolean }

    expect(response.status).toBe(200)
    expect(json.total).toBe(2)
    expect(json.emails).toHaveLength(2)
    expect(json.has_more).toBe(false)
    // headers/metadata should be parsed from JSON strings
    expect(json.emails[0].headers).toEqual({ 'x-test': '1' })
    expect(json.emails[0].metadata).toEqual({ source: 'test' })
    expect(json.emails[0].has_attachments).toBe(false)
  })

  test('returns 400 without ?to=', async () => {
    const { db } = createSyncMockD1()
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(json.error).toContain('Missing ?to=')
  })

  test('returns attachments with emails', async () => {
    const email = makeSyncEmail({ has_attachments: 1, attachment_count: 1 })
    const attachment = makeSyncAttachment()

    const { db } = createSyncMockD1({
      total: 1,
      emailRows: [email],
      attachmentRows: [[attachment]],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync?to=user@test.com')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { emails: any[] }

    expect(response.status).toBe(200)
    expect(json.emails).toHaveLength(1)
    expect(json.emails[0].has_attachments).toBe(true)
    expect(json.emails[0].attachment_count).toBe(1)
    expect(json.emails[0].attachments).toHaveLength(1)
    expect(json.emails[0].attachments[0].filename).toBe('report.txt')
    expect(json.emails[0].attachments[0].downloadable).toBe(true)
  })

  test('falls back for invalid JSON headers and metadata', async () => {
    const email = makeSyncEmail({ headers: '{bad', metadata: '{bad' })
    const { db } = createSyncMockD1({
      total: 1,
      emailRows: [email],
      attachmentRows: [[]],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const response = await worker.fetch(authedRequest('http://localhost/api/sync?to=user@test.com'), env)
    const json = await response.json() as { emails: Array<{ headers: unknown; metadata: unknown }> }

    expect(response.status).toBe(200)
    expect(json.emails[0]!.headers).toEqual({})
    expect(json.emails[0]!.metadata).toEqual({})
  })

  test('supports pagination', async () => {
    const email = makeSyncEmail()

    const { db } = createSyncMockD1({
      total: 150,
      emailRows: [email],
      attachmentRows: [[]],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync?to=user@test.com&limit=50&offset=0')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { emails: any[]; total: number; has_more: boolean }

    expect(response.status).toBe(200)
    expect(json.total).toBe(150)
    expect(json.has_more).toBe(true)
  })

  test('requires auth when AUTH_TOKEN set', async () => {
    const { db } = createSyncMockD1()
    const env: Env = { DB: db, AUTH_TOKEN: 'secret123', MAILBOX: 'user@test.com' }

    // No auth header
    const request = new Request('http://localhost/api/sync?to=user@test.com')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(401)
    expect(json.error).toBe('Unauthorized')

    // With correct auth header
    const request2 = new Request('http://localhost/api/sync?to=user@test.com', {
      headers: { Authorization: 'Bearer secret123' },
    })
    const response2 = await worker.fetch(request2, env)
    expect(response2.status).toBe(200)
  })

  test('rejects sync for a different mailbox', async () => {
    const { db } = createSyncMockD1()
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const response = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=other@test.com'),
      env,
    )
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })
})
