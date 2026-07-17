import type { SecretStorage } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { ObsidianTokenStore } from "../src/token-store";
import type { LingSyncSettings } from "../src/types";

describe("Obsidian SecretStorage token repository", () => {
  it("clears secrets and device-local connection cache after server revocation", async () => {
    const secrets = new Map<string, string>();
    const storage = {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => {
        secrets.set(id, value);
      },
    } as unknown as SecretStorage;
    const settings = {
      connection: { connection_id: "connection-1" },
      cursor: 42,
      accessExpiresAt: "2026-07-17T11:00:00.000Z",
      refreshExpiresAt: "2026-08-17T11:00:00.000Z",
      lastError: null,
    } as LingSyncSettings;
    const persist = vi.fn(async () => undefined);
    const store = new ObsidianTokenStore(
      storage,
      "vault-1",
      settings,
      persist,
    );

    storage.setSecret("ling-sync-access-vault-1", "access");
    storage.setSecret("ling-sync-refresh-vault-1", "refresh");
    await store.clear();

    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(settings.connection).toBeNull();
    expect(settings.cursor).toBe(0);
    expect(persist).toHaveBeenCalledOnce();
  });
});
