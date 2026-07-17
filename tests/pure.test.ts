import { describe, expect, it } from "vitest";

import {
  assertPairingApiMatches,
  buildCursorWindow,
  canQueueVaultChange,
  collapsePendingChanges,
  isNoteContentWithinLimit,
  MAX_NOTE_CONTENT_BYTES,
  normalizeApiRoot,
  runAfterPairingConsent,
  takeJsonRequestPrefix,
  unwrapLingResponse,
} from "../src/pure";
import { P0_SCOPES, type PendingChange } from "../src/types";

describe("sync contract logic", () => {
  it("requests only the P0 one-way sync scopes", () => {
    expect(P0_SCOPES).toEqual(["notes.read", "notes.sync"]);
    expect(P0_SCOPES).not.toContain("notes.write");
  });

  it("normalizes an origin or an existing Ling API root", () => {
    expect(normalizeApiRoot("https://api.withling.top/")).toBe(
      "https://api.withling.top/ling-api",
    );
    expect(normalizeApiRoot("http://127.0.0.1:8000/ling-api")).toBe(
      "http://127.0.0.1:8000/ling-api",
    );
    expect(normalizeApiRoot("http://localhost:8000")).toBe(
      "http://localhost:8000/ling-api",
    );
    expect(normalizeApiRoot("http://[::1]:8000")).toBe(
      "http://[::1]:8000/ling-api",
    );
    expect(() => normalizeApiRoot("http://api.withling.top")).toThrow("HTTPS");
    expect(() => normalizeApiRoot("http://192.168.1.8:8000")).toThrow("HTTPS");
  });

  it("does not let a deep link replace the configured API endpoint", () => {
    expect(() =>
      assertPairingApiMatches(
        "https://api.withling.top",
        "https://api.withling.top/ling-api/",
      ),
    ).not.toThrow();
    expect(() =>
      assertPairingApiMatches(
        "https://api.withling.top",
        "https://attacker.example",
      ),
    ).toThrow("different Ling API");
  });

  it("advances a strict integer cursor by one", () => {
    expect(buildCursorWindow(41)).toEqual({ base_cursor: 41, next_cursor: 42 });
    expect(() => buildCursorWindow(-1)).toThrow("non-negative");
  });

  it("unwraps Ling's standard response envelope", () => {
    expect(
      unwrapLingResponse<{ cursor: number }>({
        code: 200,
        message: "success",
        data: { cursor: 7 },
      }),
    ).toEqual({ cursor: 7 });
  });

  it("blocks startup events until sync is started and connected", () => {
    expect(canQueueVaultChange(false, true)).toBe(false);
    expect(canQueueVaultChange(true, false)).toBe(false);
    expect(canQueueVaultChange(true, true)).toBe(true);
  });

  it("runs the pairing claim only after explicit consent", async () => {
    let claims = 0;
    const claim = async (): Promise<void> => {
      claims += 1;
    };
    await runAfterPairingConsent(false, claim);
    expect(claims).toBe(0);
    await runAfterPairingConsent(true, claim);
    expect(claims).toBe(1);
  });

  it("caps a change request at 100 operations", () => {
    const operations = Array.from({ length: 101 }, (_, index) => ({ index }));
    const prefix = takeJsonRequestPrefix(operations, (items) => ({
      idempotency_key: "id",
      base_cursor: 0,
      next_cursor: 1,
      operations: items,
    }));
    expect(prefix).toHaveLength(100);
    expect(prefix.at(-1)).toEqual({ index: 99 });
  });

  it("uses UTF-8 bytes for the 2 MiB note limit and 8 MiB request budget", () => {
    expect(isNoteContentWithinLimit("a".repeat(MAX_NOTE_CONTENT_BYTES))).toBe(true);
    expect(isNoteContentWithinLimit("你".repeat(700_000))).toBe(false);

    const content = "a".repeat(MAX_NOTE_CONTENT_BYTES);
    const entries = Array.from({ length: 4 }, (_, index) => ({ index, content }));
    const prefix = takeJsonRequestPrefix(entries, (items) => ({
      idempotency_key: "id",
      snapshot_id: "snapshot",
      chunk_index: 0,
      is_last: false,
      base_cursor: 0,
      next_cursor: 1,
      entries: items,
    }));
    expect(prefix).toHaveLength(3);
  });

  it("debounces repeated content changes without changing operation identity", () => {
    const changes: PendingChange[] = [
      {
        operationId: "create-1",
        type: "create",
        noteId: "note-1",
        path: "note.md",
        modifiedAt: "2026-07-17T10:00:00.000Z",
        knownBefore: false,
      },
      {
        operationId: "modify-1",
        type: "modify",
        noteId: "note-1",
        path: "note.md",
        modifiedAt: "2026-07-17T10:00:01.000Z",
        knownBefore: true,
      },
    ];

    expect(collapsePendingChanges(changes)).toEqual([
      {
        ...changes[0],
        modifiedAt: "2026-07-17T10:00:01.000Z",
      },
    ]);
  });

  it("removes a new note that is deleted within the debounce window", () => {
    const changes: PendingChange[] = [
      {
        operationId: "create-1",
        type: "create",
        noteId: "note-1",
        path: "note.md",
        modifiedAt: "2026-07-17T10:00:00.000Z",
        knownBefore: false,
      },
      {
        operationId: "delete-1",
        type: "delete",
        noteId: "note-1",
        path: "note.md",
        modifiedAt: "2026-07-17T10:00:01.000Z",
        knownBefore: false,
      },
    ];

    expect(collapsePendingChanges(changes)).toEqual([]);
  });
});
