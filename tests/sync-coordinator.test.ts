import { TFile, type App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LingApiClient } from "../src/api";
import { registerForegroundLifecycle } from "../src/foreground-lifecycle";
import { SyncCoordinator } from "../src/sync-coordinator";
import type {
  ConnectionSummary,
  LingSyncSettings,
  ManifestRequest,
  ChangesBatchRequest,
} from "../src/types";

vi.mock("../src/crypto", () => ({
  randomId: () => "test-random-id",
  sha256Hex: async (content: string) => `hash-${content.length}`,
}));

const CONNECTION: ConnectionSummary = {
  connection_id: "connection-1",
  provider: "obsidian",
  status: "active",
  vault_name: "Test Vault",
  scopes: ["notes.read", "notes.sync"],
  folder_paths: [""],
  last_seen_at: null,
  last_synced_at: null,
  last_error: null,
  created_at: "2026-07-17T00:00:00.000Z",
  updated_at: "2026-07-17T00:00:00.000Z",
};

interface FakeApi {
  heartbeat: ReturnType<typeof vi.fn>;
  putManifest: ReturnType<typeof vi.fn>;
  postChanges: ReturnType<typeof vi.fn>;
}

function createFile(path: string, mtime = 1_752_729_600_000): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split("/").at(-1) ?? path;
  file.basename = file.name.replace(/\.md$/i, "");
  file.extension = "md";
  file.stat = { ctime: mtime, mtime, size: 0 };
  return file;
}

function createSettings(noteIds: Record<string, string>): LingSyncSettings {
  return {
    apiBaseUrl: "https://api.withling.top",
    vaultId: "vault-1",
    deviceId: "device-1",
    folderPaths: [""],
    connection: { ...CONNECTION },
    cursor: 0,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    noteIds: { ...noteIds },
    lastError: null,
  };
}

function createApi(settings: LingSyncSettings): FakeApi {
  return {
    heartbeat: vi.fn(async () => ({
      connection: { ...CONNECTION },
      cursor: settings.cursor,
    })),
    putManifest: vi.fn(async (body: ManifestRequest) => ({
      connection_id: CONNECTION.connection_id,
      cursor: body.next_cursor,
      applied_count: body.entries.length,
      deleted_count: 0,
      idempotent_replay: false,
      acknowledged_operation_ids: [],
    })),
    postChanges: vi.fn(async (body: ChangesBatchRequest) => ({
      connection_id: CONNECTION.connection_id,
      cursor: body.next_cursor,
      applied_count: body.operations.length,
      deleted_count: body.operations.filter((operation) => operation.type === "delete")
        .length,
      idempotent_replay: false,
      acknowledged_operation_ids: body.operations.map(
        (operation) => operation.operation_id,
      ),
    })),
  };
}

function createApp(files: TFile[], contents: Map<string, string>): App {
  return {
    vault: {
      configDir: ".obsidian",
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) =>
        files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    },
  } as unknown as App;
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("SyncCoordinator lifecycle and Vault events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces foreground events into an immediate heartbeat and manifest", async () => {
    const file = createFile("note.md");
    const contents = new Map([[file.path, "# Current\n"]]);
    const settings = createSettings({ [file.path]: "note-1" });
    const api = createApi(settings);
    const coordinator = new SyncCoordinator(
      createApp([file], contents),
      settings,
      api as unknown as LingApiClient,
      vi.fn(async () => undefined),
      vi.fn(),
    );

    await coordinator.start();
    api.heartbeat.mockClear();
    api.putManifest.mockClear();

    const windowEvents = new EventTarget();
    const documentEvents = new EventTarget();
    let visibilityState = "hidden";
    registerForegroundLifecycle(
      {
        onFocus: (listener) => windowEvents.addEventListener("focus", listener),
        onVisibilityChange: (listener) =>
          documentEvents.addEventListener("visibilitychange", listener),
        isVisible: () => visibilityState === "visible",
      },
      () => coordinator.handleAppResume(),
    );

    documentEvents.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(250);
    expect(api.heartbeat).not.toHaveBeenCalled();

    windowEvents.dispatchEvent(new Event("focus"));
    visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(249);
    expect(api.heartbeat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(api.heartbeat).toHaveBeenCalledOnce();
    expect(api.putManifest).toHaveBeenCalledOnce();
    expect(api.putManifest.mock.calls[0]?.[0]).toMatchObject({
      is_last: true,
      entries: [{ note_id: "note-1", path: "note.md", content: "# Current\n" }],
    });

    coordinator.stop();
  });

  it("does not queue a second foreground manifest while the first is running", async () => {
    const file = createFile("note.md");
    const contents = new Map([[file.path, "# Current\n"]]);
    const settings = createSettings({ [file.path]: "note-1" });
    const api = createApi(settings);
    const coordinator = new SyncCoordinator(
      createApp([file], contents),
      settings,
      api as unknown as LingApiClient,
      vi.fn(async () => undefined),
      vi.fn(),
    );

    await coordinator.start();
    api.heartbeat.mockClear();
    api.putManifest.mockClear();
    let releaseManifest: (() => void) | undefined;
    api.putManifest.mockImplementationOnce(
      (body: ManifestRequest) =>
        new Promise((resolve) => {
          releaseManifest = () =>
            resolve({
              connection_id: CONNECTION.connection_id,
              cursor: body.next_cursor,
              applied_count: body.entries.length,
              deleted_count: 0,
              idempotent_replay: false,
              acknowledged_operation_ids: [],
            });
        }),
    );

    coordinator.handleAppResume();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();
    expect(api.putManifest).toHaveBeenCalledOnce();

    coordinator.handleAppResume();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();
    expect(api.heartbeat).toHaveBeenCalledOnce();
    expect(api.putManifest).toHaveBeenCalledOnce();

    releaseManifest?.();
    await flushAsyncWork();
    coordinator.stop();
  });

  it("discards a queued foreground reconcile across stop and restart", async () => {
    const file = createFile("note.md");
    const contents = new Map([[file.path, "# Current\n"]]);
    const settings = createSettings({ [file.path]: "note-1" });
    const api = createApi(settings);
    const coordinator = new SyncCoordinator(
      createApp([file], contents),
      settings,
      api as unknown as LingApiClient,
      vi.fn(async () => undefined),
      vi.fn(),
    );

    await coordinator.start();
    api.heartbeat.mockClear();
    api.putManifest.mockClear();
    let releaseHeartbeat: (() => void) | undefined;
    api.heartbeat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHeartbeat = () =>
            resolve({
              connection: { ...CONNECTION },
              cursor: settings.cursor,
            });
        }),
    );

    const blockingReconcile = coordinator.reconcile();
    await flushAsyncWork();
    expect(api.heartbeat).toHaveBeenCalledOnce();

    coordinator.handleAppResume();
    await vi.advanceTimersByTimeAsync(250);
    coordinator.stop();
    const restarted = coordinator.start();

    releaseHeartbeat?.();
    await blockingReconcile;
    await restarted;
    await flushAsyncWork();

    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.putManifest).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("allows foreground reconciliation after heartbeat and manifest failures", async () => {
    const file = createFile("note.md");
    const contents = new Map([[file.path, "# Current\n"]]);
    const settings = createSettings({ [file.path]: "note-1" });
    const api = createApi(settings);
    const coordinator = new SyncCoordinator(
      createApp([file], contents),
      settings,
      api as unknown as LingApiClient,
      vi.fn(async () => undefined),
      vi.fn(),
    );

    await coordinator.start();
    api.heartbeat.mockClear();
    api.putManifest.mockClear();

    api.heartbeat.mockRejectedValueOnce(new Error("heartbeat failed"));
    coordinator.handleAppResume();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();
    expect(api.heartbeat).toHaveBeenCalledOnce();
    expect(api.putManifest).not.toHaveBeenCalled();

    api.putManifest.mockRejectedValueOnce(new Error("manifest failed"));
    coordinator.handleAppResume();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.putManifest).toHaveBeenCalledOnce();

    coordinator.handleAppResume();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();
    expect(api.heartbeat).toHaveBeenCalledTimes(3);
    expect(api.putManifest).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("tombstones a mirrored note that grows past 2 MiB and restores it by manifest", async () => {
    const file = createFile("note.md");
    const contents = new Map([[file.path, "# Small\n"]]);
    const settings = createSettings({ [file.path]: "note-1" });
    const api = createApi(settings);
    const coordinator = new SyncCoordinator(
      createApp([file], contents),
      settings,
      api as unknown as LingApiClient,
      vi.fn(async () => undefined),
      vi.fn(),
    );

    await coordinator.start();
    api.heartbeat.mockClear();
    api.putManifest.mockClear();
    api.postChanges.mockClear();

    contents.set(file.path, "你".repeat(700_000));
    file.stat.mtime += 1_000;
    coordinator.handleModify(file);
    await vi.advanceTimersByTimeAsync(800);
    await flushAsyncWork();

    expect(api.postChanges).toHaveBeenCalledOnce();
    expect(api.postChanges.mock.calls[0]?.[0]).toMatchObject({
      operations: [
        {
          type: "delete",
          note_id: "note-1",
          path: "note.md",
        },
      ],
    });
    expect(settings.lastError).toContain("2 MiB");

    contents.set(file.path, "# Small again\n");
    file.stat.mtime += 1_000;
    coordinator.handleModify(file);
    await vi.advanceTimersByTimeAsync(800);
    await flushAsyncWork();

    expect(api.heartbeat).toHaveBeenCalledOnce();
    expect(api.putManifest).toHaveBeenCalledOnce();
    expect(api.putManifest.mock.calls[0]?.[0]).toMatchObject({
      is_last: true,
      entries: [
        {
          note_id: "note-1",
          path: "note.md",
          content: "# Small again\n",
        },
      ],
    });
    expect(settings.lastError).toBeNull();

    coordinator.stop();
  });
});
