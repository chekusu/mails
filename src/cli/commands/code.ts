import { waitForCode } from '../../core/receive.js'
import { loadConfig } from '../../core/config.js'

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        result[key] = value
        i++
      }
    }
  }
  return result
}

export async function codeCommand(args: string[]) {
  const opts = parseArgs(args)
  const config = loadConfig()
  const mailbox = opts.to ?? config.mailbox

  if (!mailbox) {
    console.error('No mailbox specified. Use --to <address> or set: mails config set mailbox <address>')
    process.exit(1)
  }

  const timeout = opts.timeout ? parseInt(opts.timeout) : 30
  // No default for since: when omitted, existing codes are matched too,
  // so a code that arrived just before the command was run is still found.
  const since = opts.since

  console.error(`Waiting for verification code to ${mailbox} (timeout: ${timeout}s)...`)

  const result = await waitForCode(mailbox, { timeout, since })

  if (result) {
    // Print only the code to stdout (for piping)
    console.log(result.code)
    // Details to stderr
    console.error(`From: ${result.from}`)
    console.error(`Subject: ${result.subject}`)
  } else {
    console.error('No code received within timeout.')
    process.exit(1)
  }
}
