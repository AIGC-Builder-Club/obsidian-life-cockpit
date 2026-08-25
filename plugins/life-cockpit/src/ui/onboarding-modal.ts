import { App, Modal, Setting } from "obsidian";
import { COCKPIT_ROOT, cockpitPaths, MODE_IDS, MODE_LABELS } from "../core/settings";
import type { LifeCockpitSettings } from "../core/settings";
import { EXPERTISE_IDS, EXPERTISE_LABELS, isExpertise } from "../core/expertise";

/**
 * 首次运行引导（AME-317）。三个问题一屏问完——**不是向导流水线**：
 *
 *   1. 数据落在哪个文件夹（预填现在真正的数据根，原样确认等于什么都没改）；
 *   2. 思考优先还是加速实践；
 *   3. 新手还是专家。
 *
 * 关掉就是做过选择：跳过、ESC、点外面，`onboardingDone` 都置真，
 * 这辈子只在真的第一次弹。想重来的人删掉 data.json 里的 `onboardingDone`。
 */
export class OnboardingModal extends Modal {
  private readonly settings: LifeCockpitSettings;
  /** 进门时的数据根。文件夹那一问「没动过」的判定基准。 */
  private readonly initialRoot: string;
  private readonly onFinish: () => Promise<void> | void;
  private folderInput = "";
  private folderTouched = false;
  /** onClose 只收尾一次：确认按钮自己先置真，再借 close() 关窗。 */
  private finished = false;

  constructor(
    app: App,
    options: {
      settings: LifeCockpitSettings;
      /** 现在真正的数据根（`inferCockpitRoot` 推不出来时是中性默认） */
      currentRoot: string;
      onFinish: () => Promise<void> | void;
    },
  ) {
    super(app);
    this.settings = options.settings;
    this.initialRoot = options.currentRoot;
    this.onFinish = options.onFinish;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.createEl("h3", { text: "欢迎使用人生驾驶舱" });
    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text: "三个问题，问完就能用。不想现在定就跳过——之后随时能在设置里改。",
    });

    new Setting(contentEl)
      .setName("数据落在哪个文件夹")
      .setDesc(
        `番茄流水、积分账本、目标树、候选区、复盘日记、复盘素材、飞书快照、秒哒写作` +
          `都在它下面。留空用默认的 ${COCKPIT_ROOT}/。`,
      )
      .addText((text) => {
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.initialRoot);
        text.onChange((value) => {
          this.folderInput = value.trim();
          this.folderTouched = true;
        });
      });

    new Setting(contentEl)
      .setName("节奏")
      .setDesc("思考优先 25+5，加速实践 45+10。要想清楚再动手选前者，一头扎进去干选后者。")
      .addDropdown((dropdown) => {
        for (const id of MODE_IDS) dropdown.addOption(id, MODE_LABELS[id]);
        dropdown.setValue(this.settings.activeMode);
        dropdown.onChange((value) => {
          if (value === "thinking-first" || value === "accelerated-practice") {
            this.settings.activeMode = value;
          }
        });
      });

    new Setting(contentEl)
      .setName("界面档位")
      .setDesc("新手只留最常用的几项；专家把所有旋钮都摆出来。默认新手。")
      .addDropdown((dropdown) => {
        for (const id of EXPERTISE_IDS) dropdown.addOption(id, EXPERTISE_LABELS[id]);
        dropdown.setValue(this.settings.expertise);
        dropdown.onChange((value) => {
          if (isExpertise(value)) this.settings.expertise = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("跳过");
        button.onClick(() => this.close());
      })
      .addButton((button) => {
        button.setButtonText("就这样，开始用").setCta();
        button.onClick(() => void this.confirm());
      });
  }

  /** 记下三个答案和「引导放过了」，然后关窗。 */
  private async confirm(): Promise<void> {
    // 文件夹那一问没动过预填值就一个字不改——老机器的路径存在 data.json 里，
    // 引导没有资格替它搬家。动过才整组换根；清空了就是明说要默认位置。
    if (this.folderTouched) {
      Object.assign(this.settings, cockpitPaths(this.folderInput || COCKPIT_ROOT));
    }
    this.finished = true;
    this.settings.onboardingDone = true;
    this.close();
    await this.onFinish();
  }

  onClose(): void {
    // 跳过、ESC、点外面——统统算做过选择：引导只弹这一次。
    if (!this.finished) {
      this.finished = true;
      this.settings.onboardingDone = true;
      void this.onFinish();
    }
    this.contentEl.empty();
  }
}
