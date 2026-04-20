import { CloudflareProvider, type CloudflareEmailBinding } from './cloudflare'
import { ResendProvider } from './resend'
import {
  AllProvidersFailedError,
  UnsupportedFeatureError,
  type EmailProvider,
  type ProviderName,
  type SendRequest,
  type SendResult,
} from './types'

export interface ChainEnv {
  EMAIL?: CloudflareEmailBinding
  RESEND_API_KEY?: string
  EMAIL_PROVIDERS?: string
}

const DEFAULT_ORDER: ProviderName[] = ['cloudflare', 'resend']

export function buildProviderChain(env: ChainEnv, fetchImpl: typeof fetch = fetch): EmailProvider[] {
  const order = parseOrder(env.EMAIL_PROVIDERS)
  const chain: EmailProvider[] = []
  for (const name of order) {
    if (name === 'cloudflare' && env.EMAIL && typeof env.EMAIL.send === 'function') {
      chain.push(new CloudflareProvider(env.EMAIL))
    } else if (name === 'resend' && env.RESEND_API_KEY) {
      chain.push(new ResendProvider(env.RESEND_API_KEY, fetchImpl))
    }
  }
  return chain
}

export async function sendWithChain(
  chain: EmailProvider[],
  req: SendRequest,
): Promise<SendResult> {
  if (chain.length === 0) {
    throw new Error('No email provider configured')
  }

  const attempts: Array<{ provider: ProviderName; error: string }> = []
  let anySupports = false

  for (const provider of chain) {
    if (!provider.supports(req)) continue
    anySupports = true
    try {
      return await provider.send(req)
    } catch (err) {
      attempts.push({
        provider: provider.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!anySupports) {
    const features: string[] = []
    if (req.attachments?.length) features.push('attachments')
    if (req.cc?.length) features.push('cc')
    if (req.bcc?.length) features.push('bcc')
    const hint = features.length > 0 ? ` (required: ${features.join(', ')})` : ''
    throw new UnsupportedFeatureError(
      `No provider in chain supports the request${hint}. Configured chain: ${chain.map(p => p.name).join(',') || 'empty'}`,
    )
  }

  throw new AllProvidersFailedError(attempts)
}

function parseOrder(raw: string | undefined): ProviderName[] {
  if (!raw) return DEFAULT_ORDER
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const valid: ProviderName[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (name === 'cloudflare' || name === 'resend') {
      if (!seen.has(name)) {
        valid.push(name)
        seen.add(name)
      }
    }
  }
  return valid.length > 0 ? valid : DEFAULT_ORDER
}
