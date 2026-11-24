import { describe, expect, test, mock, afterEach, beforeEach } from 'bun:test'
import { setConfigValue, saveConfig, loadConfig } from '../../src/core/config'
import { _resetStorage } from '../../src/core/storage'
import type { Email, StorageProvider } from '../../src/core/types'

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: `email-${Math.random().toString(36).slice(2, 8)}`,
    mailbox: 'agent@test.com',
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: 'agent@test.com',
    subject: 'Test email',
    body_text: 'Hello',
    body_html: '',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    received_at: '2025-06-01T00:00:00Z',
    created_at: '2025-06-01T00:00:00Z',
    ...overrides,
  }
}

function createMockStorage(saved: Email[]): StorageProvider {
  return {
    name: 'sqlite',
    async init() {},
    async saveEmail(email: Email) { saved.push(email) },
    async getEmails() { return [] },
    async searchEmails() { return [] },
    async getEmail() { return null },
    async getCode() { return null },
  }
}

describe('CLI: sync command', () => {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  const originalStdoutWrite = process.stdout.write
  let importCounter = 0

  beforeEach(() => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'mails.dev',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      worker_url: 'http://localhost:8787',
      worker_token: 'wt_secret',
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
    process.stdout.write = originalStdoutWrite
    _resetStorage()
    mock.restore()
  })

  async function importSyncCommand() {
    importCounter += 1
    return await import(`../../src/cli/commands/sync.ts?test=${importCounter}`)
  }

  test('sync pulls emails from Worker and saves to storage', async () => {
    const emails = [makeEmail({ id: 'e1' }), makeEmail({ id: 'e2' })]
    const saved: Email[] = []

    _resetStorage(createMockStorage(saved))

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        emails,
        total: 2,
        has_more: false,
      }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand([])

    expect(saved).toHaveLength(2)
    expect(saved[0]!.id).toBe('e1')
    expect(saved[1]!.id).toBe('e2')
    expect(output.join('\n')).toContain('Synced 2 email(s)')
  })

  test('sync uses --since flag for incremental sync', async () => {
    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    let fetchedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrl = typeof url === 'string' ? url : url.toString()
      return new Response(JSON.stringify({
        emails: [],
        total: 0,
        has_more: false,
      }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand(['--since', '2025-06-01T00:00:00Z'])

    expect(fetchedUrl).toContain('since=2025-06-01T00%3A00%3A00Z')
  })

  test('sync uses last_sync from config when no --since', async () => {
    setConfigValue('last_sync', '2025-05-15T12:00:00Z')

    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    let fetchedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrl = typeof url === 'string' ? url : url.toString()
      return new Response(JSON.stringify({
        emails: [],
        total: 0,
        has_more: false,
      }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand([])

    expect(fetchedUrl).toContain('since=2025-05-15T12%3A00%3A00Z')
  })

  test('sync --from-scratch ignores last_sync', async () => {
    setConfigValue('last_sync', '2025-05-15T12:00:00Z')

    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    let fetchedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrl = typeof url === 'string' ? url : url.toString()
      return new Response(JSON.stringify({
        emails: [],
        total: 0,
        has_more: false,
      }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand(['--from-scratch'])

    expect(fetchedUrl).toContain('since=1970-01-01T00%3A00%3A00Z')
  })

  test('sync updates last_sync in config after completion', async () => {
    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        emails: [makeEmail({ id: 'e1' })],
        total: 1,
        has_more: false,
      }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand([])

    const config = loadConfig()
    expect(config.last_sync).toBe('2025-05-31T23:59:59.999Z')
    const later = makeEmail({ id: 'e2' })
    globalThis.fetch = mock(async (url: string) => {
      const cursor = new URL(url).searchParams.get('since')!
      return Response.json({ emails: [later].filter(email => email.received_at > cursor), has_more: false })
    }) as typeof fetch
    await syncCommand([])
    expect(saved.map(email => email.id)).toEqual(['e1', 'e2'])
  })

  test('sync errors when no worker_url or api_key', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'mails.dev',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    })

    const errors: string[] = []
    console.log = () => {}
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await expect(syncCommand([])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('No worker_url or api_key configured')
  })

  test('sync errors when no mailbox configured', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      worker_url: 'http://localhost:8787',
    })

    const errors: string[] = []
    console.log = () => {}
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await expect(syncCommand([])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('No mailbox configured')
  })

  test('sync errors when self-hosted worker_token is missing', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'mails.dev',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      worker_url: 'http://localhost:8787',
    })

    const errors: string[] = []
    console.log = () => {}
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await expect(syncCommand([])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('No worker_token configured')
  })

  test('sync sends api_key as Bearer token for hosted mode', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@mails.dev',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      api_key: 'mk_test_key',
    })

    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    let capturedHeaders: Record<string, string> = {}
    let capturedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString()
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ emails: [], total: 0, has_more: false }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand([])

    expect(capturedHeaders['Authorization']).toBe('Bearer mk_test_key')
    expect(capturedUrl).toContain('/v1/sync')
    expect(capturedUrl).not.toContain('to=')
  })

  test('sync sends worker_token as Bearer for self-hosted mode', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'mails.dev',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      worker_url: 'http://localhost:8787',
      worker_token: 'wt_secret',
    })

    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    let capturedHeaders: Record<string, string> = {}
    let capturedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString()
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ emails: [], total: 0, has_more: false }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand([])

    expect(capturedHeaders['Authorization']).toBe('Bearer wt_secret')
    expect(capturedUrl).toContain('/api/sync')
    expect(capturedUrl).toContain('to=agent%40test.com')
  })

  test('sync errors on API failure', async () => {
    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }) as typeof fetch

    const errors: string[] = []
    console.log = () => {}
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await expect(syncCommand([])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('Sync error')
  })

  test('sync errors when storage is remote', async () => {
    const remoteStorage: StorageProvider = {
      name: 'remote',
      async init() {},
      async saveEmail() {},
      async getEmails() { return [] },
      async searchEmails() { return [] },
      async getEmail() { return null },
      async getCode() { return null },
    }
    _resetStorage(remoteStorage)

    const errors: string[] = []
    console.log = () => {}
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await expect(syncCommand([])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('Cannot sync to remote storage')
  })

  test('sync handles pagination (has_more)', async () => {
    const page1 = [makeEmail({ id: 'p1' }), makeEmail({ id: 'p2' })]
    const page2 = [makeEmail({ id: 'p3' })]
    const saved: Email[] = []
    _resetStorage(createMockStorage(saved))

    let callCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      callCount++
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('offset=0')) {
        return new Response(JSON.stringify({
          emails: page1,
          total: 3,
          has_more: true,
        }))
      }
      return new Response(JSON.stringify({
        emails: page2,
        total: 3,
        has_more: false,
      }))
    }) as typeof fetch

    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write

    const { syncCommand } = await importSyncCommand()
    await syncCommand([])

    expect(callCount).toBe(2)
    expect(saved).toHaveLength(3)
    expect(saved.map(e => e.id)).toEqual(['p1', 'p2', 'p3'])
    expect(output.join('\n')).toContain('Synced 3 email(s)')
  })
})
