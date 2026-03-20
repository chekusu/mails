/**
 * Integration test: inbox CLI through real sqlite storage.
 *
 * Injects a test sqlite provider into the storage singleton, then calls
 * inboxCommand directly. This exercises the full code path:
 *   inboxCommand → receive.ts → storage.ts → sqlite provider
 * without mock.module, so bun's coverage tracker counts the lines.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { setConfigValue } from '../../src/core/config'
import { createSqliteProvider } from '../../src/providers/storage/sqlite'
import { _resetStorage } from '../../src/core/storage'
import { inboxCommand } from '../../src/cli/commands/inbox'

const TEST_DB = join(import.meta.dir, '..', '.inbox-integration.db')
const SAVE_DIR = join(import.meta.dir, '..', '.inbox-integration-downloads')
const MAILBOX = 'integration@test.com'

describe('Integration: inbox CLI with real sqlite', () => {
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  let provider: ReturnType<typeof createSqliteProvider>

  beforeAll(async () => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      if (existsSync(f)) rmSync(f)
    }
    if (existsSync(SAVE_DIR)) rmSync(SAVE_DIR, { recursive: true })

    provider = createSqliteProvider(TEST_DB)
    await provider.init()

    // Inject test provider into storage singleton
    _resetStorage(provider)
    setConfigValue('mailbox', MAILBOX)

    // Seed: plain email
    await provider.saveEmail({
      id: 'int-plain-1',
      mailbox: MAILBOX,
      from_address: 'alice@example.com',
      from_name: 'Alice',
      to_address: MAILBOX,
      subject: 'No attachments here',
      body_text: 'Just a plain email.',
      body_html: '',
      code: '998877',
      headers: {},
      metadata: {},
      direction: 'inbound',
      status: 'received',
      received_at: '2026-03-20T10:00:00Z',
      created_at: '2026-03-20T10:00:00Z',
    })

    // Seed: email with attachments
    await provider.saveEmail({
      id: 'int-att-1',
      mailbox: MAILBOX,
      from_address: 'bob@example.com',
      from_name: 'Bob',
      to_address: MAILBOX,
      subject: 'Report attached',
      body_text: 'See the attached files.',
      body_html: '',
      code: null,
      headers: {},
      metadata: {},
      direction: 'inbound',
      status: 'received',
      has_attachments: true,
      attachment_count: 2,
      attachment_names: 'data.csv report.pdf',
      attachment_search_text: 'col1,col2\nval1,val2',
      attachments: [
        {
          id: 'int-att-csv',
          email_id: 'int-att-1',
          filename: 'data.csv',
          content_type: 'text/csv',
          size_bytes: 20,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 0,
          text_content: 'col1,col2\nval1,val2',
          text_extraction_status: 'done',
          storage_key: null,
          created_at: '2026-03-20T10:01:00Z',
        },
        {
          id: 'int-att-pdf',
          email_id: 'int-att-1',
          filename: 'report.pdf',
          content_type: 'application/pdf',
          size_bytes: 50000,
          content_disposition: 'attachment',
          content_id: null,
          mime_part_index: 1,
          text_content: '',
          text_extraction_status: 'unsupported',
          storage_key: null,
          created_at: '2026-03-20T10:01:00Z',
        },
      ],
      received_at: '2026-03-20T10:01:00Z',
      created_at: '2026-03-20T10:01:00Z',
    })
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
  })

  afterAll(() => {
    _resetStorage()
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
      if (existsSync(f)) rmSync(f)
    }
    if (existsSync(SAVE_DIR)) rmSync(SAVE_DIR, { recursive: true })
  })

  test('list mode shows emails with +Natt indicator', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand([])

    const text = output.join('\n')
    // Email with attachments should show +2att
    expect(text).toContain('+2att')
    expect(text).toContain('Report attached')
    // Plain email should show code
    expect(text).toContain('[998877]')
    // Plain email should NOT have +att
    const plainLine = output.find(l => l.includes('int-plai'))
    expect(plainLine).toBeDefined()
    expect(plainLine).not.toContain('+')
  })

  test('list mode with --direction filter', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['--direction', 'inbound'])

    const text = output.join('\n')
    expect(text).toContain('int-plai')
    expect(text).toContain('int-att-')
  })

  test('list mode with --query search', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['--query', 'Report'])

    const text = output.join('\n')
    expect(text).toContain('int-att-')
    expect(text).not.toContain('int-plai')
  })

  test('list mode empty result', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['--query', 'nonexistent-xyz'])

    expect(output.join('\n')).toContain('No emails found for query: nonexistent-xyz')
  })

  test('detail mode shows attachment list with IDs', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['int-att-1'])

    const text = output.join('\n')
    expect(text).toContain('From: Bob <bob@example.com>')
    expect(text).toContain('Subject: Report attached')
    expect(text).toContain('Attachments:')
    expect(text).toContain('int-att-csv')
    expect(text).toContain('data.csv')
    expect(text).toContain('text/csv')
    expect(text).toContain('20 bytes')
    expect(text).toContain('int-att-pdf')
    expect(text).toContain('report.pdf')
    expect(text).toContain('50000 bytes')
    expect(text).toContain('See the attached files.')
  })

  test('detail mode for plain email (no attachments block)', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['int-plain-1'])

    const text = output.join('\n')
    expect(text).toContain('From: Alice <alice@example.com>')
    expect(text).toContain('Code: 998877')
    expect(text).not.toContain('Attachments:')
  })

  test('detail mode with --save downloads text attachments to disk', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['int-att-1', '--save', SAVE_DIR])

    const text = output.join('\n')
    // Text attachment should be saved
    expect(text).toContain('Saved:')
    expect(text).toContain('data.csv')

    const csvPath = join(SAVE_DIR, 'data.csv')
    expect(existsSync(csvPath)).toBe(true)
    const csv = await readFile(csvPath, 'utf-8')
    expect(csv).toBe('col1,col2\nval1,val2')

    // Binary attachment: getAttachment returns null, so "Attachment not found" is logged
    // (because sqlite can't serve binary content)
  })

  test('detail mode with --save (no dir value) saves to current dir', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
    process.exit = (() => {}) as typeof process.exit

    // --save with no value triggers parseArgs else branch (line 16-17: result[key] = '')
    // which defaults to '.' in inboxCommand
    await inboxCommand(['int-att-1', '--save'])

    const text = output.join('\n')
    expect(text).toContain('Attachments:')
    // It should try to save (text attachment succeeds, binary returns null)
    expect(text).toContain('Saved:')

    // Clean up any files saved to cwd
    const { rmSync: rm } = await import('fs')
    for (const f of ['data.csv']) {
      if (existsSync(f)) rm(f)
    }
  })

  test('--save logs error for attachment not found', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
    process.exit = (() => {}) as typeof process.exit

    // The binary attachment (int-att-pdf) returns null from getAttachment,
    // which triggers the "Attachment not found" error path (line 59-61)
    await inboxCommand(['int-att-1', '--save', SAVE_DIR])

    const text = output.join('\n')
    expect(text).toContain('Attachment not found: int-att-pdf')
  })

  test('list mode without mailbox shows error', async () => {
    // Temporarily clear the mailbox config
    setConfigValue('mailbox', '')

    const output: string[] = []
    let exitCode: number | undefined
    console.log = () => {}
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { exitCode = code; throw new Error('exit') }) as typeof process.exit

    try {
      await inboxCommand([])
    } catch {}

    // Restore
    setConfigValue('mailbox', MAILBOX)

    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('No mailbox specified')
  })

  test('detail mode for nonexistent email', async () => {
    const output: string[] = []
    let exitCode: number | undefined
    console.log = () => {}
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { exitCode = code; throw new Error('exit') }) as typeof process.exit

    try {
      await inboxCommand(['nonexistent-id'])
    } catch {}

    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('Email not found')
  })

  test('detail mode resolves a unique short id prefix', async () => {
    const output: string[] = []
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = () => {}
    process.exit = (() => {}) as typeof process.exit

    await inboxCommand(['int-att-'])

    const text = output.join('\n')
    expect(text).toContain('Subject: Report attached')
    expect(text).toContain('See the attached files.')
  })

  test('detail mode shows ambiguous id error', async () => {
    const output: string[] = []
    let exitCode: number | undefined
    console.log = () => {}
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
    process.exit = ((code?: number) => { exitCode = code; throw new Error('exit') }) as typeof process.exit

    try {
      await inboxCommand(['int-'])
    } catch {}

    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('Ambiguous email id: int-')
  })
})
