export interface SendAttachment {
  filename?: string
  content?: string | ArrayBuffer | Uint8Array
  path?: string
  contentType?: string
  contentId?: string
}

export interface PreparedAttachment {
  filename: string
  content: string
  contentType?: string
  contentId?: string
}

export type AttachmentTextExtractionStatus =
  | 'pending'
  | 'done'
  | 'unsupported'
  | 'failed'
  | 'too_large'

export interface Attachment {
  id: string
  email_id: string
  filename: string
  content_type: string
  size_bytes: number | null
  size?: number | null          // mails.dev compat alias
  content_disposition: string | null
  disposition?: string | null   // mails.dev compat alias
  content_id: string | null
  mime_part_index: number
  text_content: string
  text_extraction_status: AttachmentTextExtractionStatus
  storage_key: string | null
  downloadable?: boolean
  created_at: string
}

export interface Email {
  id: string
  mailbox: string
  from_address: string
  from_name: string
  to_address: string
  subject: string
  body_text: string
  body_html: string
  code: string | null
  headers: Record<string, string>
  metadata: Record<string, unknown>
  direction: 'inbound' | 'outbound'
  status: 'received' | 'sent' | 'failed' | 'queued'
  provider?: string | null
  message_id?: string | null
  has_attachments?: boolean
  attachment_count?: number
  attachment_names?: string
  attachment_search_text?: string
  raw_storage_key?: string | null
  attachments?: Attachment[]
  received_at: string
  created_at: string
}

export interface SendOptions {
  from?: string
  to: string | string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string
  headers?: Record<string, string>
  attachments?: SendAttachment[]
}

export interface SendResult {
  id: string
  provider: string
}

export interface MailsConfig {
  mode: 'hosted' | 'selfhosted'
  domain: string
  mailbox: string
  send_provider: string
  storage_provider: string
  resend_api_key?: string
  db9_token?: string
  db9_database_id?: string
  cloudflare_api_token?: string
  cloudflare_zone_id?: string
  worker_url?: string
  worker_token?: string
  default_from?: string
  api_key?: string
  last_sync?: string
}

export interface SendProvider {
  name: string
  send(options: {
    from: string
    to: string[]
    subject: string
    text?: string
    html?: string
    replyTo?: string
    headers?: Record<string, string>
    attachments?: PreparedAttachment[]
  }): Promise<SendResult>
}

export interface EmailQueryOptions {
  limit?: number
  offset?: number
  direction?: 'inbound' | 'outbound'
}

export interface EmailSearchOptions extends EmailQueryOptions {
  query: string
}

export interface AttachmentDownload {
  data: ArrayBuffer
  filename: string
  contentType: string
}

export interface StorageProvider {
  name: string
  init(): Promise<void>
  saveEmail(email: Email): Promise<void>
  getEmails(mailbox: string, options?: EmailQueryOptions): Promise<Email[]>
  searchEmails(mailbox: string, options: EmailSearchOptions): Promise<Email[]>
  getEmail(id: string): Promise<Email | null>
  getCode(mailbox: string, options?: {
    timeout?: number
    since?: string
  }): Promise<{ code: string; from: string; subject: string } | null>
  getAttachment?(id: string): Promise<AttachmentDownload | null>
}
