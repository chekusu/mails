import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createDb9Provider } from '../../src/providers/storage/db9'
import type { Email, Attachment } from '../../src/core/types'

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'test-1',
    mailbox: 'agent@test.com',
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: 'agent@test.com',
    subject: 'Test',
    body_text: 'Hello',
    body_html: '<p>Hello</p>',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    received_at: '2025-01-01T00:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('db9 provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('init executes CREATE TABLE', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.init()
    expect(executedQuery).toContain('CREATE TABLE IF NOT EXISTS emails')
  })

  test('saveEmail executes INSERT', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail())
    expect(executedQuery).toContain('INSERT INTO emails')
    expect(executedQuery).toContain('test-1')
    expect(executedQuery).toContain('agent@test.com')
  })

  test('saveEmail escapes single quotes', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({ subject: "It's a test" }))
    expect(executedQuery).toContain("It''s a test")
  })

  test('saveEmail handles null code', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({ code: null }))
    expect(executedQuery).toContain('NULL')
  })

  test('saveEmail handles non-null code', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({ code: '123456' }))
    expect(executedQuery).toContain("'123456'")
  })

  test('getEmails returns parsed emails', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: [
          { name: 'id', type: 'text' },
          { name: 'mailbox', type: 'text' },
          { name: 'from_address', type: 'text' },
          { name: 'from_name', type: 'text' },
          { name: 'to_address', type: 'text' },
          { name: 'subject', type: 'text' },
          { name: 'body_text', type: 'text' },
          { name: 'body_html', type: 'text' },
          { name: 'code', type: 'text' },
          { name: 'headers', type: 'jsonb' },
          { name: 'metadata', type: 'jsonb' },
          { name: 'message_id', type: 'text' },
          { name: 'has_attachments', type: 'bool' },
          { name: 'attachment_count', type: 'int4' },
          { name: 'attachment_names', type: 'text' },
          { name: 'attachment_search_text', type: 'text' },
          { name: 'direction', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'received_at', type: 'timestamptz' },
          { name: 'created_at', type: 'timestamptz' },
        ],
        rows: [
          ['e-1', 'agent@test.com', 'sender@x.com', 'Sender', 'agent@test.com', 'Hi', 'Hello', '', null, '{}', '{}', null, false, 0, '', '', 'inbound', 'received', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.getEmails('agent@test.com')
    expect(emails).toHaveLength(1)
    expect(emails[0]!.id).toBe('e-1')
    expect(emails[0]!.subject).toBe('Hi')
    expect(emails[0]!.direction).toBe('inbound')
  })

  test('getEmails filters by direction', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.getEmails('agent@test.com', { direction: 'outbound' })
    expect(executedQuery).toContain("direction = 'outbound'")
  })

  test('getEmail returns single email', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify({
          columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'message_id', 'has_attachments', 'attachment_count', 'attachment_names', 'attachment_search_text', 'direction', 'status', 'received_at', 'created_at'],
          rows: [
            ['e-1', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', null, false, 0, '', '', 'inbound', 'received', '2025-01-01', '2025-01-01'],
          ],
          row_count: 1,
        }))
      }
      // Second call: attachments query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const email = await provider.getEmail('e-1')
    expect(email).not.toBeNull()
    expect(email!.id).toBe('e-1')
    expect(email!.attachments).toEqual([])
  })

  test('getEmail returns null when not found', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    expect(await provider.getEmail('nope')).toBeNull()
  })

  test('getEmail resolves a unique id prefix', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
      }
      if (callCount === 2) {
        return new Response(JSON.stringify({
          columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'message_id', 'has_attachments', 'attachment_count', 'attachment_names', 'attachment_search_text', 'direction', 'status', 'received_at', 'created_at'],
          rows: [
            ['prefix-1111-full', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', null, false, 0, '', '', 'inbound', 'received', '2025-01-01', '2025-01-01'],
          ],
          row_count: 1,
        }))
      }
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const email = await provider.getEmail('prefix-1111')
    expect(email).not.toBeNull()
    expect(email!.id).toBe('prefix-1111-full')
  })

  test('getEmail throws on ambiguous id prefix', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
      }
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'message_id', 'has_attachments', 'attachment_count', 'attachment_names', 'attachment_search_text', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['prefix-1111', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', null, false, 0, '', '', 'inbound', 'received', '2025-01-01', '2025-01-01'],
          ['prefix-2222', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', null, false, 0, '', '', 'inbound', 'received', '2025-01-02', '2025-01-02'],
        ],
        row_count: 2,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    expect(provider.getEmail('prefix-')).rejects.toThrow('Ambiguous email id: prefix-')
  })

  test('searchEmails builds hybrid FTS query', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.searchEmails('agent@test.com', {
      query: `"reset password" OR owner's`,
      direction: 'inbound',
      limit: 5,
    })

    expect(executedQuery).toContain("websearch_to_tsquery('simple'")
    expect(executedQuery).toContain("to_tsvector('simple'")
    expect(executedQuery).toContain('ts_rank(')
    expect(executedQuery).toContain('from_address ILIKE')
    expect(executedQuery).toContain('code ILIKE')
    expect(executedQuery).toContain("direction = 'inbound'")
    expect(executedQuery).toContain("owner''s")
  })

  test('searchEmails returns parsed emails', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: [
          { name: 'id', type: 'text' },
          { name: 'mailbox', type: 'text' },
          { name: 'from_address', type: 'text' },
          { name: 'from_name', type: 'text' },
          { name: 'to_address', type: 'text' },
          { name: 'subject', type: 'text' },
          { name: 'body_text', type: 'text' },
          { name: 'body_html', type: 'text' },
          { name: 'code', type: 'text' },
          { name: 'headers', type: 'jsonb' },
          { name: 'metadata', type: 'jsonb' },
          { name: 'message_id', type: 'text' },
          { name: 'has_attachments', type: 'bool' },
          { name: 'attachment_count', type: 'int4' },
          { name: 'attachment_names', type: 'text' },
          { name: 'attachment_search_text', type: 'text' },
          { name: 'direction', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'received_at', type: 'timestamptz' },
          { name: 'created_at', type: 'timestamptz' },
        ],
        rows: [
          ['search-1', 'agent@test.com', 'sender@x.com', 'Sender', 'agent@test.com', 'Reset password', 'Hello', '', '123456', '{}', '{}', null, false, 0, '', '', 'inbound', 'received', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.searchEmails('agent@test.com', { query: 'reset' })
    expect(emails).toHaveLength(1)
    expect(emails[0]!.id).toBe('search-1')
    expect(emails[0]!.code).toBe('123456')
  })

  test('getCode returns code on first poll', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: [
          { name: 'code', type: 'text' },
          { name: 'from_address', type: 'text' },
          { name: 'subject', type: 'text' },
        ],
        rows: [['999888', 'noreply@svc.com', 'Your code']],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getCode('agent@test.com', { timeout: 3 })
    expect(result).not.toBeNull()
    expect(result!.code).toBe('999888')
    expect(result!.from).toBe('noreply@svc.com')
  })

  test('getCode returns null on timeout', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ columns: ['code', 'from_address', 'subject'], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getCode('agent@test.com', { timeout: 1 })
    expect(result).toBeNull()
  })

  test('getCode includes since filter', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: ['code', 'from_address', 'subject'], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.getCode('agent@test.com', { timeout: 1, since: '2025-06-01T00:00:00Z' })
    expect(executedQuery).toContain('2025-06-01')
  })

  test('throws on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('Unauthorized', { status: 401 })
    }) as typeof fetch

    const provider = createDb9Provider('bad-token', 'db-123')
    expect(provider.init()).rejects.toThrow('db9 error (401)')
  })

  test('sends correct auth header', async () => {
    let authHeader = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>)['Authorization']
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('my-secret-token', 'db-123')
    await provider.init()
    expect(authHeader).toBe('Bearer my-secret-token')
  })

  test('uses correct database URL', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'my-db-id')
    await provider.init()
    expect(requestUrl).toBe('https://api.db9.ai/customer/databases/my-db-id/sql')
  })

  test('getEmails handles JSONB object headers', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'message_id', 'has_attachments', 'attachment_count', 'attachment_names', 'attachment_search_text', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['e-1', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, { 'X-Custom': 'val' }, { key: 'value' }, null, false, 0, '', '', 'inbound', 'received', '2025-01-01', '2025-01-01'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.getEmails('a@b.com')
    expect(emails[0]!.headers).toEqual({ 'X-Custom': 'val' })
    expect(emails[0]!.metadata).toEqual({ key: 'value' })
  })

  test('saveEmail includes attachment metadata columns in SQL', async () => {
    const queries: string[] = []
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      queries.push(body.query)
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({
      message_id: '<abc@example.com>',
      has_attachments: true,
      attachment_count: 2,
      attachments: [
        {
          id: 'att-1', email_id: 'test-1', filename: 'file.txt', content_type: 'text/plain',
          size_bytes: 100, content_disposition: 'attachment', content_id: null,
          mime_part_index: 0, text_content: 'hello world', text_extraction_status: 'done',
          storage_key: null, created_at: '2025-01-01T00:00:00Z',
        },
        {
          id: 'att-2', email_id: 'test-1', filename: 'image.png', content_type: 'image/png',
          size_bytes: 5000, content_disposition: 'attachment', content_id: null,
          mime_part_index: 1, text_content: '', text_extraction_status: 'unsupported',
          storage_key: null, created_at: '2025-01-01T00:00:00Z',
        },
      ],
    }))
    const emailInsert = queries[0]!
    expect(emailInsert).toContain('has_attachments')
    expect(emailInsert).toContain('attachment_count')
    expect(emailInsert).toContain('attachment_names')
    expect(emailInsert).toContain('attachment_search_text')
    expect(emailInsert).toContain('message_id')
    expect(emailInsert).toContain('true')
    expect(emailInsert).toContain('file.txt, image.png')
    expect(emailInsert).toContain('hello world')
  })

  test('saveEmail inserts attachments into attachments table', async () => {
    const queries: string[] = []
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      queries.push(body.query)
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({
      attachments: [
        {
          id: 'att-1', email_id: 'test-1', filename: 'report.pdf', content_type: 'application/pdf',
          size_bytes: 2048, content_disposition: 'attachment', content_id: null,
          mime_part_index: 0, text_content: 'extracted text', text_extraction_status: 'done',
          storage_key: 'key-123', created_at: '2025-01-01T00:00:00Z',
        },
      ],
    }))

    expect(queries).toHaveLength(2)
    expect(queries[0]!).toContain('INSERT INTO emails')
    expect(queries[1]!).toContain('INSERT INTO attachments')
    expect(queries[1]!).toContain('att-1')
    expect(queries[1]!).toContain('report.pdf')
    expect(queries[1]!).toContain('application/pdf')
    expect(queries[1]!).toContain('2048')
    expect(queries[1]!).toContain('extracted text')
    expect(queries[1]!).toContain('key-123')
  })

  test('saveEmail does not insert attachments when none provided', async () => {
    const queries: string[] = []
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      queries.push(body.query)
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail())

    expect(queries).toHaveLength(1)
    expect(queries[0]!).toContain('INSERT INTO emails')
  })

  test('getEmail fetches attachments from attachments table', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify({
          columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'message_id', 'has_attachments', 'attachment_count', 'attachment_names', 'attachment_search_text', 'direction', 'status', 'received_at', 'created_at'],
          rows: [
            ['e-1', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', null, true, 1, 'doc.pdf', '', 'inbound', 'received', '2025-01-01', '2025-01-01'],
          ],
          row_count: 1,
        }))
      }
      // Second call: attachments
      return new Response(JSON.stringify({
        columns: ['id', 'email_id', 'filename', 'content_type', 'size_bytes', 'content_disposition', 'content_id', 'mime_part_index', 'text_content', 'text_extraction_status', 'storage_key', 'created_at'],
        rows: [
          ['att-1', 'e-1', 'doc.pdf', 'application/pdf', 1024, 'attachment', null, 0, 'pdf text', 'done', null, '2025-01-01'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const email = await provider.getEmail('e-1')
    expect(email).not.toBeNull()
    expect(email!.attachments).toHaveLength(1)
    expect(email!.attachments![0]!.id).toBe('att-1')
    expect(email!.attachments![0]!.filename).toBe('doc.pdf')
    expect(email!.attachments![0]!.content_type).toBe('application/pdf')
    expect(email!.attachments![0]!.size_bytes).toBe(1024)
    expect(email!.attachments![0]!.text_content).toBe('pdf text')
    expect(email!.attachments![0]!.text_extraction_status).toBe('done')
    expect(email!.attachments![0]!.mime_part_index).toBe(0)
  })

  test('getEmails returns has_attachments and attachment_count', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'message_id', 'has_attachments', 'attachment_count', 'attachment_names', 'attachment_search_text', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['e-1', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', null, true, 2, 'a.pdf, b.txt', 'some text', 'inbound', 'received', '2025-01-01', '2025-01-01'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.getEmails('a@b.com')
    expect(emails).toHaveLength(1)
    expect(emails[0]!.has_attachments).toBe(true)
    expect(emails[0]!.attachment_count).toBe(2)
    expect(emails[0]!.attachment_names).toBe('a.pdf, b.txt')
    expect(emails[0]!.attachment_search_text).toBe('some text')
  })

  test('EMAIL_COLUMNS includes attachment metadata fields', async () => {
    // Verify by checking that getEmails SELECT query includes the new column names
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.getEmails('a@b.com')
    expect(executedQuery).toContain('message_id')
    expect(executedQuery).toContain('has_attachments')
    expect(executedQuery).toContain('attachment_count')
    expect(executedQuery).toContain('attachment_names')
    expect(executedQuery).toContain('attachment_search_text')
  })

  test('init creates attachments table', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.init()
    expect(executedQuery).toContain('CREATE TABLE IF NOT EXISTS attachments')
    expect(executedQuery).toContain('idx_attachments_email_id')
  })

  test('getAttachment returns text attachment content', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['filename', 'content_type', 'text_content', 'text_extraction_status'],
        rows: [['report.pdf', 'application/pdf', 'extracted pdf text', 'done']],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getAttachment!('att-1')
    expect(result).not.toBeNull()
    expect(result!.filename).toBe('report.pdf')
    expect(result!.contentType).toBe('application/pdf')
    const text = new TextDecoder().decode(result!.data)
    expect(text).toBe('extracted pdf text')
  })

  test('getAttachment returns null for binary attachment', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['filename', 'content_type', 'text_content', 'text_extraction_status'],
        rows: [['image.png', 'image/png', '', 'unsupported']],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getAttachment!('att-2')
    expect(result).toBeNull()
  })

  test('getAttachment returns null for unknown id', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['filename', 'content_type', 'text_content', 'text_extraction_status'],
        rows: [],
        row_count: 0,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getAttachment!('nonexistent')
    expect(result).toBeNull()
  })

  test('getAttachment sends correct SQL', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({
        columns: ['filename', 'content_type', 'text_content', 'text_extraction_status'],
        rows: [],
        row_count: 0,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.getAttachment!('att-xyz')
    expect(executedQuery).toContain('SELECT filename, content_type, text_content, text_extraction_status FROM attachments')
    expect(executedQuery).toContain("WHERE id = 'att-xyz'")
  })

  test('SEARCH_VECTOR includes attachment_search_text', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.searchEmails('a@b.com', { query: 'test' })
    expect(executedQuery).toContain("coalesce(attachment_search_text, '')")
  })
})
