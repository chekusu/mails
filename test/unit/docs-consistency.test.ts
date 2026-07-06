/**
 * Docs ⇄ Code consistency guard.
 *
 * This suite exists to prevent the 13 classes of doc/code drift fixed in
 * task 54e3b35f from silently re-appearing. It is intentionally strict: it
 * FAILS if a command is added to one place but not the other, if the version
 * strings fall out of sync, or if a language switcher link goes missing.
 *
 * If this test fails, do not weaken it — fix the underlying drift.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const READMES = ['README.md', 'README.en.md', 'README.ja.md'] as const

/**
 * Canonical command names routed by the CLI (`src/cli/index.ts`).
 * Extracted from `case '<name>':` labels, excluding flag aliases
 * (`--help`, `-h`, `--version`, `-v`) and the bare `undefined` case.
 */
function parseCliCommands(): Set<string> {
  const src = read('src/cli/index.ts')
  const cmds = new Set<string>()
  // Only word-shaped labels; flags start with '-' and are ignored on purpose.
  for (const m of src.matchAll(/case\s+'([a-z][a-z0-9-]*)'\s*:/g)) {
    const name = m[1]
    if (!name.startsWith('-')) cmds.add(name)
  }
  return cmds
}

/**
 * Command names advertised in the `Commands:` section of the help text
 * (`src/cli/commands/help.ts`). The section runs from the `Commands:` header
 * to the next blank line; each entry's first token is the command name.
 */
function parseHelpCommands(): Set<string> {
  const src = read('src/cli/commands/help.ts')
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /^\s*Commands:\s*$/.test(l))
  expect(start).toBeGreaterThanOrEqual(0) // help text must have a Commands: section
  const cmds = new Set<string>()
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) break // section ends at first blank line
    const m = line.match(/^\s+([a-z][a-z0-9-]*)\b/)
    if (m) cmds.add(m[1])
  }
  return cmds
}

const sorted = (s: Iterable<string>) => [...s].sort()

describe('docs-consistency: help ⇄ CLI router', () => {
  test('help Commands list exactly matches the CLI switch branches', () => {
    const help = parseHelpCommands()
    const cli = parseCliCommands()

    // Guard against parser regressions producing empty sets.
    expect(help.size).toBeGreaterThan(0)
    expect(cli.size).toBeGreaterThan(0)

    // Set equality: any command present in one but not the other fails here.
    // (Missing command -> help subset shrinks; extra command -> superset grows.)
    expect(sorted(help)).toEqual(sorted(cli))
  })
})

describe('docs-consistency: README commands ⇄ CLI router', () => {
  const cli = parseCliCommands()

  for (const file of READMES) {
    test(`every 'mails <cmd>' in ${file} is a real CLI command`, () => {
      const content = read(file)
      // \bmails avoids matching the "mails" tail of "emails"; capture the token.
      const used = new Set<string>()
      for (const m of content.matchAll(/\bmails\s+([a-z][a-z0-9-]*)/g)) {
        used.add(m[1])
      }
      expect(used.size).toBeGreaterThan(0) // README should document some commands

      const unknown = [...used].filter((c) => !cli.has(c))
      expect(unknown).toEqual([]) // any documented-but-unrouted command fails
    })
  }
})

describe('docs-consistency: version alignment', () => {
  test('package.json, src/version.ts and worker default response agree', () => {
    const pkgVersion = JSON.parse(read('package.json')).version as string
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/)

    const versionTs = read('src/version.ts')
    const cliMatch = versionTs.match(/CLI_VERSION\s*=\s*'([^']+)'/)
    expect(cliMatch).not.toBeNull()
    const cliVersion = cliMatch![1]

    const workerSrc = read('worker/src/index.ts')
    const workerMatch = workerSrc.match(
      /name:\s*'mails-worker'\s*,\s*version:\s*'([^']+)'/
    )
    expect(workerMatch).not.toBeNull()
    const workerVersion = workerMatch![1]

    expect(cliVersion).toBe(pkgVersion)
    expect(workerVersion).toBe(pkgVersion)
  })
})

describe('docs-consistency: README language switchers', () => {
  /**
   * Locate the single language-switcher line — the one row that names all
   * three languages (English / 日本語 / 中文).
   */
  function switcherLine(file: string): string {
    const matches = read(file)
      .split('\n')
      .filter(
        (l) => l.includes('English') && l.includes('日本語') && l.includes('中文')
      )
    expect(matches.length).toBe(1) // exactly one switcher row per file
    return matches[0]
  }

  for (const file of READMES) {
    const others = READMES.filter((f) => f !== file)
    test(`${file} switcher links to the other two languages (${others.join(', ')})`, () => {
      const line = switcherLine(file)
      for (const other of others) {
        // "README.md" is not a substring of "README.en.md"/"README.ja.md",
        // so these membership checks are unambiguous.
        expect(line).toContain(other)
      }
    })
  }
})
