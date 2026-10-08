// ShrimpX V2 — BW-1: 定期取得の作法（非表示タブ停止・重複防止・backoff・認証切れ停止）
//
// Staging の Redis が月間帯域を使い切った原因のひとつは、画面が setInterval で
// 無条件に取得し続けていたことだった。開いたまま放置されたタブ、失敗し続けている
// 通信、前の取得が終わっていない状態でも等間隔で叩いていた。
//
// ここで固定する契約
//   1. 非表示タブでは取得しない。表示へ戻った瞬間に待たずに1回取得する。
//   2. 前の取得が終わるまで次を始めない（同時に2本の取得が飛ばない）。
//   3. 失敗が続くあいだは間隔を倍々に延ばし、上限で止まる。成功したら元へ戻す。
//   4. 認証切れ（unauthorized）を受けたら、以後一切取得せずタイマーも張らない。
//   5. stop() 後は取得せず、可視状態の購読も解除する。
//
// 偽のクロックで時間を手で進めるため、結果は実行時間に依存しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { PollOutcome, PollingClock, startVisiblePollingLoop } from "../visiblePollingLoop";

interface FakeClock extends PollingClock {
  /** 指定 ms ぶん時間を進め、期限の来たタイマーを発火する。 */
  advance(ms: number): Promise<void>;
  /** 「表示へ戻った」を起こす。 */
  becomeVisible(): void;
  hidden: boolean;
  readonly pendingTimers: number;
  readonly visibleListeners: number;
}

function createFakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();
  const clock: FakeClock = {
    hidden: false,
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    isHidden: () => clock.hidden,
    onVisible(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async advance(ms) {
      // 保留していた poll が解決した直後など、まだ流れていない継続を先に流す。
      await flushMicrotasks();
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flushMicrotasks();
      }
      now = target;
    },
    becomeVisible() {
      clock.hidden = false;
      for (const listener of listeners) listener();
    },
    get pendingTimers() {
      return timers.size;
    },
    get visibleListeners() {
      return listeners.size;
    },
  };
  return clock;
}

/** await の連鎖が解けるまでマイクロタスクを流す。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function recordingPoll(outcomes: PollOutcome[] = []) {
  const calls: number[] = [];
  let resolveHeld: ((o: PollOutcome) => void) | null = null;
  const poll = (): Promise<PollOutcome> => {
    calls.push(calls.length + 1);
    const next = outcomes.shift();
    if (next === undefined) {
      // 保留して「まだ終わっていない取得」を作る。
      return new Promise<PollOutcome>((resolve) => {
        resolveHeld = resolve;
      });
    }
    return Promise.resolve(next);
  };
  return {
    poll,
    get count() {
      return calls.length;
    },
    release(outcome: PollOutcome = "ok") {
      resolveHeld?.(outcome);
      resolveHeld = null;
    },
  };
}

test("BW1-P1: 非表示タブでは取得しない。表示へ戻った瞬間に1回取得する", async () => {
  const clock = createFakeClock();
  clock.hidden = true;
  const p = recordingPoll(["ok", "ok", "ok"]);
  const loop = startVisiblePollingLoop({ intervalMs: 4000, maxIntervalMs: 60000, poll: p.poll, clock });

  await clock.advance(0);
  assert.equal(p.count, 0, "非表示なのに初回取得が走っている");
  await clock.advance(4000 * 5);
  assert.equal(p.count, 0, "非表示のあいだに取得が走っている");

  clock.becomeVisible();
  await clock.advance(0);
  assert.equal(p.count, 1, "表示へ戻っても取得されない");
  loop.stop();
});

test("BW1-P2: 前の取得が終わるまで次を始めない（同時に2本飛ばない）", async () => {
  const clock = createFakeClock();
  const p = recordingPoll(); // 1回目を保留させる
  const loop = startVisiblePollingLoop({ intervalMs: 4000, maxIntervalMs: 60000, poll: p.poll, clock });

  await clock.advance(0);
  assert.equal(p.count, 1);

  /**
   * 取得が飛んでいるあいだ、次のタイマーはまだ張られていない（schedule は
   * poll が終わってから呼ばれる）。したがって時間を進めるだけでは二重取得は
   * 起こらない。実際に危ないのは「取得中にタブが表示へ戻る」経路で、
   * ここは待たずに1回取得しようとする。その場合も既存の取得を追い越さない。
   */
  await clock.advance(4000 * 4);
  assert.equal(p.count, 1, "取得中にタイマー経由で次が始まっている（重複取得）");

  clock.becomeVisible();
  await clock.advance(0);
  clock.becomeVisible();
  await clock.advance(0);
  assert.equal(p.count, 1, "取得中にタブ復帰で2本目が始まっている（重複取得）");

  p.release("ok");
  await clock.advance(4000);
  assert.equal(p.count, 2, "取得が終わったのに次が始まらない");
  loop.stop();
});

test("BW1-P3: 失敗が続くと間隔が倍々に延び、上限で止まる", async () => {
  const clock = createFakeClock();
  const p = recordingPoll(["error", "error", "error", "error", "error", "error", "error", "error"]);
  const loop = startVisiblePollingLoop({ intervalMs: 1000, maxIntervalMs: 8000, poll: p.poll, clock });

  await clock.advance(0);
  assert.equal(p.count, 1);
  // 1回目の失敗 → 次は 2000ms 後。1999ms では来ない。
  await clock.advance(1999);
  assert.equal(p.count, 1, "backoff せずに元の間隔で再試行している");
  await clock.advance(1);
  assert.equal(p.count, 2);
  // 2回目の失敗 → 4000ms、3回目 → 8000ms、以降は上限 8000ms のまま。
  await clock.advance(4000);
  assert.equal(p.count, 3);
  await clock.advance(8000);
  assert.equal(p.count, 4);
  await clock.advance(8000);
  assert.equal(p.count, 5, "上限を超えて延び続けている");
  loop.stop();
});

test("BW1-P4: 成功したら間隔が元へ戻る", async () => {
  const clock = createFakeClock();
  const p = recordingPoll(["error", "ok", "ok"]);
  const loop = startVisiblePollingLoop({ intervalMs: 1000, maxIntervalMs: 8000, poll: p.poll, clock });

  await clock.advance(0);
  assert.equal(p.count, 1);
  await clock.advance(2000); // backoff 後の2回目（成功）
  assert.equal(p.count, 2);
  await clock.advance(1000); // 成功したので基準間隔へ戻っている
  assert.equal(p.count, 3, "成功しても間隔が元へ戻っていない");
  loop.stop();
});

test("BW1-P5: 認証切れを受けたら以後一切取得せず、タイマーも張らない", async () => {
  const clock = createFakeClock();
  const p = recordingPoll(["unauthorized"]);
  const loop = startVisiblePollingLoop({ intervalMs: 1000, maxIntervalMs: 60000, poll: p.poll, clock });

  await clock.advance(0);
  assert.equal(p.count, 1);
  assert.equal(clock.pendingTimers, 0, "認証切れ後もタイマーが残っている（叩き続ける）");
  assert.equal(clock.visibleListeners, 0, "認証切れ後も可視状態の購読が残っている");

  await clock.advance(1000 * 100);
  assert.equal(p.count, 1, "認証切れ後に取得が走っている");
  // 表示へ戻しても再開しない。
  clock.becomeVisible();
  await clock.advance(1000 * 10);
  assert.equal(p.count, 1, "認証切れ後にタブ復帰で取得が再開している");
  loop.stop();
});

test("BW1-P6: stop() 後は取得せず、購読も解除する", async () => {
  const clock = createFakeClock();
  const p = recordingPoll(["ok", "ok", "ok"]);
  const loop = startVisiblePollingLoop({ intervalMs: 1000, maxIntervalMs: 60000, poll: p.poll, clock });

  await clock.advance(0);
  assert.equal(p.count, 1);
  loop.stop();
  assert.equal(clock.pendingTimers, 0);
  assert.equal(clock.visibleListeners, 0);
  await clock.advance(1000 * 50);
  clock.becomeVisible();
  await clock.advance(1000 * 50);
  assert.equal(p.count, 1, "stop() 後に取得が走っている");
});

test("BW1-P7: poll が例外を投げても失敗扱いで継続する（画面が黙って止まらない）", async () => {
  const clock = createFakeClock();
  let calls = 0;
  const poll = async (): Promise<PollOutcome> => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return "ok";
  };
  const loop = startVisiblePollingLoop({ intervalMs: 1000, maxIntervalMs: 8000, poll, clock });

  await clock.advance(0);
  assert.equal(calls, 1);
  await clock.advance(2000); // 例外は error と同じ扱い＝backoff して再試行
  assert.equal(calls, 2, "例外のあと再試行されていない");
  loop.stop();
});
