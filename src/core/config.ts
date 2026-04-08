import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'os'
import { join } from 'path'
import type { MailsConfig } from './types.js'
import { resolveHostedApiUrl } from './api-url.js'

const CONFIG_DIR = join(homedir(), '.mails')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: MailsConfig = {
  mode: 'hosted',
  domain: 'mails.dev',
  mailbox: '',
  send_provider: 'resend',
  storage_provider: 'sqlite',
}

function ensureDir() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_DIR, 0o700)
  }
}

export function loadConfig(): MailsConfig {
  ensureDir()
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG }
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8')
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
}

export function saveConfig(config: MailsConfig) {
  ensureDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_FILE, 0o600)
  }
}

export function getConfigValue(key: string): string | undefined {
  const config: Record<string, unknown> = { ...loadConfig() }
  return config[key] as string | undefined
}

export function setConfigValue(key: string, value: string) {
  const config: Record<string, unknown> = { ...loadConfig() }
  config[key] = value
  saveConfig(config as unknown as MailsConfig)
}

/**
 * Resolve mailbox + default_from from /v1/me given an api_key.
 * Saves to config if successful.
 */
export async function resolveApiKey(apiKey: string): Promise<string | null> {
  const apiUrl = resolveHostedApiUrl()
  try {
    const res = await fetch(`${apiUrl}/v1/me`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (!res.ok) return null
    const data = await res.json() as { mailbox?: string }
    if (data.mailbox) {
      setConfigValue('mailbox', data.mailbox)
      setConfigValue('default_from', data.mailbox)
      if (data.mailbox.endsWith('@mails.dev')) {
        setConfigValue('storage_provider', 'remote')
      }
      return data.mailbox
    }
  } catch {}
  return null
}

export { CONFIG_DIR, CONFIG_FILE }
