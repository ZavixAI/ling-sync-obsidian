import { requestUrl } from "obsidian";

import { normalizeApiRoot, unwrapLingResponse } from "./pure";
import type {
  ChangesBatchRequest,
  HeartbeatResponse,
  ManifestRequest,
  PairingClaim,
  SyncAcknowledgement,
  TokenEnvelope,
} from "./types";
import { PLUGIN_VERSION } from "./types";

const CONNECTOR_PATH = "/integrations/notes/obsidian/connector";

export interface TokenStore {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  save(envelope: TokenEnvelope): Promise<void>;
  clear(): Promise<void>;
}

export class LingApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`Ling API request failed with status ${status}.`);
  }
}

export class LingApiClient {
  private apiRoot: string;

  constructor(
    baseUrl: string,
    private readonly tokenStore: TokenStore,
  ) {
    this.apiRoot = normalizeApiRoot(baseUrl);
  }

  setBaseUrl(baseUrl: string): void {
    this.apiRoot = normalizeApiRoot(baseUrl);
  }

  async claim(body: PairingClaim): Promise<TokenEnvelope> {
    const envelope = await this.requestJson<TokenEnvelope>(
      "POST",
      `${CONNECTOR_PATH}/claim`,
      body,
    );
    await this.tokenStore.save(envelope);
    return envelope;
  }

  async refresh(): Promise<TokenEnvelope> {
    const refreshToken = this.tokenStore.getRefreshToken();
    if (!refreshToken) {
      await this.tokenStore.clear();
      throw new Error("Ling refresh token is unavailable; pair this Vault again.");
    }

    try {
      const envelope = await this.requestJson<TokenEnvelope>(
        "POST",
        `${CONNECTOR_PATH}/refresh`,
        { refresh_token: refreshToken },
      );
      await this.tokenStore.save(envelope);
      return envelope;
    } catch (error) {
      if (error instanceof LingApiError && error.status === 401) {
        await this.tokenStore.clear();
      }
      throw error;
    }
  }

  heartbeat(lastError: string | null): Promise<HeartbeatResponse> {
    return this.authorizedRequest<HeartbeatResponse>(
      "POST",
      `${CONNECTOR_PATH}/heartbeat`,
      { plugin_version: PLUGIN_VERSION, last_error: lastError },
    );
  }

  putManifest(body: ManifestRequest): Promise<SyncAcknowledgement> {
    return this.authorizedRequest<SyncAcknowledgement>(
      "PUT",
      `${CONNECTOR_PATH}/manifest`,
      body,
    );
  }

  postChanges(body: ChangesBatchRequest): Promise<SyncAcknowledgement> {
    return this.authorizedRequest<SyncAcknowledgement>(
      "POST",
      `${CONNECTOR_PATH}/changes/batch`,
      body,
    );
  }

  private async authorizedRequest<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    let accessToken = this.tokenStore.getAccessToken();
    if (!accessToken) {
      accessToken = (await this.refresh()).access_token;
    }

    try {
      return await this.requestJson<T>(method, path, body, accessToken);
    } catch (error) {
      if (!(error instanceof LingApiError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await this.refresh();
      return this.requestJson<T>(method, path, body, refreshed.access_token);
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: unknown,
    accessToken?: string,
  ): Promise<T> {
    const response = await requestUrl({
      url: `${this.apiRoot}${path}`,
      method,
      contentType: "application/json",
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined,
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new LingApiError(response.status, response.text);
    }
    return unwrapLingResponse<T>(response.json);
  }
}
