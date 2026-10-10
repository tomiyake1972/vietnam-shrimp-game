// ShrimpX V2 — 非表示タブでも止まらない「ブラウザへ制御を戻す」待機。
//
// 【なぜ必要か】Management Console の Turn 進行ループは、1Turn ごとに
// 「ブラウザへ制御を戻して進捗表示を描画させる」ための待機を1回挟んでいる。
// この待機を requestAnimationFrame で行うと、タブが非表示のあいだブラウザが
// 発火を止める／大幅に間引くため、待ち時間が1Turnあたり数秒〜十数秒に伸びる。
// 実測（三宅さん・実機）: 裏タブで1Turn 約110秒。前面なら数秒。
// 計算そのものは遅くなっていない。待っているだけである。
//
// 【MessageChannel を使う理由】postMessage のコールバックは macrotask として
// 実行され、タブが非表示でも間引かれない。
// setTimeout は非表示タブで最小間隔が 1000ms 近くまで伸びる実装があるため主経路にしない。
// React 自身の scheduler も同じ理由で MessageChannel を使っている。
//
// 【描画は妨げない】macrotask の境目でブラウザは描画できるため、
// 前面タブでの進捗表示はこれまでどおり更新される。
// 実測（この作業環境・前面タブ・32回ぶん）:
//   requestAnimationFrame 529.0 ms（1回 16.5 ms＝60fps待ち）
//   MessageChannel          2.1 ms（1回  0.1 ms）
//   setTimeout(0)         108.8 ms（1回  3.4 ms）
// 裏タブでの改善幅はこの環境では未実測（headless では visibilityState を
// hidden にできない）。配備後に実機ブラウザで再確認が必要。
// 計測スクリプト: scripts/int1/measureTabYield.ts
//
// 【ゲーム計算には影響しない】この待機はスケジューリングだけを担う。
// Turn の計算順序・入力・結果は変わらない。

/**
 * 待機の実装に必要なものだけを受け取る（テストで差し替えるため）。
 * requestAnimationFrame は意図的に受け取らない（使わないことを型で示す）。
 */
export interface YieldScope {
  readonly MessageChannel?: typeof MessageChannel;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
}

/** どちらの経路で待機したか（テスト・診断用）。 */
export type YieldImplementation = "messageChannel" | "setTimeout";

/** この環境でどちらの経路を使うか。 */
export function resolveYieldImplementation(scope: YieldScope): YieldImplementation {
  return typeof scope.MessageChannel === "function" ? "messageChannel" : "setTimeout";
}

/**
 * ブラウザへ1回だけ制御を戻す。
 *
 * MessageChannel が使えればそれを使い、無い環境（古いブラウザ・SSR）では
 * setTimeout(0) へ落ちる。どちらの場合も解決は1回だけで、
 * MessageChannel の port は必ず閉じる（開いたままにすると解放されない）。
 */
export function yieldOnceWith(scope: YieldScope): Promise<YieldImplementation> {
  const ChannelCtor = scope.MessageChannel;
  if (typeof ChannelCtor === "function") {
    return new Promise<YieldImplementation>((resolve) => {
      const channel = new ChannelCtor();
      let settled = false;
      channel.port1.onmessage = (): void => {
        if (settled) return;
        settled = true;
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        resolve("messageChannel");
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise<YieldImplementation>((resolve) => {
    scope.setTimeout(() => resolve("setTimeout"), 0);
  });
}

/** 実行環境の global を使う版。製品コードはこちらを呼ぶ。 */
export function yieldToBrowser(): Promise<YieldImplementation> {
  return yieldOnceWith(globalThis as unknown as YieldScope);
}
