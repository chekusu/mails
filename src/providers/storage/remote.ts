import type { AttachmentDownload, Email, EmailQueryOptions, EmailSearchOptions, StorageProvider } from '../../core/types.js'

interface RemoteProviderOptions {
  /** Worker API base URL */
  url: string
  /** Mailbox address for query scoping */
  mailbox: string
  /** API key (for mails.dev hosted /v1/* endpoints). If set, uses /v1/* paths. */
  apiKey?: string
  /** Auth token (api_key or worker_token). Sent as Bearer header. For self-hosted /api/* this should be the mailbox token. */
  token?: string
}

export function createRemoteProvider(options: RemoteProviderOptions): StorageProvider {
  const { url, mailbox, apiKey, token } = options
  const useAuthApi = !!apiKey
  const inboxPageSize = 100
  const maxInboxPagesForIdResolution = 10

  async function apiFetch(path: string, params?: Record<string, string | number>): Promise<Response> {
    const endpoint = new URL(path, url)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) endpoint.searchParams.set(k, String(v))
      }
    }
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return fetch(endpoint.toString(), { headers })
  }

  // Hosted endpoints (/v1/*) don't need ?to= — api_key is scoped to mailbox.
  // Self-hosted endpoints (/api/*) still need ?to= and a mailbox token.
  function inboxPath() { return useAuthApi ? '/v1/inbox' : '/api/inbox' }
  function codePath() { return useAuthApi ? '/v1/code' : '/api/code' }
  function emailPath() { return useAuthApi ? '/v1/email' : '/api/email' }
  function attachmentPath() { return useAuthApi ? '/v1/attachment' : '/api/attachment' }

  function withMailbox(params: Record<string, string | number>): Record<string, string | number> {
    if (!useAuthApi) {
      params.to = mailbox
    }
    return params
  }

  async function fetchEmailById(id: string): Promise<Email | null> {
    const res = await apiFetch(emailPath(), { id })
    if (!res.ok) {
      if (res.status === 404) return null
      const data = await res.json() as { error?: string }
      throw new Error(`API error: ${data.error ?? res.statusText}`)
    }
    return await res.json() as Email
  }

  async function resolveEmailIdPrefix(prefix: string): Promise<string | null> {
    let match: string | null = null

    for (let page = 0; page < maxInboxPagesForIdResolution; page++) {
      const res = await apiFetch(inboxPath(), withMailbox({
        limit: inboxPageSize,
        offset: page * inboxPageSize,
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }

      const data = await res.json() as { emails: Email[] }
      const emails = data.emails ?? []

      for (const email of emails) {
        if (!email.id?.startsWith(prefix)) continue
        if (match && match !== email.id) {
          throw new Error(`Ambiguous email id: ${prefix}`)
        }
        match = email.id
      }

      if (emails.length < inboxPageSize) break
    }

    return match
  }

  return {
    name: 'remote',

    async init() {},

    async saveEmail() {
      throw new Error('Remote provider is read-only. Emails are received by the Worker.')
    },

    async getEmails(_mailbox, options) {
      const res = await apiFetch(inboxPath(), withMailbox({
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
        ...(options?.direction ? { direction: options.direction } : {}),
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { emails: Email[] }
      return data.emails
    },

    async searchEmails(_mailbox, options) {
      const res = await apiFetch(inboxPath(), withMailbox({
        query: options.query,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
        ...(options.direction ? { direction: options.direction } : {}),
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { emails: Email[] }
      return data.emails
    },

    async getEmail(id) {
      const direct = await fetchEmailById(id)
      if (direct || id.length >= 36) return direct

      const resolvedId = await resolveEmailIdPrefix(id)
      if (!resolvedId) return null

      return await fetchEmailById(resolvedId)
    },

    async getAttachment(id): Promise<AttachmentDownload | null> {
      const res = await apiFetch(attachmentPath(), { id })
      if (!res.ok) {
        if (res.status === 404) return null
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const contentDisposition = res.headers.get('Content-Disposition') ?? ''
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/)
      return {
        data: await res.arrayBuffer(),
        filename: filenameMatch?.[1] ?? 'download',
        contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
      }
    },

    async getCode(_mailbox, options) {
      const res = await apiFetch(codePath(), withMailbox({
        timeout: options?.timeout ?? 30,
        ...(options?.since ? { since: options.since } : {}),
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { code: string | null; from?: string; subject?: string }
      if (!data.code) return null
      return { code: data.code, from: data.from ?? '', subject: data.subject ?? '' }
    },
  }
}
