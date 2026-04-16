import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createRemoteProvider } from '../../src/providers/storage/remote'

const API = 'http://localhost:9999'
const MAILBOX = 'agent@test.com'

describe('Remote provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // --- Self-hosted mode (/api/* with mailbox token) ---

  test('getEmails calls /api/inbox with ?to= in self-hosted mode', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ emails: [{ id: '1', subject: 'Test' }] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    await provider.init()
    const emails = await provider.getEmails(MAILBOX, { limit: 5, direction: 'inbound' })

    expect(requestUrl).toContain('/api/inbox')
    expect(requestUrl).toContain('to=agent%40test.com')
    expect(requestUrl).toContain('limit=5')
    expect(requestUrl).toContain('direction=inbound')
    expect(emails).toHaveLength(1)
  })

  test('getCode calls /api/code with ?to= in self-hosted mode', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ code: '123456', from: 'a@b.com', subject: 'Code' }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const result = await provider.getCode(MAILBOX, { timeout: 5 })

    expect(requestUrl).toContain('/api/code')
    expect(requestUrl).toContain('to=agent%40test.com')
    expect(requestUrl).toContain('timeout=5')
    expect(result).toEqual({ code: '123456', from: 'a@b.com', subject: 'Code' })
  })

  test('getCode returns null when no code', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ code: null }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(await provider.getCode(MAILBOX, { timeout: 1 })).toBeNull()
  })

  test('getEmail calls /api/email', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'e1', subject: 'Detail' }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const email = await provider.getEmail('e1')
    expect(email).not.toBeNull()
    expect(email!.id).toBe('e1')
  })

  test('getEmail returns null for 404', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(await provider.getEmail('12345678-1234-1234-1234-123456789012')).toBeNull()
  })

  test('getEmail resolves a short id prefix via inbox fallback', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (url: string) => {
      calls.push(url)
      const parsed = new URL(url)
      if (parsed.pathname === '/v1/email' && parsed.searchParams.get('id') === 'e5b51d60') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      }
      if (parsed.pathname === '/v1/inbox') {
        return new Response(JSON.stringify({
          emails: [
            { id: 'e5b51d60-7238-433d-85f6-00f922e73ed3', subject: 'OTP Code' },
          ],
        }))
      }
      if (parsed.pathname === '/v1/email' && parsed.searchParams.get('id') === 'e5b51d60-7238-433d-85f6-00f922e73ed3') {
        return new Response(JSON.stringify({
          id: 'e5b51d60-7238-433d-85f6-00f922e73ed3',
          subject: 'OTP Code',
        }))
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const email = await provider.getEmail('e5b51d60')

    expect(email).not.toBeNull()
    expect(email!.id).toBe('e5b51d60-7238-433d-85f6-00f922e73ed3')
    expect(calls.some(url => url.includes('/v1/inbox'))).toBe(true)
  })

  test('getEmail short id fallback throws for ambiguous matches', async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes('/api/email?id=abcd1234')) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      }
      if (url.includes('/api/inbox')) {
        return new Response(JSON.stringify({
          emails: [
            { id: 'abcd1234-first', subject: 'First' },
            { id: 'abcd1234-second', subject: 'Second' },
          ],
        }))
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: 'worker-token' })
    expect(provider.getEmail('abcd1234')).rejects.toThrow('Ambiguous email id: abcd1234')
  })

  test('searchEmails calls /api/inbox with ?query=', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    await provider.searchEmails(MAILBOX, { query: 'reset', limit: 10, direction: 'outbound' })

    expect(requestUrl).toContain('/api/inbox')
    expect(requestUrl).toContain('query=reset')
    expect(requestUrl).toContain('direction=outbound')
  })

  test('saveEmail throws read-only error', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.saveEmail({} as any)).rejects.toThrow('read-only')
  })

  // --- Authenticated mode (mails.dev hosted, with apiKey) ---

  test('uses /v1/* paths and Bearer header when apiKey is set', async () => {
    let requestUrl = ''
    let authHeader = ''
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      requestUrl = url
      authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? ''
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    await provider.getEmails(MAILBOX)

    expect(requestUrl).toContain('/v1/inbox')
    expect(requestUrl).not.toContain('to=')
    expect(authHeader).toBe('Bearer mk_test')
  })

  test('uses /v1/code without ?to= when apiKey is set', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ code: null }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    await provider.getCode(MAILBOX, { timeout: 3, since: '2025-01-01' })

    expect(requestUrl).toContain('/v1/code')
    expect(requestUrl).not.toContain('to=')
    expect(requestUrl).toContain('since=2025-01-01')
  })

  // --- Self-hosted auth ---

  test('sends Bearer header with worker_token in self-hosted mode', async () => {
    let authHeader = ''
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? ''
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: 'myworkertoken' })
    await provider.getEmails(MAILBOX)

    expect(authHeader).toBe('Bearer myworkertoken')
  })

  // --- Error handling ---

  test('throws on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.getEmails(MAILBOX)).rejects.toThrow('API error')
  })

  test('throws on search API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.searchEmails(MAILBOX, { query: 'x' })).rejects.toThrow('API error')
  })

  test('throws on code API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.getCode(MAILBOX)).rejects.toThrow('API error')
  })

  test('throws on email detail API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.getEmail('x')).rejects.toThrow('API error')
  })

  // --- Attachment passthrough ---

  test('getEmail passes through attachments from API', async () => {
    const apiEmail = {
      id: 'att-1',
      mailbox: MAILBOX,
      from_address: 'sender@test.com',
      from_name: 'Sender',
      to_address: MAILBOX,
      subject: 'With attachment',
      body_text: 'See attached',
      body_html: '',
      code: null,
      headers: {},
      metadata: {},
      direction: 'inbound',
      status: 'received',
      has_attachments: true,
      attachment_count: 2,
      attachment_names: 'report.pdf data.csv',
      attachments: [
        {
          id: 'a1',
          email_id: 'att-1',
          filename: 'report.pdf',
          content_type: 'application/pdf',
          size_bytes: 12345,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 0,
          text_content: '',
          text_extraction_status: 'unsupported',
          storage_key: null,
          downloadable: false,
          created_at: '2026-03-20T00:00:00Z',
        },
        {
          id: 'a2',
          email_id: 'att-1',
          filename: 'data.csv',
          content_type: 'text/csv',
          size_bytes: 456,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 1,
          text_content: 'col1,col2\nval1,val2',
          text_extraction_status: 'done',
          storage_key: null,
          downloadable: false,
          created_at: '2026-03-20T00:00:00Z',
        },
      ],
      received_at: '2026-03-20T00:00:00Z',
      created_at: '2026-03-20T00:00:00Z',
    }

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(apiEmail))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const email = await provider.getEmail('att-1')

    expect(email).not.toBeNull()
    expect(email!.has_attachments).toBe(true)
    expect(email!.attachment_count).toBe(2)
    expect(email!.attachments).toHaveLength(2)
    expect(email!.attachments![0]!.filename).toBe('report.pdf')
    expect(email!.attachments![0]!.content_type).toBe('application/pdf')
    expect(email!.attachments![0]!.size_bytes).toBe(12345)
    expect(email!.attachments![1]!.filename).toBe('data.csv')
    expect(email!.attachments![1]!.text_content).toBe('col1,col2\nval1,val2')
  })

  test('getEmails passes through attachment_count from API', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        emails: [
          { id: '1', subject: 'No attachment', has_attachments: false, attachment_count: 0 },
          { id: '2', subject: 'Has attachment', has_attachments: true, attachment_count: 3 },
        ],
      }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const emails = await provider.getEmails(MAILBOX)

    expect(emails).toHaveLength(2)
    expect(emails[0]!.attachment_count).toBe(0)
    expect(emails[1]!.attachment_count).toBe(3)
    expect(emails[1]!.has_attachments).toBe(true)
  })

  test('getEmail works for email without attachments', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        id: 'no-att',
        subject: 'Plain email',
        has_attachments: false,
        attachment_count: 0,
        attachments: [],
      }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const email = await provider.getEmail('no-att')

    expect(email).not.toBeNull()
    expect(email!.attachments).toHaveLength(0)
    expect(email!.has_attachments).toBe(false)
  })

  // --- Default params ---

  test('uses defaults when no options provided', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    await provider.getEmails(MAILBOX)
    expect(requestUrl).toContain('limit=20')
    expect(requestUrl).toContain('offset=0')
  })
})
