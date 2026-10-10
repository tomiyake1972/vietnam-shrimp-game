// ShrimpX V2 — 裏タブ進行遅延の修正: 「ブラウザへ制御を戻す」待機の契約
//
// ここで固定する契約
//   1. MessageChannel が使える環境では MessageChannel を使う（requestAnimationFrame は使わない）
//   2. MessageChannel が無い環境では setTimeout(0) へ落ちる
//   3. 解決は必ず1回だけ（メッセージが複数届いても二重に進まない）
//   4. MessageChannel の port は必ず両方閉じる（開いたままにしない）
//   5. requestAnimationFrame が永久に発火しない環境でも解決する（＝依存していないことの否定対照）

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveYieldImplementation, yieldOnceWith, yieldToBrowser, type YieldScope } from "../yieldToBrowser";

/** close の呼び出しを数える偽の MessageChannel。 */
function fakeMessageChannelFactory(): {
  readonly ctor: typeof MessageChannel;
  readonly closed: () => readonly string[];
  readonly deliveredTimes: () => number;
} {
  const closed: string[] = [];
  let delivered = 0;

  class FakePort {
    public onmessage: ((event: unknown) => void) | null = null;
    public constructor(private readonly label: string) {}
    public close(): void {
      closed.push(this.label);
    }
  }

  class FakeChannel {
    public readonly port1 = new FakePort("port1");
    public readonly port2: { postMessage: (value: unknown) => void; close: () => void };
    public constructor() {
      const port1 = this.port1;
      const p2 = new FakePort("port2");
      this.port2 = {
        close: () => p2.close(),
        postMessage: (): void => {
          // 本物と同じく非同期に届ける。2回届けて「1回だけ解決する」ことを見る。
          setTimeout(() => {
            delivered += 1;
            port1.onmessage?.({});
            delivered += 1;
            port1.onmessage?.({});
          }, 0);
        },
      };
    }
  }

  return {
    ctor: FakeChannel as unknown as typeof MessageChannel,
    closed: () => closed,
    deliveredTimes: () => delivered,
  };
}

test("TABYIELD-1: MessageChannel が使える環境では MessageChannel を使う", async () => {
  const fake = fakeMessageChannelFactory();
  const scope: YieldScope = {
    MessageChannel: fake.ctor,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
  };
  assert.equal(resolveYieldImplementation(scope), "messageChannel");
  assert.equal(await yieldOnceWith(scope), "messageChannel");
});

test("TABYIELD-2: MessageChannel が無ければ setTimeout(0) へ落ちる", async () => {
  const calls: number[] = [];
  const scope: YieldScope = {
    MessageChannel: undefined,
    setTimeout: (cb, ms) => {
      calls.push(ms);
      return setTimeout(cb, ms);
    },
  };
  assert.equal(resolveYieldImplementation(scope), "setTimeout");
  assert.equal(await yieldOnceWith(scope), "setTimeout");
  // 間隔は0。非表示タブで伸ばされる余地を自分から作らない。
  assert.deepEqual(calls, [0]);
});

test("TABYIELD-3: メッセージが2回届いても解決は1回だけ", async () => {
  const fake = fakeMessageChannelFactory();
  let resolvedTimes = 0;
  const scope: YieldScope = { MessageChannel: fake.ctor, setTimeout: (cb, ms) => setTimeout(cb, ms) };
  await yieldOnceWith(scope).then(() => {
    resolvedTimes += 1;
  });
  // 偽チャネルは2回配信している（＝二重解決し得る状況を作っている）。
  assert.equal(fake.deliveredTimes(), 2, "偽チャネルが2回配信していない＝この検査が意味を持たない");
  assert.equal(resolvedTimes, 1);
});

test("TABYIELD-4: port を両方とも閉じる", async () => {
  const fake = fakeMessageChannelFactory();
  const scope: YieldScope = { MessageChannel: fake.ctor, setTimeout: (cb, ms) => setTimeout(cb, ms) };
  await yieldOnceWith(scope);
  assert.deepEqual([...fake.closed()].sort(), ["port1", "port2"]);
});

test("TABYIELD-5: requestAnimationFrame が永久に発火しなくても解決する（否定対照）", async () => {
  const globals = globalThis as unknown as { requestAnimationFrame?: unknown };
  const original = globals.requestAnimationFrame;
  let rafCalls = 0;
  // 裏タブで止まった requestAnimationFrame を再現する（呼ばれても二度と発火しない）。
  globals.requestAnimationFrame = (): number => {
    rafCalls += 1;
    return 0;
  };
  try {
    const implementation = await yieldToBrowser();
    assert.equal(implementation, "messageChannel", "この環境の global は MessageChannel を持つ想定");
    assert.equal(rafCalls, 0, "requestAnimationFrame が呼ばれている＝裏タブで止まる経路が残っている");
  } finally {
    if (original === undefined) delete globals.requestAnimationFrame;
    else globals.requestAnimationFrame = original;
  }
});

test("TABYIELD-6: 実行環境の global でそのまま動く", async () => {
  assert.equal(await yieldToBrowser(), "messageChannel");
});
