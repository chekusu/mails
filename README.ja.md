# mails

AIエージェント向けのメールインフラ。プログラムでメールの送受信ができます。

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)

[English](https://github.com/chekusu/mails/blob/main/README.md) | [中文](https://github.com/chekusu/mails/blob/main/README.zh.md)

## 仕組み

```
                        送信                                        受信

  Agent                                               外部送信者
    |                                                   |
    |  mails send --to user@example.com                 |  agent@mails.dev にメール送信
    |                                                   |
    v                                                   v
+--------+                                    +-------------------+
|  CLI   |                                    | Cloudflare Email  |
|  /SDK  |                                    |     Routing       |
+--------+                                    +-------------------+
    |                                                   |
    |  /v1/send                                         |  email() handler
    |  /api/send                                        |
    v                                                   v
+-----------------------------------------------------------+
|                       Worker                              |
|                                                           |
|  provider チェーン：Cloudflare Email Service → Resend     |
|                                                           |
|  mails.dev（ホスティング）    or   自前デプロイ              |
|  +-----------------------------------------+              |
|  |  +----------+    +----------------+     |  +---------+ |
|  |  |  db9.ai  |    |  fs9（ファイル） |     |  |   D1    | |
|  |  | 全文検索  |    | （添付保存）    |     |  | （保存） | |
|  |  | 高度検索  |    +----------------+     |  +---------+ |
|  |  +----------+                           |              |
|  +-----------------------------------------+              |
+-----------------------------------------------------------+
          |                           |
   CLI/SDKで問い合わせ          mails sync
   （remote provider）      （ローカルに取得）
          |                           |
          v                     +-----+------+
       Agent                    |            |
                          +---------+  +-----------+
                          | SQLite  |  |  db9.ai   |
                          |（ローカル）|  |（クラウド） |
                          +---------+  +-----------+
                          オフライン    全文検索
                          バックアップ  高度なフィルター
```

## 特徴

- **メール送信** — プロバイダチェーン：Cloudflare Email Service（ネイティブ `env.EMAIL.send()` バインディング、パブリックベータ）と Resend のフォールバック。デフォルト順序 `cloudflare,resend`、`EMAIL_PROVIDERS` で上書き可能
- **メール受信** — Cloudflare Email Routing Worker経由
- **受信箱検索** — キーワードで件名、本文、送信者、認証コードを検索
- **認証コード自動抽出** — メールから認証コードを自動検出（英/中/日/韓対応）
- **添付ファイル** — CLIの `--attach` またはSDKで送信、MIME添付ファイルの受信・解析
- **ストレージプロバイダー** — ローカルSQLite、[db9.ai](https://db9.ai)クラウドPostgreSQL、またはリモートWorker API
- **プロバイダ可視化** — `/api/send` レスポンスと `/api/inbox` の outbound 行に `provider` フィールド（`cloudflare`/`resend`）が含まれ、実際にどちらが配信したか確認できる
- **ゼロランタイム依存** — プロバイダは全て Workers バインディングまたは `fetch()` を直接使用、SDK なし
- **ホスティングサービス** — `mails claim` で無料 `@mails.dev` メールアドレス取得
- **セルフホスト** — 独自Workerデプロイ、メールボックス単位の token 認証

## インストール

```bash
npm install -g mails
# or
bun install -g mails
# or use directly
npx mails
```

CLI は最大 24 時間に 1 回 npm を確認し、新しいバージョンがある場合は stderr に更新通知を表示します。`MAILS_NO_UPDATE_CHECK=1` で無効化できます。

## クイックスタート

### ホスティングモード (mails.dev)

```bash
mails claim myagent                  # myagent@mails.dev を無料で取得
mails send --to user@example.com --subject "Hello" --body "World"  # 月100通無料
mails inbox                          # 受信箱を確認
mails inbox --query "password"       # メール検索
mails code --to myagent@mails.dev    # 認証コードを待機
```

Resendキー不要 — ホスティングユーザーは月100通無料。無制限送信は自分のキーを設定：`mails config set resend_api_key re_YOUR_KEY`

### セルフホストモード

```bash
cd worker && wrangler deploy             # 独自Workerをデプロイ
# 送信プロバイダを最低1つ設定：
wrangler secret put RESEND_API_KEY       # オプションA：Resend
#   オプションB：Cloudflare Email Service（パブリックベータ）— wrangler.toml に追加：
#   [[send_email]]
#   name = "EMAIL"
# 両方設定時、デフォルトの優先順位は cloudflare → resend。
# 順序の強制 / 片方無効化：
#   wrangler secret put EMAIL_PROVIDERS   # 例: "resend" または "cloudflare,resend"
#
# 単一メールボックス:
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# 複数メールボックス:
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_MAILBOX_TOKEN
mails config set mailbox agent@yourdomain.com
mails send --to user@example.com --subject "Hello" --body "Hi"  # Worker経由で送信
mails inbox                              # Worker APIに問い合わせ
mails sync                               # メールをローカルSQLiteにダウンロード
```

## CLIリファレンス

### claim

```bash
mails claim <name>                   # name@mails.dev を取得（ユーザーあたり最大10個）
```

### send

```bash
mails send --to <email> --subject <subject> --body <text>
mails send --to <email> --subject <subject> --html "<h1>Hello</h1>"
mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
mails send --to <email> --subject "Report" --body "See attached" --attach report.pdf
```

### inbox

```bash
mails inbox                                  # 最近のメール一覧
mails inbox --mailbox agent@test.com         # 特定のメールボックス
mails inbox --query "password reset"         # 全文検索（関連性順）
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <id>                             # メール詳細 + 添付ファイル

# 高度なフィルター（mails.dev ホスティング / db9）
mails inbox --has-attachments                # 添付ファイル付きのみ
mails inbox --attachment-type pdf            # 添付ファイルの種類で絞り込み
mails inbox --from github.com               # 送信者で絞り込み
mails inbox --since 2026-03-01 --until 2026-03-20  # 期間指定
mails inbox --header "X-Mailer:sendgrid"    # メールヘッダーで絞り込み

# 自由に組み合わせ可能
mails inbox --from github.com --has-attachments --since 2026-03-13
mails inbox --query "deploy" --attachment-type log --direction inbound
```

### stats

```bash
mails stats senders                          # 送信者の頻度ランキング
```

### code

```bash
mails code --to agent@test.com              # 認証コード待機（デフォルト30秒）
mails code --to agent@test.com --timeout 60 # タイムアウト指定
```

認証コードはstdoutに出力されるため、パイプで簡単に連携できます：`CODE=$(mails code --to agent@test.com)`

### config

```bash
mails config                    # 設定をすべて表示
mails config set <key> <value>  # 値を設定
mails config get <key>          # 値を取得
```

### sync

```bash
mails sync                              # Workerからローカルストレージにメールを同期
mails sync --since 2026-03-01           # 指定日からの同期
mails sync --from-scratch               # フル再同期
```

Worker（ホスティングまたはセルフホスト）からローカルSQLiteにメールをプル。オフラインアクセスやローカルバックアップに便利。

## SDK

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// 送信
const result = await send({
  to: 'user@example.com',
  subject: 'Hello',
  text: 'World',
})

// 添付ファイル付き送信
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// 受信箱一覧
const emails = await getInbox('agent@mails.dev', { limit: 10 })

// 受信箱検索（全文検索、関連性順）
const results = await searchInbox('agent@mails.dev', {
  query: 'password reset',
  direction: 'inbound',
})

// 高度なフィルター（mails.dev ホスティング / db9）
const pdfs = await getInbox('agent@mails.dev', {
  has_attachments: true,
  attachment_type: 'pdf',
  since: '2026-03-01',
})

// 認証コード待機
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## Email Worker

`worker/` ディレクトリにはメール受信用のCloudflare Email Routing Workerが含まれています。

### セットアップ

```bash
cd worker
bun install
wrangler d1 create mails
# wrangler.toml を編集 — D1データベースIDを設定
wrangler d1 execute mails --file=schema.sql
wrangler deploy
```

デプロイ後、Cloudflare Email Routingでこのworkerにメールを転送するよう設定してください。

### Workerの認証設定

```bash
# 単一メールボックス:
#   MAILBOX=agent@yourdomain.com
#   AUTH_TOKEN=YOUR_MAILBOX_TOKEN
# 複数メールボックス:
#   AUTH_TOKENS_JSON={"agent@yourdomain.com":"token1","other@yourdomain.com":"token2"}
```

すべての `/api/*` エンドポイントに `Authorization: Bearer <mailbox-token>` が必要です。この token は `?to=`、取得対象メール、または送信時の `from` と一致するメールボックス用である必要があります。`/health` は常に公開されます。mailbox token が未設定のまま `/api/*` にアクセスすると `503` を返します。

### Worker API

| エンドポイント | 説明 |
|-------------|------|
| `GET /api/inbox?to=<addr>&limit=20` | メール一覧 |
| `GET /api/inbox?to=<addr>&query=<text>` | メール検索 |
| `GET /api/code?to=<addr>&timeout=30` | 認証コードのロングポーリング |
| `GET /api/email?id=<id>` | メール詳細（添付ファイル含む） |
| `POST /api/send` | プロバイダチェーン経由でメール送信（Cloudflare Email Service、Resend） |
| `GET /api/sync?to=<addr>&since=<iso>` | 増分メール同期（添付ファイル含む） |
| `GET /health` | ヘルスチェック（常に公開） |

## ストレージプロバイダー

CLIはストレージプロバイダーを自動検出します：
- 設定に `api_key` がある場合 → リモート（mails.devホスティング）
- 設定に `worker_url` がある場合 → リモート（セルフホストWorker）
- それ以外 → ローカルSQLite

### SQLite（デフォルト）

ローカルデータベース：`~/.mails/mails.db`。設定不要。

### db9.ai

AIエージェント向けクラウドPostgreSQL。全文検索と関連性ランキング、添付ファイル内容の検索、高度なフィルタリングに対応。

```bash
mails config set storage_provider db9
mails config set db9_token YOUR_TOKEN
mails config set db9_database_id YOUR_DB_ID
```

db9を使うと以下の機能が利用可能：
- **重み付きFTS** — 件名（最高優先）> 送信者 > 本文 > 添付ファイルテキスト
- **添付ファイルフィルター** — 種類別、名前別、添付の有無
- **送信者・期間フィルター** — `--from`、`--since`、`--until`
- **ヘッダー検索** — JSONB形式のメールヘッダーを検索
- **送信者統計** — 全送信者の頻度ランキング

### リモート（Worker API）

Worker HTTP APIに直接問い合わせます。`api_key` または `worker_url` が設定されている場合、自動的に有効になります。

## 設定キー

| キー | デフォルト | 説明 |
|-----|----------|------|
| `mailbox` | | 受信メールアドレス |
| `api_key` | | mails.devホスティングサービスAPIキー |
| `worker_url` | | セルフホストWorker URL |
| `worker_token` | | セルフホストWorker用の mailbox token |
| `resend_api_key` | | Resend APIキー |
| `default_from` | | デフォルト送信者アドレス |
| `storage_provider` | auto | `sqlite`、`db9`、`remote` |

## テスト

```bash
bun test              # ユニット + E2Eテスト（外部依存なし）
bun test:coverage     # カバレッジレポート付き
bun test:live         # ライブE2Eテスト（.env設定が必要）
bun test:all          # すべてのテスト（ライブE2E含む）
```

ユニットテスト198件 + E2Eテスト27件 = **225件のテスト**、全プロバイダーをカバー。

### プロバイダー別E2Eカバレッジ

|                           | SQLite | db9   | Remote (OSS) | Remote (Hosted) |
|---------------------------|--------|-------|--------------|-----------------|
| Save inbound email        | ✅     | ✅    | N/A          | N/A             |
| Save email + attachments  | ✅     | ✅    | N/A          | N/A             |
| Send → receive (real)     | ✅     | —     | ✅           | ✅              |
| Inbox list                | ✅     | ✅    | ✅           | ✅              |
| has_attachments flag      | ✅     | ✅    | ✅           | ✅              |
| Direction filter          | ✅     | ✅    | ✅           | ✅              |
| Pagination                | ✅     | ✅    | ✅           | ✅              |
| Email detail              | ✅     | ✅    | ✅           | ✅              |
| Attachment metadata       | ✅     | ✅    | ✅           | ✅              |
| Search                    | ✅     | ✅    | ✅           | ✅              |
| Attachment content search | ✅     | ✅    | —            | —               |
| Verification code         | ✅     | ✅    | ✅           | ✅              |
| Download attachment       | ✅     | ✅    | —            | ✅              |
| Save to disk (--save)     | ✅     | —     | —            | ✅              |
| Mailbox isolation         | ✅     | ✅    | —            | —               |
| Outbound recording        | ✅     | —     | ✅           | N/A             |
| Send via Worker (/api/send)| —     | —     | ✅           | —               |
| Sync to local             | —      | —     | ✅           | —               |

## ライセンス

MIT
