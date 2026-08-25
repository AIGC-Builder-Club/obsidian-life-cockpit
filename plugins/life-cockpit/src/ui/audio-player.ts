import { App, Component, Notice } from "obsidian";
import { musicAction, trackForSegment } from "../core/music";
import type { MusicSettings, MusicTrack } from "../core/music";
import type { SegmentKind, TimerStatus } from "../core/timer";

/**
 * 运行时音乐。曲目是 vault 内的文件，靠 `getResourcePath` 换成播得动的地址——
 * **不联网、不内置音频**，放什么由仓库主人自己往 vault 里丢。
 *
 * 每秒 tick 都会调一次 `sync`，所以「同一首继续放」必须什么都不做：
 * 判定在 `core/music.ts` 里，这里只负责执行 start / switch / stop 三个动作。
 */
export class AudioPlayer extends Component {
  private app: App;
  private element: HTMLAudioElement | null = null;
  /** 正在放的那一首的 vault 路径；null = 没在放 */
  private playing: string | null = null;
  /** 同一首曲子只抱怨一次，别每秒弹一条 */
  private complainedFor: string | null = null;

  constructor(app: App) {
    super();
    this.app = app;
  }

  get current(): string | null {
    return this.playing;
  }

  sync(settings: MusicSettings, kind: SegmentKind, status: TimerStatus): void {
    const next = trackForSegment(settings, kind, status);
    const action = musicAction(this.playing, next);
    if (action === "none") {
      // 同一首继续放，但音量可能刚在设置里调过。
      if (next && this.element) this.element.volume = next.volume;
      return;
    }
    if (action === "stop" || !next) {
      this.stop();
      return;
    }
    this.play(next);
  }

  stop(): void {
    if (this.element) {
      this.element.pause();
      this.element.remove();
      this.element = null;
    }
    this.playing = null;
  }

  onunload(): void {
    this.stop();
  }

  private play(track: MusicTrack): void {
    this.stop();
    const source = this.app.vault.adapter.getResourcePath(track.path);
    const audio = new Audio(source);
    audio.loop = track.loop;
    audio.volume = track.volume;
    audio.addEventListener("error", () => {
      // 路径写错是最常见的情况，说清楚是哪一条，别只留一个静音。
      if (this.complainedFor === track.path) return;
      this.complainedFor = track.path;
      new Notice(`放不出这首曲子：${track.path}。检查一下路径是不是 vault 内的音频文件。`);
    });
    void audio.play().catch(() => {
      // 自动播放被挡住之类：交给上面那个 error 监听说话，这里不重复弹。
    });
    this.element = audio;
    this.playing = track.path;
    if (this.complainedFor !== track.path) this.complainedFor = null;
  }
}
