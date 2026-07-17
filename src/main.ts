import {
  Notice,
  Platform,
  Plugin,
  TFile,
  type ObsidianProtocolData,
} from "obsidian";

import { LingApiClient } from "./api";
import { randomId } from "./crypto";
import { registerForegroundLifecycle } from "./foreground-lifecycle";
import { requestPairingConsent } from "./pairing-modal";
import { normalizeFolderPaths } from "./path-policy";
import {
  assertPairingApiMatches,
  normalizeApiRoot,
  runAfterPairingConsent,
} from "./pure";
import { LingSyncSettingTab } from "./settings-tab";
import { SyncCoordinator } from "./sync-coordinator";
import { ObsidianTokenStore } from "./token-store";
import { DEFAULT_API_BASE_URL, type LingSyncSettings } from "./types";

const LOCAL_STATE_KEY = "ling-sync-local-state";

type LocalState = Pick<
  LingSyncSettings,
  | "deviceId"
  | "connection"
  | "cursor"
  | "accessExpiresAt"
  | "refreshExpiresAt"
  | "lastError"
>;

export default class LingSyncPlugin extends Plugin {
  override settings = {} as LingSyncSettings;

  private coordinator!: SyncCoordinator;
  private tokenStore!: ObsidianTokenStore;
  private api!: LingApiClient;
  private settingTab!: LingSyncSettingTab;
  private saveChain: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.tokenStore = new ObsidianTokenStore(
      this.app.secretStorage,
      this.settings.vaultId,
      this.settings,
      () => this.saveSettings(),
    );
    this.api = new LingApiClient(this.settings.apiBaseUrl, this.tokenStore);
    this.coordinator = new SyncCoordinator(
      this.app,
      this.settings,
      this.api,
      () => this.saveSettings(),
      () => this.settingTab?.refresh(),
    );
    this.settingTab = new LingSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerObsidianProtocolHandler("ling-sync", (parameters) => {
      void this.handlePairingProtocol(parameters);
    });
    this.addCommand({
      id: "reconcile",
      name: "Reconcile selected notes with Ling",
      callback: () => {
        void this.coordinator
          .reconcile()
          .then(() => new Notice("Ling Sync reconciliation complete."))
          .catch((error: unknown) =>
            new Notice(error instanceof Error ? error.message : String(error)),
          );
      },
    });
    this.registerLifecycleEvents();

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      void this.coordinator.start().catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    });
  }

  override onunload(): void {
    this.coordinator.stop();
  }

  async applyConfiguration(): Promise<void> {
    normalizeApiRoot(this.settings.apiBaseUrl);
    this.settings.folderPaths = normalizeFolderPaths(this.settings.folderPaths);
    this.api.setBaseUrl(this.settings.apiBaseUrl);
    await this.saveSettings();
    if (this.settings.connection) {
      await this.coordinator.reconcile();
    }
    this.settingTab.refresh();
  }

  saveSettings(): Promise<void> {
    const {
      deviceId,
      connection,
      cursor,
      accessExpiresAt,
      refreshExpiresAt,
      lastError,
      ...vaultSettings
    } = this.settings;
    this.app.saveLocalStorage(LOCAL_STATE_KEY, {
      deviceId,
      connection,
      cursor,
      accessExpiresAt,
      refreshExpiresAt,
      lastError,
    } satisfies LocalState);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => this.saveData(vaultSettings));
    return this.saveChain;
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LingSyncSettings> | null;
    const local = this.app.loadLocalStorage(LOCAL_STATE_KEY) as Partial<LocalState> | null;
    this.settings = {
      apiBaseUrl: loaded?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      vaultId: loaded?.vaultId ?? randomId(),
      deviceId: local?.deviceId ?? randomId(),
      folderPaths: normalizeFolderPaths(loaded?.folderPaths ?? [""]),
      connection: local?.connection ?? null,
      cursor: local?.cursor ?? 0,
      accessExpiresAt: local?.accessExpiresAt ?? null,
      refreshExpiresAt: local?.refreshExpiresAt ?? null,
      noteIds: loaded?.noteIds ?? {},
      lastError: local?.lastError ?? null,
    };
    await this.saveSettings();
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.coordinator.handleCreate(file);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.coordinator.handleModify(file);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.coordinator.handleRename(file, oldPath);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.coordinator.handleDelete(file);
        }
      }),
    );
  }

  private registerLifecycleEvents(): void {
    registerForegroundLifecycle(
      {
        onFocus: (listener) => this.registerDomEvent(window, "focus", listener),
        onVisibilityChange: (listener) =>
          this.registerDomEvent(document, "visibilitychange", listener),
        isVisible: () => document.visibilityState === "visible",
      },
      () => this.coordinator.handleAppResume(),
    );
  }

  private async handlePairingProtocol(
    parameters: ObsidianProtocolData,
  ): Promise<void> {
    try {
      const pairingId = parameters.pairing_id;
      const pairingCode = parameters.pairing_code;
      if (!pairingId || !pairingCode) {
        throw new Error("The Ling pairing link is missing pairing_id or pairing_code.");
      }

      assertPairingApiMatches(
        this.settings.apiBaseUrl,
        parameters.api_base_url,
      );
      const consented = await requestPairingConsent(this.app, {
        apiRoot: normalizeApiRoot(this.settings.apiBaseUrl),
        vaultName: this.app.vault.getName(),
        folderPaths: normalizeFolderPaths(this.settings.folderPaths),
      });
      await runAfterPairingConsent(consented, async () => {
        this.api.setBaseUrl(this.settings.apiBaseUrl);
        await this.saveSettings();
        await this.coordinator.claim({
          pairingId,
          pairingCode,
          vaultName: this.app.vault.getName(),
          deviceName: Platform.isMobileApp
            ? "Obsidian Mobile"
            : "Obsidian Desktop",
        });
        new Notice("Obsidian is connected to Ling.");
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

}
