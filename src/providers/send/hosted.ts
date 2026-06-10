import type { SendProvider, SendResult } from '../../core/types.js'
import { resolveHostedApiUrl } from '../../core/api-url.js'

export function createHostedSendProvider(apiKey: string, apiUrl?: string): SendProvider {
  const baseUrl = resolveHostedApiUrl(apiUrl)

  return {
    name: 'mails.dev',

    async send(options): Promise<SendResult> {
      const body: Record<string, unknown> = {
        to: options.to,
        subject: options.subject,
      }
      if (options.text) body.text = options.text
      if (options.html) body.html = options.html
      if (options.replyTo) body.reply_to = options.replyTo
      if (options.attachments?.length) {
        body.attachments = options.attachments.map(a => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType ? { content_type: a.contentType } : {}),
        }))
      }

      const res = await fetch(`${baseUrl}/v1/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      const data = await res.json() as {
        id?: string
        from?: string
        sends_this_month?: number
        monthly_limit?: number
        error?: string
        price?: string
      }

      if (res.status === 402) {
        const msg = data.error ?? 'Monthly free limit reached'
        throw new Error(`${msg}\n  Pay ${data.price ?? '$0.002'}/email with USDC, or use your own Resend key:\n  mails config set resend_api_key re_YOUR_KEY`)
      }

      if (!res.ok) {
        throw new Error(`Send failed: ${data.error ?? res.statusText}`)
      }

      // Show quota in stderr
      if (data.sends_this_month !== undefined && data.monthly_limit !== undefined) {
        process.stderr.write(`  [${data.sends_this_month}/${data.monthly_limit} this month]\n`)
      }

      if (!data.id) {
        throw new Error('Send succeeded but the API response did not include a message id')
      }

      return { id: data.id, provider: 'mails.dev' }
    },
  }
}
