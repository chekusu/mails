import { describe, expect, test, mock } from 'bun:test'
import { CloudflareProvider } from '../../worker/src/providers/cloudflare'
import { ResendProvider } from '../../worker/src/providers/resend'
import {
  buildProviderChain,
  sendWithChain,
} from '../../worker/src/providers/chain'
import {
  AllProvidersFailedError,
  UnsupportedFeatureError,
  type EmailProvider,
  type SendRequest,
} from '../../worker/src/providers/types'

const baseReq = (overrides: Partial<SendRequest> = {}): SendRequest => ({
  from: 'me@example.com',
  to: ['you@example.com'],
  subject: 'Hi',
  text: 'Hello',
  ...overrides,
})

describe('CloudflareProvider.supports', () => {
  const cf = new CloudflareProvider({ send: async () => ({ messageId: 'x' }) })

  test('supports every request (public beta covers all features)', () => {
    expect(cf.supports(baseReq())).toBe(true)
    expect(cf.supports(baseReq({ html: '<p>hi</p>' }))).toBe(true)
    expect(cf.supports(baseReq({ reply_to: 'a@b.com' }))).toBe(true)
    expect(cf.supports(baseReq({ cc: ['c@d.com'], bcc: ['e@f.com'] }))).toBe(true)
    expect(cf.supports(baseReq({ attachments: [{ filename: 'f', content: 'x' }] }))).toBe(true)
  })
})

describe('CloudflareProvider.send', () => {
  test('maps SendRequest to the Cloudflare binding shape', async () => {
    const sendMock = mock(() => Promise.resolve({ messageId: 'cf-42' }))
    const cf = new CloudflareProvider({ send: sendMock })

    const res = await cf.send(baseReq({
      html: '<p>hi</p>',
      reply_to: 'a@b.com',
      cc: ['c@d.com'],
      bcc: ['e@f.com'],
      attachments: [{ filename: 'note.pdf', content: 'AAA', content_type: 'application/pdf' }],
    }))
    expect(res).toEqual({ id: 'cf-42', provider: 'cloudflare' })

    const [msg] = (sendMock as any).mock.calls[0]
    expect(msg.from).toBe('me@example.com')
    expect(msg.to).toBe('you@example.com')
    expect(msg.subject).toBe('Hi')
    expect(msg.text).toBe('Hello')
    expect(msg.html).toBe('<p>hi</p>')
    expect(msg.replyTo).toBe('a@b.com')       // camelCase per CF API
    expect(msg.cc).toEqual(['c@d.com'])
    expect(msg.bcc).toEqual(['e@f.com'])
    expect(msg.attachments).toEqual([{
      content: 'AAA',
      filename: 'note.pdf',
      type: 'application/pdf',               // `type`, not `content_type`
      disposition: 'attachment',
    }])
    expect(msg.reply_to).toBeUndefined()     // must not leak snake_case
  })

  test('passes array when multiple recipients', async () => {
    const sendMock = mock(() => Promise.resolve({ messageId: 'x' }))
    const cf = new CloudflareProvider({ send: sendMock })
    await cf.send(baseReq({ to: ['a@b.com', 'c@d.com'] }))
    const [msg] = (sendMock as any).mock.calls[0]
    expect(msg.to).toEqual(['a@b.com', 'c@d.com'])
  })

  test('defaults attachment type to application/octet-stream when unset', async () => {
    const sendMock = mock(() => Promise.resolve({ messageId: 'x' }))
    const cf = new CloudflareProvider({ send: sendMock })
    await cf.send(baseReq({ attachments: [{ filename: 'bin', content: 'x' }] }))
    const [msg] = (sendMock as any).mock.calls[0]
    expect(msg.attachments[0].type).toBe('application/octet-stream')
  })

  test('accepts legacy `id` field from binding response', async () => {
    const cf = new CloudflareProvider({ send: async () => ({ id: 'legacy-42' }) as any })
    const res = await cf.send(baseReq())
    expect(res.id).toBe('legacy-42')
  })

  test('assigns uuid when binding returns no messageId', async () => {
    const cf = new CloudflareProvider({ send: async () => undefined })
    const res = await cf.send(baseReq())
    expect(res.provider).toBe('cloudflare')
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('ResendProvider', () => {
  test('supports all requests', () => {
    const r = new ResendProvider('k')
    expect(r.supports(baseReq())).toBe(true)
    expect(r.supports(baseReq({ attachments: [{ filename: 'f', content: 'x' }] }))).toBe(true)
    expect(r.supports(baseReq({ cc: ['c@d.com'], bcc: ['e@f.com'] }))).toBe(true)
  })

  test('posts to Resend API with full body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ id: 'resend-99' }, { status: 200 })),
    )
    const r = new ResendProvider('kk', fetchMock as unknown as typeof fetch)
    const res = await r.send(baseReq({
      html: '<p>h</p>',
      reply_to: 'a@b.com',
      cc: ['c@d.com'],
      bcc: ['e@f.com'],
      attachments: [{ filename: 'f.pdf', content: 'AAAA', content_type: 'application/pdf' }],
    }))

    expect(res).toEqual({ id: 'resend-99', provider: 'resend' })

    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.from).toBe('me@example.com')
    expect(body.to).toEqual(['you@example.com'])
    expect(body.html).toBe('<p>h</p>')
    expect(body.cc).toEqual(['c@d.com'])
    expect(body.bcc).toEqual(['e@f.com'])
    expect(body.attachments[0]).toMatchObject({
      filename: 'f.pdf',
      content: 'AAAA',
      content_type: 'application/pdf',
    })
  })

  test('throws on non-2xx response', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ message: 'domain not verified' }, { status: 403 })),
    )
    const r = new ResendProvider('kk', fetchMock as unknown as typeof fetch)
    await expect(r.send(baseReq())).rejects.toThrow('Resend: domain not verified')
  })
})

describe('buildProviderChain', () => {
  test('defaults to cloudflare,resend order', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({ id: 'x' }) },
      RESEND_API_KEY: 'k',
    })
    expect(chain.map(p => p.name)).toEqual(['cloudflare', 'resend'])
  })

  test('skips cloudflare when no binding', () => {
    const chain = buildProviderChain({ RESEND_API_KEY: 'k' })
    expect(chain.map(p => p.name)).toEqual(['resend'])
  })

  test('skips resend when no api key', () => {
    const chain = buildProviderChain({ EMAIL: { send: async () => ({}) } })
    expect(chain.map(p => p.name)).toEqual(['cloudflare'])
  })

  test('empty chain when nothing configured', () => {
    const chain = buildProviderChain({})
    expect(chain).toEqual([])
  })

  test('EMAIL_PROVIDERS=resend forces single provider', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      EMAIL_PROVIDERS: 'resend',
    })
    expect(chain.map(p => p.name)).toEqual(['resend'])
  })

  test('EMAIL_PROVIDERS reverses order', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      EMAIL_PROVIDERS: 'resend,cloudflare',
    })
    expect(chain.map(p => p.name)).toEqual(['resend', 'cloudflare'])
  })

  test('EMAIL_PROVIDERS dedupes and ignores unknown', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      EMAIL_PROVIDERS: 'resend,resend, bogus, cloudflare',
    })
    expect(chain.map(p => p.name)).toEqual(['resend', 'cloudflare'])
  })

  test('EMAIL_PROVIDERS empty string falls back to default', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      EMAIL_PROVIDERS: '',
    })
    expect(chain.map(p => p.name)).toEqual(['cloudflare', 'resend'])
  })
})

describe('sendWithChain', () => {
  const makeProvider = (
    name: 'cloudflare' | 'resend',
    opts: { supports?: boolean; send?: () => Promise<{ id: string; provider: 'cloudflare' | 'resend' }> } = {},
  ): EmailProvider => ({
    name,
    supports: () => opts.supports ?? true,
    send: opts.send ?? (() => Promise.resolve({ id: `${name}-ok`, provider: name })),
  })

  test('throws when chain empty', async () => {
    await expect(sendWithChain([], baseReq())).rejects.toThrow('No email provider configured')
  })

  test('returns first successful provider', async () => {
    const cf = makeProvider('cloudflare')
    const rs = makeProvider('resend')
    const res = await sendWithChain([cf, rs], baseReq())
    expect(res).toEqual({ id: 'cloudflare-ok', provider: 'cloudflare' })
  })

  test('skips providers that do not support the request', async () => {
    const cf = makeProvider('cloudflare', { supports: false })
    const rs = makeProvider('resend')
    const res = await sendWithChain([cf, rs], baseReq({ attachments: [{ filename: 'x', content: 'y' }] }))
    expect(res.provider).toBe('resend')
  })

  test('falls back when primary throws', async () => {
    const cf = makeProvider('cloudflare', {
      send: () => Promise.reject(new Error('binding exploded')),
    })
    const rs = makeProvider('resend')
    const res = await sendWithChain([cf, rs], baseReq())
    expect(res.provider).toBe('resend')
  })

  test('throws UnsupportedFeatureError when no provider supports request', async () => {
    const cf = makeProvider('cloudflare', { supports: false })
    await expect(
      sendWithChain([cf], baseReq({ attachments: [{ filename: 'x', content: 'y' }] })),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError)
  })

  test('throws AllProvidersFailedError with attempts when all fail', async () => {
    const cf = makeProvider('cloudflare', { send: () => Promise.reject(new Error('cf down')) })
    const rs = makeProvider('resend', { send: () => Promise.reject(new Error('resend down')) })
    try {
      await sendWithChain([cf, rs], baseReq())
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersFailedError)
      const e = err as AllProvidersFailedError
      expect(e.attempts).toHaveLength(2)
      expect(e.attempts[0]).toEqual({ provider: 'cloudflare', error: 'cf down' })
      expect(e.attempts[1]).toEqual({ provider: 'resend', error: 'resend down' })
    }
  })
})
