import type { PendingChange } from "./types";

export const MAX_NOTE_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_ITEMS_PER_REQUEST = 100;
export const SAFE_SYNC_REQUEST_BYTES = 8 * 1024 * 1024 - 16 * 1024;

export function normalizeApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error(
      "Ling API requires HTTPS; HTTP is only allowed for localhost, 127.0.0.1, or [::1].",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Ling API base URL cannot include credentials, query, or fragment.");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const apiPath = path.endsWith("/ling-api") ? path : `${path}/ling-api`;
  return `${parsed.origin}${apiPath}`;
}

export function assertPairingApiMatches(
  configuredBaseUrl: string,
  launchBaseUrl: string | undefined,
): void {
  if (
    launchBaseUrl !== undefined &&
    normalizeApiRoot(launchBaseUrl) !== normalizeApiRoot(configuredBaseUrl)
  ) {
    throw new Error(
      "The pairing link targets a different Ling API. Configure that API explicitly before pairing.",
    );
  }
}

export function collapsePendingChanges(
  changes: readonly PendingChange[],
): PendingChange[] {
  const collapsed: PendingChange[] = [];

  for (const change of changes) {
    const previous = collapsed.at(-1);
    if (previous?.noteId !== change.noteId) {
      collapsed.push(change);
      continue;
    }

    if (
      previous.type === "create" &&
      change.type === "modify" &&
      previous.path === change.path
    ) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        modifiedAt: change.modifiedAt,
      };
      continue;
    }

    if (
      previous.type === "modify" &&
      change.type === "modify" &&
      previous.path === change.path
    ) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        modifiedAt: change.modifiedAt,
      };
      continue;
    }

    if (
      previous.type === "create" &&
      change.type === "delete" &&
      !previous.knownBefore
    ) {
      collapsed.pop();
      continue;
    }

    collapsed.push(change);
  }

  return collapsed;
}

export function buildCursorWindow(cursor: number): {
  base_cursor: number;
  next_cursor: number;
} {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Cursor must be a non-negative safe integer.");
  }
  return { base_cursor: cursor, next_cursor: cursor + 1 };
}

export function unwrapLingResponse<T>(response: unknown): T {
  const envelope = response as {
    code: number;
    message: string;
    data: T;
  };
  if (envelope.code !== 200) {
    throw new Error(envelope.message || `Ling API returned code ${envelope.code}.`);
  }
  return envelope.data;
}

export function canQueueVaultChange(
  started: boolean,
  connected: boolean,
): boolean {
  return started && connected;
}

export async function runAfterPairingConsent(
  consented: boolean,
  connect: () => Promise<void>,
): Promise<void> {
  if (consented) {
    await connect();
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isNoteContentWithinLimit(content: string): boolean {
  return utf8ByteLength(content) <= MAX_NOTE_CONTENT_BYTES;
}

export function takeJsonRequestPrefix<T>(
  items: readonly T[],
  buildRequest: (prefix: readonly T[]) => unknown,
  maxItems = MAX_SYNC_ITEMS_PER_REQUEST,
  maxBytes = SAFE_SYNC_REQUEST_BYTES,
): T[] {
  const candidates = items.slice(0, maxItems);
  let lower = 0;
  let upper = candidates.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const bytes = utf8ByteLength(
      JSON.stringify(buildRequest(candidates.slice(0, middle))),
    );
    if (bytes <= maxBytes) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return candidates.slice(0, lower);
}
