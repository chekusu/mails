import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createSqliteProvider } from '../../src/providers/storage/sqlite'
import type { Attachment, Email } from '../../src/core/types'

const TEST_DB = join(import.meta.dir, '..', '.test-mails.db')

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: crypto.randomUUID(),
    mailbox: 'agent@test.com',
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: 'agent@test.com',
    subject: 'Test email',
    body_text: 'Hello world',
    body_html: '<p>Hello world</p>',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('SQLite provider', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB)
    if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal')
    if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm')
  })

  afterEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB)
    if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal')
    if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm')
  })

  test('init creates database and table', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    expect(existsSync(TEST_DB)).toBe(true)
  })

  test('saveEmail and getEmail', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const email = makeEmail({ id: 'test-1', subject: 'Saved email' })
    await provider.saveEmail(email)

    const retrieved = await provider.getEmail('test-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe('test-1')
    expect(retrieved!.subject).toBe('Saved email')
    expect(retrieved!.from_address).toBe('sender@example.com')
    expect(retrieved!.direction).toBe('inbound')
  })

  test('getEmail returns null for nonexistent', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    expect(await provider.getEmail('nonexistent')).toBeNull()
  })

  test('getEmail resolves a unique id prefix', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: 'abcd1234-full-id', subject: 'Prefix hit' }))

    const retrieved = await provider.getEmail('abcd1234')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe('abcd1234-full-id')
  })

  test('getEmail throws on ambiguous id prefix', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: 'prefix-1111', subject: 'First' }))
    await provider.saveEmail(makeEmail({ id: 'prefix-2222', subject: 'Second' }))

    expect(provider.getEmail('prefix-')).rejects.toThrow('Ambiguous email id: prefix-')
  })

  test('getEmails returns emails sorted by received_at DESC', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const e1 = makeEmail({ id: '1', subject: 'First', received_at: '2025-01-01T00:00:00Z' })
    const e2 = makeEmail({ id: '2', subject: 'Second', received_at: '2025-01-02T00:00:00Z' })
    const e3 = makeEmail({ id: '3', subject: 'Third', received_at: '2025-01-03T00:00:00Z' })

    await provider.saveEmail(e1)
    await provider.saveEmail(e2)
    await provider.saveEmail(e3)

    const emails = await provider.getEmails('agent@test.com')
    expect(emails).toHaveLength(3)
    expect(emails[0]!.subject).toBe('Third')
    expect(emails[2]!.subject).toBe('First')
  })

  test('getEmails respects limit and offset', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    for (let i = 0; i < 5; i++) {
      await provider.saveEmail(makeEmail({
        id: `email-${i}`,
        received_at: `2025-01-0${i + 1}T00:00:00Z`,
      }))
    }

    const page1 = await provider.getEmails('agent@test.com', { limit: 2 })
    expect(page1).toHaveLength(2)

    const page2 = await provider.getEmails('agent@test.com', { limit: 2, offset: 2 })
    expect(page2).toHaveLength(2)
    expect(page2[0]!.id).not.toBe(page1[0]!.id)
  })

  test('getEmails filters by direction', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: '1', direction: 'inbound' }))
    await provider.saveEmail(makeEmail({ id: '2', direction: 'outbound', status: 'sent' }))

    const inbound = await provider.getEmails('agent@test.com', { direction: 'inbound' })
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.direction).toBe('inbound')

    const outbound = await provider.getEmails('agent@test.com', { direction: 'outbound' })
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.direction).toBe('outbound')
  })

  test('getEmails filters by mailbox', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: '1', mailbox: 'a@test.com' }))
    await provider.saveEmail(makeEmail({ id: '2', mailbox: 'b@test.com' }))

    const emails = await provider.getEmails('a@test.com')
    expect(emails).toHaveLength(1)
    expect(emails[0]!.mailbox).toBe('a@test.com')
  })

  test('searchEmails matches subject body from and code case-insensitively', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'a',
      subject: 'Reset Password',
      from_name: 'Security Team',
      from_address: 'noreply@service.com',
      body_text: 'Use code 654321 to continue.',
      code: '654321',
    }))
    await provider.saveEmail(makeEmail({
      id: 'b',
      subject: 'Weekly digest',
      from_address: 'digest@example.com',
      body_text: 'Summary for the week',
    }))

    expect((await provider.searchEmails('agent@test.com', { query: 'security' }))[0]!.id).toBe('a')
    expect((await provider.searchEmails('agent@test.com', { query: '654321' }))[0]!.id).toBe('a')
    expect((await provider.searchEmails('agent@test.com', { query: 'DIGEST@EXAMPLE.COM' }))[0]!.id).toBe('b')
  })

  test('searchEmails respects mailbox direction sort and limit', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'same-inbound',
      mailbox: 'agent@test.com',
      direction: 'inbound',
      subject: 'Invoice available',
      received_at: '2025-01-01T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'same-outbound',
      mailbox: 'agent@test.com',
      direction: 'outbound',
      status: 'sent',
      subject: 'Invoice follow-up',
      received_at: '2025-01-03T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'other-mailbox',
      mailbox: 'other@test.com',
      subject: 'Invoice from another mailbox',
      received_at: '2025-01-04T00:00:00Z',
    }))

    const scoped = await provider.searchEmails('agent@test.com', {
      query: 'invoice',
      direction: 'inbound',
      limit: 5,
    })
    expect(scoped.map(email => email.id)).toEqual(['same-inbound'])

    const ordered = await provider.searchEmails('agent@test.com', { query: 'invoice', limit: 1 })
    expect(ordered).toHaveLength(1)
    expect(ordered[0]!.id).toBe('same-outbound')
  })

  test('getCode returns code when available', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'code-1',
      code: '123456',
      from_address: 'noreply@service.com',
      subject: 'Your code',
    }))

    const result = await provider.getCode('agent@test.com', { timeout: 1 })
    expect(result).not.toBeNull()
    expect(result!.code).toBe('123456')
    expect(result!.from).toBe('noreply@service.com')
    expect(result!.subject).toBe('Your code')
  })

  test('getCode returns null on timeout', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const result = await provider.getCode('agent@test.com', { timeout: 1 })
    expect(result).toBeNull()
  })

  test('getCode filters by since', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'old',
      code: '111111',
      received_at: '2024-01-01T00:00:00Z',
    }))

    const result = await provider.getCode('agent@test.com', {
      timeout: 1,
      since: '2025-01-01T00:00:00Z',
    })
    expect(result).toBeNull()
  })

  test('saveEmail with JSON headers and metadata', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'json-1',
      headers: { 'X-Custom': 'value' },
      metadata: { source: 'test', count: 42 },
    }))

    const email = await provider.getEmail('json-1')
    expect(email!.headers).toEqual({ 'X-Custom': 'value' })
    expect(email!.metadata).toEqual({ source: 'test', count: 42 })
  })

  test('saveEmail persists attachment metadata columns', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'att-meta-1',
      message_id: '<msg-123@example.com>',
      has_attachments: true,
      attachment_count: 2,
      attachment_names: 'report.pdf, data.csv',
      attachment_search_text: 'report data quarterly',
    }))

    const email = await provider.getEmail('att-meta-1')
    expect(email).not.toBeNull()
    expect(email!.message_id).toBe('<msg-123@example.com>')
    expect(email!.has_attachments).toBe(true)
    expect(email!.attachment_count).toBe(2)
    expect(email!.attachment_names).toBe('report.pdf, data.csv')
    expect(email!.attachment_search_text).toBe('report data quarterly')
  })

  test('saveEmail persists attachments to attachments table', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const attachments: Attachment[] = [
      {
        id: 'att-1',
        email_id: 'att-email-1',
        filename: 'report.pdf',
        content_type: 'application/pdf',
        size_bytes: 12345,
        content_disposition: 'attachment',
        content_id: null,
        mime_part_index: 0,
        text_content: 'Extracted text from PDF',
        text_extraction_status: 'done',
        storage_key: 'r2://bucket/att-1',
        created_at: new Date().toISOString(),
      },
      {
        id: 'att-2',
        email_id: 'att-email-1',
        filename: 'image.png',
        content_type: 'image/png',
        size_bytes: 67890,
        content_disposition: 'inline',
        content_id: '<img-001>',
        mime_part_index: 1,
        text_content: '',
        text_extraction_status: 'unsupported',
        storage_key: null,
        created_at: new Date().toISOString(),
      },
    ]

    await provider.saveEmail(makeEmail({
      id: 'att-email-1',
      has_attachments: true,
      attachment_count: 2,
      attachment_names: 'report.pdf, image.png',
      attachments,
    }))

    const email = await provider.getEmail('att-email-1')
    expect(email).not.toBeNull()
    expect(email!.attachments).toHaveLength(2)

    const first = email!.attachments![0]!
    expect(first.id).toBe('att-1')
    expect(first.filename).toBe('report.pdf')
    expect(first.content_type).toBe('application/pdf')
    expect(first.size_bytes).toBe(12345)
    expect(first.content_disposition).toBe('attachment')
    expect(first.content_id).toBeNull()
    expect(first.mime_part_index).toBe(0)
    expect(first.text_content).toBe('Extracted text from PDF')
    expect(first.text_extraction_status).toBe('done')
    expect(first.storage_key).toBe('r2://bucket/att-1')

    const second = email!.attachments![1]!
    expect(second.id).toBe('att-2')
    expect(second.filename).toBe('image.png')
    expect(second.content_id).toBe('<img-001>')
    expect(second.mime_part_index).toBe(1)
    expect(second.text_extraction_status).toBe('unsupported')
    expect(second.storage_key).toBeNull()
  })

  test('saveEmail without attachments works normally', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: 'no-att-1' }))

    const email = await provider.getEmail('no-att-1')
    expect(email).not.toBeNull()
    expect(email!.has_attachments).toBe(false)
    expect(email!.attachment_count).toBe(0)
    expect(email!.attachments).toEqual([])
  })

  test('getAttachment returns text attachment content', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const attachments: Attachment[] = [
      {
        id: 'dl-att-1',
        email_id: 'dl-email-1',
        filename: 'data.csv',
        content_type: 'text/csv',
        size_bytes: 23,
        content_disposition: 'attachment',
        content_id: null,
        mime_part_index: 0,
        text_content: 'col1,col2\nval1,val2',
        text_extraction_status: 'done',
        storage_key: null,
        created_at: new Date().toISOString(),
      },
    ]

    await provider.saveEmail(makeEmail({
      id: 'dl-email-1',
      has_attachments: true,
      attachment_count: 1,
      attachment_names: 'data.csv',
      attachments,
    }))

    const result = await provider.getAttachment!('dl-att-1')
    expect(result).not.toBeNull()
    expect(result!.filename).toBe('data.csv')
    expect(result!.contentType).toBe('text/csv')
    const text = new TextDecoder().decode(result!.data)
    expect(text).toBe('col1,col2\nval1,val2')
  })

  test('getAttachment returns null for binary attachment', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const attachments: Attachment[] = [
      {
        id: 'bin-att-1',
        email_id: 'bin-email-1',
        filename: 'photo.png',
        content_type: 'image/png',
        size_bytes: 50000,
        content_disposition: 'attachment',
        content_id: null,
        mime_part_index: 0,
        text_content: '',
        text_extraction_status: 'unsupported',
        storage_key: null,
        created_at: new Date().toISOString(),
      },
    ]

    await provider.saveEmail(makeEmail({
      id: 'bin-email-1',
      has_attachments: true,
      attachment_count: 1,
      attachment_names: 'photo.png',
      attachments,
    }))

    const result = await provider.getAttachment!('bin-att-1')
    expect(result).toBeNull()
  })

  test('getAttachment returns null for unknown id', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const result = await provider.getAttachment!('nonexistent')
    expect(result).toBeNull()
  })

  test('getEmails returns has_attachments and attachment_count', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'list-1',
      has_attachments: true,
      attachment_count: 3,
      received_at: '2025-01-02T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'list-2',
      has_attachments: false,
      attachment_count: 0,
      received_at: '2025-01-01T00:00:00Z',
    }))

    const emails = await provider.getEmails('agent@test.com')
    expect(emails).toHaveLength(2)

    const withAtt = emails.find(e => e.id === 'list-1')!
    expect(withAtt.has_attachments).toBe(true)
    expect(withAtt.attachment_count).toBe(3)

    const withoutAtt = emails.find(e => e.id === 'list-2')!
    expect(withoutAtt.has_attachments).toBe(false)
    expect(withoutAtt.attachment_count).toBe(0)
  })

  test('searchEmails escapes % wildcard in query', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'percent-match',
      subject: 'discount 100% off',
      received_at: '2025-01-02T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'percent-no-match',
      subject: 'something else',
      received_at: '2025-01-01T00:00:00Z',
    }))

    const results = await provider.searchEmails('agent@test.com', { query: '100%' })
    expect(results).toHaveLength(1)
    expect(results[0]!.subject).toContain('100%')
  })

  test('searchEmails escapes _ wildcard in query', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'underscore-match',
      subject: 'user_admin',
      received_at: '2025-01-02T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'underscore-no-match',
      subject: 'user3admin',
      received_at: '2025-01-01T00:00:00Z',
    }))

    const results = await provider.searchEmails('agent@test.com', { query: 'user_admin' })
    expect(results).toHaveLength(1)
    expect(results[0]!.subject).toBe('user_admin')
  })
})
