# PostgreSQL profiles and command library sync

This build adds two pages under **Settings**: **PostgreSQL sync** and **Command library**.

## Database setup

Enter a database name and a dedicated user. **Test & initialize** applies the idempotent migration automatically. If PostgreSQL reports that the requested database does not exist and the supplied user has `CREATEDB`, Tabby creates that database first; otherwise it reports the missing privilege explicitly. Database administrators may instead apply [`db/migrations/20260824_tabby_postgres_sync.sql`](../db/migrations/20260824_tabby_postgres_sync.sql) before enabling the feature. Once the database and tables exist, the runtime account no longer needs database/schema-creation permission.

In **PostgreSQL sync**, enter the host, port, database and user, enter the password, then choose **Test & initialize**. The password is sent directly to the Electron main process and stored in the OS keychain under `Tabby PostgreSQL sync`; it is not persisted in `config.yaml`, PostgreSQL rows, logs, or IPC responses. Use **Synchronize** to enable the feature and perform the initial pull.

The eye button retrieves the password from the OS keychain only after an explicit click. A keychain-loaded password is hidden automatically after 20 seconds and removed from the settings component's memory when hidden.

The configured port must expose the native PostgreSQL TCP protocol. Nginx `http`/`https` reverse-proxy blocks cannot proxy PostgreSQL. Use a direct published database port, an SSH tunnel, HAProxy TCP mode, or Nginx `stream`; if a port accepts TCP and immediately closes the PostgreSQL startup packet, Tabby reports that handshake stage directly.

TLS certificate verification is enabled by default. Keep it enabled for remote databases; turn it off only for a deliberately trusted development database without a valid certificate.

## Sync semantics

The application synchronizes ordinary Tabby settings (appearance, terminal, hotkeys, SSH options, plugin settings, AI endpoint/model), user profiles, profile groups, command topics and commands. SSH passwords, private-key passphrases, API keys, access tokens and other credentials managed by Tabby's vault/keychain are intentionally not exported as profile JSON. The PostgreSQL connection settings themselves remain local bootstrap data: a new computer needs them in order to reach the database in the first place.

The first synchronization treats rows already in PostgreSQL as authoritative for objects with the same ID, while preserving a conflicting local version in `tabby_sync.conflicts`. New local objects are added to the database. Afterwards, each change carries a device ID and timestamp. The newest change wins deterministically; the losing payload is retained in `tabby_sync.conflicts`, rather than being discarded. Deletes are soft deletes and are replicated using tombstones. This permits reconnecting clients to observe a deletion without accidentally recreating the item.

Every saved profile, group, command topic or command is marked pending and sent automatically when PostgreSQL sync and automatic sync are enabled. The settings page shows the server-confirmed time of the last successful synchronization, the last attempt and the exact pending-object count. Before the first successful exchange, or while local changes are pending, **Synchronize now** remains visually active.

Local changes made offline remain in the local configuration metadata and are retried immediately after a later save, every 30 seconds after reconnecting, and on the next manual synchronization. Pending state survives an application restart. A change made while another sync request is in flight is kept locally and queued for a follow-up request rather than being overwritten by the response already on its way.

Each synchronized object records the PostgreSQL revision it was read from. An uncontended local edit based on that revision can therefore be committed without trusting workstation clock accuracy. Truly concurrent edits are resolved deterministically, and the losing payload remains in `tabby_sync.conflicts` for recovery/audit. A conflict row can be reviewed and marked resolved by an administrator after copying/restoring the payload of interest.

## Command library

Create a topic such as `Nginx`, select it, and add commands with a name, description and command text. Each saved command has **Copy** and **Run in current terminal** actions. Run sends the text plus a newline to the active terminal session; when the library settings page itself is selected, it uses the most recently active live terminal session.

## Build and run

Install Node.js 22.12 or newer, then run from the repository root:

```sh
corepack yarn install
corepack yarn build
TABBY_DEV=1 corepack yarn start
```

The application package now requires `pg`. If a package cache contains a broken native `russh` artifact, clear that cache entry and rerun the install; it is unrelated to this feature.
