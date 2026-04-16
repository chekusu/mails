const STRONG_NUMERIC_PATTERNS = [
  /(?:验证码|verification\s*code|認証コード|确认码|confirm(?:ation)?\s*code|security\s*code|passcode|pin\s*code|인증\s*코드|otp\s*code)\s*(?:is|=|:|：|-|\s)\s*(\d{4,8})\b/i,
  /\botp\s*(?:is|=|:|：|-)\s*(\d{4,8})\b/i,
  /\bcode\s*(?:is|=|:|：|-)\s*(\d{4,8})\b/i,
  /(?:^|[^\d])(\d{4,8})(?:[^\d]|$)/,
]

const ALPHANUMERIC_PATTERNS = [
  /(?:验证码|verification\s*code|認証コード|确认码|confirm(?:ation)?\s*code|security\s*code|passcode|pin\s*code|인증\s*코드|otp\s*code)\s*(?:is|=|:|：|-|\s)\s*([A-Za-z0-9]{4,8})\b/i,
  /\botp\s*(?:is|=|:|：|-)\s*([A-Za-z0-9]{4,8})\b/i,
  /\bcode\s*(?:is|=|:|：|-)\s*([A-Za-z0-9]{4,8})\b/i,
]

/**
 * Extract verification codes (4-8 digit/alphanumeric) from text.
 * Numeric body codes are preferred over weaker subject-like matches.
 */
export function extractCode(text: string): string | null {
  const normalized = normalizeText(text)
  if (!normalized) return null

  for (const pattern of STRONG_NUMERIC_PATTERNS) {
    const match = normalized.match(pattern)
    if (match?.[1]) return match[1]
  }

  for (const pattern of ALPHANUMERIC_PATTERNS) {
    const match = normalized.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
}

export function extractEmailCode(input: {
  subject?: string | null
  bodyText?: string | null
  bodyHtml?: string | null
  storedCode?: string | null
}): string | null {
  const bodyText = normalizeText(input.bodyText ?? '')
  const htmlText = normalizeText(htmlToText(input.bodyHtml ?? ''))
  const subject = normalizeText(input.subject ?? '')
  const storedCode = normalizeText(input.storedCode ?? '')

  return (
    extractCode(bodyText) ??
    (htmlText !== bodyText ? extractCode(htmlText) : null) ??
    extractCode(subject) ??
    extractCode(storedCode)
  )
}

export function htmlToText(html: string): string {
  if (!html) return ''

  const withoutTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|table|section|article|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  return normalizeText(decodeHtmlEntities(withoutTags))
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, token: string) => {
    const lower = token.toLowerCase()
    if (lower === 'nbsp') return ' '
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return '\''

    if (lower.startsWith('#x')) {
      const value = Number.parseInt(lower.slice(2), 16)
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity
    }

    if (lower.startsWith('#')) {
      const value = Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity
    }

    return entity
  })
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
