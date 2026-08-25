// vault 文件访问口。core 下的持久层（积分账本、目标树）都只认这个接口，
// 不 import "obsidian"，所以整条落盘链路都能在 node --test 里跑真的。

export interface VaultIo {
  /** 文件不存在返回 null；读不动要抛，让上层知道 */
  read(path: string): Promise<string | null>;
  /** 内容没变就不写盘，返回是否真的写了 */
  writeIfChanged(path: string, content: string): Promise<boolean>;
  /** 目录下的 .md 文件名（不含路径）；目录不存在返回空数组 */
  listMarkdown(folder: string): Promise<string[]>;
  /** 目录下的子目录名（不含路径）；目录不存在返回空数组 */
  listFolders(folder: string): Promise<string[]>;
  /**
   * 删掉一个文件，返回是否真的删了。候选区「移进归档」拆成先写归档、再删原件两步，
   * 所以调用方要保证归档已经落盘——这个口子本身不做保护。
   */
  remove(path: string): Promise<boolean>;
}

/**
 * 「这次载入以为文件不在，盘上却有」——任务表、月账、目标树都是整份重写的，
 * 这时候写下去就是抹掉人写的东西，所以宁可不写（AME-227 的冷启动竞态）。
 *
 * 单独一个类型是为了让 UI 认得出来：这类错的文案是给人看的、能照着做，
 * 要原样弹出去，不能和别的写盘失败一样只丢一句「详情见开发者控制台」。
 */
export class StaleMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleMissingError";
  }
}
