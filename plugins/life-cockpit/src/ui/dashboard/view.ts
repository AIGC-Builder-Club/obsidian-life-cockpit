// 把那张 React 页挂进 Obsidian 的一个 ItemView。
//
// **这个文件是唯一同时碰 Obsidian 和 React 的地方**，所以它很薄：
// 建 root、渲染、卸载时收干净。`App.tsx` 那边一个 `import "obsidian"` 都没有，
// 将来要拆成独立网站，换掉的就只有这一个文件。

import { ItemView, WorkspaceLeaf } from "obsidian";
import { createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { App, ConvexBridge, Route } from "./App";

export const DASHBOARD_VIEW_TYPE = "life-cockpit-dashboard";
export const WECHAT_PERSONA_VIEW_TYPE = "life-cockpit-wechat-personas";

/**
 * 两个 ItemView 共用这一个基类：**同一个 React 项目，只是落在不同路由**。
 * 分成两个 view type 而不是一个，是因为 Obsidian 的 leaf 是按 type 找的——
 * 一个 type 的话，「打开画像」只会把已经开着的数据台切过去，
 * 而人通常是想两页并排看。
 */
abstract class ReactPageView extends ItemView {
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private bridge: ConvexBridge,
    private today: () => string,
    private route: Route,
  ) {
    super(leaf);
  }

  async onOpen(): Promise<void> {
    const host = this.containerEl.children[1] as HTMLElement;
    host.empty();
    host.addClass("life-cockpit-dashboard-host");
    this.root = createRoot(host);
    this.render();
  }

  /** 账本日翻篇、或者设置改了之后重画。 */
  render(): void {
    this.root?.render(
      createElement(App, {
        bridge: this.bridge,
        today: this.today(),
        route: this.route,
      }),
    );
  }

  async onClose(): Promise<void> {
    // **必须 unmount**：不 unmount 的话 React 里那些 useEffect 的退订不会跑，
    // 于是每开关一次视图就漏一个 Convex 订阅，而漏掉的订阅还在计费。
    this.root?.unmount();
    this.root = null;
  }
}

export class DashboardView extends ReactPageView {
  constructor(leaf: WorkspaceLeaf, bridge: ConvexBridge, today: () => string) {
    super(leaf, bridge, today, "dashboard");
  }
  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return "驾驶舱数据台"; }
  getIcon(): string { return "bar-chart-3"; }
}

export class WechatPersonaView extends ReactPageView {
  constructor(leaf: WorkspaceLeaf, bridge: ConvexBridge, today: () => string) {
    super(leaf, bridge, today, "wechat");
  }
  getViewType(): string { return WECHAT_PERSONA_VIEW_TYPE; }
  getDisplayText(): string { return "微信画像"; }
  getIcon(): string { return "contact"; }
}
