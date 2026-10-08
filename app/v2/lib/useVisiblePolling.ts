"use client";

// ShrimpX V2 — 画面の定期更新を「必要なときだけ」行う共通フック（BW-1・転送量削減）
//
// 【なぜ必要か】GM Console の Seat 一覧（5秒）と Independent Player の
// 意思決定画面（4秒）は setInterval で無条件に取得していた。開いたまま放置された
// タブ、失敗し続けている通信、前の取得が終わっていない状態でも等間隔で叩き続けるため、
// Redis の転送量をそのぶん消費する。
//
// 判断そのもの（いつ呼ぶか）は visiblePollingLoop.ts が持つ。ここはそれを
// React のライフサイクルとブラウザの API へ繋ぐだけに留める
// （そうすることで、非表示タブ停止・重複防止・backoff・認証切れ停止を
//   偽のクロックで実際に検証できる）。

import { useEffect, useRef } from "react";
import { PollOutcome, PollingClock, startVisiblePollingLoop } from "./visiblePollingLoop";

export type { PollOutcome } from "./visiblePollingLoop";

export interface VisiblePollingOptions {
  /** 通常時の取得間隔（ms）。 */
  readonly intervalMs: number;
  /** false のあいだは一切取得しない（runId 未確定など）。 */
  readonly enabled: boolean;
  /** 1回ぶんの取得。並行して呼ばれることはない。 */
  readonly poll: () => Promise<PollOutcome>;
  /** 失敗時に延ばす上限（ms）。既定 60 秒。 */
  readonly maxIntervalMs?: number;
}

const browserClock: PollingClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  onVisible: (listener) => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "hidden") listener();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  },
};

export function useVisiblePolling({ intervalMs, enabled, poll, maxIntervalMs = 60_000 }: VisiblePollingOptions): void {
  // 毎描画ごとに最新の poll を持ち直す。タイマーからはこの ref 越しに呼ぶため、
  // poll の中身が変わってもループを作り直さずに済む。
  // 代入を描画中に行うと react-hooks/refs に反します（描画中の ref 更新は禁止）。
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });

  useEffect(() => {
    if (!enabled) return;
    const loop = startVisiblePollingLoop({
      intervalMs,
      maxIntervalMs,
      poll: () => pollRef.current(),
      clock: browserClock,
    });
    return () => loop.stop();
  }, [enabled, intervalMs, maxIntervalMs]);
}
