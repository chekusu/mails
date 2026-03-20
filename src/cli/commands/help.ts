export function helpCommand() {
  console.log(`
mails - Email infrastructure for AI agents

Usage:
  mails <command> [options]

Commands:
  claim         Claim a @mails.dev mailbox for your agent
  send          Send an email
  inbox         List received emails
  code          Wait for a verification code
  sync          Sync emails from Worker to local storage
  config        View or modify configuration
  help          Show this help message
  version       Show version

Claim:
  mails claim <name>                    Claim name@mails.dev (max 10 per user)
                                        Opens browser for human approval.
                                        In headless mode, shows a device code
                                        for the human to enter at mails.dev.

Send:
  mails send --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --html <html>
  mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --body <text> --attach ./invoice.pdf

Inbox:
  mails inbox                           List recent emails
  mails inbox --full-id                 List recent emails with full IDs
  mails inbox --mailbox <address>       List emails for a specific mailbox
  mails inbox --query "reset password"  Search emails in a mailbox
  mails inbox --query "invoice" --direction inbound --limit 10
  mails inbox <id>                      Show email details
  mails inbox <id> --save               Download attachments to current directory
  mails inbox <id> --save ./downloads   Download attachments to a directory

Code:
  mails code --to <address>             Wait for a verification code
  mails code --to <address> --timeout 60

Sync:
  mails sync                            Sync emails from Worker to local storage
  mails sync --since 2026-03-01         Sync from specific date
  mails sync --from-scratch             Full re-sync (ignore last sync time)

Config:
  mails config                    Show current config
  mails config set <key> <value>  Set a config value
  mails config get <key>          Get a config value
  mails config path               Show config file path

Environment:
  MAILS_API_URL       Override API base URL (default: https://api.mails.dev)
  MAILS_CLAIM_URL     Override claim page URL (default: https://mails.dev)

https://mails.dev
`.trim())
}
