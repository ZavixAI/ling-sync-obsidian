import { normalizePath, TFile, type App } from "obsidian";

import { LingApiClient, LingApiError } from "./api";
import { randomId, sha256Hex } from "./crypto";
import { isIncludedMarkdown, normalizeFolderPaths } from "./path-policy";
import {
  buildCursorWindow,
  canQueueVaultChange,
  collapsePendingChanges,
  isNoteContentWithinLimit,
  MAX_SYNC_ITEMS_PER_REQUEST,
  takeJsonRequestPrefix,
} from "./pure";
import type {
  ChangeOperation,
  ChangesBatchRequest,
  LingSyncSettings,
  ManifestRequest,
  NoteEntry,
  PairingClaim,
  PendingChange,
} from "./types";
import { P0_SCOPES, PLUGIN_VERSION } from "./types";

const CHANGE_DEBOUNCE_MS = 800;
const FAILED_BATCH_RETRY_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const FOREGROUND_RECONCILE_DEBOUNCE_MS = 250;

interface InFlightBatch {
  body: ChangesBatchRequest;
  sourceOperationIds: Set<string>;
}

export interface ClaimParameters {
  pairingId: string;
  pairingCode: string;
  vaultName: string;
  deviceName: string;
}

export class SyncCoordinator {
  private pendingChanges: PendingChange[] = [];
  private inFlightBatch: InFlightBatch | null = null;
  private buildingOperationIds = new Set<string>();
  private flushTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private foregroundReconcileTimer: number | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private stopped = true;
  private reconcileNeeded = false;
  private oversizedPaths = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly settings: LingSyncSettings,
    private readonly api: LingApiClient,
    private readonly persistSettings: () => Promise<void>,
    private readonly statusChanged: () => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.heartbeatTimer = window.setInterval(() => {
      this.runInBackground(() => this.heartbeatTick());
    }, HEARTBEAT_INTERVAL_MS);
    if (this.settings.connection) {
      this.reconcileNeeded = true;
      await this.reconcile();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.foregroundReconcileTimer !== null) {
      window.clearTimeout(this.foregroundReconcileTimer);
      this.foregroundReconcileTimer = null;
    }
  }

  handleAppResume(): void {
    if (this.stopped || !this.settings.connection) {
      return;
    }
    if (this.foregroundReconcileTimer !== null) {
      window.clearTimeout(this.foregroundReconcileTimer);
    }
    this.foregroundReconcileTimer = window.setTimeout(() => {
      this.foregroundReconcileTimer = null;
      this.runInBackground(async () => {
        if (this.stopped || !this.settings.connection) {
          return;
        }
        this.reconcileNeeded = true;
        await this.sendHeartbeat();
        await this.uploadManifest();
      });
    }, FOREGROUND_RECONCILE_DEBOUNCE_MS);
  }

  claim(parameters: ClaimParameters): Promise<void> {
    return this.runSerialized(async () => {
      this.clearPendingChanges();
      const folderPaths = normalizeFolderPaths(this.settings.folderPaths);
      const body: PairingClaim = {
        pairing_id: parameters.pairingId,
        pairing_code: parameters.pairingCode,
        vault_id: this.settings.vaultId,
        vault_name: parameters.vaultName,
        device_id: this.settings.deviceId,
        device_name: parameters.deviceName,
        folder_paths: folderPaths,
        scopes: [...P0_SCOPES],
        plugin_version: PLUGIN_VERSION,
      };

      const envelope = await this.api.claim(body);
      this.settings.cursor = envelope.cursor;
      this.settings.connection = envelope.connection;
      this.settings.lastError = null;
      await this.persistSettings();
      this.reconcileNeeded = true;
      await this.uploadManifest();
      this.statusChanged();
    });
  }

  reconcile(): Promise<void> {
    return this.runSerialized(async () => {
      if (!this.settings.connection) {
        return;
      }
      this.reconcileNeeded = true;
      await this.sendHeartbeat();
      await this.uploadManifest();
    });
  }

  handleCreate(file: TFile): void {
    const path = normalizePath(file.path);
    if (!this.shouldSync(path)) {
      return;
    }
    if (this.oversizedPaths.has(path)) {
      this.scheduleManifestReconciliation();
      return;
    }
    const knownBefore = this.settings.noteIds[path] !== undefined;
    const noteId = this.settings.noteIds[path] ?? randomId();
    this.settings.noteIds[path] = noteId;
    this.queueChange({
      operationId: randomId(),
      type: knownBefore ? "modify" : "create",
      noteId,
      path,
      modifiedAt: this.modifiedAt(file),
      knownBefore,
    });
    if (!knownBefore) {
      void this.persistSettings();
    }
  }

  handleModify(file: TFile): void {
    const path = normalizePath(file.path);
    if (!this.shouldSync(path)) {
      return;
    }
    if (this.oversizedPaths.has(path)) {
      this.scheduleManifestReconciliation();
      return;
    }
    const knownBefore = this.settings.noteIds[path] !== undefined;
    const noteId = this.settings.noteIds[path] ?? randomId();
    this.settings.noteIds[path] = noteId;
    this.queueChange({
      operationId: randomId(),
      type: knownBefore ? "modify" : "create",
      noteId,
      path,
      modifiedAt: this.modifiedAt(file),
      knownBefore,
    });
    if (!knownBefore) {
      void this.persistSettings();
    }
  }

  handleRename(file: TFile, oldPath: string): void {
    const previousPath = normalizePath(oldPath);
    const path = normalizePath(file.path);
    const includedBefore = this.shouldSync(previousPath);
    const includedAfter = this.shouldSync(path);

    if (!includedBefore && !includedAfter) {
      return;
    }

    const previousNoteId = this.settings.noteIds[previousPath];
    if (includedBefore && includedAfter && previousNoteId) {
      delete this.settings.noteIds[previousPath];
      this.settings.noteIds[path] = previousNoteId;
      if (this.oversizedPaths.delete(previousPath)) {
        this.oversizedPaths.add(path);
        this.scheduleManifestReconciliation();
        void this.persistSettings();
        return;
      }
      this.queueChange({
        operationId: randomId(),
        type: "rename",
        noteId: previousNoteId,
        previousPath,
        path,
        modifiedAt: this.modifiedAt(file),
        knownBefore: true,
      });
      void this.persistSettings();
      return;
    }

    if (includedBefore && previousNoteId) {
      delete this.settings.noteIds[previousPath];
      if (this.oversizedPaths.delete(previousPath)) {
        this.scheduleManifestReconciliation();
        void this.persistSettings();
        return;
      }
      this.queueChange({
        operationId: randomId(),
        type: "delete",
        noteId: previousNoteId,
        path: previousPath,
        modifiedAt: this.modifiedAt(file),
        knownBefore: true,
      });
      void this.persistSettings();
      return;
    }

    if (includedAfter) {
      const noteId = randomId();
      this.settings.noteIds[path] = noteId;
      this.queueChange({
        operationId: randomId(),
        type: "create",
        noteId,
        path,
        modifiedAt: this.modifiedAt(file),
        knownBefore: false,
      });
      void this.persistSettings();
    }
  }

  handleDelete(file: TFile): void {
    const path = normalizePath(file.path);
    if (!this.shouldSync(path)) {
      return;
    }
    const noteId = this.settings.noteIds[path];
    if (!noteId) {
      return;
    }
    delete this.settings.noteIds[path];
    if (this.oversizedPaths.delete(path)) {
      this.scheduleManifestReconciliation();
      void this.persistSettings();
      return;
    }
    this.queueChange({
      operationId: randomId(),
      type: "delete",
      noteId,
      path,
      modifiedAt: this.modifiedAt(file),
      knownBefore: true,
    });
    void this.persistSettings();
  }

  private queueChange(change: PendingChange): void {
    if (!canQueueVaultChange(!this.stopped, this.settings.connection !== null)) {
      return;
    }
    const inFlightIds = new Set(this.inFlightBatch?.sourceOperationIds ?? []);
    for (const operationId of this.buildingOperationIds) {
      inFlightIds.add(operationId);
    }
    const protectedChanges = this.pendingChanges.filter((pending) =>
      inFlightIds.has(pending.operationId),
    );
    const queuedChanges = this.pendingChanges.filter(
      (pending) => !inFlightIds.has(pending.operationId),
    );
    this.pendingChanges = [
      ...protectedChanges,
      ...collapsePendingChanges([...queuedChanges, change]),
    ];
    this.scheduleFlush(CHANGE_DEBOUNCE_MS);
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
    }
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.runInBackground(() => this.flushChanges());
    }, delay);
  }

  private scheduleManifestReconciliation(): void {
    this.reconcileNeeded = true;
    this.scheduleFlush(CHANGE_DEBOUNCE_MS);
  }

  private async flushChanges(): Promise<void> {
    if (!this.settings.connection) {
      return;
    }

    try {
      if (this.pendingChanges.length === 0) {
        if (this.reconcileNeeded) {
          await this.sendHeartbeat();
          await this.uploadManifest();
        }
        return;
      }
      if (!this.inFlightBatch) {
        this.inFlightBatch = await this.buildChangesBatch();
      }
      if (this.inFlightBatch.body.operations.length === 0) {
        this.removeAcknowledgedPending(this.inFlightBatch.sourceOperationIds);
        this.inFlightBatch = null;
        this.updateSizeWarning();
        await this.persistSettings();
        this.statusChanged();
        if (this.pendingChanges.length > 0 || this.reconcileNeeded) {
          this.scheduleFlush(CHANGE_DEBOUNCE_MS);
        }
        return;
      }

      const acknowledgement = await this.api.postChanges(
        this.inFlightBatch.body,
      );
      this.settings.cursor = acknowledgement.cursor;
      this.removeAcknowledgedPending(this.inFlightBatch.sourceOperationIds);
      this.inFlightBatch = null;
      this.updateSizeWarning();
      await this.persistSettings();
      this.statusChanged();

      if (this.pendingChanges.length > 0 || this.reconcileNeeded) {
        this.scheduleFlush(CHANGE_DEBOUNCE_MS);
      }
    } catch (error) {
      if (error instanceof LingApiError && error.status === 409) {
        this.reconcileNeeded = true;
        try {
          const sourceIds = this.inFlightBatch?.sourceOperationIds ?? new Set();
          await this.sendHeartbeat();
          await this.uploadManifest();
          this.removeAcknowledgedPending(sourceIds);
          this.inFlightBatch = null;
        } catch (recoveryError) {
          await this.recordError(recoveryError);
          this.scheduleFlush(FAILED_BATCH_RETRY_MS);
        }
        return;
      }
      await this.recordError(error);
      this.scheduleFlush(FAILED_BATCH_RETRY_MS);
    }
  }

  private async buildChangesBatch(): Promise<InFlightBatch> {
    const sourceChanges = [...this.pendingChanges];
    this.buildingOperationIds = new Set(
      sourceChanges.map((change) => change.operationId),
    );
    try {
      const operations: ChangeOperation[] = [];
      const sourceOperationIds = new Set<string>();
      const idempotencyKey = randomId();
      const cursorWindow = buildCursorWindow(this.settings.cursor);

      for (const change of sourceChanges) {
        if (operations.length >= MAX_SYNC_ITEMS_PER_REQUEST) {
          break;
        }

        let operation: ChangeOperation | null = null;
        if (change.type === "rename") {
          if (this.oversizedPaths.delete(change.previousPath)) {
            this.oversizedPaths.add(change.path);
            this.reconcileNeeded = true;
            sourceOperationIds.add(change.operationId);
            continue;
          }
          operation = {
            operation_id: change.operationId,
            type: "rename",
            note_id: change.noteId,
            previous_path: change.previousPath,
            path: change.path,
            modified_at: change.modifiedAt,
            metadata: {},
          };
        } else if (change.type === "delete") {
          if (this.oversizedPaths.delete(change.path)) {
            this.reconcileNeeded = true;
            sourceOperationIds.add(change.operationId);
            continue;
          }
          operation = {
            operation_id: change.operationId,
            type: "delete",
            note_id: change.noteId,
            path: change.path,
            modified_at: change.modifiedAt,
            metadata: {},
          };
        } else {
          const abstractFile = this.app.vault.getAbstractFileByPath(change.path);
          if (!(abstractFile instanceof TFile) || !this.shouldSync(change.path)) {
            if (change.knownBefore) {
              operation = {
                operation_id: change.operationId,
                type: "delete",
                note_id: change.noteId,
                path: change.path,
                modified_at: change.modifiedAt,
                metadata: {},
              };
            } else {
              sourceOperationIds.add(change.operationId);
            }
          } else {
            const content = await this.app.vault.cachedRead(abstractFile);
            if (!isNoteContentWithinLimit(content)) {
              this.oversizedPaths.add(change.path);
              if (change.knownBefore) {
                operation = {
                  operation_id: change.operationId,
                  type: "delete",
                  note_id: change.noteId,
                  path: change.path,
                  modified_at: this.modifiedAt(abstractFile),
                  metadata: {},
                };
              } else {
                sourceOperationIds.add(change.operationId);
                continue;
              }
            } else {
              this.oversizedPaths.delete(change.path);
              operation = {
                operation_id: change.operationId,
                type: change.type,
                note_id: change.noteId,
                path: change.path,
                content,
                content_hash: await sha256Hex(content),
                modified_at: this.modifiedAt(abstractFile),
                metadata: {},
              };
            }
          }
        }

        if (!operation) {
          continue;
        }
        const fits =
          takeJsonRequestPrefix([operation], (candidate) => ({
            idempotency_key: idempotencyKey,
            ...cursorWindow,
            operations: [...operations, ...candidate],
          })).length === 1;
        if (!fits) {
          if (operations.length === 0) {
            throw new Error(`Sync operation for ${change.path} exceeds 8 MiB.`);
          }
          break;
        }
        operations.push(operation);
        sourceOperationIds.add(change.operationId);
      }

      this.updateSizeWarning();
      await this.persistSettings();
      return {
        body: {
          idempotency_key: idempotencyKey,
          ...cursorWindow,
          operations,
        },
        sourceOperationIds,
      };
    } finally {
      this.buildingOperationIds.clear();
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.settings.connection || this.stopped) {
      return;
    }
    const response = await this.api.heartbeat(this.settings.lastError);
    this.settings.connection = response.connection;
    this.settings.cursor = response.cursor;
    await this.persistSettings();
    this.statusChanged();
  }

  private async heartbeatTick(): Promise<void> {
    if (!this.settings.connection || this.stopped) {
      return;
    }
    await this.sendHeartbeat();
    if (this.reconcileNeeded) {
      await this.uploadManifest();
    }
  }

  private async uploadManifest(): Promise<void> {
    const entries = await this.buildManifestEntries();
    const snapshotId = randomId();
    let chunkIndex = 0;
    let offset = 0;

    do {
      const cursorWindow = buildCursorWindow(this.settings.cursor);
      const idempotencyKey = randomId();
      const remaining = entries.slice(offset);
      const chunkEntries = takeJsonRequestPrefix(remaining, (candidate) => ({
        idempotency_key: idempotencyKey,
        snapshot_id: snapshotId,
        chunk_index: chunkIndex,
        is_last: false,
        ...cursorWindow,
        entries: candidate,
      }));
      if (remaining.length > 0 && chunkEntries.length === 0) {
        throw new Error(`Manifest entry for ${remaining[0]?.path ?? "note"} exceeds 8 MiB.`);
      }

      const isLast = offset + chunkEntries.length >= entries.length;
      const body: ManifestRequest = {
        idempotency_key: idempotencyKey,
        snapshot_id: snapshotId,
        chunk_index: chunkIndex,
        is_last: isLast,
        ...cursorWindow,
        entries: chunkEntries,
      };
      const acknowledgement = await this.api.putManifest(body);
      this.settings.cursor = acknowledgement.cursor;
      await this.persistSettings();
      offset += chunkEntries.length;
      chunkIndex += 1;
    } while (offset < entries.length);

    this.updateSizeWarning();
    this.reconcileNeeded = false;
    await this.persistSettings();
    this.statusChanged();
  }

  private async buildManifestEntries(): Promise<NoteEntry[]> {
    const entries: NoteEntry[] = [];
    const activePaths = new Set<string>();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.shouldSync(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));

    for (const file of files) {
      const path = normalizePath(file.path);
      if (!this.shouldSync(path)) {
        continue;
      }
      activePaths.add(path);
      const noteId = this.settings.noteIds[path] ?? randomId();
      this.settings.noteIds[path] = noteId;
      const content = await this.app.vault.cachedRead(file);
      if (!isNoteContentWithinLimit(content)) {
        this.oversizedPaths.add(path);
        continue;
      }
      this.oversizedPaths.delete(path);
      entries.push({
        note_id: noteId,
        path,
        content,
        content_hash: await sha256Hex(content),
        modified_at: this.modifiedAt(file),
        metadata: {},
      });
    }

    for (const path of this.oversizedPaths) {
      if (!activePaths.has(path)) {
        this.oversizedPaths.delete(path);
      }
    }
    for (const path of Object.keys(this.settings.noteIds)) {
      if (!activePaths.has(path)) {
        delete this.settings.noteIds[path];
      }
    }
    this.updateSizeWarning();
    await this.persistSettings();

    return entries;
  }

  private shouldSync(path: string): boolean {
    return isIncludedMarkdown(
      path,
      this.settings.folderPaths,
      this.app.vault.configDir,
    );
  }

  private modifiedAt(file: TFile): string {
    return new Date(file.stat.mtime).toISOString();
  }

  private removeAcknowledgedPending(operationIds: ReadonlySet<string>): void {
    this.pendingChanges = this.pendingChanges.filter(
      (change) => !operationIds.has(change.operationId),
    );
  }

  private runSerialized(operation: () => Promise<void>): Promise<void> {
    const next = this.operationChain.then(operation);
    this.operationChain = next.catch(async (error: unknown) => {
      await this.recordError(error);
    });
    return next;
  }

  private runInBackground(operation: () => Promise<void>): void {
    void this.runSerialized(operation).catch(() => undefined);
  }

  private clearPendingChanges(): void {
    this.pendingChanges = [];
    this.inFlightBatch = null;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private updateSizeWarning(): void {
    if (this.oversizedPaths.size === 0) {
      this.settings.lastError = null;
      return;
    }
    const paths = [...this.oversizedPaths].sort();
    const visiblePaths = paths.slice(0, 3).join(", ");
    const remainder = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
    this.settings.lastError = `Not mirrored in Ling: ${visiblePaths}${remainder} exceeds the 2 MiB UTF-8 limit. Any previous Ling copy was removed; the local Vault file is unchanged.`;
  }

  private async recordError(error: unknown): Promise<void> {
    this.settings.lastError =
      error instanceof Error ? error.message : String(error);
    await this.persistSettings();
    this.statusChanged();
  }
}
