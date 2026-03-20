import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Attachment, AttachmentDownload, Email, EmailQueryOptions, EmailSearchOptions, StorageProvider } from '../../core/types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT DEFAULT '',
  to_address TEXT NOT NULL,
  subject TEXT DEFAULT '',
  body_text TEXT DEFAULT '',
  body_html TEXT DEFAULT '',
  code TEXT,
  headers TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  message_id TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  content_disposition TEXT,
  content_id TEXT,
  mime_part_index INTEGER NOT NULL,
  text_content TEXT DEFAULT '',
  text_extraction_status TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
`

export function createSqliteProvider(dbPath?: string): StorageProvider {
  const dir = join(homedir(), '.mails')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const path = dbPath ?? join(dir, 'mails.db')
  let db: Database

  return {
    name: 'sqlite',

    async init() {
      db = new Database(path)
      db.exec('PRAGMA journal_mode=WAL;')
      db.exec(SCHEMA)
    },

    async saveEmail(email: Email) {
      db.prepare(`
        INSERT OR REPLACE INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, headers, metadata, message_id, has_attachments, attachment_count, attachment_names, attachment_search_text, direction, status, received_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        email.id, email.mailbox, email.from_address, email.from_name,
        email.to_address, email.subject, email.body_text, email.body_html,
        email.code, JSON.stringify(email.headers), JSON.stringify(email.metadata),
        email.message_id ?? null,
        email.has_attachments ? 1 : 0,
        email.attachment_count ?? 0,
        email.attachment_names ?? '',
        email.attachment_search_text ?? '',
        email.direction, email.status, email.received_at, email.created_at,
      )

      if (email.attachments?.length) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO attachments (id, email_id, filename, content_type, size_bytes, content_disposition, content_id, mime_part_index, text_content, text_extraction_status, storage_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const att of email.attachments) {
          stmt.run(
            att.id, att.email_id, att.filename, att.content_type,
            att.size_bytes ?? null, att.content_disposition ?? null,
            att.content_id ?? null, att.mime_part_index,
            att.text_content ?? '', att.text_extraction_status ?? 'pending',
            att.storage_key ?? null, att.created_at,
          )
        }
      }
    },

    async getEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      let query = 'SELECT * FROM emails WHERE mailbox = ?'
      const params: (string | number)[] = [mailbox]

      if (options?.direction) {
        query += ' AND direction = ?'
        params.push(options.direction)
      }

      query += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
      params.push(limit, offset)

      const rows = db.prepare(query).all(...params) as Record<string, unknown>[]
      return rows.map(rowToEmail)
    },

    async searchEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      const escaped = options.query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
      const pattern = `%${escaped}%`
      let query = `
        SELECT * FROM emails
        WHERE mailbox = ?
      `
      const params: (string | number)[] = [mailbox]

      if (options.direction) {
        query += ' AND direction = ?'
        params.push(options.direction)
      }

      query += `
        AND (
          subject LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR body_text LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR from_address LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR from_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR to_address LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR code LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?
      `

      params.push(pattern, pattern, pattern, pattern, pattern, pattern, limit, offset)

      const rows = db.prepare(query).all(...params) as Record<string, unknown>[]
      return rows.map(rowToEmail)
    },

    async getEmail(id) {
      let row = db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Record<string, unknown> | null
      if (!row) {
        const matches = db.prepare('SELECT * FROM emails WHERE id LIKE ? ORDER BY received_at DESC LIMIT 2').all(`${id}%`) as Record<string, unknown>[]
        if (matches.length > 1) {
          throw new Error(`Ambiguous email id: ${id}`)
        }
        row = matches[0] ?? null
      }
      if (!row) return null
      const email = rowToEmail(row)
      const attRows = db.prepare('SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC').all(email.id) as Record<string, unknown>[]
      email.attachments = attRows.map(rowToAttachment)
      return email
    },

    async getCode(mailbox, options) {
      const timeout = (options?.timeout ?? 30) * 1000
      const since = options?.since
      const deadline = Date.now() + timeout

      while (Date.now() < deadline) {
        let query = 'SELECT code, from_address, subject FROM emails WHERE mailbox = ? AND code IS NOT NULL'
        const params: string[] = [mailbox]

        if (since) {
          query += ' AND received_at > ?'
          params.push(since)
        }

        query += ' ORDER BY received_at DESC LIMIT 1'

        const row = db.prepare(query).get(...params) as { code: string; from_address: string; subject: string } | null
        if (row) {
          return { code: row.code, from: row.from_address, subject: row.subject }
        }

        await new Promise(r => setTimeout(r, 1000))
      }

      return null
    },

    async getAttachment(id: string): Promise<AttachmentDownload | null> {
      const row = db.prepare(
        'SELECT filename, content_type, text_content, text_extraction_status FROM attachments WHERE id = ?',
      ).get(id) as { filename: string; content_type: string; text_content: string; text_extraction_status: string } | null

      if (!row) return null
      if (row.text_extraction_status !== 'done' || !row.text_content) return null

      return {
        data: new TextEncoder().encode(row.text_content).buffer as ArrayBuffer,
        filename: row.filename,
        contentType: row.content_type,
      }
    },
  }
}

function rowToEmail(row: Record<string, unknown>): Email {
  return {
    id: row.id as string,
    mailbox: row.mailbox as string,
    from_address: row.from_address as string,
    from_name: (row.from_name as string) ?? '',
    to_address: row.to_address as string,
    subject: (row.subject as string) ?? '',
    body_text: (row.body_text as string) ?? '',
    body_html: (row.body_html as string) ?? '',
    code: (row.code as string) ?? null,
    headers: safeJsonParse(row.headers as string, {}),
    metadata: safeJsonParse(row.metadata as string, {}),
    message_id: (row.message_id as string) ?? null,
    has_attachments: !!(row.has_attachments as number),
    attachment_count: (row.attachment_count as number) ?? 0,
    attachment_names: (row.attachment_names as string) ?? '',
    attachment_search_text: (row.attachment_search_text as string) ?? '',
    direction: row.direction as Email['direction'],
    status: row.status as Email['status'],
    received_at: row.received_at as string,
    created_at: row.created_at as string,
  }
}

function rowToAttachment(row: Record<string, unknown>): Attachment {
  return {
    id: row.id as string,
    email_id: row.email_id as string,
    filename: row.filename as string,
    content_type: row.content_type as string,
    size_bytes: (row.size_bytes as number) ?? null,
    content_disposition: (row.content_disposition as string) ?? null,
    content_id: (row.content_id as string) ?? null,
    mime_part_index: row.mime_part_index as number,
    text_content: (row.text_content as string) ?? '',
    text_extraction_status: (row.text_extraction_status as Attachment['text_extraction_status']) ?? 'pending',
    storage_key: (row.storage_key as string) ?? null,
    created_at: row.created_at as string,
  }
}

function safeJsonParse<T>(str: string | undefined, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

function normalizeQueryOptions(options?: EmailQueryOptions | EmailSearchOptions): { limit: number; offset: number } {
  const limit = Number.isFinite(options?.limit) ? Math.trunc(options!.limit!) : 20
  const offset = Number.isFinite(options?.offset) ? Math.trunc(options!.offset!) : 0

  return {
    limit: limit > 0 ? limit : 20,
    offset: offset >= 0 ? offset : 0,
  }
}
