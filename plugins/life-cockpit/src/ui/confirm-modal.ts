import { App, Modal, Setting } from "obsidian";

/** 破坏性动作的确认窗。不用原生 confirm——Obsidian 里那玩意儿会把窗口抢走。 */
export class ConfirmModal extends Modal {
  private title: string;
  private body: string;
  private confirmText: string;
  private onConfirm: () => void;

  constructor(
    app: App,
    options: { title: string; body: string; confirmText?: string; onConfirm: () => void },
  ) {
    super(app);
    this.title = options.title;
    this.body = options.body;
    this.confirmText = options.confirmText ?? "确认";
    this.onConfirm = options.onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createDiv({ cls: "life-cockpit-hint", text: this.body });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("取消");
        button.onClick(() => this.close());
      })
      .addButton((button) => {
        button.setButtonText(this.confirmText).setWarning();
        button.onClick(() => {
          this.close();
          this.onConfirm();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
