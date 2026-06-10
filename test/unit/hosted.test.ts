import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createHostedSendProvider } from '../../src/providers/send/hosted'

describe('Hosted send provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends email successfully', async () => {
    let requestUrl = ''
    let requestBody: Record<string, unknown> = {}
    let authHeader = ''

    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      requestUrl = url
      authHeader = (init.headers as Record<string, string>)['Authorization']
      requestBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({
        id: 'hosted_msg_1',
        from: 'agent@mails.dev',
        to: ['user@example.com'],
        sends_this_month: 5,
        monthly_limit: 100,
      }))
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_test_key', 'http://localhost:3160')
    const result = await provider.send({
      from: 'agent@mails.dev',
      to: ['user@example.com'],
      subject: 'Test',
      text: 'Hello',
    })

    expect(result.id).toBe('hosted_msg_1')
    expect(result.provider).toBe('mails.dev')
    expect(requestUrl).toBe('http://localhost:3160/v1/send')
    expect(authHeader).toBe('Bearer mk_test_key')
    expect(requestBody.to).toEqual(['user@example.com'])
    expect(requestBody.subject).toBe('Test')
    expect(requestBody.text).toBe('Hello')
  })

  test('sends HTML email', async () => {
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.html).toBe('<h1>Hi</h1>')
      expect(body.text).toBeUndefined()
      return new Response(JSON.stringify({ id: 'hosted_html', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    await provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'HTML', html: '<h1>Hi</h1>' })
  })

  test('sends with reply_to', async () => {
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.reply_to).toBe('reply@test.com')
      return new Response(JSON.stringify({ id: 'hosted_reply', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    await provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'R', text: 'x', replyTo: 'reply@test.com' })
  })

  test('sends with attachments', async () => {
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.attachments).toHaveLength(1)
      expect(body.attachments[0].filename).toBe('report.pdf')
      expect(body.attachments[0].content_type).toBe('application/pdf')
      return new Response(JSON.stringify({ id: 'hosted_attach', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    await provider.send({
      from: 'a@b.dev', to: ['c@d.com'], subject: 'File', text: 'see attached',
      attachments: [{ filename: 'report.pdf', content: 'base64data', contentType: 'application/pdf' }],
    })
  })

  test('throws on 402 quota exceeded', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        error: 'Monthly free limit reached (100/100)',
        price: '$0.002',
      }), { status: 402 })
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    expect(
      provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'Over', text: 'quota' })
    ).rejects.toThrow('Monthly free limit reached')
  })

  test('throws on 401 invalid key', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_bad')
    expect(
      provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'Bad', text: 'key' })
    ).rejects.toThrow('Invalid API key')
  })

  test('throws on 502 resend error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Resend: rate limit' }), { status: 502 })
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    expect(
      provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'Err', text: 'x' })
    ).rejects.toThrow('Resend: rate limit')
  })

  test('throws when ok response is missing message id', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    expect(
      provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'NoId', text: 'x' })
    ).rejects.toThrow('did not include a message id')
  })

  test('uses default API URL when not specified', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ id: 'x', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const provider = createHostedSendProvider('mk_key')
    await provider.send({ from: 'a@b.dev', to: ['c@d.com'], subject: 'T', text: 'x' })
    expect(requestUrl).toContain('/v1/send')
  })
})
