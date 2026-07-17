export const PLUGIN_VERSION = "0.1.3";
export const DEFAULT_API_BASE_URL = "https://api.withling.top";
export const P0_SCOPES = ["notes.read", "notes.sync"] as const;

export type LingScope = (typeof P0_SCOPES)[number];

export interface ConnectionSummary {
  connection_id: string;
  provider: "obsidian";
  status: string;
  vault_name: string;
  scopes: LingScope[];
  folder_paths: string[];
  last_seen_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  manifest_upload?: {
    snapshot_id: string;
    next_chunk_index: number;
  } | null;
}

export interface LingSyncSettings {
  apiBaseUrl: string;
  vaultId: string;
  deviceId: string;
  folderPaths: string[];
  connection: ConnectionSummary | null;
  cursor: number;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  noteIds: Record<string, string>;
  lastError: string | null;
}

export interface PairingClaim {
  pairing_id: string;
  pairing_code: string;
  vault_id: string;
  vault_name: string;
  device_id: string;
  device_name: string;
  folder_paths: string[];
  scopes: LingScope[];
  plugin_version: string;
}

export interface TokenEnvelope {
  token_type: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  connection: ConnectionSummary;
  cursor: number;
}

export interface HeartbeatResponse {
  connection: ConnectionSummary;
  cursor: number;
}

export interface NoteEntry {
  note_id: string;
  path: string;
  content: string;
  content_hash: string;
  modified_at: string;
  metadata: Record<string, unknown>;
}

export interface ManifestRequest {
  idempotency_key: string;
  snapshot_id: string;
  chunk_index: number;
  is_last: boolean;
  base_cursor: number;
  next_cursor: number;
  entries: NoteEntry[];
}

interface ChangeOperationBase {
  operation_id: string;
  note_id: string;
  path: string;
  modified_at: string;
  metadata: Record<string, unknown>;
}

export interface ContentChangeOperation extends ChangeOperationBase {
  type: "create" | "modify";
  content: string;
  content_hash: string;
}

export interface RenameChangeOperation extends ChangeOperationBase {
  type: "rename";
  previous_path: string;
}

export interface DeleteChangeOperation extends ChangeOperationBase {
  type: "delete";
}

export type ChangeOperation =
  | ContentChangeOperation
  | RenameChangeOperation
  | DeleteChangeOperation;

export interface ChangesBatchRequest {
  idempotency_key: string;
  base_cursor: number;
  next_cursor: number;
  operations: ChangeOperation[];
}

export interface SyncAcknowledgement {
  connection_id: string;
  cursor: number;
  applied_count: number;
  deleted_count: number;
  idempotent_replay: boolean;
  acknowledged_operation_ids: string[];
  snapshot_id?: string;
  next_chunk_index?: number;
  snapshot_complete?: boolean;
}

export type PendingChange =
  | {
      operationId: string;
      type: "create" | "modify";
      noteId: string;
      path: string;
      modifiedAt: string;
      knownBefore: boolean;
    }
  | {
      operationId: string;
      type: "rename";
      noteId: string;
      path: string;
      previousPath: string;
      modifiedAt: string;
      knownBefore: true;
    }
  | {
      operationId: string;
      type: "delete";
      noteId: string;
      path: string;
      modifiedAt: string;
      knownBefore: boolean;
    };
