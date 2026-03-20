import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getInbox, searchInbox, getEmail, downloadAttachment } from '../../core/receive.js'
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
      } else {
        result[key] = ''
      }
    } else if (!result._positional) {
      result._positional = arg
    }
  }
  return result
}

export async function inboxCommand(args: string[]) {
  const opts = parseArgs(args)

  // mails inbox <id> — show single email
  if (opts._positional) {
    let email
    try {
      email = await getEmail(opts._positional)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
      return
    }
    if (!email) {
      console.error(`Email not found: ${opts._positional}`)
      process.exit(1)
      return
    }
    console.log(`From: ${email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}`)
    console.log(`To: ${email.to_address}`)
    console.log(`Subject: ${email.subject}`)
    console.log(`Date: ${email.received_at}`)
    if (email.code) console.log(`Code: ${email.code}`)
    console.log(`Status: ${email.status}`)
    if (email.attachments?.length) {
      console.log('Attachments:')
      for (const attachment of email.attachments) {
        const size = attachment.size_bytes ?? attachment.size ?? 0
        console.log(`  ${attachment.id}  ${attachment.filename} (${attachment.content_type}, ${size} bytes)`)
      }
    }
    console.log('---')
    console.log(email.body_text || '(no text body)')

    // --save: download all attachments to disk
    if (opts.save !== undefined && email.attachments?.length) {
      const dir = opts.save || '.'
      await mkdir(dir, { recursive: true })
      for (const att of email.attachments) {
        try {
          const download = await downloadAttachment(att.id)
          if (!download) {
            console.error(`Attachment not found: ${att.id}`)
            continue
          }
          const dest = join(dir, download.filename)
          await writeFile(dest, Buffer.from(download.data))
          console.log(`Saved: ${dest}`)
        } catch (err) {
          console.error(`Failed to download ${att.filename}: ${(err as Error).message}`)
        }
      }
    }
    return
  }

  // mails inbox — list emails
  const config = loadConfig()
  const mailbox = opts.mailbox ?? config.mailbox
  if (!mailbox) {
    console.error('No mailbox specified. Use --mailbox <address> or set: mails config set mailbox <address>')
    process.exit(1)
  }

  const limit = opts.limit ? (parseInt(opts.limit, 10) || 20) : 20
  const direction = opts.direction === 'inbound' || opts.direction === 'outbound'
    ? opts.direction
    : undefined
  const query = opts.query?.trim()

  const emails = query
    ? await searchInbox(mailbox, { query, direction, limit })
    : await getInbox(mailbox, { limit, direction })

  if (emails.length === 0) {
    console.log(query ? `No emails found for query: ${query}` : 'No emails found.')
    return
  }

  const showFullId = opts['full-id'] !== undefined

  for (const email of emails) {
    const code = email.code ? ` [${email.code}]` : ''
    const clip = email.attachment_count ? ` +${email.attachment_count}att` : ''
    const from = email.from_name || email.from_address
    const displayId = showFullId ? email.id : email.id.slice(0, 8)
    console.log(`${displayId}  ${email.received_at.slice(0, 16)}  ${from.padEnd(24).slice(0, 24)}  ${email.subject.slice(0, 40)}${code}${clip}`)
  }
}
