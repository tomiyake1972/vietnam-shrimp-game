"use client";

// ShrimpX V2 — PLAYER-INTRO-1 §3/§8: 導入の表示状態（ブラウザ内のみ）
//
// 【保存スキーマ・認証条件を変えない】導入を読んだか・歩留まり前提を確認したかは
// localStorage だけで扱う。Redis の保存物・PlayerDecisionContext・提出APIには
// 一切触れない（新しい永続フィールドを作らない）。
//
// 【記録できなくても進める】private window・site data 無効・容量超過などで
// localStorage が使えない環境では読み書きが例外を投げるため、すべて try/catch で
// 包み、読めなければ「未確認」として扱う。確認操作そのものは常にその場で成立し、
// 画面の state だけで先へ進める（§3「記録できない場合も、その場で確認して進められる」）。

const KEY_PREFIX = "shrimpx.v2.playerIntro.";

/** Run ごとに分ける（別のRunへ参加したら導入をもう一度出す）。 */
function keyFor(simulationRunId: string, suffix: string): string {
  return `${KEY_PREFIX}${simulationRunId}.${suffix}`;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** 書き込みの成否を返す（false なら「この端末には記録できていない」と画面へ出せる）。 */
function writeFlag(key: string): boolean {
  try {
    window.localStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

/** 導入を一度読み終えたか。 */
export function hasSeenIntro(simulationRunId: string): boolean {
  return readFlag(keyFor(simulationRunId, "seen"));
}

export function markIntroSeen(simulationRunId: string): boolean {
  return writeFlag(keyFor(simulationRunId, "seen"));
}

/**
 * 歩留まり100％の前提を確認したか。
 * 導入をスキップしてもこの確認だけは残す（§3）。
 */
export function hasAcknowledgedYieldAssumption(simulationRunId: string): boolean {
  return readFlag(keyFor(simulationRunId, "yieldAck"));
}

export function markYieldAssumptionAcknowledged(simulationRunId: string): boolean {
  return writeFlag(keyFor(simulationRunId, "yieldAck"));
}
