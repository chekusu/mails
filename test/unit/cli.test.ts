import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { setConfigValue, loadConfig, saveConfig, CONFIG_DIR, CONFIG_FILE } from '../../src/core/config'
import type { Email, StorageProvider } from '../../src/core/types'
import { _resetStorage } from '../../src/core/storage'

describe('CLI: send command', () => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const originalExit = process.exit
  const attachmentPath = join(import.meta.dir, '..', '.cli-attachment.txt')

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.error = originalError
    process.exit = originalExit
    if (existsSync(attachmentPath)) rmSync(attachmentPath)
  })

  test('send command parses args correctly', async () => {
    // Setup config
    setConfigValue('resend_api_key', 're_test')
    setConfigValue('default_from', 'Bot <bot@test.com>')

    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'msg_cli' }))
    }) as typeof fetch

    // Import and call directly
    const { send } = await import('../../src/core/send')
    const result = await send({
      to: 'user@example.com',
      subject: 'CLI Test',
      text: 'Hello from CLI',
      attachments: [
        {
          filename: 'notes.txt',
          content: new TextEncoder().encode('hello attachment'),
          contentType: 'text/plain',
        },
      ],
    })

    expect(sentBody.to).toEqual(['user@example.com'])
    expect(sentBody.subject).toBe('CLI Test')
    expect(sentBody.text).toBe('Hello from CLI')
    expect(sentBody.attachments).toEqual([
      {
        filename: 'notes.txt',
        content: Buffer.from('hello attachment').toString('base64'),
        content_type: 'text/plain',
      },
    ])
    expect(result.id).toBe('msg_cli')
  })

  test('send command supports repeated --attach flags', async () => {
    setConfigValue('resend_api_key', 're_test')
    setConfigValue('default_from', 'Bot <bot@test.com>')
    writeFileSync(attachmentPath, 'attachment from path')

    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'msg_cli_attach' }))
    }) as typeof fetch

    const { sendCommand } = await import('../../src/cli/commands/send')
    const originalLog = console.log
    console.log = () => {}

    try {
      await sendCommand([
        '--to', 'user@example.com',
        '--subject', 'CLI Attach',
        '--body', 'See attached',
        '--attach', attachmentPath,
      ])
    } finally {
      console.log = originalLog
    }

    expect(sentBody.attachments).toEqual([
      {
        filename: '.cli-attachment.txt',
        content: Buffer.from('attachment from path').toString('base64'),
        content_type: 'text/plain',
      },
    ])
  })

  test('send command validates required arguments', async () => {
    const errors: string[] = []
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit
    const { sendCommand } = await import('../../src/cli/commands/send')

    await expect(sendCommand([])).rejects.toThrow('exit:1')
    await expect(sendCommand(['--to', 'user@example.com'])).rejects.toThrow('exit:1')
    await expect(sendCommand(['--to', 'user@example.com', '--subject', 'Hi'])).rejects.toThrow('exit:1')

    expect(errors.join('\n')).toContain('Usage: mails send')
    expect(errors.join('\n')).toContain('Missing --subject')
    expect(errors.join('\n')).toContain('Missing --body or --html')
  })
})

describe('CLI: config command', () => {
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    })
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
    globalThis.fetch = originalFetch
  })

  test('config set and get work', () => {
    setConfigValue('domain', 'cli-test.com')
    const { getConfigValue } = require('../../src/core/config')
    expect(getConfigValue('domain')).toBe('cli-test.com')
  })

  test('config loads defaults for missing file', () => {
    const config = loadConfig()
    expect(config.mode).toBe('hosted')
    expect(config.send_provider).toBe('resend')
  })

  test('config command masks secrets in set output and default display', async () => {
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }

    try {
      const { configCommand } = await import('../../src/cli/commands/config')
      await configCommand(['set', 'worker_token', 'wt_secret_value_12345678'])
      await configCommand([])
    } finally {
      console.log = originalLog
    }

    const text = output.join('\n')
    expect(text).toContain('Set worker_token = wt_s...5678')
    expect(text).not.toContain('wt_secret_value_12345678')
  })

  test('saveConfig writes restricted permissions on POSIX', () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@mails.dev',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      api_key: 'mk_secret_value_12345678',
    })

    if (process.platform !== 'win32') {
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700)
      expect(statSync(CONFIG_FILE).mode & 0o777).toBe(0o600)
    }
  })

  test('config command validates set arguments', async () => {
    const errors: string[] = []
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { configCommand } = await import('../../src/cli/commands/config')
    await expect(configCommand(['set', 'domain'])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('Usage: mails config set')
  })

  test('config command gets values and exits for missing keys', async () => {
    const output: string[] = []
    const errors: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { configCommand } = await import('../../src/cli/commands/config')
    await configCommand(['set', 'domain', 'cli.example'])
    await configCommand(['get', 'domain'])
    expect(output).toContain('cli.example')

    await expect(configCommand(['get', 'missing_key'])).rejects.toThrow('exit:1')
    expect(errors.join('\n')).toContain('Key "missing_key" not set')
  })

  test('config command validates get arguments and prints config path', async () => {
    const output: string[] = []
    const errors: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { errors.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { configCommand } = await import('../../src/cli/commands/config')
    await expect(configCommand(['get'])).rejects.toThrow('exit:1')
    await configCommand(['path'])

    expect(errors.join('\n')).toContain('Usage: mails config get')
    expect(output).toContain(CONFIG_FILE)
  })

  test('config command resolves hosted api key metadata', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    globalThis.fetch = mock(async () => Response.json({ mailbox: 'agent@mails.dev' })) as typeof fetch

    const { configCommand } = await import('../../src/cli/commands/config')
    await configCommand(['set', 'api_key', 'mk_hosted_secret_1234'])

    const config = loadConfig()
    expect(config.mailbox).toBe('agent@mails.dev')
    expect(config.default_from).toBe('agent@mails.dev')
    expect(config.storage_provider).toBe('remote')
    expect(output.join('\n')).toContain('Resolved mailbox: agent@mails.dev')
  })

  test('config command switches storage when worker_url is set', async () => {
    console.log = () => {}
    const { configCommand } = await import('../../src/cli/commands/config')
    await configCommand(['set', 'worker_url', 'https://worker.example.com'])

    expect(loadConfig().storage_provider).toBe('remote')
  })
})

describe('CLI: version', () => {
  test('CLI_VERSION matches package.json', () => {
    const pkg = require('../../package.json')
    const { CLI_VERSION } = require('../../src/version')
    expect(CLI_VERSION).toBe(pkg.version)
  })
})

describe('CLI: help command', () => {
  test('helpCommand outputs text', () => {
    const { helpCommand } = require('../../src/cli/commands/help')
    // Just verify it doesn't throw
    const originalLog = console.log
    let output = ''
    console.log = (msg: string) => { output = msg }
    helpCommand()
    console.log = originalLog
    expect(output).toContain('mails')
    expect(output).toContain('send')
    expect(output).toContain('inbox')
    expect(output).toContain('code')
    expect(output).toContain('config')
    expect(output).toContain('--query')
    expect(output).toContain('mails.dev')
  })
})

describe('CLI: inbox command', () => {
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  let importCounter = 0

  beforeEach(() => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    })
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
    _resetStorage()
    mock.restore()
  })

  function makeEmail(overrides: Partial<Email> = {}): Email {
    return {
      id: 'email-1',
      mailbox: 'agent@test.com',
      from_address: 'sender@example.com',
      from_name: 'Sender',
      to_address: 'agent@test.com',
      subject: 'Reset password',
      body_text: 'Hello',
      body_html: '',
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

  async function importInboxCommand() {
    importCounter += 1
    return await import(`../../src/cli/commands/inbox.ts?test=${importCounter}`)
  }

  function useStorage(overrides: Partial<StorageProvider> = {}) {
    const provider = {
      name: 'test',
      init: mock(async () => {}),
      saveEmail: mock(async () => {}),
      getEmails: mock(async () => []),
      searchEmails: mock(async () => []),
      getEmail: mock(async () => null),
      getAttachment: mock(async () => null),
      getCode: mock(async () => null),
      ...overrides,
    } as StorageProvider
    _resetStorage(provider)
    return provider
  }

  test('search mode uses searchInbox and prints query-specific empty state', async () => {
    const getInboxSpy = mock(async () => [])
    const searchInboxSpy = mock(async () => [])
    const getEmailSpy = mock(async () => null)
    const output: string[] = []

    useStorage({
      getEmails: getInboxSpy,
      searchEmails: searchInboxSpy,
      getEmail: getEmailSpy,
    })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand(['--query', 'reset', '--direction', 'inbound'])

    expect(searchInboxSpy.mock.calls).toHaveLength(1)
    expect(searchInboxSpy.mock.calls[0]).toEqual([
      'agent@test.com',
      { query: 'reset', direction: 'inbound', limit: 20 },
    ])
    expect(getInboxSpy.mock.calls).toHaveLength(0)
    expect(output.join('\n')).toContain('No emails found for query: reset')
  })

  test('list mode uses getInbox and preserves existing list output shape', async () => {
    const email = makeEmail({ id: 'abcdef123456', subject: 'Invoice update', code: '123456' })
    const getInboxSpy = mock(async () => [email])
    const searchInboxSpy = mock(async () => [])
    const output: string[] = []

    useStorage({
      getEmails: getInboxSpy,
      searchEmails: searchInboxSpy,
    })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand(['--direction', 'inbound'])

    expect(getInboxSpy.mock.calls).toHaveLength(1)
    expect(getInboxSpy.mock.calls[0]).toEqual([
      'agent@test.com',
      { limit: 20, direction: 'inbound' },
    ])
    expect(searchInboxSpy.mock.calls).toHaveLength(0)
    expect(output.join('\n')).toContain('abcdef12')
    expect(output.join('\n')).toContain('Invoice update')
    expect(output.join('\n')).toContain('[123456]')
  })

  test('list mode shows attachment indicator when email has attachments', async () => {
    const email = makeEmail({
      id: 'att-email-1234',
      subject: 'Report attached',
      attachment_count: 2,
    })
    const getInboxSpy = mock(async () => [email])
    const output: string[] = []

    useStorage({ getEmails: getInboxSpy })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand([])

    const line = output.join('\n')
    expect(line).toContain('att-emai')
    expect(line).toContain('Report attached')
    expect(line).toContain('+2att')
  })

  test('list mode supports --full-id', async () => {
    const email = makeEmail({ id: 'full-id-12345', subject: 'Full id email' })
    const output: string[] = []

    useStorage({ getEmails: mock(async () => [email]) })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand(['--full-id'])

    const line = output.join('\n')
    expect(line).toContain('full-id-12345')
    expect(line).toContain('Full id email')
  })

  test('list mode omits attachment indicator when no attachments', async () => {
    const email = makeEmail({ id: 'no-att-12345', subject: 'Plain email' })
    const getInboxSpy = mock(async () => [email])
    const output: string[] = []

    useStorage({ getEmails: getInboxSpy })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand([])

    const line = output.join('\n')
    expect(line).toContain('no-att-1')
    expect(line).toContain('Plain email')
    expect(line).not.toContain('+')  // no "+Natt" indicator
  })

  test('detail view shows attachment list', async () => {
    const email = makeEmail({
      id: 'detail-att-123',
      subject: 'With files',
      attachments: [
        {
          id: 'a1',
          email_id: 'detail-att-123',
          filename: 'report.pdf',
          content_type: 'application/pdf',
          size_bytes: 12345,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 0,
          text_content: '',
          text_extraction_status: 'unsupported' as const,
          storage_key: null,
          created_at: '2026-03-20T00:00:00Z',
        },
        {
          id: 'a2',
          email_id: 'detail-att-123',
          filename: 'notes.txt',
          content_type: 'text/plain',
          size_bytes: 89,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 1,
          text_content: 'some notes',
          text_extraction_status: 'done' as const,
          storage_key: null,
          created_at: '2026-03-20T00:00:00Z',
        },
      ],
    })
    const output: string[] = []

    useStorage({ getEmail: mock(async () => email) })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand(['detail-att-123'])

    const text = output.join('\n')
    expect(text).toContain('Attachments:')
    expect(text).toContain('report.pdf')
    expect(text).toContain('application/pdf')
    expect(text).toContain('12345')
    expect(text).toContain('notes.txt')
    expect(text).toContain('text/plain')
  })

  test('detail view handles mails.dev attachment format (size field)', async () => {
    const email = makeEmail({
      id: 'compat-att-123',
      subject: 'Compat test',
      attachments: [
        {
          id: 'a1',
          email_id: 'compat-att-123',
          filename: 'doc.pdf',
          content_type: 'application/pdf',
          size_bytes: null,
          size: 5000,
          content_disposition: null,
          disposition: 'attachment',
          content_id: null,
          mime_part_index: 0,
          text_content: '',
          text_extraction_status: 'unsupported' as const,
          storage_key: null,
          created_at: '2026-03-20T00:00:00Z',
        },
      ],
    })
    const output: string[] = []

    useStorage({ getEmail: mock(async () => email) })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    const { inboxCommand } = await importInboxCommand()
    await inboxCommand(['compat-att-123'])

    const text = output.join('\n')
    expect(text).toContain('Attachments:')
    expect(text).toContain('doc.pdf')
    expect(text).toContain('5000 bytes')
  })

  test('detail save sanitizes attachment filenames', async () => {
    const email = makeEmail({
      id: 'save-att-123',
      attachments: [
        {
          id: 'save-a1',
          email_id: 'save-att-123',
          filename: '../../escape.txt',
          content_type: 'text/plain',
          size_bytes: 4,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 0,
          text_content: 'safe',
          text_extraction_status: 'done' as const,
          storage_key: null,
          created_at: '2026-03-20T00:00:00Z',
        },
      ],
    })
    const output: string[] = []
    const saveDir = join(import.meta.dir, '..', '.tmp-cli-save')

    if (existsSync(saveDir)) rmSync(saveDir, { recursive: true, force: true })

    useStorage({
      getEmail: mock(async () => email),
      getAttachment: mock(async () => ({
        filename: '../../escape.txt',
        contentType: 'text/plain',
        data: new TextEncoder().encode('safe').buffer,
      })),
    })

    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as typeof process.exit

    try {
      const { inboxCommand } = await importInboxCommand()
      await inboxCommand(['save-att-123', '--save', saveDir])
    } finally {
      // keep assertions below able to read saved output first
    }

    const savedPath = join(saveDir, 'escape.txt')
    expect(existsSync(savedPath)).toBe(true)
    expect(readFileSync(savedPath, 'utf-8')).toBe('safe')
    expect(output.join('\n')).toContain(savedPath)

    rmSync(saveDir, { recursive: true, force: true })
  })
})
