# Life Cockpit · 人生驾驶舱

**把日记模板里画出来的作息表，跑成一个真的会打断你的 Obsidian 桌面插件。**

番茄计时、当日 560 分钟进度、积分账本、六层目标树、夜班 AI 产物的候选区拍板面、睡前复盘，
以及把这些推到 Obsidian 窗口之外的推动器——纯本地运行，离线完整可用。
它是什么、为什么做成这样、做到了哪一步：**读 [`plugins/life-cockpit/README.md`](plugins/life-cockpit/README.md)**。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `plugins/life-cockpit/` | 插件源码、605 条回归用例、构建配置与全部插件文档（[使用手册](plugins/life-cockpit/docs/使用手册.md) · [快速上手](plugins/life-cockpit/docs/快速上手.md)） |
| `dist/life-cockpit/` | 安装三件套 `main.js` / `manifest.json` / `styles.css`（与 Release assets 同源） |
| `docs/` | 设计文档：[人生驾驶舱-LifeCockpit](docs/人生驾驶舱-LifeCockpit.md) · [飞书金字塔表格-快照约定](docs/飞书金字塔表格-快照约定.md) |

## 安装

- **BRAT**：`Add Beta Plugin` → 填 `hanshou101/obsidian-life-cockpit`。
- **手动**：从 [Releases](https://github.com/hanshou101/obsidian-life-cockpit/releases) 下载
  `main.js`、`manifest.json`、`styles.css`，放进笔记库的
  `.obsidian/plugins/life-cockpit/` 后重载。
- **从源码构建**：`cd plugins/life-cockpit && npm install && npm run build`。

20 分钟零后端跑通第一个番茄：见[快速上手](plugins/life-cockpit/docs/快速上手.md)。

## License

本仓库整体以 [AGPL-3.0-only](LICENSE) 发布——源码、文档与安装产物同属一个 license。
