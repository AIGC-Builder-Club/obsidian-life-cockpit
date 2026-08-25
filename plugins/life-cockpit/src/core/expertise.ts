// 新手 / 专家两档设置面。判断在这里，灰不灰得起来在 ../settings-tab.ts。
//
// AME-244 原话：
//
//   「目前，我看了一下——【可配置项】实在是太多、太复杂了（就连我这个设计者，
//    看上去 很多选项不自己亲手折腾一下，也会不知道啥意思）；建议你【增加
//    新手-开箱即用模式/专家模式】两种；默认是【新手-开箱即用模式】——大部分设置
//    选项，是灰色的不许修改、仅查看；少部分设置，是可以手动修改的。」
//
// 于是这一层只回答一个问题：**这一项，现在允不允许改。**
//
// 划线的规矩写死成一句话，免得以后一项一项地讨价还价：
//
//   **新手模式下能改的只有两类——「这台电脑的显示偏好」和「这一层功能要不要」。
//   所有参数、阈值、路径、凭据一律只读。**
//
// 为什么是这两类：换一台电脑就要重调的东西（字号）不给改等于不能用；而每一层
// 功能的总开关是**反悔口子**——一个会锁屏、会闪屏的插件，人必须随时关得掉它，
// 哪怕他还没搞懂下面那二十个参数。剩下的（催几轮、闪多久、账本落在哪）恰恰是
// 「不自己亲手折腾一下也不知道啥意思」的那一批，它们有默认值，新手不该被它们绊住。
//
// 注意这一层**不隐藏**任何设置：灰着但看得见（原话「灰色的不许修改、仅查看」）。
// 藏起来的话，人连「原来这个东西可以调」都不知道，那是另一种形式的复杂。

export type ExpertiseId = "beginner" | "expert";

export const EXPERTISE_IDS: ExpertiseId[] = ["beginner", "expert"];

export const EXPERTISE_LABELS: Record<ExpertiseId, string> = {
  beginner: "新手 · 开箱即用",
  expert: "专家 · 全部可改",
};

export interface ExpertiseSettings {
  /** 设置面的档位。**默认新手**（原话）：见本文件抬头 */
  expertise: ExpertiseId;
}

export function isExpertise(value: unknown): value is ExpertiseId {
  return typeof value === "string" && EXPERTISE_IDS.includes(value as ExpertiseId);
}

/**
 * 这一项现在能不能改。
 *
 * `beginnerOpen` 由设置页在**建这一项的时候**标出来（`openInBeginner()`），
 * 不是在这里按名字对表——按名字对表的话，改一次文案就会有一项悄悄地锁死，
 * 而那种 bug 谁也不会发现（人只会以为「本来就不让改」）。
 */
export function canEditSetting(expertise: ExpertiseId, beginnerOpen: boolean): boolean {
  return expertise === "expert" || beginnerOpen;
}

/** 设置页顶上那一行：现在是哪一档、这一档意味着什么。 */
export function describeExpertise(expertise: ExpertiseId): string {
  return expertise === "expert"
    ? "专家模式：所有选项都可以改。切回新手模式**不会**把改过的值还原——它只是把它们锁上。"
    : "新手模式：开箱即用。灰着的项仍然看得见、只是不许改；能改的只有界面字号和各层功能的总开关。要全部可改就切到专家模式。";
}
