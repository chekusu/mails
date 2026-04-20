export interface SendAttachment {
  filename: string
  content: string
  content_type?: string
}

export interface SendRequest {
  from: string
  to: string[]
  subject: string
  text?: string
  html?: string
  reply_to?: string
  cc?: string[]
  bcc?: string[]
  attachments?: SendAttachment[]
}

export type ProviderName = 'cloudflare' | 'resend'

export interface SendResult {
  id: string
  provider: ProviderName
}

export interface EmailProvider {
  name: ProviderName
  supports(req: SendRequest): boolean
  send(req: SendRequest): Promise<SendResult>
}

export class UnsupportedFeatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedFeatureError'
  }
}

export class AllProvidersFailedError extends Error {
  constructor(public attempts: Array<{ provider: ProviderName; error: string }>) {
    super(`All providers failed: ${attempts.map(a => `${a.provider}: ${a.error}`).join('; ')}`)
    this.name = 'AllProvidersFailedError'
  }
}
