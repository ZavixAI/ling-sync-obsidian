import type { SecretStorage } from "obsidian";

import type { LingSyncSettings, TokenEnvelope } from "./types";

export class ObsidianTokenStore {
  private readonly accessSecretId: string;
  private readonly refreshSecretId: string;

  constructor(
    private readonly secretStorage: SecretStorage,
    vaultId: string,
    private readonly settings: LingSyncSettings,
    private readonly persistSettings: () => Promise<void>,
  ) {
    const keySuffix = vaultId.toLowerCase().replace(/[^a-z0-9-]/gu, "-");
    this.accessSecretId = `ling-sync-access-${keySuffix}`;
    this.refreshSecretId = `ling-sync-refresh-${keySuffix}`;
  }

  getAccessToken(): string | null {
    return this.secretStorage.getSecret(this.accessSecretId) || null;
  }

  getRefreshToken(): string | null {
    return this.secretStorage.getSecret(this.refreshSecretId) || null;
  }

  async save(envelope: TokenEnvelope): Promise<void> {
    this.secretStorage.setSecret(this.accessSecretId, envelope.access_token);
    this.secretStorage.setSecret(this.refreshSecretId, envelope.refresh_token);
    this.settings.accessExpiresAt = envelope.access_expires_at;
    this.settings.refreshExpiresAt = envelope.refresh_expires_at;
    this.settings.connection = envelope.connection;
    this.settings.cursor = envelope.cursor;
    await this.persistSettings();
  }

  async clear(): Promise<void> {
    this.secretStorage.setSecret(this.accessSecretId, "");
    this.secretStorage.setSecret(this.refreshSecretId, "");
    this.settings.accessExpiresAt = null;
    this.settings.refreshExpiresAt = null;
    this.settings.connection = null;
    this.settings.cursor = 0;
    this.settings.lastError = null;
    await this.persistSettings();
  }
}
