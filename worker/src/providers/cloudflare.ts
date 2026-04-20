import type { EmailProvider, SendRequest, SendResult } from './types'

/**
 * Cloudflare Email Service binding shape (private beta, April 2026).
 * Announcement: https://blog.cloudflare.com/email-for-agents/
 *
 * The binding is expected to expose `send(message)` returning an object with
 * an `id` (message id). Field names follow the blog's example:
 * `{ to, from, subject, text }`. `html` / `reply_to` are assumed-supported
 * but can be gated in `supports()` if runtime proves otherwise.
 */
export interface CloudflareEmailBinding {
  send(message: {
    from: string
    to: string | string[]
    subject: string
    text?: string
    html?: string
    reply_to?: string
  }): Promise<{ id?: string } | void>
}

export class CloudflareProvider implements EmailProvider {
  readonly name = 'cloudflare' as const

  constructor(private binding: CloudflareEmailBinding) {}

  supports(req: SendRequest): boolean {
    if (req.attachments?.length) return false
    if (req.cc?.length) return false
    if (req.bcc?.length) return false
    return true
  }

  async send(req: SendRequest): Promise<SendResult> {
    const message: Parameters<CloudflareEmailBinding['send']>[0] = {
      from: req.from,
      to: req.to.length === 1 ? req.to[0]! : req.to,
      subject: req.subject,
    }
    if (req.text) message.text = req.text
    if (req.html) message.html = req.html
    if (req.reply_to) message.reply_to = req.reply_to

    const result = await this.binding.send(message)
    const id = (result && typeof result === 'object' && 'id' in result && result.id)
      ? result.id
      : crypto.randomUUID()
    return { id, provider: 'cloudflare' }
  }
}
