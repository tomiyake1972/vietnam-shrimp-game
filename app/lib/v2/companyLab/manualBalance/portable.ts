// ShrimpX V2 — 手動バランス調整の持ち出し／取り込み（別Runで同じ条件を試すため）
//
// 【目的】「Turn5から販売95・原料105」のような条件を、別のRunでもう一度試したい
// という運用のために、設定スケジュールをJSONとして書き出し・読み込みできるようにする。
//
// 【Run Identity を必ず添える理由】同じ設定でも Scenario・seed・販売市場モデルが
// 違えば結果は別物である。取り込み時に「どのRunで作った設定か」を提示できないと、
// 別条件の結果を同条件だと誤認したまま比較してしまう。そのため書き出し時点の
// 識別情報を必ず同梱し、取り込み時に現在のRunとの差分を呼び出し側へ返す
// （差分があっても取り込み自体は禁止しない。判断は人が行う）。
//
// 【exportRunIdentity.ts に依存しない】本タスクのbase
// （feature/v2-ds2-standard-ai-cost-projection @ 33850ab）には
// companyLab/exportRunIdentity.ts が存在しない（feature/v2-export-run-identity-1
// 側の未統合ファイル）。そのため識別情報はここで独立に構成する。
// 将来そのファイルがbaseへ統合された場合は、この型をそちらへ寄せてよい
// （フィールド名は sourceCommit / scenarioId / seed / salesModelId を意図的に揃えてある）。

import type { ManualBalanceSchedule, ManualBalanceScheduleEntry, ManualBalanceSettings } from "./overrides";
import { validateManualBalanceSettings } from "./overrides";

/**
 * 手動バランス調整の仕様版。設定の意味（指数100が中立・ターン別が継続に優先する等）が
 * 変わったときにだけ上げる。取り込み側が未知の版を黙って解釈しないための印。
 */
export const MANUAL_BALANCE_SPEC_VERSION = "manual-balance-v1";

/** 書き出し時点のRun識別情報。「不明」は推測で埋めず、そのまま "UNKNOWN" を保持する。 */
export interface ManualBalancePortableIdentity {
  /**
   * そのRunを計算したアプリのソースコミット。
   * 既存の AI Analysis Pack と同じ規約（NEXT_PUBLIC_SOURCE_COMMIT 未設定なら "UNKNOWN"）。
   * 【重要】これは「実際にそのRunを計算した版」であり、いま動いているアプリの版とは
   * 別物として扱う。取り込み側は両者を並べて表示し、同一だと言い切らない。
   */
  readonly sourceCommit: string;
  /** 手動バランス調整の仕様版（MANUAL_BALANCE_SPEC_VERSION）。 */
  readonly specVersion: string;
  readonly scenarioId: string;
  readonly seed: string;
  /** 販売市場モデルID。未指定（sai5フラグからのlegacy解決）のRunでは null。 */
  readonly salesModelId: string | null;
}

export interface ManualBalancePortableDocument {
  readonly format: "shrimpx-v2-manual-balance";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly identity: ManualBalancePortableIdentity;
  readonly schedule: ManualBalanceSchedule;
}

export function buildManualBalancePortableDocument(input: {
  readonly schedule: ManualBalanceSchedule;
  readonly identity: ManualBalancePortableIdentity;
  readonly exportedAt: string;
}): ManualBalancePortableDocument {
  return {
    format: "shrimpx-v2-manual-balance",
    formatVersion: 1,
    exportedAt: input.exportedAt,
    identity: input.identity,
    schedule: input.schedule,
  };
}

/** 現在のRunと取り込もうとしている設定の、識別情報の食い違い。 */
export interface ManualBalanceIdentityDifference {
  readonly field: "specVersion" | "scenarioId" | "seed" | "salesModelId" | "sourceCommit";
  readonly imported: string;
  readonly current: string;
}

export type ManualBalanceImportResult =
  | {
      readonly ok: true;
      readonly document: ManualBalancePortableDocument;
      /** 空でなければ、別条件で作られた設定を取り込もうとしている。 */
      readonly identityDifferences: readonly ManualBalanceIdentityDifference[];
    }
  | { readonly ok: false; readonly error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSettings(raw: unknown): ManualBalanceSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const dividendRaw = r.dividendPayout;
  if (typeof dividendRaw !== "object" || dividendRaw === null) return null;
  const d = dividendRaw as Record<string, unknown>;
  let dividendPayout: ManualBalanceSettings["dividendPayout"];
  if (d.kind === "unspecified") {
    dividendPayout = { kind: "unspecified" };
  } else if (d.kind === "specified" && isFiniteNumber(d.payoutRatio)) {
    dividendPayout = { kind: "specified", payoutRatio: d.payoutRatio };
  } else {
    return null;
  }

  const readIndex = (value: unknown): number | undefined | "invalid" => {
    if (value === undefined || value === null) return undefined;
    if (isFiniteNumber(value)) return value;
    return "invalid";
  };
  const salesPriceIndex = readIndex(r.salesPriceIndex);
  const rawMarketPriceIndex = readIndex(r.rawMarketPriceIndex);
  if (salesPriceIndex === "invalid" || rawMarketPriceIndex === "invalid") return null;

  const settings: ManualBalanceSettings = { dividendPayout, salesPriceIndex, rawMarketPriceIndex };
  // 取り込んだ値も、画面入力と同じ検証を必ず通す（範囲外の設定を保存させない）。
  if (validateManualBalanceSettings(settings).length > 0) return null;
  return settings;
}

function parseEntry(raw: unknown): ManualBalanceScheduleEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== "MANUAL_OVERRIDE") return null;
  if (typeof r.recordedAt !== "string") return null;

  if (r.kind === "release") {
    if (!isFiniteNumber(r.effectiveFromTurn)) return null;
    return { kind: "release", effectiveFromTurn: r.effectiveFromTurn, source: "MANUAL_OVERRIDE", recordedAt: r.recordedAt };
  }
  if (r.kind === "continuing") {
    if (!isFiniteNumber(r.effectiveFromTurn)) return null;
    const settings = parseSettings(r.settings);
    if (!settings) return null;
    return {
      kind: "continuing",
      effectiveFromTurn: r.effectiveFromTurn,
      settings,
      source: "MANUAL_OVERRIDE",
      recordedAt: r.recordedAt,
    };
  }
  if (r.kind === "perTurn") {
    if (!isFiniteNumber(r.turn)) return null;
    const settings = parseSettings(r.settings);
    if (!settings) return null;
    return { kind: "perTurn", turn: r.turn, settings, source: "MANUAL_OVERRIDE", recordedAt: r.recordedAt };
  }
  return null;
}

/**
 * 書き出したJSONを取り込む。
 *
 * 【黙って直さない】1件でも壊れたエントリがあればエラーにする（部分的に読める
 * ぶんだけ適用して「取り込めた」と表示すると、画面に出ていない設定が
 * Engineへ渡ってしまう）。
 */
export function parseManualBalancePortableDocument(
  json: string,
  current: ManualBalancePortableIdentity
): ManualBalanceImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "JSONとして読み取れませんでした。" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "手動バランス調整の設定ファイルではありません。" };
  }
  const p = parsed as Record<string, unknown>;
  if (p.format !== "shrimpx-v2-manual-balance") {
    return { ok: false, error: "手動バランス調整の設定ファイルではありません（formatが一致しません）。" };
  }
  if (p.formatVersion !== 1) {
    return { ok: false, error: `未知のformatVersionです（このアプリが読めるのは1のみ）: ${String(p.formatVersion)}` };
  }
  const identityRaw = p.identity;
  if (typeof identityRaw !== "object" || identityRaw === null) {
    return { ok: false, error: "identityが含まれていません。どのRunで作られた設定か確認できないため取り込みません。" };
  }
  const i = identityRaw as Record<string, unknown>;
  if (
    typeof i.sourceCommit !== "string" ||
    typeof i.specVersion !== "string" ||
    typeof i.scenarioId !== "string" ||
    typeof i.seed !== "string" ||
    !(typeof i.salesModelId === "string" || i.salesModelId === null)
  ) {
    return { ok: false, error: "identityの形式が不正です。" };
  }
  const identity: ManualBalancePortableIdentity = {
    sourceCommit: i.sourceCommit,
    specVersion: i.specVersion,
    scenarioId: i.scenarioId,
    seed: i.seed,
    salesModelId: i.salesModelId,
  };

  if (!Array.isArray(p.schedule)) {
    return { ok: false, error: "scheduleが配列ではありません。" };
  }
  const entries: ManualBalanceScheduleEntry[] = [];
  for (const [index, rawEntry] of p.schedule.entries()) {
    const entry = parseEntry(rawEntry);
    if (!entry) {
      return { ok: false, error: `schedule[${index}] を読み取れませんでした。ファイル全体を取り込みません。` };
    }
    entries.push(entry);
  }

  const identityDifferences: ManualBalanceIdentityDifference[] = [];
  const compare = (field: ManualBalanceIdentityDifference["field"], imported: string | null, cur: string | null): void => {
    const a = imported ?? "(未指定)";
    const b = cur ?? "(未指定)";
    if (a !== b) identityDifferences.push({ field, imported: a, current: b });
  };
  compare("specVersion", identity.specVersion, current.specVersion);
  compare("scenarioId", identity.scenarioId, current.scenarioId);
  compare("seed", identity.seed, current.seed);
  compare("salesModelId", identity.salesModelId, current.salesModelId);
  compare("sourceCommit", identity.sourceCommit, current.sourceCommit);

  return {
    ok: true,
    document: {
      format: "shrimpx-v2-manual-balance",
      formatVersion: 1,
      exportedAt: typeof p.exportedAt === "string" ? p.exportedAt : "",
      identity,
      schedule: entries,
    },
    identityDifferences,
  };
}
