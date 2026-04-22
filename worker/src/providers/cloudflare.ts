import type { EmailProvider, SendRequest, SendResult } from './types'

/**
 * Cloudflare Email Service binding (public beta, April 2026).
 * Docs: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *
 * Binding declaration (wrangler.toml):
 *   [[send_email]]
 *   name = "EMAIL"
 *
 * The full API supports html, cc/bcc, replyTo, headers, and attachments, so
 * the provider advertises every feature.
 */
export interface CloudflareEmailAttachment {
  content: string | ArrayBuffer
  filename: string
  type: string
  disposition: 'attachment' | 'inline'
  contentId?: string
}

export interface CloudflareEmailMessage {
  from: string | { email: string; name?: string }
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string | { email: string; name?: string }
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: CloudflareEmailAttachment[]
}

export interface CloudflareEmailBinding {
  send(message: CloudflareEmailMessage): Promise<{ messageId?: string; id?: string } | void>
}

export class CloudflareProvider implements EmailProvider {
  readonly name = 'cloudflare' as const

  constructor(private binding: CloudflareEmailBinding) {}

  supports(_req: SendRequest): boolean {
    return true
  }

  async send(req: SendRequest): Promise<SendResult> {
    const msg: CloudflareEmailMessage = {
      from: req.from,
      to: req.to.length === 1 ? req.to[0]! : req.to,
      subject: req.subject,
    }
    if (req.text) msg.text = req.text
    if (req.html) msg.html = req.html
    if (req.reply_to) msg.replyTo = req.reply_to
    if (req.cc?.length) msg.cc = req.cc
    if (req.bcc?.length) msg.bcc = req.bcc
    if (req.attachments?.length) {
      msg.attachments = req.attachments.map(a => ({
        content: a.content,
        filename: a.filename,
        type: a.content_type ?? 'application/octet-stream',
        disposition: 'attachment' as const,
      }))
    }

    const result = await this.binding.send(msg)
    const id = (result && typeof result === 'object' && (result.messageId ?? result.id)) || crypto.randomUUID()
    return { id, provider: 'cloudflare' }
  }
}
