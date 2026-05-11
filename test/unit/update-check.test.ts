import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkForCliUpdate, isNewerVersion } from '../../src/cli/update-check'

const tempDirs: string[] = []

function tempCacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mails-update-check-'))
  tempDirs.push(dir)
  return join(dir, 'update-check.json')
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  mock.restore()
})

describe('CLI update check', () => {
  test('compares semver versions', () => {
    expect(isNewerVersion('1.5.6', '1.5.5')).toBe(true)
    expect(isNewerVersion('1.6.0', '1.5.9')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('1.5.5', '1.5.5')).toBe(false)
    expect(isNewerVersion('1.5.4', '1.5.5')).toBe(false)
    expect(isNewerVersion('1.6.0-beta.2', '1.6.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.6.0', '1.6.0-beta.2')).toBe(true)
    expect(isNewerVersion('1.6.0-beta.2', '1.6.0')).toBe(false)
  })

  test('prints an update notice when the registry has a newer version', async () => {
    const cacheFile = tempCacheFile()
    const logs: string[] = []
    const fetchImpl = mock(async () => jsonResponse({ version: '1.6.0' }))

    await checkForCliUpdate({
      cacheFile,
      currentVersion: '1.5.5',
      env: {},
      fetchImpl,
      log: (message) => logs.push(message),
      now: 1_000,
    })

    expect(fetchImpl.mock.calls).toHaveLength(1)
    expect(logs).toEqual([
      'mails update available: v1.5.5 -> v1.6.0\nUpgrade this CLI: npm install -g mails@latest',
    ])

    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    expect(cache.latestVersion).toBe('1.6.0')
    expect(cache.notifiedVersion).toBe('1.6.0')
    expect(cache.notifiedAt).toBe(1_000)
  })

  test('uses a fresh cache without hitting the registry', async () => {
    const cacheFile = tempCacheFile()
    const logs: string[] = []
    const fetchImpl = mock(async () => {
      throw new Error('should not fetch')
    })

    writeFileSync(cacheFile, JSON.stringify({
      checkedAt: 1_000,
      latestVersion: '1.6.0',
    }))

    await checkForCliUpdate({
      cacheFile,
      currentVersion: '1.5.5',
      env: {},
      fetchImpl,
      log: (message) => logs.push(message),
      now: 2_000,
    })

    expect(fetchImpl.mock.calls).toHaveLength(0)
    expect(logs).toEqual([
      'mails update available: v1.5.5 -> v1.6.0\nUpgrade this CLI: npm install -g mails@latest',
    ])

    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    expect(cache.notifiedVersion).toBe('1.6.0')
    expect(cache.notifiedAt).toBe(2_000)
  })

  test('does not repeat the same notice within a day', async () => {
    const cacheFile = tempCacheFile()
    const logs: string[] = []
    const fetchImpl = mock(async () => {
      throw new Error('should not fetch')
    })

    writeFileSync(cacheFile, JSON.stringify({
      checkedAt: 1_000,
      latestVersion: '1.6.0',
      notifiedAt: 1_500,
      notifiedVersion: '1.6.0',
    }))

    await checkForCliUpdate({
      cacheFile,
      currentVersion: '1.5.5',
      env: {},
      fetchImpl,
      log: (message) => logs.push(message),
      now: 2_000,
    })

    expect(fetchImpl.mock.calls).toHaveLength(0)
    expect(logs).toEqual([])
  })

  test('skips checks in CI or when disabled', async () => {
    for (const env of [{ CI: 'true' }, { MAILS_NO_UPDATE_CHECK: '1' }]) {
      const cacheFile = tempCacheFile()
      const fetchImpl = mock(async () => jsonResponse({ version: '1.6.0' }))

      await checkForCliUpdate({
        cacheFile,
        currentVersion: '1.5.5',
        env,
        fetchImpl,
        log: () => {},
        now: 1_000,
      })

      expect(fetchImpl.mock.calls).toHaveLength(0)
      expect(existsSync(cacheFile)).toBe(false)
    }
  })
})
