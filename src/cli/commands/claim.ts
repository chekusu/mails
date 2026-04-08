import { setConfigValue } from '../../core/config.js'
import { resolveHostedApiUrl } from '../../core/api-url.js'

const API_BASE = resolveHostedApiUrl()
const CLAIM_PAGE = process.env.MAILS_CLAIM_URL || 'https://mails.dev'
const POLL_INTERVAL = 2000

export async function claimCommand(args: string[]) {
  const name = args[0]

  if (!name) {
    console.error('Usage: mails claim <name>')
    console.error('Example: mails claim myagent  →  myagent@mails.dev')
    process.exit(1)
  }

  // 1. Create claim session
  const startRes = await fetch(`${API_BASE}/v1/claim/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  const startData = await startRes.json() as {
    session_id?: string
    device_code?: string
    error?: string
  }

  if (!startRes.ok) {
    console.error(`Error: ${startData.error}`)
    process.exit(1)
  }

  const { session_id, device_code } = startData
  const claimUrl = `${CLAIM_PAGE}?session=${session_id}&claim=${encodeURIComponent(name)}&source=cli`

  // 2. Try to open browser
  let browserOpened = false
  try {
    const { execSync } = await import('child_process')
    const platform = process.platform
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
    execSync(`${cmd} "${claimUrl}"`, { stdio: 'ignore', timeout: 3000 })
    browserOpened = true
  } catch {}

  // 3. Show info
  console.log('')
  if (browserOpened) {
    console.log(`  Claiming ${name}@mails.dev — confirm in your browser.`)
    console.log('')
    console.log(`  If the page didn't open: ${claimUrl}`)
  } else {
    // No browser (sandbox / SSH / headless)
    console.log(`  Claiming ${name}@mails.dev`)
    console.log('')
    console.log(`  Open this link to confirm:`)
    console.log('')
    console.log(`    ${claimUrl}`)
  }
  console.log('')

  // 4. Poll for result
  process.stdout.write('  Waiting...')

  const deadline = Date.now() + 10 * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))

    const pollRes = await fetch(`${API_BASE}/v1/claim/poll?session=${session_id}`)
    const pollData = await pollRes.json() as {
      status: string
      mailbox?: string
      api_key?: string
    }

    if (pollData.status === 'complete') {
      process.stdout.write('\n')
      console.log('')

      setConfigValue('mailbox', pollData.mailbox!)
      setConfigValue('api_key', pollData.api_key!)
      setConfigValue('default_from', pollData.mailbox!)
      setConfigValue('storage_provider', 'remote')

      console.log(`  Claimed: ${pollData.mailbox}`)
      console.log(`  API Key: ${pollData.api_key}`)
      console.log('')
      console.log('  Saved to ~/.mails/config.json')
      return
    }

    if (pollData.status === 'expired') {
      process.stdout.write('\n')
      console.error('  Session expired. Try again.')
      process.exit(1)
    }

    process.stdout.write('.')
  }

  process.stdout.write('\n')
  console.error('  Timeout. Try again.')
  process.exit(1)
}
