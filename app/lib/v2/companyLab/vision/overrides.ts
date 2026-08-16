// ShrimpX V2 — Management Console Vision Calibration（Run-specific Vision override）
//
// 【目的】コードを直接書き換えなくても、Management Console から各社の
// Q32 Vision 目標規模（と、任意で strategicPosture）を Run ごとに調整できるようにする
// （ChatGPT #05指示・目的B）。
//
// 【設計方針・指示§17「Vision resolution関数を1か所に集約」】
// UI・Standard AI・Strategic Growth・Forward Capacity Gap・Commercial Ambition・
// New Factory・Analysis Pack のすべてが、必ずこの resolveCompanyVision を通して
// Vision を読む。defaultVisionDocumentFor / resolveVisionAtTurn を直接呼んで
// Run override を無視する経路を作らない（UIだけ変更してAIがDefaultを見る事故を防ぐ）。
//
// 【Vision は hard quota ではない・指示§5/§6】override は
// targetScaleTonsPerQuarterAtQ32（と任意で strategicPosture）だけを差し替える。
// 「Vision>=80000なら第3工場を建てる」のような強制ロジックはここにも一切存在しない。
// override後もVisionは既存の Strategic Growth → Forward Capacity Gap →
// Standard AI の各ゲートを通るだけの「参考値」のままである。
//
// 【過去Turnのretroactive変更を防ぐ・指示§13】この関数は「指定したturnの時点で
// 有効なVision」だけを返す純粋関数であり、過去に確定したTurnのAI判断record
// （AI Analysis Packのcapture）を書き換えない。Turn10でoverrideを適用しても、
// Turn1〜9のcaptureは、その時点でこの関数を呼んで得られていた「override適用前の
// Vision」のままである（capture自体は各Turn実行時に一度だけ行われ、後から
// 再計算されないため）。

import { CompanyVision, CompanyVisionDocument, resolveVisionAtTurn, StrategicPosture } from "./types";
import { defaultVisionDocumentFor } from "./defaults";

/**
 * Management Console から編集された、ある時点から有効な Vision の差分。
 * 【最小構成・指示§8】必須は targetScaleTonsPerQuarterAtQ32 のみ。strategicPosture は
 * 任意（指示§23、同画面に置く場合のみ使う）。他のVisionフィールド
 * （growthAmbition・preferredEndState・willingnessToBuildFactories等の会社人格）は
 * このPhaseの編集対象ではなく、直近のdefault Visionからそのまま引き継ぐ。
 */
export interface CompanyVisionOverrideEntry {
  /** このoverrideが有効になるターン（1始まり）。過去Turnには遡って適用されない。 */
  readonly effectiveFromTurn: number;
  /** Q32時点で目指す四半期あたり規模（HOSO換算トン/四半期）。10,000〜150,000の範囲を想定（指示§41）。 */
  readonly targetScaleTonsPerQuarterAtQ32: number;
  readonly strategicPosture?: StrategicPosture;
  /** 【指示§21】変更ログ表示用。UIから編集された場合は常に"MANUAL_OVERRIDE"。 */
  readonly source: "MANUAL_OVERRIDE";
}

/** 会社ID → その会社に対するoverride履歴（effectiveFromTurn昇順である必要はない。解決時にソートする）。 */
export type CompanyLabVisionOverrides = Readonly<Record<string, readonly CompanyVisionOverrideEntry[]>>;

const EMPTY_OVERRIDES: CompanyLabVisionOverrides = {};

/**
 * 【指示§41】UI validationの安全範囲。上限は現在の市場モデル
 * （5社合計のQ32 TRUE需要が266,642t/四半期、defaults.tsの実測校正コメント参照）を
 * 監査したうえでの目安であり、1社で市場のTRUE需要の過半を超える極端値を防ぐ。
 * 下限は既存最小Vision（VAP 17,000）を下回らない範囲。
 */
export const VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER = 10000;
export const VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER = 150000;

export function isVisionTargetScaleInValidRange(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER &&
    value <= VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER
  );
}

/**
 * 【指示§17・SSoT】Run固有のoverrideを反映した、指定ターンで有効なVisionを返す。
 *
 * UI・Standard AI・Strategic Growth・Forward Capacity Gap・Commercial Ambition・
 * New Factory・Analysis Packは必ずこの関数を通す。defaultVisionDocumentFor /
 * resolveVisionAtTurnを直接呼ぶ経路は、この関数の内部実装以外に作らない。
 *
 * 未知の会社IDには架空のVisionを作らずnullを返す（defaultVisionDocumentForと同じ規約）。
 */
export function resolveCompanyVision(companyId: string, turn: number, overrides?: CompanyLabVisionOverrides): CompanyVision | null {
  const defaultDocument = defaultVisionDocumentFor(companyId);
  if (!defaultDocument) return null;

  const defaultVision = resolveVisionAtTurn(defaultDocument, turn);
  if (!defaultVision) return null;

  const companyOverrides = (overrides ?? EMPTY_OVERRIDES)[companyId] ?? [];
  const applicable = companyOverrides
    .filter((entry) => entry.effectiveFromTurn <= turn)
    .slice()
    .sort((a, b) => a.effectiveFromTurn - b.effectiveFromTurn);
  if (applicable.length === 0) return defaultVision;

  const latest = applicable[applicable.length - 1];
  // overrideが有効になった時点でのdefault Vision（会社の人格・成長軌道の形自体は
  // そこから引き継ぎ、規模とposture「だけ」を差し替える）。
  const baseVision = resolveVisionAtTurn(defaultDocument, latest.effectiveFromTurn) ?? defaultVision;

  return {
    ...baseVision,
    visionId: `${baseVision.visionId}-override-t${latest.effectiveFromTurn}`,
    effectiveFromTurn: latest.effectiveFromTurn,
    targetScaleTonsPerQuarterAtQ32: latest.targetScaleTonsPerQuarterAtQ32,
    strategicPosture: latest.strategicPosture ?? baseVision.strategicPosture,
    // 【指示§25「途中Turnが旧trajectoryのままにならない」】referenceGrowthPathを
    // 空にすることで、referenceScaleAtTurn（types.ts）の既存フォールバックである
    // 「開始規模→Q32目標の線形補間」を使う。開始規模は呼び出し側
    // （strategicGrowth.ts等）がその時点の実際の持続可能規模を渡すため、
    // overrideが効き始めた時点から新しいQ32目標へ向けて自然に軌道が引き直される
    // （waypointを手動で作り直す必要がない）。
    referenceGrowthPath: [],
  };
}

/** 会社の既定Vision（override無し）をそのまま返す。UIの「Default」列表示用。 */
export function defaultCompanyVisionAtTurn(companyId: string, turn: number): CompanyVision | null {
  const document = defaultVisionDocumentFor(companyId);
  if (!document) return null;
  return resolveVisionAtTurn(document, turn);
}

/**
 * 【指示§9/§11「Reset to Default」】ある会社のoverrideをすべて取り除いた
 * overridesを返す（純粋関数。既存overridesを書き換えない）。
 */
export function withCompanyVisionOverrideReset(overrides: CompanyLabVisionOverrides | undefined, companyId: string): CompanyLabVisionOverrides {
  const next = { ...(overrides ?? EMPTY_OVERRIDES) };
  delete next[companyId];
  return next;
}

/**
 * 【指示§12「Run開始後のVision編集」】ある会社に新しいoverride entryを追加する
 * （既存entryは残す＝履歴として保持。resolveCompanyVisionはeffectiveFromTurn最大の
 * ものを選ぶため、同じeffectiveFromTurnの重複追加は直近の呼び出しが実質的に勝つ）。
 */
export function withCompanyVisionOverrideApplied(
  overrides: CompanyLabVisionOverrides | undefined,
  companyId: string,
  entry: CompanyVisionOverrideEntry
): CompanyLabVisionOverrides {
  const base = overrides ?? EMPTY_OVERRIDES;
  const existing = base[companyId] ?? [];
  return { ...base, [companyId]: [...existing, entry] };
}

/** UI表示用：ある会社の最新（有効中）overrideエントリを返す（無ければnull）。 */
export function activeCompanyVisionOverrideEntry(
  overrides: CompanyLabVisionOverrides | undefined,
  companyId: string,
  turn: number
): CompanyVisionOverrideEntry | null {
  const companyOverrides = (overrides ?? EMPTY_OVERRIDES)[companyId] ?? [];
  const applicable = companyOverrides.filter((entry) => entry.effectiveFromTurn <= turn);
  if (applicable.length === 0) return null;
  return applicable.reduce((latest, entry) => (entry.effectiveFromTurn > latest.effectiveFromTurn ? entry : latest));
}

/** 型re-export（呼び出し側でtypes.tsを別importしなくて済むように）。 */
export type { CompanyVision, CompanyVisionDocument };
