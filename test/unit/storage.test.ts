import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { saveConfig, setConfigValue } from '../../src/core/config'
import type { MailsConfig, StorageProvider } from '../../src/core/types'
import { getStorage, _resetStorage } from '../../src/core/storage'

describe('storage resolver', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // Reset config
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    } as MailsConfig)
    _resetStorage()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    _resetStorage()
  })

  test('resolves sqlite by default', async () => {
    const provider = await getStorage()
    expect(provider.name).toBe('sqlite')
  })

  test('resolves db9 when configured', async () => {
    setConfigValue('storage_provider', 'db9')
    setConfigValue('db9_token', 'test-token')
    setConfigValue('db9_database_id', 'test-db-id')

    // Mock db9 API for init
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = await getStorage()
    expect(provider.name).toBe('db9')
  })

  test('throws when db9 token missing', async () => {
    setConfigValue('storage_provider', 'db9')

    expect(getStorage()).rejects.toThrow('db9_token not configured')
  })

  test('throws when db9 database_id missing', async () => {
    setConfigValue('storage_provider', 'db9')
    setConfigValue('db9_token', 'some-token')

    expect(getStorage()).rejects.toThrow('db9_database_id not configured')
  })

  test('resolves explicit remote storage with hosted api key', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@mails.dev',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)

    const provider = await getStorage()
    expect(provider.name).toBe('remote')
  })

  test('auto-detects remote storage from worker_url', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'example.com',
      mailbox: 'agent@example.com',
      send_provider: 'resend',
      storage_provider: '',
      worker_url: 'https://worker.example.com',
      worker_token: 'worker-token',
    } as unknown as MailsConfig)

    const provider = await getStorage()
    expect(provider.name).toBe('remote')
  })

  test('auto-resolves mailbox for hosted remote storage', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)
    globalThis.fetch = mock(async () => {
      return Response.json({ mailbox: 'agent@mails.dev' })
    }) as typeof fetch

    const provider = await getStorage()
    expect(provider.name).toBe('remote')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  test('throws when remote mailbox cannot be resolved', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)
    globalThis.fetch = mock(async () => {
      return Response.json({}, { status: 200 })
    }) as typeof fetch

    expect(getStorage()).rejects.toThrow('mailbox not configured')
  })

  test('throws when self-hosted remote is missing worker token', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'example.com',
      mailbox: 'agent@example.com',
      send_provider: 'resend',
      storage_provider: 'remote',
      worker_url: 'https://worker.example.com',
    } as unknown as MailsConfig)

    expect(getStorage()).rejects.toThrow('worker_token not configured')
  })

  test('caches provider on second call', async () => {
    const p1 = await getStorage()
    const p2 = await getStorage()
    expect(p1).toBe(p2) // same instance
  })

  test('returns injected provider from reset helper', async () => {
    const injected = {
      name: 'injected',
      init: mock(async () => {}),
      saveEmail: mock(async () => {}),
      getEmails: mock(async () => []),
      searchEmails: mock(async () => []),
      getEmail: mock(async () => null),
      getCode: mock(async () => null),
    } as unknown as StorageProvider

    _resetStorage(injected)
    expect(await getStorage()).toBe(injected)
    expect(injected.init).not.toHaveBeenCalled()
  })
})
