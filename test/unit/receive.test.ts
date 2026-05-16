import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { saveConfig } from '../../src/core/config'
import type { MailsConfig, Email, StorageProvider } from '../../src/core/types'
import { _resetStorage } from '../../src/core/storage'
import { getInbox, searchInbox, waitForCode, getEmail, downloadAttachment } from '../../src/core/receive'
import { createSqliteProvider } from '../../src/providers/storage/sqlite'

const TEST_DB = join(import.meta.dir, '..', '.test-receive.db')

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: crypto.randomUUID(),
    mailbox: 'agent@test.com',
    from_address: 'sender@test.com',
    from_name: 'Sender',
    to_address: 'agent@test.com',
    subject: 'Test',
    body_text: 'Hello',
    body_html: '',
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

describe('receive module (via sqlite)', () => {
  beforeEach(async () => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      if (existsSync(f)) rmSync(f)
    }
    // Reset config to use sqlite (clear any api_key/worker_url that would trigger remote)
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    } as MailsConfig)
    _resetStorage()
  })

  afterEach(() => {
    _resetStorage()
  })

  test('getInbox returns emails from sqlite', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    await provider.saveEmail(makeEmail({ id: 'recv-1', subject: 'Inbox test' }))
    _resetStorage(provider)

    const emails = await getInbox('agent@test.com', { limit: 10 })
    expect(emails).toHaveLength(1)
    expect(emails[0]!.subject).toBe('Inbox test')
  })

  test('searchInbox returns matching emails', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    await provider.saveEmail(makeEmail({ id: 's1', subject: 'Password reset' }))
    await provider.saveEmail(makeEmail({ id: 's2', subject: 'Weekly digest' }))
    _resetStorage(provider)

    const results = await searchInbox('agent@test.com', { query: 'password' })
    expect(results).toHaveLength(1)
    expect(results[0]!.subject).toBe('Password reset')
  })

  test('waitForCode returns code', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    await provider.saveEmail(makeEmail({ id: 'c1', code: '998877' }))
    _resetStorage(provider)

    const result = await waitForCode('agent@test.com', { timeout: 1 })
    expect(result).not.toBeNull()
    expect(result!.code).toBe('998877')
  })

  test('getEmail returns single email', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    await provider.saveEmail(makeEmail({ id: 'detail-1', subject: 'Detail test' }))
    _resetStorage(provider)

    const email = await getEmail('detail-1')
    expect(email).not.toBeNull()
    expect(email!.subject).toBe('Detail test')
  })

  test('downloadAttachment throws when provider does not support attachments', async () => {
    _resetStorage({
      name: 'memory',
      init: async () => {},
      saveEmail: async () => {},
      getEmails: async () => [],
      searchEmails: async () => [],
      getEmail: async () => null,
      getCode: async () => null,
    } as StorageProvider)

    expect(downloadAttachment('att-1')).rejects.toThrow('does not support attachment downloads')
  })
})
