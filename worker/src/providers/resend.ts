import type { EmailProvider, SendRequest, SendResult } from './types'

export class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const
  private readonly fetchImpl: typeof fetch

  constructor(
    private apiKey: string,
    fetchImpl?: typeof fetch,
  ) {
    // Wrap in a lambda so `this` inside fetch resolves to globalThis (required by Workers runtime).
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
  }

  supports(_req: SendRequest): boolean {
    return true
  }

  async send(req: SendRequest): Promise<SendResult> {
    const body: Record<string, unknown> = {
      from: req.from,
      to: req.to,
      subject: req.subject,
    }
    if (req.text) body.text = req.text
    if (req.html) body.html = req.html
    if (req.reply_to) body.reply_to = req.reply_to
    if (req.cc?.length) body.cc = req.cc
    if (req.bcc?.length) body.bcc = req.bcc
    if (req.attachments?.length) {
      body.attachments = req.attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        ...(a.content_type ? { content_type: a.content_type } : {}),
      }))
    }

    // Detach from `this` so Workers runtime keeps `this = globalThis` inside fetch.
    const doFetch = this.fetchImpl
    const res = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({})) as { id?: string; message?: string }
    if (!res.ok) {
      throw new Error(`Resend: ${data.message ?? res.statusText}`)
    }

    return { id: data.id ?? crypto.randomUUID(), provider: 'resend' }
  }
}
