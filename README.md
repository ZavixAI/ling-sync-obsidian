# Ling Sync for Obsidian

Ling Sync is a mobile-safe Obsidian Community Plugin that sends selected Markdown notes to Ling through the provider-neutral Notes Integration API. It uses only public Obsidian APIs, works with `isDesktopOnly: false`, and does not import Node.js, Electron, or filesystem modules at runtime.

## What P0 includes

- Pairing through `obsidian://ling-sync`.
- Tokens stored only in Obsidian `SecretStorage`.
- Device identity, cursor, and connection status kept in Obsidian's vault-local app storage rather than syncable plugin data.
- Whole-Vault or selected-folder manifests.
- Debounced create, modify, rename, and delete batches.
- Strict server cursors and idempotent retries.
- Startup reconciliation after plugin or device interruption.
- Desktop and mobile networking through Obsidian `requestUrl`.
- One active connector device per Ling account and Vault; pairing another device revokes the previous device to keep the P0 cursor single-writer.

P0 sync is strictly Obsidian to Ling. Every client pairing and connector claim is fixed to the minimum `notes.read` and `notes.sync` scopes.

## Compatibility

- Obsidian `1.11.4` or newer (`SecretStorage` was added in 1.11.4).
- Desktop and mobile Obsidian.
- Node.js 20 or newer is needed only to build or test the plugin.

## Pairing flow

1. The user configures the Ling API and selected folders in the Obsidian plugin settings.
2. The user chooses Obsidian in Ling; Ling creates a pairing and opens the returned launch URI.
3. Obsidian dispatches the URI to this plugin. The plugin rejects a launch URI whose API does not exactly match the API explicitly configured in settings.
4. Obsidian displays the Ling API host, Vault, folders, and scope. Cancel performs no network request.
5. After the user clicks **Connect**, the plugin claims the pairing, stores the rotating credentials in `SecretStorage`, obtains the authoritative server cursor, and uploads a complete manifest.

The protocol format is:

```text
obsidian://ling-sync?pairing_id=<id>&pairing_code=<one-time-code>&api_base_url=https%3A%2F%2Fapi.withling.top
```

`api_base_url` is optional. The default is `https://api.withling.top`; the plugin appends `/ling-api` unless it is already present.

The plugin requires HTTPS so connector tokens are never sent over plaintext. HTTP is accepted only for loopback development hosts: `localhost`, `127.0.0.1`, and `[::1]`.

The claim body is:

```json
{
  "pairing_id": "pairing-id",
  "pairing_code": "one-time-code",
  "vault_id": "stable-vault-uuid",
  "vault_name": "My Vault",
  "device_id": "stable-device-uuid",
  "device_name": "Obsidian Mobile",
  "folder_paths": ["Projects/Ling"],
  "scopes": ["notes.read", "notes.sync"],
  "plugin_version": "0.1.0"
}
```

An empty folder selection is encoded as `[""]`, which means the whole Vault. The plugin never sends an empty `folder_paths` array.

## Backend contract

The API root is `<Ling API base URL>/ling-api`. Connector routes are:

```text
POST /integrations/notes/obsidian/connector/claim
POST /integrations/notes/obsidian/connector/refresh
POST /integrations/notes/obsidian/connector/heartbeat
PUT  /integrations/notes/obsidian/connector/manifest
POST /integrations/notes/obsidian/connector/changes/batch
```

P0 always requests the exact provider-neutral scopes `notes.read` and `notes.sync`. The plugin has no broader permission option.

The plugin sends a complete manifest as:

```json
{
  "idempotency_key": "uuid",
  "snapshot_id": "snapshot-uuid",
  "chunk_index": 0,
  "is_last": true,
  "base_cursor": 4,
  "next_cursor": 5,
  "entries": [
    {
      "note_id": "stable-note-uuid",
      "path": "Projects/Ling/plan.md",
      "content": "# Plan\n",
      "content_hash": "sha256-hex-of-utf8-content",
      "modified_at": "2026-07-17T10:00:00.000Z",
      "metadata": {}
    }
  ]
}
```

Large manifests are split into an ordered snapshot: at most 100 entries and safely below the 8 MiB UTF-8 JSON limit per chunk. Every acknowledged chunk advances the cursor by one; only `is_last: true` tombstones notes absent from the completed snapshot. A new startup reconciliation safely replaces an interrupted partial snapshot with a new `snapshot_id` from chunk `0`.

Change batches use the same cursor window and a stable `idempotency_key` for an in-flight retry. Every operation has its own `operation_id`. Content is included for `create` and `modify`; `rename` sends `previous_path`; `delete` sends the deleted path. A batch contains at most 100 operations and stays safely below 8 MiB. Markdown content is measured as UTF-8 and notes over 2 MiB are skipped with an explicit connection error so they cannot block later notes forever.

At startup, heartbeat or token refresh returns the authoritative server cursor. If the plugin stopped after the server committed a request but before local settings were saved, it does not replay the stale cursor. It sends a fresh complete manifest from the server cursor. A runtime `409` follows the same reconciliation path.

## Vault rules

Only `.md` files under configured folders are uploaded. These paths are always excluded:

- `.obsidian`
- `.trash`
- `.git`
- Any directory whose name starts with `.`

Vault access uses `Vault.getMarkdownFiles()` and `Vault.cachedRead()`. The plugin does not access the filesystem adapter directly.

## Build and test

```bash
npm install
npm test
npm run build
```

The build produces `main.js`. For a manual install, place these files in `<vault>/.obsidian/plugins/ling-sync/`:

```text
main.js
manifest.json
versions.json
```

Enable **Ling Sync** in Obsidian's Community Plugins settings, configure the API and folders, and start pairing from Ling.

Ling is authoritative for unlinking. API base URL and folders are locked while connected because they are part of the pairing authorization. Unlink the connection in Ling, then pair again to change them; the plugin does not expose a local-only disconnect that could leave an active server mirror behind.

## Data and privacy disclosures

- A Ling account is required to create and manage a connection.
- The plugin reads only Markdown files in the folders the user approves. It excludes Obsidian configuration, trash, Git data, hidden directories, and non-Markdown files.
- It sends each included note's body, Vault-relative path, modification time, SHA-256 content hash, stable note ID, and empty provider metadata object to the explicitly configured Ling API over HTTPS (loopback HTTP is development-only).
- Connector access and refresh tokens are stored with Obsidian `SecretStorage`. Tokens are never written to plugin data.
- P0 does not write, rename, or delete files in the Vault. Sync direction is Obsidian to Ling.
- The plugin contains no telemetry, analytics, advertising, or payment flow.
- This is a beta integration, not yet a published Obsidian Community Plugin listing.
