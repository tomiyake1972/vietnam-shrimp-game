// ShrimpX V2 — REUSE-1: 変更していない保存パートを送り直さない（送り方だけの変更）
//
// 【この層が存在する理由】
//   GM Console の保存（simulationRunStore.saveToServer）は、保存のたびに
//   dataset / resume / pack を丸ごと送っている。5社PLAYERでは1Turnに6回保存が走るが、
//   そのうち5回（PLAYER意思決定の確定）は dataset と pack を一切変更しない。
//   実測（5社PLAYER×32Turn、tiered-v200-crowding-v1）で T32 の1保存は
//   dataset 4,002,162 B / pack 1,682,483 B あり、変わっていない値を6回送っていた。
//
// 【保存形式は変えない】変えるのは送り方（wire）だけで、Redis 上の正規キーに
//   完全な JSON を置く形は不変。既存Runの読み出し経路・migration は不要のまま。
//
// 【この版に含めないもの（意図的な限定）】
//   - gzip 圧縮
//   - 差分追記（append）
//   - 保存タイミングのまとめ（デバウンス）
//   - 受講者提出経路（player/submit.ts）の変更
//   いずれも別の修正として切り離して審査するため、ここには入れない。

import type { SimulationRunPart } from "./repository";
import type { SimulationPackCapture } from "./types";
import type { SimulationAnalyticsDataset } from "../analytics/types";

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

export class SimulationRunPartShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationRunPartShapeError";
  }
}

function isDatasetLike(value: unknown): value is SimulationAnalyticsDataset {
  return typeof value === "object" && value !== null && Array.isArray((value as { turns?: unknown }).turns);
}

function isPackLike(value: unknown): value is SimulationPackCapture {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { companyTurns?: unknown; worldTurns?: unknown };
  return Array.isArray(candidate.companyTurns) && Array.isArray(candidate.worldTurns);
}

/**
 * パートが含んでいる最大 turn（行が無ければ0）。
 *
 * 【用途はひとつだけ】クライアントが「このパートは前回保存したときから
 * 変わっていないか」を判定するために使う。dataset / pack はいずれも
 * turn が進んだときにだけ行が増えるため、最大 turn が一致していれば
 * 内容も同一である。
 *
 * 【捏造しない】turn を持たないパート（resume）では例外にする。
 */
export function maxTurnOfSimulationRunPart(part: SimulationRunPart, value: unknown): number {
  if (part === "dataset") {
    if (!isDatasetLike(value)) throw new SimulationRunPartShapeError("dataset の形が不正で最大turnを判定できません。");
    return value.turns.length > 0 ? Math.max(...value.turns) : 0;
  }
  if (part === "pack") {
    if (!isPackLike(value)) throw new SimulationRunPartShapeError("pack の形が不正で最大turnを判定できません。");
    const turns = [...value.companyTurns.map((t) => t.turn), ...value.worldTurns.map((t) => t.turn)];
    return turns.length > 0 ? Math.max(...turns) : 0;
  }
  throw new SimulationRunPartShapeError(`part=${part} は turn を持ちません。`);
}

/**
 * 再利用の判定に使えるパート（turn が進んだときにだけ増えるもの）。
 *
 * 型述語にしてあるのは、呼び出し側が「resume を最大turn判定へ渡してしまう」
 * 取り違えを型で弾けるようにするため（resume は turn を持たない）。
 */
export function isReusableSimulationRunPart(part: SimulationRunPart): part is "dataset" | "pack" {
  return part === "dataset" || part === "pack";
}
