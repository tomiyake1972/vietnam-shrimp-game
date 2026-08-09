// ShrimpX V2 — 32Q Management Console: Mission / Vision / Strategy Profile（Phase 1）
//
// 【調査結果：既存実装は存在しなかった】
// companyLab には Mission / Vision に相当する項目が無く、会社の性格付けは
//   CompanyFixture.archetype   … "balanced" | "massMarket" | "japanQuality" | "vapSpecialist" | "conservative"
//   CompanyFixture.description … GM向けの説明文（本番会社設定ではない旨を含む）
// の2つだけで表現されていた。したがって Mission / Vision は**新設**である。
//
// 【Phase 1 の範囲】
//   ・スキーマと保存構造
//   ・表示と編集UIの土台
// までとし、**Strategy Profile を Standard AI の数値判断へ反映する処理は実装しない**
// （次フェーズで #05 と設計するため）。この分離を守るために、本モジュールは
// standardAi/ を一切 import しない。逆向きの依存も作らない。
//
// 【値を捏造しない】
// Mission / Vision の既定値は空である。archetype / description は実在するデータなので
// そのまま参照してよいが、それらしい経営理念を勝手に生成して保存しない。

/** 保存構造の版。SimulationRun の再現性メタデータへ記録する。 */
export const STRATEGY_PROFILE_SCHEMA_VERSION = "strategyProfile-v0.1-draft";

export type ProductFocus = "HOSO" | "PD" | "VAP" | "BALANCED";
export type InventoryPosture = "LEAN" | "BALANCED" | "BUFFER";
export type ContractPreference = "SPOT" | "BALANCED" | "LONG_TERM";
export type StrategicHorizon = "SHORT" | "BALANCED" | "LONG";

/** 市場志向（各市場への重み。0〜100）。 */
export interface MarketOrientation {
  readonly US: number;
  readonly EU: number;
  readonly JP: number;
  readonly CN: number;
  readonly OTHER: number;
}

/**
 * 戦略プロファイル（draft schema）。
 * **この値は現時点でゲームの計算に一切影響しない。** 表示・保存のみ。
 */
export interface StrategyProfile {
  readonly productFocus: ProductFocus;
  /** 特化度 0〜100。 */
  readonly specialization: number;
  readonly marketOrientation: MarketOrientation;
  /** 成長志向 0〜100。 */
  readonly growthAppetite: number;
  /** 投資志向 0〜100。 */
  readonly investmentAppetite: number;
  /** 財務保守性 0〜100。 */
  readonly financialConservatism: number;
  /** 品質志向 0〜100。 */
  readonly qualityOrientation: number;
  /** 垂直統合志向 0〜100。 */
  readonly verticalIntegrationPreference: number;
  readonly inventoryPosture: InventoryPosture;
  readonly contractPreference: ContractPreference;
  readonly strategicHorizon: StrategicHorizon;
}

/**
 * ある時点から有効になる戦略。
 *
 * 【なぜ effectiveFromTurn を持つか】将来
 *   Turn 1  VAP focused
 *   Turn 12 HOSO / China focused
 *   Turn 20 Cash preservation
 * のような戦略転換を追えるようにするため。Phase 1 では保存構造まで。
 */
export interface StrategyProfileEntry {
  readonly effectiveFromTurn: number;
  readonly profile: StrategyProfile;
  /** 変更理由のメモ（任意）。 */
  readonly note: string | null;
}

/** 1社ぶんの Mission / Vision / 戦略履歴。 */
export interface CompanyStrategyDocument {
  readonly companyId: string;
  /** 経営理念。未設定なら空文字（それらしい文言を生成しない）。 */
  readonly mission: string;
  /** 将来像。未設定なら空文字。 */
  readonly vision: string;
  /** 時系列の戦略。effectiveFromTurn の昇順で保持する。 */
  readonly strategyHistory: readonly StrategyProfileEntry[];
  readonly schemaVersion: string;
}

/** 中立な既定プロファイル（どの方向にも寄っていない状態）。 */
export const NEUTRAL_STRATEGY_PROFILE: StrategyProfile = {
  productFocus: "BALANCED",
  specialization: 50,
  marketOrientation: { US: 20, EU: 20, JP: 20, CN: 20, OTHER: 20 },
  growthAppetite: 50,
  investmentAppetite: 50,
  financialConservatism: 50,
  qualityOrientation: 50,
  verticalIntegrationPreference: 50,
  inventoryPosture: "BALANCED",
  contractPreference: "BALANCED",
  strategicHorizon: "BALANCED",
};

/**
 * 未設定の会社に与える空のドキュメント。
 * Mission / Vision は**空**であり、archetype から文章を作ることはしない。
 */
export function createEmptyStrategyDocument(companyId: string): CompanyStrategyDocument {
  return {
    companyId,
    mission: "",
    vision: "",
    strategyHistory: [{ effectiveFromTurn: 1, profile: NEUTRAL_STRATEGY_PROFILE, note: null }],
    schemaVersion: STRATEGY_PROFILE_SCHEMA_VERSION,
  };
}

/**
 * 指定ターン時点で有効な戦略を返す（effectiveFromTurn が turn 以下で最大のもの）。
 * 該当が無ければ null（推測で埋めない）。
 */
export function resolveStrategyAtTurn(doc: CompanyStrategyDocument, turn: number): StrategyProfileEntry | null {
  let found: StrategyProfileEntry | null = null;
  for (const entry of doc.strategyHistory) {
    if (entry.effectiveFromTurn <= turn && (found === null || entry.effectiveFromTurn > found.effectiveFromTurn)) {
      found = entry;
    }
  }
  return found;
}
