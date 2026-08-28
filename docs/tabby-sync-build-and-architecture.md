# Tabby Sync: architecture, build and operation

## Product behaviour

Tabby Sync keeps Tabby's terminal/session engine and adds a Termius-inspired operational shell:

- **Vaults** opens as a full-width host and group browser. A single click selects a host, a double click connects, and the pencil opens a fixed 330 px editor flush with the right edge. Clicking the free host canvas closes the editor and returns the grid to full width.
- **SFTP** is a standalone two-pane workspace. Either pane can be Local or any saved SSH profile. The divider is resizable and remembered. The workspace supports navigation, filtering, upload/download, folder creation, rename, delete with confirmation, and cross-pane copy.
- The fixed 330 px **command shelf** exists only beside an active local or SSH terminal. Categories and commands have full create/edit/delete controls; commands can be copied or sent to the active terminal.
- The **AI command chat** is a separate bottom row below the terminal. It never overlays terminal content. Context is collected only after Ask, and a suggested command is not run without an explicit Run click.
- The terminal AI button can regenerate an unsuitable result while retaining the original request and avoiding the previous command. Plain `cd ` input receives keyboard- and mouse-driven directory suggestions from the local filesystem or the authenticated SSH SFTP channel without involving the LLM.
- **Command history** records completed command lines from local and SSH sessions, filters obvious credential input, and is visible under Vaults → Logs and in the command shelf.
- **Voice input** runs the bundled GigaAM v3 E2E CTC Q4 model locally. Audio and transcription are not uploaded by the voice feature.

## PostgreSQL architecture

The Electron renderer converts local state into versioned sync entities. The Electron main process owns the PostgreSQL connection and exposes only narrow IPC operations; the database password never returns to the renderer.

The idempotent migration is [`db/migrations/20260824_tabby_postgres_sync.sql`](../db/migrations/20260824_tabby_postgres_sync.sql). It creates:

- `tabby_sync.objects` for global settings, profiles, profile groups, command topics and commands;
- `tabby_sync.conflicts` for the losing payload of every real conflict;
- soft-delete tombstones so an offline device cannot accidentally recreate a deleted object.

Conflict storage is idempotent and bounded: PostgreSQL fingerprints each distinct local/remote payload pair, compacts legacy duplicates, retains at most 20 recovery versions per object, expires unresolved/resolved conflicts after 90/30 days, and removes tombstones after a 180-day offline-device grace period. Current synchronized objects are never pruned.

The first synchronization pulls an existing row before replacing a same-ID local object. Later changes use deterministic last-write-wins timestamps, while the losing local or remote payload is retained in `tabby_sync.conflicts`. Offline changes remain in local metadata and are retried every 30 seconds and on manual Synchronize.

Remote profile application preserves local password/passphrase fields that were deliberately omitted from PostgreSQL. Global settings are deep-merged so omitted local secrets and newer plugin defaults are not erased.

### Secret boundaries

- PostgreSQL password: operating-system keychain (`Tabby PostgreSQL sync`).
- LLM API key: operating-system keychain (`Tabby Sync AI assistant`).
- SSH credentials and private-key passphrases: Tabby vault/keychain.
- PostgreSQL host/database/user and sync bookkeeping: local bootstrap configuration, because a fresh device needs these values before it can reach the shared database.
- Vault master passphrase, database passwords, API keys and SSH secrets are never synchronized as plain JSON.

## Configure and run

1. Open **Settings → PostgreSQL sync**.
2. Enter Host, Port, Database, User and Password. Keep verified TLS enabled for a remote production database.
3. Click **Test & initialize**. The password is saved to the OS keychain, a missing database is created when the user has `CREATEDB`, and the idempotent schema migration is applied automatically.
4. Click **Synchronize** for the initial pull/push.
5. Leave **Automatically sync changes and retry after reconnecting** enabled for normal operation.
6. Configure an OpenAI-compatible endpoint under **Settings → AI assistant** if the bottom command chat is required.

The installed application is `/Applications/Tabby Sync.app`. Its user configuration is stored separately at:

```text
~/Library/Application Support/Tabby Sync
```

Replacing the `.app` does not delete that directory. The original `/Applications/Tabby.app` is a separate application and is not modified.

## Build on macOS Apple Silicon

From the repository root:

```sh
corepack yarn install
corepack yarn build
./node_modules/.bin/electron-builder --config electron-builder.yml --mac dir --arm64
```

The signed directory build is produced at:

```text
dist/mac-arm64/Tabby Sync.app
```

For an incremental plugin build during development:

```sh
./node_modules/.bin/webpack --config tabby-core/webpack.config.mjs
./node_modules/.bin/webpack --config tabby-settings/webpack.config.mjs
./node_modules/.bin/webpack --config tabby-ssh/webpack.config.mjs
./node_modules/.bin/webpack --config tabby-terminal/webpack.config.mjs
cp tabby-core/dist/index.js builtin-plugins/tabby-core/dist/index.js
cp tabby-settings/dist/index.js builtin-plugins/tabby-settings/dist/index.js
cp tabby-ssh/dist/index.js builtin-plugins/tabby-ssh/dist/index.js
cp tabby-terminal/dist/index.js builtin-plugins/tabby-terminal/dist/index.js
```

Before installing, quit only Tabby Sync and keep a recoverable copy of the previous application bundle:

```sh
osascript -e 'tell application "Tabby Sync" to quit'
mv "/Applications/Tabby Sync.app" "/tmp/Tabby Sync.previous.app"
ditto "dist/mac-arm64/Tabby Sync.app" "/Applications/Tabby Sync.app"
codesign --verify --deep --strict "/Applications/Tabby Sync.app"
open -a "/Applications/Tabby Sync.app"
```

## Main implementation areas

- `tabby-core/src/components/vaultsTab.*`: Vaults host/group browser, editor and operational sections.
- `tabby-core/src/components/commandSidebar.*`: snippets, command history, bottom AI chat and voice capture.
- `tabby-core/src/components/appRoot.*`: persistent Vault/SFTP actions and terminal-only panel layout.
- `tabby-ssh/src/components/sftpWorkspace*`: standalone two-pane SFTP workspace.
- `tabby-terminal/src/api/baseTerminalTab.component.ts`: safe command-history capture, AI regeneration state and cross-platform `cd` completion controller.
- `tabby-settings/src/services/postgresSync.service.ts`: entity projection, offline metadata, pull/apply and secret-preserving merge.
- `app/lib/postgresSync.ts`: PostgreSQL migration, transaction, conflict log, tombstones and keychain password lookup.
- `app/lib/llmAssistant.ts`: Ollama/Open WebUI request boundary, keychain API-key lookup and constrained context.
- `app/lib/voiceTranscription.ts`: local GigaAM process and private temporary audio lifecycle.
- `app/lib/app.ts`: narrow IPC handlers for sync, AI, voice and local SFTP operations.
- `extras/voice/`: bundled macOS arm64 runtime and Q4 model.
