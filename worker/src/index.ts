import { extractEmailCode } from './extract-code'
import { parseIncomingEmail } from './mime'
import {
  AllProvidersFailedError,
  UnsupportedFeatureError,
  buildProviderChain,
  sendWithChain,
  type CloudflareEmailBinding,
  type SendRequest,
} from './providers'

export interface Env {
  DB: D1Database
  /** Single-mailbox token. Requires MAILBOX to be set. */
  AUTH_TOKEN?: string
  /** Single mailbox address associated with AUTH_TOKEN. */
  MAILBOX?: string
  /** Optional multi-mailbox token map as JSON: {"mailbox@example.com":"token"} */
  AUTH_TOKENS_JSON?: string
  /** Resend API key for outbound email sending. */
  RESEND_API_KEY?: string
  /** Cloudflare Email Service binding (private beta). */
  EMAIL?: CloudflareEmailBinding
  /**
   * Ordered provider preference list, e.g. "cloudflare,resend".
   * Defaults to "cloudflare,resend"; providers lacking configuration are
   * silently skipped so existing Resend-only deployments continue to work.
   */
  EMAIL_PROVIDERS?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    let response: Response

    // /health is always public
    if (url.pathname === '/health') {
      response = Response.json({ ok: true })
    } else if (url.pathname.startsWith('/api/')) {
      const auth = requireAuthorizedMailbox(request, env)
      if ('response' in auth) {
        response = auth.response
      } else {
        switch (url.pathname) {
          case '/api/inbox':
            response = await handleInbox(url, env, auth.mailbox)
            break
          case '/api/code':
            response = await handleGetCode(url, env, auth.mailbox)
            break
          case '/api/email':
            response = await handleGetEmail(url, env, auth.mailbox)
            break
          case '/api/send':
            if (request.method !== 'POST') {
              response = Response.json({ error: 'Method not allowed' }, { status: 405 })
            } else {
              response = await handleSend(request, env, auth.mailbox)
            }
            break
          case '/api/sync':
            response = await handleSync(url, env, auth.mailbox)
            break
          default:
            response = Response.json({ error: 'Not found' }, { status: 404 })
        }
      }
    } else {
      response = Response.json({ name: 'mails-worker', version: '1.5.6' })
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value)
    }
    return response
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = message.to
    const from = message.from
    const mailbox = normalizeMailbox(to)
    const fromAddress = normalizeMailbox(message.headers.get('from') ?? from)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const parsed = await parseIncomingEmail(await new Response(message.raw).arrayBuffer(), id, now)
    const subject = parsed.subject || message.headers.get('subject') || ''
    const code = extractEmailCode({
      subject,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
    })
    const fromName = parseFromName(message.headers.get('from') ?? from)
    const statements = [
      env.DB.prepare(`
        INSERT INTO emails (
          id, mailbox, from_address, from_name, to_address, subject,
          body_text, body_html, code, headers, metadata, message_id,
          has_attachments, attachment_count, attachment_names, attachment_search_text,
          raw_storage_key, direction, status, received_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?)
      `).bind(
        id,
        mailbox,
        fromAddress,
        fromName,
        mailbox,
        subject,
        parsed.bodyText.slice(0, 50000),
        parsed.bodyHtml.slice(0, 100000),
        code,
        JSON.stringify(parsed.headers),
        JSON.stringify({}),
        parsed.messageId,
        parsed.attachmentCount > 0 ? 1 : 0,
        parsed.attachmentCount,
        parsed.attachmentNames,
        parsed.attachmentSearchText,
        null,
        now,
        now
      ),
      ...parsed.attachments.map((attachment) =>
        env.DB.prepare(`
          INSERT INTO attachments (
            id, email_id, filename, content_type, size_bytes,
            content_disposition, content_id, mime_part_index,
            text_content, text_extraction_status, storage_key, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          attachment.id,
          attachment.email_id,
          attachment.filename,
          attachment.content_type,
          attachment.size_bytes,
          attachment.content_disposition,
          attachment.content_id,
          attachment.mime_part_index,
          attachment.text_content,
          attachment.text_extraction_status,
          attachment.storage_key,
          attachment.created_at
        )
      ),
    ]

    await env.DB.batch(statements)
  },
} satisfies ExportedHandler<Env>

// --- HTTP Handlers ---

async function handleGetCode(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const timeoutSec = Math.min(parseInt(url.searchParams.get('timeout') ?? '30'), 55)
  const since = url.searchParams.get('since')
  const deadline = Date.now() + timeoutSec * 1000

  while (Date.now() < deadline) {
    let query = 'SELECT id, code, from_address, subject, body_text, body_html, received_at FROM emails WHERE mailbox = ?'
    const params: string[] = [authorizedMailbox]

    if (since) {
      query += ' AND received_at > ?'
      params.push(since)
    }

    query += ' ORDER BY received_at DESC LIMIT 50'

    const rows = await env.DB.prepare(query).bind(...params).all<{
      id: string
      code: string | null
      from_address: string
      subject: string
      body_text: string
      body_html: string
      received_at: string
    }>()

    for (const row of rows.results ?? []) {
      const resolvedCode = resolveEmailCode(row as Record<string, unknown>)
      if (!resolvedCode) continue

      return Response.json({
        id: (row as { id: string }).id,
        code: resolvedCode,
        from: (row as { from_address: string }).from_address,
        subject: (row as { subject: string }).subject,
        received_at: (row as { received_at: string }).received_at,
      })
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  return Response.json({ code: null })
}

async function handleInbox(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0
  const direction = url.searchParams.get('direction')
  const query = url.searchParams.get('query')?.trim()

  let sql = `
    SELECT id, mailbox, from_address, from_name, subject, body_text, body_html, code,
           direction, status, provider, received_at, has_attachments, attachment_count
    FROM emails WHERE mailbox = ?`
  const params: (string | number)[] = [authorizedMailbox]

  if (direction === 'inbound' || direction === 'outbound') {
    sql += ' AND direction = ?'
    params.push(direction)
  }

  if (query) {
    const pattern = `%${escapeLike(query)}%`
    sql += " AND (subject LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')"
    params.push(pattern, pattern, pattern, pattern, pattern)
  }

  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = await env.DB.prepare(sql).bind(...params).all()

  return Response.json({
    emails: rows.results.map((row) => toInboxEmail(row as Record<string, unknown>)),
  })
}

async function handleGetEmail(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  let row = await env.DB.prepare('SELECT * FROM emails WHERE id = ? AND mailbox = ?').bind(id, authorizedMailbox).first<{
    id: string
    mailbox: string
    from_address: string
    from_name: string
    to_address: string
    subject: string
    body_text: string
    body_html: string
    code: string | null
    headers: string
    metadata: string
    direction: 'inbound' | 'outbound'
    status: 'received' | 'sent' | 'failed' | 'queued'
    provider: string | null
    message_id: string | null
    has_attachments: number
    attachment_count: number
    attachment_names: string
    attachment_search_text: string
    raw_storage_key: string | null
    received_at: string
    created_at: string
  }>()

  if (!row) {
    const safeId = id.replace(/%/g, '\\%').replace(/_/g, '\\_')
    const matches = await env.DB.prepare("SELECT * FROM emails WHERE id LIKE ? ESCAPE '\\' AND mailbox = ? ORDER BY received_at DESC LIMIT 2").bind(`${safeId}%`, authorizedMailbox).all<{
      id: string
      mailbox: string
      from_address: string
      from_name: string
      to_address: string
      subject: string
      body_text: string
      body_html: string
      code: string | null
      headers: string
      metadata: string
      direction: 'inbound' | 'outbound'
      status: 'received' | 'sent' | 'failed' | 'queued'
      provider: string | null
      message_id: string | null
      has_attachments: number
      attachment_count: number
      attachment_names: string
      attachment_search_text: string
      raw_storage_key: string | null
      received_at: string
      created_at: string
    }>()

    if ((matches.results?.length ?? 0) > 1) {
      return Response.json({ error: `Ambiguous email id: ${id}` }, { status: 409 })
    }

    row = matches.results?.[0] ?? null
  }

  if (!row) return Response.json({ error: 'Email not found' }, { status: 404 })

  const attachments = await env.DB.prepare(
    'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
  ).bind(row.id).all<{
    id: string
    email_id: string
    filename: string
    content_type: string
    size_bytes: number | null
    content_disposition: string | null
    content_id: string | null
    mime_part_index: number
    text_content: string
    text_extraction_status: string
    storage_key: string | null
    created_at: string
  }>()

  return Response.json(
    toDetailEmail(
      row as unknown as Record<string, unknown>,
      attachments.results as Record<string, unknown>[],
    ),
  )
}

async function handleSend(request: Request, env: Env, authorizedMailbox: string): Promise<Response> {
  const chain = buildProviderChain(env)
  if (chain.length === 0) {
    return Response.json({ error: 'No email provider configured' }, { status: 503 })
  }

  const body = await request.json() as {
    from?: string
    to?: string[]
    subject?: string
    text?: string
    html?: string
    reply_to?: string
    cc?: string[]
    bcc?: string[]
    attachments?: Array<{ filename: string; content: string; content_type?: string }>
  }

  if (!body.from || !body.to?.length || !body.subject) {
    return Response.json({ error: 'Missing required fields: from, to, subject' }, { status: 400 })
  }
  if (!body.text && !body.html) {
    return Response.json({ error: 'Either text or html is required' }, { status: 400 })
  }

  const senderMailbox = normalizeMailbox(body.from)
  if (senderMailbox !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sendReq: SendRequest = {
    from: body.from,
    to: body.to,
    subject: body.subject,
    text: body.text,
    html: body.html,
    reply_to: body.reply_to,
    cc: body.cc,
    bcc: body.bcc,
    attachments: body.attachments,
  }

  let result: { id: string; provider: 'cloudflare' | 'resend' }
  try {
    result = await sendWithChain(chain, sendReq)
  } catch (err) {
    if (err instanceof UnsupportedFeatureError) {
      return Response.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof AllProvidersFailedError) {
      return Response.json({ error: err.message, attempts: err.attempts }, { status: 502 })
    }
    throw err
  }

  const now = new Date().toISOString()
  await env.DB.prepare(`
    INSERT INTO emails (
      id, mailbox, from_address, from_name, to_address, subject,
      body_text, body_html, code, headers, metadata, message_id,
      has_attachments, attachment_count, attachment_names, attachment_search_text,
      raw_storage_key, direction, status, provider, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', '{}', NULL, ?, ?, '', '', NULL, 'outbound', 'sent', ?, ?, ?)
  `).bind(
    result.id, authorizedMailbox, senderMailbox, parseFromName(body.from),
    body.to.join(', '), body.subject,
    (body.text ?? '').slice(0, 50000), (body.html ?? '').slice(0, 100000),
    body.attachments?.length ? 1 : 0,
    body.attachments?.length ?? 0,
    result.provider, now, now,
  ).run()

  return Response.json({ id: result.id, from: body.from, provider: result.provider })
}

async function handleSync(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z'
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  // Count total matching emails
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM emails WHERE mailbox = ? AND received_at > ?'
  ).bind(authorizedMailbox, since).first<{ total: number }>()
  const total = countRow?.total ?? 0

  // Get emails with full data
  const rows = await env.DB.prepare(`
    SELECT * FROM emails
    WHERE mailbox = ? AND received_at > ?
    ORDER BY received_at ASC
    LIMIT ? OFFSET ?
  `).bind(authorizedMailbox, since, limit, offset).all()

  // For each email, fetch attachments
  const emails = []
  for (const row of rows.results) {
    const r = row as Record<string, unknown>
    const attachments = await env.DB.prepare(
      'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
    ).bind(r.id).all()

    emails.push(toDetailEmail(r, attachments.results as Record<string, unknown>[]))
  }

  return Response.json({
    emails,
    total,
    has_more: offset + limit < total,
  })
}

function toInboxEmail(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    mailbox: row.mailbox as string,
    from_address: row.from_address as string,
    from_name: (row.from_name as string) ?? '',
    subject: (row.subject as string) ?? '',
    code: resolveEmailCode(row),
    direction: row.direction as string,
    status: row.status as string,
    provider: (row.provider as string | null) ?? null,
    received_at: row.received_at as string,
    has_attachments: Boolean(row.has_attachments),
    attachment_count: Number(row.attachment_count ?? 0),
  }
}

function toDetailEmail(row: Record<string, unknown>, attachments: Record<string, unknown>[]) {
  return {
    id: row.id as string,
    mailbox: row.mailbox as string,
    from_address: row.from_address as string,
    from_name: (row.from_name as string) ?? '',
    to_address: row.to_address as string,
    subject: (row.subject as string) ?? '',
    body_text: (row.body_text as string) ?? '',
    body_html: (row.body_html as string) ?? '',
    code: resolveEmailCode(row),
    headers: safeJsonParse(row.headers as string, {}),
    metadata: safeJsonParse(row.metadata as string, {}),
    direction: row.direction as string,
    status: row.status as string,
    provider: (row.provider as string | null) ?? null,
    message_id: (row.message_id as string) ?? null,
    has_attachments: Boolean(row.has_attachments),
    attachment_count: Number(row.attachment_count ?? 0),
    attachment_names: (row.attachment_names as string) ?? '',
    attachment_search_text: (row.attachment_search_text as string) ?? '',
    raw_storage_key: (row.raw_storage_key as string) ?? null,
    received_at: row.received_at as string,
    created_at: row.created_at as string,
    attachments: attachments.map(toAttachmentRecord),
  }
}

function toAttachmentRecord(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    email_id: row.email_id as string,
    filename: row.filename as string,
    content_type: row.content_type as string,
    size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    content_disposition: (row.content_disposition as string) ?? null,
    content_id: (row.content_id as string) ?? null,
    mime_part_index: Number(row.mime_part_index),
    text_content: (row.text_content as string) ?? '',
    text_extraction_status: row.text_extraction_status as string,
    storage_key: (row.storage_key as string) ?? null,
    downloadable: Boolean(row.storage_key),
    created_at: row.created_at as string,
  }
}

function resolveEmailCode(row: Record<string, unknown>): string | null {
  return extractEmailCode({
    subject: (row.subject as string) ?? '',
    bodyText: (row.body_text as string) ?? '',
    bodyHtml: (row.body_html as string) ?? '',
    storedCode: (row.code as string | null) ?? null,
  })
}

function parseFromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1]!.trim() : ''
}

function normalizeMailbox(value: string): string {
  const match = value.match(/<([^>]+)>/)
  const mailbox = (match?.[1] ?? value).trim().toLowerCase()
  return mailbox
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  const length = Math.max(aBytes.length, bBytes.length)
  let diff = aBytes.length ^ bBytes.length

  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }

  return diff === 0
}

function getMailboxTokens(env: Env): { tokens?: Map<string, string>; response?: Response } {
  if (env.AUTH_TOKENS_JSON) {
    try {
      const parsed = JSON.parse(env.AUTH_TOKENS_JSON) as Record<string, unknown>
      const tokens = new Map<string, string>()
      for (const [mailbox, token] of Object.entries(parsed)) {
        if (typeof token !== 'string' || !token.trim()) {
          return { response: Response.json({ error: 'AUTH_TOKENS_JSON is invalid' }, { status: 503 }) }
        }
        tokens.set(normalizeMailbox(mailbox), token)
      }
      if (tokens.size === 0) {
        return { response: Response.json({ error: 'AUTH_TOKENS_JSON is invalid' }, { status: 503 }) }
      }
      return { tokens }
    } catch {
      return { response: Response.json({ error: 'AUTH_TOKENS_JSON is invalid' }, { status: 503 }) }
    }
  }

  if (env.AUTH_TOKEN && env.MAILBOX) {
    return { tokens: new Map([[normalizeMailbox(env.MAILBOX), env.AUTH_TOKEN]]) }
  }

  if (env.AUTH_TOKEN && !env.MAILBOX) {
    return { response: Response.json({ error: 'MAILBOX not configured' }, { status: 503 }) }
  }

  return { response: Response.json({ error: 'AUTH_TOKEN not configured' }, { status: 503 }) }
}

function requireAuthorizedMailbox(request: Request, env: Env): { mailbox: string } | { response: Response } {
  const configured = getMailboxTokens(env)
  if (configured.response) return { response: configured.response }

  const token = extractBearerToken(request)
  if (!token) {
    return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  let matchedMailbox: string | null = null
  for (const [mailbox, expectedToken] of configured.tokens!) {
    if (timingSafeEqual(token, expectedToken)) {
      if (matchedMailbox) {
        return { response: Response.json({ error: 'Duplicate mailbox tokens are not allowed' }, { status: 503 }) }
      }
      matchedMailbox = mailbox
    }
  }

  if (!matchedMailbox) {
    return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  return { mailbox: matchedMailbox }
}
