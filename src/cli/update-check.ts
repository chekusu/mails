import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../core/config.js'
import { CLI_VERSION } from '../version.js'

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/mails/latest'
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 750
const DEFAULT_CACHE_FILE = join(CONFIG_DIR, 'update-check.json')

type Env = Record<string, string | undefined>
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface UpdateCheckCache {
  checkedAt?: number
  latestVersion?: string
  notifiedAt?: number
  notifiedVersion?: string
}

interface CheckForCliUpdateOptions {
  cacheFile?: string
  cacheTtlMs?: number
  currentVersion?: string
  env?: Env
  fetchImpl?: FetchLike
  log?: (message: string) => void
  now?: number
  registryUrl?: string
  timeoutMs?: number
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease?: string
}

export async function checkForCliUpdate(options: CheckForCliUpdateOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  if (isUpdateCheckDisabled(env)) return

  const now = options.now ?? Date.now()
  const cacheFile = options.cacheFile ?? env.MAILS_UPDATE_CHECK_FILE ?? DEFAULT_CACHE_FILE
  const cacheTtlMs = options.cacheTtlMs ?? DAY_MS
  const currentVersion = normalizeVersion(options.currentVersion ?? CLI_VERSION)
  const log = options.log ?? ((message: string) => console.error(message))

  const cache = readCache(cacheFile)
  if (cache.checkedAt !== undefined && now - cache.checkedAt < cacheTtlMs) {
    const nextCache = maybeNotify(cache, currentVersion, now, env, log)
    if (nextCache !== cache) writeCache(cacheFile, nextCache)
    return
  }

  const latestVersion = await fetchLatestVersion({
    fetchImpl: options.fetchImpl ?? fetch,
    registryUrl: options.registryUrl ?? REGISTRY_LATEST_URL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })

  const nextCache: UpdateCheckCache = { ...cache, checkedAt: now }
  if (latestVersion) {
    nextCache.latestVersion = normalizeVersion(latestVersion)
  }

  writeCache(cacheFile, maybeNotify(nextCache, currentVersion, now, env, log))
}

export function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  const latest = parseVersion(latestVersion)
  const current = parseVersion(currentVersion)
  if (!latest || !current) return false

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (latest[key] !== current[key]) return latest[key] > current[key]
  }

  if (latest.prerelease === current.prerelease) return false
  if (!latest.prerelease && current.prerelease) return true
  if (latest.prerelease && !current.prerelease) return false

  return comparePrerelease(latest.prerelease!, current.prerelease!) > 0
}

function maybeNotify(
  cache: UpdateCheckCache,
  currentVersion: string,
  now: number,
  env: Env,
  log: (message: string) => void
): UpdateCheckCache {
  const latestVersion = cache.latestVersion
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return cache

  const alreadyNotifiedForLatest = cache.notifiedVersion === latestVersion
  const recentlyNotified = cache.notifiedAt !== undefined && now - cache.notifiedAt < DAY_MS
  if (alreadyNotifiedForLatest && recentlyNotified) return cache

  log(formatUpdateNotice(currentVersion, latestVersion, env))
  return {
    ...cache,
    notifiedAt: now,
    notifiedVersion: latestVersion,
  }
}

function formatUpdateNotice(currentVersion: string, latestVersion: string, env: Env): string {
  return [
    `mails update available: v${currentVersion} -> v${latestVersion}`,
    `Upgrade this CLI: ${upgradeCommand(env)}`,
  ].join('\n')
}

function upgradeCommand(env: Env): string {
  const userAgent = env.npm_config_user_agent ?? ''
  if (userAgent.startsWith('bun')) return 'bun install -g mails@latest'
  if (userAgent.startsWith('pnpm')) return 'pnpm add -g mails@latest'
  if (userAgent.startsWith('yarn')) return 'yarn global add mails@latest'
  return 'npm install -g mails@latest'
}

function isUpdateCheckDisabled(env: Env): boolean {
  return isTruthy(env.MAILS_NO_UPDATE_CHECK) || isTruthy(env.NO_UPDATE_NOTIFIER) || isTruthy(env.CI)
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

async function fetchLatestVersion(options: {
  fetchImpl: FetchLike
  registryUrl: string
  timeoutMs: number
}): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await options.fetchImpl(options.registryUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `mails/${CLI_VERSION}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) return null

    const data = await response.json() as { version?: unknown }
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function readCache(cacheFile: string): UpdateCheckCache {
  try {
    if (!existsSync(cacheFile)) return {}
    const data = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, unknown>
    return {
      checkedAt: typeof data.checkedAt === 'number' && Number.isFinite(data.checkedAt) ? data.checkedAt : undefined,
      latestVersion: typeof data.latestVersion === 'string' ? data.latestVersion : undefined,
      notifiedAt: typeof data.notifiedAt === 'number' && Number.isFinite(data.notifiedAt) ? data.notifiedAt : undefined,
      notifiedVersion: typeof data.notifiedVersion === 'string' ? data.notifiedVersion : undefined,
    }
  } catch {
    return {}
  }
}

function writeCache(cacheFile: string, cache: UpdateCheckCache) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dirname(cacheFile), 0o700)
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(cacheFile, 0o600)
  } catch {
    // Update checks must never affect the command the user actually ran.
  }
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function parseVersion(version: string): ParsedVersion | null {
  const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  const length = Math.max(leftParts.length, rightParts.length)

  for (let i = 0; i < length; i++) {
    const leftPart = leftParts[i]
    const rightPart = rightParts[i]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue

    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }

  return 0
}
