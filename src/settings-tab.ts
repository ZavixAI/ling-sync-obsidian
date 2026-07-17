import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type SettingDefinitionItem,
} from "obsidian";

import { normalizeFolderPaths } from "./path-policy";
import type LingSyncPlugin from "./main";

export class LingSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LingSyncPlugin) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Connection",
        desc: this.connectionStatus(),
      },
      {
        name: "Ling API base URL",
        render: (setting) => this.addApiBaseUrlControl(setting),
      },
      {
        name: "Vault",
        desc: this.app.vault.getName(),
      },
      {
        name: "Folders",
        desc: "One Vault-relative folder per line. Leave blank for the whole Vault.",
        render: (setting) => this.addFolderControl(setting),
      },
      {
        name: "Configuration",
        render: (setting) => this.addApplyButton(setting),
      },
    ];
  }

  override display(): void {
    this.displayLegacySettings();
  }

  refresh(): void {
    const update = Reflect.get(this, "update");
    if (typeof update === "function") {
      update.call(this);
      return;
    }
    this.displayLegacySettings();
  }

  private displayLegacySettings(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(this.connectionStatus());

    this.addApiBaseUrlControl(
      new Setting(containerEl).setName("Ling API base URL"),
    );

    new Setting(containerEl)
      .setName("Vault")
      .setDesc(this.app.vault.getName());

    this.addFolderControl(
      new Setting(containerEl)
        .setName("Folders")
        .setDesc("One Vault-relative folder per line. Leave blank for the whole Vault."),
    );

    this.addApplyButton(new Setting(containerEl).setName("Configuration"));
  }

  private addApiBaseUrlControl(setting: Setting): void {
    setting.addText((text) =>
      text
        .setPlaceholder("https://api.withling.top")
        .setValue(this.plugin.settings.apiBaseUrl)
        .setDisabled(this.plugin.settings.connection !== null)
        .onChange((value) => {
          this.plugin.settings.apiBaseUrl = value.trim();
        }),
    );
  }

  private addFolderControl(setting: Setting): void {
    setting.addTextArea((text) =>
      text
        .setPlaceholder("Projects/Notes")
        .setValue(
          this.plugin.settings.folderPaths[0] === ""
            ? ""
            : this.plugin.settings.folderPaths.join("\n"),
        )
        .setDisabled(this.plugin.settings.connection !== null)
        .onChange((value) => {
          this.plugin.settings.folderPaths = normalizeFolderPaths(
            value.split("\n"),
          );
        }),
    );
  }

  private addApplyButton(setting: Setting): void {
    setting.addButton((button) =>
      button.setButtonText("Apply and reconcile").onClick(async () => {
        try {
          await this.plugin.applyConfiguration();
          new Notice("Ling Sync configuration applied.");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }

  private connectionStatus(): string {
    const connection = this.plugin.settings.connection;
    if (!connection) {
      return "Not connected. Start pairing in Ling; Ling will open obsidian://ling-sync.";
    }
    if (this.plugin.settings.lastError) {
      return `Connected (${connection.connection_id}). Last error: ${this.plugin.settings.lastError}`;
    }
    return `Connected (${connection.status}) · Read only. Unlink from Ling to change API or folders.`;
  }
}
