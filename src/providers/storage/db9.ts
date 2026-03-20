import type { AttachmentDownload, Email, EmailQueryOptions, EmailSearchOptions, StorageProvider } from '../../core/types.js'

// Issue #1 fix: remove invalid GIN index, use generated column instead
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
  headers JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  message_id TEXT,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
`

// Issue #4 fix: single source of truth for search vector expression
const SEARCH_VECTOR = `(
  setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(from_name, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(body_text, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(attachment_search_text, '')), 'C')
)`

// Issue #3 fix: explicit column list instead of SELECT *
const EMAIL_COLUMNS = 'id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, headers, metadata, message_id, has_attachments, attachment_count, attachment_names, attachment_search_text, direction, status, received_at, created_at'

interface Db9SqlColumn {
  name: string
  type?: string
}

interface Db9SqlResult {
  columns: Array<string | Db9SqlColumn>
  rows: unknown[][]
  row_count: number
}

function getColumnNames(columns: Array<string | Db9SqlColumn>): string[] {
  return columns.map(col => typeof col === 'string' ? col : col.name)
}

export function createDb9Provider(token: string, databaseId: string): StorageProvider {
  const baseUrl = 'https://api.db9.ai'

  // Issue #2 fix: escape single quotes AND backslashes
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "''")

  // Issue #6 fix: escape ILIKE wildcards
  const escLike = (s: string) => esc(s).replace(/%/g, '\\%').replace(/_/g, '\\_')

  async function sql(query: string): Promise<Db9SqlResult> {
    const res = await fetch(`${baseUrl}/customer/databases/${databaseId}/sql`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`db9 error (${res.status}): ${text}`)
    }
    return await res.json() as Db9SqlResult
  }

  function rowsToEmails(result: Db9SqlResult): Email[] {
    const columns = getColumnNames(result.columns)
    return result.rows.map(row => {
      const obj: Record<string, unknown> = {}
      columns.forEach((col, i) => { obj[col] = row[i] })
      return {
        id: obj.id as string,
        mailbox: obj.mailbox as string,
        from_address: obj.from_address as string,
        from_name: (obj.from_name as string) ?? '',
        to_address: obj.to_address as string,
        subject: (obj.subject as string) ?? '',
        body_text: (obj.body_text as string) ?? '',
        body_html: (obj.body_html as string) ?? '',
        code: (obj.code as string) ?? null,
        headers: typeof obj.headers === 'string' ? JSON.parse(obj.headers) : (obj.headers as Record<string, string>) ?? {},
        metadata: typeof obj.metadata === 'string' ? JSON.parse(obj.metadata) : (obj.metadata as Record<string, unknown>) ?? {},
        message_id: (obj.message_id as string) ?? null,
        has_attachments: obj.has_attachments === true || obj.has_attachments === 't' || obj.has_attachments === 'true',
        attachment_count: Number(obj.attachment_count) || 0,
        attachment_names: (obj.attachment_names as string) ?? '',
        attachment_search_text: (obj.attachment_search_text as string) ?? '',
        direction: obj.direction as Email['direction'],
        status: obj.status as Email['status'],
        received_at: obj.received_at as string,
        created_at: obj.created_at as string,
      }
    })
  }

  return {
    name: 'db9',

    async init() {
      await sql(SCHEMA)
    },

    async saveEmail(email: Email) {
      const attachments = email.attachments ?? []
      const hasAttachments = attachments.length > 0
      const attachmentCount = attachments.length
      const attachmentNames = hasAttachments ? attachments.map(a => a.filename).join(', ') : ''
      const attachmentSearchText = hasAttachments ? attachments.map(a => a.text_content || '').join(' ').trim() : ''

      await sql(`
        INSERT INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, headers, metadata, message_id, has_attachments, attachment_count, attachment_names, attachment_search_text, direction, status, received_at, created_at)
        VALUES (
          '${esc(email.id)}', '${esc(email.mailbox)}', '${esc(email.from_address)}', '${esc(email.from_name)}',
          '${esc(email.to_address)}', '${esc(email.subject)}', '${esc(email.body_text)}', '${esc(email.body_html)}',
          ${email.code ? `'${esc(email.code)}'` : 'NULL'},
          '${esc(JSON.stringify(email.headers))}'::jsonb,
          '${esc(JSON.stringify(email.metadata))}'::jsonb,
          ${email.message_id ? `'${esc(email.message_id)}'` : 'NULL'},
          ${hasAttachments}, ${attachmentCount},
          '${esc(attachmentNames)}', '${esc(attachmentSearchText)}',
          '${esc(email.direction)}', '${esc(email.status)}',
          '${esc(email.received_at)}', '${esc(email.created_at)}'
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          has_attachments = EXCLUDED.has_attachments,
          attachment_count = EXCLUDED.attachment_count,
          attachment_names = EXCLUDED.attachment_names,
          attachment_search_text = EXCLUDED.attachment_search_text
      `)

      if (attachments.length > 0) {
        const values = attachments.map(a => `(
          '${esc(a.id)}', '${esc(a.email_id)}', '${esc(a.filename)}', '${esc(a.content_type)}',
          ${a.size_bytes !== null && a.size_bytes !== undefined ? a.size_bytes : 'NULL'},
          ${a.content_disposition ? `'${esc(a.content_disposition)}'` : 'NULL'},
          ${a.content_id ? `'${esc(a.content_id)}'` : 'NULL'},
          ${a.mime_part_index},
          '${esc(a.text_content ?? '')}',
          '${esc(a.text_extraction_status ?? 'pending')}',
          ${a.storage_key ? `'${esc(a.storage_key)}'` : 'NULL'},
          '${esc(a.created_at)}'
        )`).join(',\n')

        await sql(`
          INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, content_disposition, content_id, mime_part_index, text_content, text_extraction_status, storage_key, created_at)
          VALUES ${values}
          ON CONFLICT (id) DO NOTHING
        `)
      }
    },

    async getEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      let query = `SELECT ${EMAIL_COLUMNS} FROM emails WHERE mailbox = '${esc(mailbox)}'`

      if (options?.direction) {
        query += ` AND direction = '${esc(options.direction)}'`
      }

      query += ` ORDER BY received_at DESC LIMIT ${limit} OFFSET ${offset}`

      const result = await sql(query)
      return rowsToEmails(result)
    },

    async searchEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      const directionClause = options.direction
        ? `AND direction = '${esc(options.direction)}'`
        : ''
      const queryText = esc(options.query)
      const pattern = `%${escLike(options.query)}%`

      const result = await sql(`
        SELECT ${EMAIL_COLUMNS}
        FROM emails
        WHERE mailbox = '${esc(mailbox)}'
          ${directionClause}
          AND (
            ${SEARCH_VECTOR} @@ websearch_to_tsquery('simple', '${queryText}')
            OR from_address ILIKE '${pattern}' ESCAPE '\\\\'
            OR to_address ILIKE '${pattern}' ESCAPE '\\\\'
            OR code ILIKE '${pattern}' ESCAPE '\\\\'
          )
        ORDER BY
          ts_rank(${SEARCH_VECTOR}, websearch_to_tsquery('simple', '${queryText}')) DESC,
          received_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)

      return rowsToEmails(result)
    },

    async getEmail(id) {
      let result = await sql(`SELECT ${EMAIL_COLUMNS} FROM emails WHERE id = '${esc(id)}' LIMIT 1`)
      let emails = rowsToEmails(result)
      let email = emails[0] ?? null
      if (!email) {
        result = await sql(`SELECT ${EMAIL_COLUMNS} FROM emails WHERE id LIKE '${esc(id)}%' ORDER BY received_at DESC LIMIT 2`)
        emails = rowsToEmails(result)
        if (emails.length > 1) {
          throw new Error(`Ambiguous email id: ${id}`)
        }
        email = emails[0] ?? null
      }
      if (!email) return null

      const attResult = await sql(`SELECT * FROM attachments WHERE email_id = '${esc(email.id)}' ORDER BY mime_part_index ASC`)
      if (attResult.row_count > 0) {
        const attColumns = getColumnNames(attResult.columns)
        email.attachments = attResult.rows.map(row => {
          const obj: Record<string, unknown> = {}
          attColumns.forEach((col, i) => { obj[col] = row[i] })
          return {
            id: obj.id as string,
            email_id: obj.email_id as string,
            filename: obj.filename as string,
            content_type: obj.content_type as string,
            size_bytes: obj.size_bytes !== null && obj.size_bytes !== undefined ? Number(obj.size_bytes) : null,
            content_disposition: (obj.content_disposition as string) ?? null,
            content_id: (obj.content_id as string) ?? null,
            mime_part_index: Number(obj.mime_part_index),
            text_content: (obj.text_content as string) ?? '',
            text_extraction_status: (obj.text_extraction_status as string ?? 'pending') as import('../../core/types.js').AttachmentTextExtractionStatus,
            storage_key: (obj.storage_key as string) ?? null,
            created_at: obj.created_at as string,
          }
        })
      } else {
        email.attachments = []
      }

      return email
    },

    async getCode(mailbox, options) {
      const timeout = (options?.timeout ?? 30) * 1000
      const since = options?.since
      const deadline = Date.now() + timeout

      while (Date.now() < deadline) {
        let query = `SELECT code, from_address, subject FROM emails WHERE mailbox = '${esc(mailbox)}' AND code IS NOT NULL`

        if (since) {
          query += ` AND received_at > '${esc(since)}'`
        }

        query += ' ORDER BY received_at DESC LIMIT 1'

        const result = await sql(query)
        if (result.row_count > 0) {
          const columns = getColumnNames(result.columns)
          const row = result.rows[0]!
          const codeIdx = columns.indexOf('code')
          const fromIdx = columns.indexOf('from_address')
          const subIdx = columns.indexOf('subject')
          return {
            code: row[codeIdx] as string,
            from: row[fromIdx] as string,
            subject: row[subIdx] as string,
          }
        }

        await new Promise(r => setTimeout(r, 2000))
      }

      return null
    },

    async getAttachment(id: string): Promise<AttachmentDownload | null> {
      const result = await sql(`SELECT filename, content_type, text_content, text_extraction_status FROM attachments WHERE id = '${esc(id)}'`)
      if (result.row_count === 0) return null

      const columns = getColumnNames(result.columns)
      const row = result.rows[0]!
      const obj: Record<string, unknown> = {}
      columns.forEach((col, i) => { obj[col] = row[i] })

      const textExtractionStatus = obj.text_extraction_status as string
      const textContent = obj.text_content as string

      if (textExtractionStatus !== 'done' || !textContent) return null

      return {
        data: new TextEncoder().encode(textContent).buffer as ArrayBuffer,
        filename: obj.filename as string,
        contentType: obj.content_type as string,
      }
    },
  }
}

function normalizeQueryOptions(options?: EmailQueryOptions | EmailSearchOptions): { limit: number; offset: number } {
  const limit = Number.isFinite(options?.limit) ? Math.trunc(options!.limit!) : 20
  const offset = Number.isFinite(options?.offset) ? Math.trunc(options!.offset!) : 0

  return {
    limit: limit > 0 ? limit : 20,
    offset: offset >= 0 ? offset : 0,
  }
}
