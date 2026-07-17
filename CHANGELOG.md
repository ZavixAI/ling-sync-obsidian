# Changelog

## 0.1.2 - 2026-07-17

- Coalesce repeated foreground-resume events while reconciliation is already running.
- Discard stale foreground reconciliation work across plugin stop and restart.
- Allow foreground reconciliation to recover cleanly after heartbeat or manifest failures.

## 0.1.1 - 2026-07-17

- Describe the Ling search and AI-assisted recall use case in the plugin manifest.
- Respect each Vault's configured settings directory when filtering paths.
- Add searchable settings definitions for Obsidian 1.13 and newer.
- Publish only the release assets consumed by Obsidian and attest `main.js`.
- Reconcile immediately after Obsidian returns to the foreground.
- Remove stale Ling mirrors when a Markdown file grows beyond the 2 MiB limit.

## 0.1.0 - 2026-07-17

- Add mobile-safe Obsidian-to-Ling Markdown synchronization.
- Add Ling account pairing with rotating connector credentials.
- Add whole-Vault and selected-folder synchronization policies.
- Add resumable manifests, incremental change batches, and cursor recovery.
- Store connector tokens in Obsidian SecretStorage.
- Support Obsidian desktop, iOS, and Android.
