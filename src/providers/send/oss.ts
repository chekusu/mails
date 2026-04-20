import type { SendProvider, SendResult } from '../../core/types.js'

export function createOSSSendProvider(workerUrl: string, token?: string): SendProvider {
  return {
    name: 'oss',
    async send(options): Promise<SendResult> {
      const body: Record<string, unknown> = {
        from: options.from,
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

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${workerUrl}/api/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const data = await res.json() as { id?: string; provider?: string; error?: string }
      if (!res.ok) throw new Error(`OSS send error (${res.status}): ${data.error ?? res.statusText}`)

      return { id: data.id!, provider: data.provider ?? 'oss' }
    },
  }
}
