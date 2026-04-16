import PostalMime, { type Attachment as PostalMimeAttachment } from 'postal-mime'
import type { Attachment, AttachmentTextExtractionStatus } from '../../src/core/types.js'
import { htmlToText } from './extract-code'

const TEXT_EXTRACTION_LIMIT_BYTES = 10 * 1024 * 1024
const TEXT_ATTACHMENT_TYPES = new Set([
  'application/json',
  'text/csv',
  'text/markdown',
  'text/plain',
])

export interface ParsedIncomingEmail {
  subject: string
  bodyText: string
  bodyHtml: string
  headers: Record<string, string>
  messageId: string | null
  attachmentCount: number
  attachmentNames: string
  attachmentSearchText: string
  attachments: Attachment[]
}

export async function parseIncomingEmail(
  raw: ArrayBuffer,
  emailId: string,
  createdAt: string
): Promise<ParsedIncomingEmail> {
  const parser = new PostalMime({ attachmentEncoding: 'arraybuffer' })
  const parsed = await parser.parse(raw)
  const attachments = parsed.attachments.map((attachment, index) =>
    toAttachmentRecord(attachment, emailId, index, createdAt)
  )
  const rawBodyText = typeof parsed.text === 'string' ? parsed.text : ''
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : ''
  const bodyText = rawBodyText.trim().length > 0 ? rawBodyText : htmlToText(bodyHtml)

  return {
    subject: parsed.subject ?? '',
    bodyText,
    bodyHtml,
    headers: headersToRecord(parsed.headers),
    messageId: parsed.messageId ?? null,
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((attachment) => attachment.filename).join(' '),
    attachmentSearchText: attachments
      .map((attachment) => attachment.text_content)
      .filter((value) => value.length > 0)
      .join('\n\n'),
    attachments,
  }
}

function toAttachmentRecord(
  attachment: PostalMimeAttachment,
  emailId: string,
  mimePartIndex: number,
  createdAt: string
): Attachment {
  const filename = attachment.filename?.trim() || `attachment-${mimePartIndex + 1}`
  const sizeBytes = getAttachmentSize(attachment.content)
  const { text, status } = extractAttachmentText(attachment, sizeBytes)

  return {
    id: crypto.randomUUID(),
    email_id: emailId,
    filename,
    content_type: attachment.mimeType || 'application/octet-stream',
    size_bytes: sizeBytes,
    content_disposition: attachment.disposition ?? null,
    content_id: attachment.contentId ?? null,
    mime_part_index: mimePartIndex,
    text_content: text,
    text_extraction_status: status,
    storage_key: null,
    downloadable: false,
    created_at: createdAt,
  }
}

function headersToRecord(headers: Array<{ originalKey: string; value: string }>): Record<string, string> {
  const record: Record<string, string> = {}

  for (const header of headers) {
    if (record[header.originalKey]) {
      record[header.originalKey] += `\n${header.value}`
      continue
    }

    record[header.originalKey] = header.value
  }

  return record
}

function extractAttachmentText(
  attachment: PostalMimeAttachment,
  sizeBytes: number | null
): { text: string; status: AttachmentTextExtractionStatus } {
  if (sizeBytes !== null && sizeBytes > TEXT_EXTRACTION_LIMIT_BYTES) {
    return { text: '', status: 'too_large' }
  }

  if (!TEXT_ATTACHMENT_TYPES.has(attachment.mimeType)) {
    return { text: '', status: 'unsupported' }
  }

  try {
    return {
      text: decodeAttachmentContent(attachment.content),
      status: 'done',
    }
  } catch {
    return { text: '', status: 'failed' }
  }
}

function decodeAttachmentContent(content: PostalMimeAttachment['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (content instanceof Uint8Array) {
    return new TextDecoder().decode(content)
  }

  return new TextDecoder().decode(new Uint8Array(content))
}

function getAttachmentSize(content: PostalMimeAttachment['content']): number | null {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).byteLength
  }

  if (content instanceof Uint8Array) {
    return content.byteLength
  }

  if (content instanceof ArrayBuffer) {
    return content.byteLength
  }

  return null
}
