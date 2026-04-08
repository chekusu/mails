import { loadConfig, getConfigValue, setConfigValue, resolveApiKey, CONFIG_FILE } from '../../core/config.js'

function isSensitiveConfigKey(key: string): boolean {
  return /(?:^|_)(?:token|key|secret)(?:$|_)/i.test(key)
}

function maskValue(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function formatDisplayValue(key: string, value: string): string {
  return isSensitiveConfigKey(key) ? maskValue(value) : value
}

export async function configCommand(args: string[]) {
  const subcommand = args[0]

  switch (subcommand) {
    case 'set': {
      const key = args[1]
      const value = args[2]
      if (!key || !value) {
        console.error('Usage: mails config set <key> <value>')
        process.exit(1)
      }
      setConfigValue(key, value)
      console.log(`Set ${key} = ${formatDisplayValue(key, value)}`)

      // When api_key is set, auto-resolve mailbox from /v1/me
      if (key === 'api_key' && value.startsWith('mk_')) {
        const mailbox = await resolveApiKey(value)
        if (mailbox) {
          console.log(`Resolved mailbox: ${mailbox}`)
          console.log(`Set default_from = ${mailbox}`)
        }
      }

      // When worker_url is set, switch to remote storage
      if (key === 'worker_url') {
        setConfigValue('storage_provider', 'remote')
      }
      break
    }

    case 'get': {
      const key = args[1]
      if (!key) {
        console.error('Usage: mails config get <key>')
        process.exit(1)
      }
      const value = getConfigValue(key)
      if (value !== undefined) {
        console.log(value)
      } else {
        console.error(`Key "${key}" not set`)
        process.exit(1)
      }
      break
    }

    case 'path': {
      console.log(CONFIG_FILE)
      break
    }

    default: {
      const config = loadConfig()
      const displayConfig = Object.fromEntries(
        Object.entries(config).map(([key, value]) => {
          if (typeof value !== 'string') return [key, value]
          return [key, formatDisplayValue(key, value)]
        })
      )
      console.log(JSON.stringify(displayConfig, null, 2))
      break
    }
  }
}
