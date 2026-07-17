import { requestUrl, type RequestUrlResponse } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LingApiClient, LingApiError, type TokenStore } from "../src/api";
import type { TokenEnvelope } from "../src/types";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

function response(status: number, data: unknown = null): RequestUrlResponse {
  return {
    status,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: data,
    text: JSON.stringify(data),
  };
}

function tokenStore(access: string | null, refresh: string | null): TokenStore {
  return {
    getAccessToken: vi.fn(() => access),
    getRefreshToken: vi.fn(() => refresh),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

describe("connector authentication", () => {
  afterEach(() => vi.resetAllMocks());

  it("clears local credentials only when access and refresh are rejected", async () => {
    const store = tokenStore("expired-access", "revoked-refresh");
    vi.mocked(requestUrl).mockResolvedValue(response(401));
    const api = new LingApiClient("https://api.withling.top", store);

    await expect(api.heartbeat(null)).rejects.toBeInstanceOf(LingApiError);
    expect(store.clear).toHaveBeenCalledOnce();
  });

  it("clears local connection state when no refresh credential remains", async () => {
    const store = tokenStore(null, null);
    const api = new LingApiClient("https://api.withling.top", store);

    await expect(api.heartbeat(null)).rejects.toThrow("pair this Vault again");
    expect(store.clear).toHaveBeenCalledOnce();
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("does not clear credentials for a network or server failure", async () => {
    const store = tokenStore("access", "refresh");
    vi.mocked(requestUrl).mockResolvedValue(response(503));
    const api = new LingApiClient("https://api.withling.top", store);

    await expect(api.heartbeat(null)).rejects.toMatchObject({ status: 503 });
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("rotates credentials and retries after an access-only rejection", async () => {
    const store = tokenStore("expired-access", "refresh");
    const rotated = {
      token_type: "Bearer",
      access_token: "new-access",
      access_expires_at: "2026-07-17T11:00:00.000Z",
      refresh_token: "new-refresh",
      refresh_expires_at: "2026-08-17T11:00:00.000Z",
      connection: {},
      cursor: 9,
    } as TokenEnvelope;
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(
        response(200, { code: 200, message: "success", data: rotated }),
      )
      .mockResolvedValueOnce(
        response(200, {
          code: 200,
          message: "success",
          data: { connection: rotated.connection, cursor: 9 },
        }),
      );
    const api = new LingApiClient("https://api.withling.top", store);

    await expect(api.heartbeat(null)).resolves.toMatchObject({ cursor: 9 });
    expect(store.save).toHaveBeenCalledWith(rotated);
    expect(store.clear).not.toHaveBeenCalled();
  });
});
