import { Modal, Setting, type App } from "obsidian";

export interface PairingConsentDetails {
  apiRoot: string;
  vaultName: string;
  folderPaths: string[];
}

class PairingConsentModal extends Modal {
  private completed = false;

  constructor(
    app: App,
    private readonly details: PairingConsentDetails,
    private readonly resolveConsent: (consented: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Connect this Vault to Ling?");
    contentEl.createEl("p", {
      text: "Ling will receive Markdown content from the selected folders after you connect.",
    });

    new Setting(contentEl)
      .setName("Ling API host")
      .setDesc(new URL(this.details.apiRoot).host);
    new Setting(contentEl).setName("Vault").setDesc(this.details.vaultName);
    new Setting(contentEl)
      .setName("Folders")
      .setDesc(
        this.details.folderPaths[0] === ""
          ? "Entire Vault"
          : this.details.folderPaths.join(", "),
      );
    new Setting(contentEl)
      .setName("Scope")
      .setDesc("Read only (notes.read, notes.sync)");
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.finish(false)),
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Connect")
          .onClick(() => this.finish(true)),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.completed) {
      this.completed = true;
      this.resolveConsent(false);
    }
  }

  private finish(consented: boolean): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.resolveConsent(consented);
    this.close();
  }
}

export function requestPairingConsent(
  app: App,
  details: PairingConsentDetails,
): Promise<boolean> {
  return new Promise((resolve) => {
    new PairingConsentModal(app, details, resolve).open();
  });
}
