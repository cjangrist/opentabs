export interface RetainableRun {
  done: boolean;
  error: unknown;
  close: () => void;
}

export class RunRetention<TRun extends RetainableRun> {
  private readonly runs = new Map<string, TRun>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly retentionMs: number) {}

  retain(key: string, run: TRun): void {
    clearTimeout(this.timers.get(key));
    this.runs.set(key, run);
    this.timers.set(
      key,
      setTimeout(() => {
        if (this.runs.get(key) !== run) return;
        this.runs.delete(key);
        this.timers.delete(key);
        if (!run.done && !run.error) run.close();
      }, this.retentionMs),
    );
  }

  get(key: string): TRun | undefined {
    return this.runs.get(key);
  }
}
