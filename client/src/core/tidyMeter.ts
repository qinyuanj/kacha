// 整理入场基线独立于后续重测：旧的当前量响应可以丢弃，入场量必须保留。
import { boardBytes, type BoardMeasure } from "./tidy";

export interface TidyMeasurement {
  measure: BoardMeasure | null;
  before: number | null;
  /** 最近一次量失败（读不出画板或存储报错）；此时界面显示未知，不当作 0。 */
  failed?: boolean;
}

export class TidyMeter {
  private state: TidyMeasurement = { measure: null, before: null };
  private revision = 0;
  private disposed = false;
  private readonly entry: Promise<BoardMeasure>;

  constructor(private readonly entryText: string, private readonly measure: (text: string) => Promise<BoardMeasure>, private readonly changed: (state: TidyMeasurement) => void) {
    this.entry = measure(entryText);
    void this.entry.then((value) => this.publish({ ...this.state, before: boardBytes(value) }), () => undefined);
  }

  update(text: string): void {
    const revision = ++this.revision;
    void (text === this.entryText ? this.entry : this.measure(text)).then((value) => {
      if (revision === this.revision) this.publish({ ...this.state, measure: value, failed: false });
    }, () => {
      // 量不出来就说量不出来：沿用上一份数会让界面报一个已经不成立的体量。
      if (revision === this.revision) this.publish({ ...this.state, measure: null, failed: true });
    });
  }

  dispose(): void { this.disposed = true; }

  private publish(state: TidyMeasurement): void {
    if (this.disposed) return;
    this.state = state;
    this.changed(state);
  }
}
