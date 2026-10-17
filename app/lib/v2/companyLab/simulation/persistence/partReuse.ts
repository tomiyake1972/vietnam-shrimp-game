// ShrimpX V2 — REUSE-1: 変更していない保存パートを送り直さない（送り方だけの変更）
//
// 【この層が存在する理由】
//   GM Console の保存（simulationRunStore.saveToServer）は、保存のたびに
//   dataset / resume / pack を丸ごと送っている。5社PLAYERでは1Turnに6回保存が走るが、
//   そのうち5回（PLAYER意思決定の確定）は dataset と pack を一切変更しない。
//   実測（5社PLAYER×32Turn、tiered-v200-crowding-v1）で T32 の1保存は
//   dataset 約4.0MB / pack 約1.7MB あり、変わっていない値を6回送っていた。
//
// 【保存形式は変えない】変えるのは送り方（wire）だけで、Redis 上の正規キーに
//   完全な JSON を置く形は不変。既存Runの読み出し経路・migration は不要のまま。
//
// 【「変わっていない」の判定は内容そのもので行う（受入前の指摘1）】
//   当初は「パートが含む最大 turn が一致すれば同じ内容」と判定していた。
//   dataset / pack は turn が進んだときにだけ増える、というのは観察であって
//   保証ではない。過去Turnの行が再計算で値だけ変わる場合、最大 turn は動かず、
//   変更が送られないまま静かに失われる（simulationRunStore.test.ts の
//   REUSE-STORE-1 がこの事故を固定している）。
//   そのため判定は保存する JSON そのもののハッシュで行う。
//
// 【この版に含めないもの（意図的な限定）】
//   - gzip 圧縮
//   - 差分追記（append）
//   - 保存タイミングのまとめ（デバウンス）
//   - 受講者提出経路（player/submit.ts）の変更
//   いずれも別の修正として切り離して審査するため、ここには入れない。

import type { SimulationRunPart } from "./repository";

/**
 * 再利用元として申告した revision のパートが、公開中のものと食い違う／存在しない。
 *
 * 【STALE_PERSISTENCE_REVISION と混同しない】あちらは「他のwriterが先に公開した」。
 * こちらは「送らずに済ませようとしたが、土台が無い／ずれている」であり、
 * クライアントは同じ内容を完全な値で送り直せば解決する。
 */
export const SIMULATION_RUN_REUSE_BASE_MISMATCH = "REUSE_BASE_MISMATCH";

/** 1パートの送り方。この版では「完全な値」か「前の revision の再利用」の2通りだけ。 */
export type SimulationRunPartSource =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "reuse"; readonly fromRevision: number };

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 保存リクエストの body から送り方を読み取る。
 * value と reuseFromRevision は排他で、どちらも無ければ不正。
 */
export function parseSimulationRunPartSource(candidate: {
  readonly value?: unknown;
  readonly reuseFromRevision?: unknown;
}): SimulationRunPartSource | { readonly error: string } {
  const hasValue = candidate.value !== undefined;
  const hasReuse = candidate.reuseFromRevision !== undefined;

  if (hasReuse && hasValue) {
    return { error: "reuseFromRevision を指定した場合は value を送りません。" };
  }
  if (!hasReuse && !hasValue) {
    return { error: "value / reuseFromRevision のいずれかが必要です。" };
  }
  if (hasReuse) {
    if (!isNonNegativeInt(candidate.reuseFromRevision)) {
      return { error: "reuseFromRevision は0以上の整数である必要があります。" };
    }
    return { kind: "reuse", fromRevision: candidate.reuseFromRevision };
  }
  return { kind: "value", value: candidate.value };
}

/** 再利用の対象にするパート。resume は毎回変わるため対象にしない。 */
export function isReusableSimulationRunPart(part: SimulationRunPart): part is "dataset" | "pack" {
  return part === "dataset" || part === "pack";
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 保存するパートの内容そのもののフィンガープリント。
 *
 * 【SHA-256 を使う理由】フィンガープリントが衝突すると、変更が送られずに
 * 静かに失われる。自作の短いハッシュでは衝突確率を自分で保証できないため、
 * 標準の SHA-256 を使い、長さも併記する。
 *
 * 【取れない環境では null を返す】`crypto.subtle` は secure context でしか
 * 使えない（HTTP の開発サーバー等では存在しない）。その場合は null を返し、
 * 呼び出し側は再利用せず完全な値を送る。判定できないときは確実に動く方へ倒す
 * ＝「たぶん同じ」で送らない、ということをしない。
 */
export async function fingerprintSimulationRunPart(value: unknown): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const json = JSON.stringify(value);
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(json));
    return `${json.length}:${toHex(digest)}`;
  } catch {
    return null;
  }
}
