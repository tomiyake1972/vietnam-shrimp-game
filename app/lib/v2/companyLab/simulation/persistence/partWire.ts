// ShrimpX V2 — FOT-1: Simulation Run パート保存の「送り方」だけを定義する層
//
// 【この層が存在する理由】
//   Vercel Fast Origin Transfer（ブラウザ→サーバーの送信量）が Hobby 上限を超えて
//   アカウントが停止した。原因は simulationRunStore.saveToServer が、保存のたびに
//   dataset / resume / pack を丸ごと・無圧縮で送っていたことである（実測: 5社PLAYER
//   ×32Turn の1Run で 979.96 MB、T32 の1保存で 8.36 MB）。
//
// 【保存形式は変えない】ここで変えるのは**送り方（wire）だけ**であり、Redis 上の
//   保存形式（正規キー `:dataset:{revision}` 等に完全な JSON を置く）は一切変えない。
//   既存Runの読み出し経路・migration は不要のままにする（依頼書の「止める条件」）。
//
// 【3つの送り方】
//   value  … 従来どおり完全な値を送る（後方互換。旧クライアントもこの形）。
//   reuse  … 「このパートは前の revision から変わっていない」とだけ伝える。
//            サーバーは公開済みの値を Redis 内でコピーするため、ブラウザからは
//            数十バイトしか出ない。5社PLAYERでは1Turnあたり6回の保存のうち
//            5回（PLAYER意思決定の確定）が dataset / pack を変えないため、ここが最大の削減。
//   append … 「このTurnで増えた行だけ」を送る。サーバーは公開済みの値と
//            turn キーでマージして完全な値を作り、従来と同じ形で保存する。
//
// 【append が安全な理由】dataset / pack はいずれも全行が `turn` を持つ long-format の
//   行集合であり、既に本番コードが同じ意味のマージ（mergeAnalyticsDatasets）を
//   resume 経路で使っている。新しいマージ規則を発明していない。

import { mergeAnalyticsDatasets } from "../analytics/dataset";
import type { SimulationAnalyticsDataset } from "../analytics/types";
import type { SimulationRunPart } from "./repository";
import type { SimulationPackCapture } from "./types";

/**
 * gzip 圧縮された request body であることを示すヘッダ。
 *
 * 【標準の Content-Encoding を使わない理由】Content-Encoding は本来レスポンス向けの
 * ネゴシエーションで使われ、request body に付けた場合の扱いは経路（プロキシ・
 * プラットフォーム）によって異なる。途中で勝手に展開される／拒否されるといった
 * 挙動差を避けるため、このアプリ専用のヘッダで明示する。
 */
export const SIMULATION_RUN_BODY_ENCODING_HEADER = "x-shrimpx-body-encoding";
export const SIMULATION_RUN_BODY_ENCODING_GZIP = "gzip";

/** append / reuse の基準 revision が、サーバーで公開中の revision と食い違っていた。 */
export const SIMULATION_RUN_DELTA_BASE_MISMATCH = "DELTA_BASE_MISMATCH";

/** 1パートの送り方。 */
export type SimulationRunPartSource =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "reuse"; readonly fromRevision: number }
  | {
      readonly kind: "append";
      readonly fromRevision: number;
      readonly delta: unknown;
      /**
       * マージ後に期待する最大 turn。サーバーはマージ結果を検証し、一致しなければ
       * 保存せず DELTA_BASE_MISMATCH を返す（クライアントは完全な値で送り直す）。
       * 差分が噛み合っていないまま正本化して、あとで findStaleness に引っかかる
       * （＝AI Analysis Pack が出せない）状態を作らないための歯止め。
       */
      readonly expectedMaxTurn: number;
    };

/** append を使えるパート。turn キーの long-format 行集合だけが対象。 */
export function isAppendableSimulationRunPart(part: SimulationRunPart): boolean {
  return part === "dataset" || part === "pack";
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 保存リクエストの body から送り方を読み取る。
 * 3つの指定は排他で、どれも無ければ不正。
 */
export function parseSimulationRunPartSource(
  part: SimulationRunPart,
  candidate: {
    readonly value?: unknown;
    readonly reuseFromRevision?: unknown;
    readonly appendFromRevision?: unknown;
    readonly expectedMaxTurn?: unknown;
  }
): SimulationRunPartSource | { readonly error: string } {
  const hasValue = candidate.value !== undefined;
  const hasReuse = candidate.reuseFromRevision !== undefined;
  const hasAppend = candidate.appendFromRevision !== undefined;
  const specified = [hasValue && !hasAppend, hasReuse, hasAppend].filter(Boolean).length;

  if (hasReuse && hasAppend) {
    return { error: "reuseFromRevision と appendFromRevision は同時に指定できません。" };
  }
  if (hasReuse && hasValue) {
    return { error: "reuseFromRevision を指定した場合は value を送りません。" };
  }
  if (specified === 0) {
    return { error: "value / reuseFromRevision / appendFromRevision のいずれかが必要です。" };
  }

  if (hasReuse) {
    if (!isNonNegativeInt(candidate.reuseFromRevision)) {
      return { error: "reuseFromRevision は0以上の整数である必要があります。" };
    }
    return { kind: "reuse", fromRevision: candidate.reuseFromRevision };
  }

  if (hasAppend) {
    if (!isAppendableSimulationRunPart(part)) {
      return { error: `part=${part} は差分追記（appendFromRevision）に対応していません。` };
    }
    if (!isNonNegativeInt(candidate.appendFromRevision)) {
      return { error: "appendFromRevision は0以上の整数である必要があります。" };
    }
    if (!isNonNegativeInt(candidate.expectedMaxTurn)) {
      return { error: "appendFromRevision を指定する場合は expectedMaxTurn（0以上の整数）も必要です。" };
    }
    if (candidate.value === undefined) {
      return { error: "appendFromRevision を指定する場合は差分を value として送ってください。" };
    }
    return {
      kind: "append",
      fromRevision: candidate.appendFromRevision,
      delta: candidate.value,
      expectedMaxTurn: candidate.expectedMaxTurn,
    };
  }

  return { kind: "value", value: candidate.value };
}

function turnsOf(rows: readonly { readonly turn: number }[]): ReadonlySet<number> {
  return new Set(rows.map((r) => r.turn));
}

/**
 * turn キーで prior と delta をマージする（delta が持つ turn は delta を採用する）。
 * mergeAnalyticsDatasets が dataset に対して行っているのと同じ規則。
 */
function mergeTurnKeyedRows<T extends { readonly turn: number }>(prior: readonly T[], delta: readonly T[]): readonly T[] {
  const deltaTurns = turnsOf(delta);
  return [...prior.filter((row) => !deltaTurns.has(row.turn)), ...delta];
}

/** 【pack】companyTurns / worldTurns を turn キーでマージする。 */
export function mergePackCaptures(prior: SimulationPackCapture, delta: SimulationPackCapture): SimulationPackCapture {
  return {
    companyTurns: mergeTurnKeyedRows(prior.companyTurns, delta.companyTurns),
    worldTurns: mergeTurnKeyedRows(prior.worldTurns, delta.worldTurns),
  };
}

export class SimulationRunPartMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationRunPartMergeError";
  }
}

/**
 * 公開済みの完全な値と、クライアントが送ってきた差分をマージして、
 * 従来と同じ「完全な値」を作る。保存形式は変わらない。
 */
export function mergeSimulationRunPart(part: SimulationRunPart, published: unknown, delta: unknown): unknown {
  if (part === "dataset") {
    if (!isDatasetLike(published)) {
      throw new SimulationRunPartMergeError("公開済みの dataset を差分追記の土台として読めませんでした。");
    }
    if (!isDatasetLike(delta)) {
      throw new SimulationRunPartMergeError("送られてきた dataset 差分の形が不正です。");
    }
    return mergeAnalyticsDatasets(published, delta);
  }
  if (part === "pack") {
    if (!isPackLike(published)) {
      throw new SimulationRunPartMergeError("公開済みの pack を差分追記の土台として読めませんでした。");
    }
    if (!isPackLike(delta)) {
      throw new SimulationRunPartMergeError("送られてきた pack 差分の形が不正です。");
    }
    return mergePackCaptures(published, delta);
  }
  throw new SimulationRunPartMergeError(`part=${part} は差分追記に対応していません。`);
}

function isDatasetLike(value: unknown): value is SimulationAnalyticsDataset {
  return typeof value === "object" && value !== null && Array.isArray((value as { turns?: unknown }).turns);
}

function isPackLike(value: unknown): value is SimulationPackCapture {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { companyTurns?: unknown; worldTurns?: unknown };
  return Array.isArray(candidate.companyTurns) && Array.isArray(candidate.worldTurns);
}

function isTurnRow(value: unknown): value is { readonly turn: number } {
  return typeof value === "object" && value !== null && typeof (value as { turn?: unknown }).turn === "number";
}

/**
 * 【FOT-1】送信する差分を作る。`afterTurn` より後の turn の行だけを残す。
 *
 * 【どのフィールドを落とすかを列挙しない】dataset / pack は turn を持つ行の配列を
 * 複数抱えており、将来 fact 配列が増えたときに列挙を更新し忘れると、その配列だけ
 * 差分から抜け落ちて静かにデータが欠ける。そこで「要素が turn を持つ配列」を
 * 一律に絞り込む形にする。
 *
 * 落とさないもの:
 *   - turn を持たない配列（dataset.companies など）はそのまま残す。
 *     mergeAnalyticsDatasets が `companies` と `schemaVersion` を next 側から
 *     採用するため、差分側が完全な値を持っていなければならない。
 *   - `turns`（turn 番号そのものの配列）は要素が数値なので、数値として絞り込む。
 *     マージ後の turns は prior と差分の和集合になる。
 */
export function sliceSimulationRunPartAfterTurn(part: SimulationRunPart, value: unknown, afterTurn: number): unknown {
  if (!isAppendableSimulationRunPart(part)) {
    throw new SimulationRunPartMergeError(`part=${part} は差分抽出に対応していません。`);
  }
  if (afterTurn < 0) return value;
  if (typeof value !== "object" || value === null) {
    throw new SimulationRunPartMergeError(`part=${part} の形が不正で差分を作れません。`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!Array.isArray(field)) {
      out[key] = field;
      continue;
    }
    if (key === "turns") {
      out[key] = field.filter((turn) => typeof turn === "number" && turn > afterTurn);
      continue;
    }
    if (field.some(isTurnRow)) {
      out[key] = field.filter((row) => isTurnRow(row) && row.turn > afterTurn);
      continue;
    }
    out[key] = field;
  }
  return out;
}

/**
 * パートが持つ最大 turn（行が無ければ0）。append の検証にだけ使う。
 * 【捏造しない】turn を持たないパート（resume）では例外にする。
 */
export function maxTurnOfSimulationRunPart(part: SimulationRunPart, value: unknown): number {
  if (part === "dataset") {
    if (!isDatasetLike(value)) throw new SimulationRunPartMergeError("dataset の形が不正で最大turnを判定できません。");
    return value.turns.length > 0 ? Math.max(...value.turns) : 0;
  }
  if (part === "pack") {
    if (!isPackLike(value)) throw new SimulationRunPartMergeError("pack の形が不正で最大turnを判定できません。");
    const turns = [...value.companyTurns.map((t) => t.turn), ...value.worldTurns.map((t) => t.turn)];
    return turns.length > 0 ? Math.max(...turns) : 0;
  }
  throw new SimulationRunPartMergeError(`part=${part} は turn を持ちません。`);
}
