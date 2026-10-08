// ShrimpX V2 — 定期取得の「いつ呼ぶか」だけを決める核（BW-1・転送量削減）
//
// React から切り離してあるのは、次の4つを実際に確かめられるようにするため。
//   - 非表示タブでは取得しない／表示へ戻った瞬間に1回取得する
//   - 前の取得が終わるまで次を始めない（重複取得の防止）
//   - 失敗が続くあいだは間隔を倍々に延ばす（上限あり）、成功で元へ戻す
//   - 認証切れ（401/403）を受けたら以後の自動取得を止める
// タイマー・可視状態・リスナー登録はすべて外から渡す（PollingClock）ので、
// テストでは偽のクロックを渡して決定的に検証できる。
//
// 取得そのもの（何を送り、何を受けるか）は呼び出し側の責務。
// ゲーム計算・保存形式には一切関与しない。

/** 1回の取得の結果。呼び出し側がこれを返すことで、次回の間隔が決まる。 */
export type PollOutcome =
  /** 取得できた（変化の有無は問わない）。間隔を基準値へ戻す。 */
  | "ok"
  /** 通信・サーバー側の失敗。間隔を延ばして再試行する。 */
  | "error"
  /** 認証切れ。以後の自動取得を止める。 */
  | "unauthorized";

/** タイマーと可視状態の外部依存。ブラウザでは window / document を包む。 */
export interface PollingClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** いまタブが非表示か。 */
  isHidden(): boolean;
  /** 「表示へ戻った」通知の購読。戻り値は解除関数。 */
  onVisible(listener: () => void): () => void;
}

export interface VisiblePollingLoopOptions {
  readonly intervalMs: number;
  readonly maxIntervalMs: number;
  /** 1回ぶんの取得。並行して呼ばれることはない。 */
  readonly poll: () => Promise<PollOutcome>;
  readonly clock: PollingClock;
}

export interface VisiblePollingLoop {
  /** 以後の取得を完全に止め、購読も解除する。 */
  stop(): void;
}

export function startVisiblePollingLoop({ intervalMs, maxIntervalMs, poll, clock }: VisiblePollingLoopOptions): VisiblePollingLoop {
  let stopped = false; // stop() もしくは認証切れ
  let timer: unknown = null;
  let inFlight = false;
  let delay = intervalMs;

  const clear = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    clear();
    timer = clock.setTimeout(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // 非表示のあいだは取得しない。表示へ戻ったときに onVisible が拾う。
    if (clock.isHidden()) {
      schedule(delay);
      return;
    }
    // 前の取得が終わっていないあいだは始めない（重複取得の防止）。
    if (inFlight) {
      schedule(delay);
      return;
    }
    inFlight = true;
    let outcome: PollOutcome = "error";
    try {
      outcome = await poll();
    } catch {
      outcome = "error";
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (outcome === "unauthorized") {
      // 叩き続けない。復帰はログインし直して画面を開き直す操作に委ねる。
      stopped = true;
      clear();
      unsubscribe();
      return;
    }
    delay = outcome === "error" ? Math.min(delay * 2, maxIntervalMs) : intervalMs;
    schedule(delay);
  };

  const unsubscribe = clock.onVisible(() => {
    if (stopped) return;
    // 戻ってきた時点の状態を見せたいので、待たずに1回取得する。
    delay = intervalMs;
    schedule(0);
  });

  // 初回取得も effect 本体から直接呼ばず、タイマー経由にそろえる。
  schedule(0);

  return {
    stop: () => {
      stopped = true;
      clear();
      unsubscribe();
    },
  };
}
