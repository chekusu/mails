import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createOSSSendProvider } from '../../src/providers/send/oss'

describe('OSS send provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends to /api/send with correct body', async () => {
    let requestUrl = ''
    let requestBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      requestUrl = url
      requestBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'oss_1' }))
    }) as typeof fetch

    const provider = createOSSSendProvider('https://my-worker.example.com', 'tok_secret')
    const result = await provider.send({
      from: 'bot@example.com',
      to: ['user@example.com'],
      subject: 'Test',
      text: 'Hello world',
    })

    expect(result.id).toBe('oss_1')
    expect(result.provider).toBe('oss') // worker didn't report provider — falls back to 'oss'
    expect(requestUrl).toBe('https://my-worker.example.com/api/send')
    expect(requestBody.from).toBe('bot@example.com')
    expect(requestBody.to).toEqual(['user@example.com'])
    expect(requestBody.subject).toBe('Test')
    expect(requestBody.text).toBe('Hello world')
  })

  test('includes Bearer token when provided', async () => {
    let authHeader = ''

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>)['Authorization']
      return new Response(JSON.stringify({ id: 'oss_auth' }))
    }) as typeof fetch

    const provider = createOSSSendProvider('https://worker.example.com', 'my_token_123')
    await provider.send({ from: 'a@b.com', to: ['c@d.com'], subject: 'Auth', text: 'test' })

    expect(authHeader).toBe('Bearer my_token_123')
  })

  test('handles attachments correctly', async () => {
    let requestBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'oss_attach' }))
    }) as typeof fetch

    const provider = createOSSSendProvider('https://worker.example.com', 'tok')
    await provider.send({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'File',
      text: 'see attached',
      attachments: [
        { filename: 'report.pdf', content: 'base64data', contentType: 'application/pdf' },
        { filename: 'notes.txt', content: 'plain text' },
      ],
    })

    const attachments = requestBody.attachments as Array<Record<string, unknown>>
    expect(attachments).toHaveLength(2)
    expect(attachments[0].filename).toBe('report.pdf')
    expect(attachments[0].content).toBe('base64data')
    expect(attachments[0].content_type).toBe('application/pdf')
    expect(attachments[1].filename).toBe('notes.txt')
    expect(attachments[1].content_type).toBeUndefined()
  })

  test('throws on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Invalid from address' }), { status: 400 })
    }) as typeof fetch

    const provider = createOSSSendProvider('https://worker.example.com', 'tok')
    expect(
      provider.send({ from: 'bad', to: ['c@d.com'], subject: 'Err', text: 'x' })
    ).rejects.toThrow('OSS send error (400): Invalid from address')
  })

  test('works without token (no auth header)', async () => {
    let headers: Record<string, string> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'oss_noauth' }))
    }) as typeof fetch

    const provider = createOSSSendProvider('https://worker.example.com')
    const result = await provider.send({ from: 'a@b.com', to: ['c@d.com'], subject: 'No Auth', text: 'hi' })

    expect(result.id).toBe('oss_noauth')
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  test('sends HTML email', async () => {
    let requestBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'oss_html' }))
    }) as typeof fetch

    const provider = createOSSSendProvider('https://worker.example.com', 'tok')
    await provider.send({ from: 'a@b.com', to: ['c@d.com'], subject: 'HTML', html: '<h1>Hi</h1>' })

    expect(requestBody.html).toBe('<h1>Hi</h1>')
    expect(requestBody.text).toBeUndefined()
  })

  test('sends with reply_to', async () => {
    let requestBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'oss_reply' }))
    }) as typeof fetch

    const provider = createOSSSendProvider('https://worker.example.com', 'tok')
    await provider.send({ from: 'a@b.com', to: ['c@d.com'], subject: 'R', text: 'x', replyTo: 'reply@test.com' })

    expect(requestBody.reply_to).toBe('reply@test.com')
  })

  test('propagates worker-reported provider (cloudflare/resend)', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ id: 'w_cf', provider: 'cloudflare' })),
    ) as typeof fetch
    const provider = createOSSSendProvider('https://worker.example.com', 'tok')
    const result = await provider.send({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'x' })
    expect(result.provider).toBe('cloudflare')
  })
})
