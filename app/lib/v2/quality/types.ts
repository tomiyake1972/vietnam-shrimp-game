// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 共通型（Phase 7A）
//
// Phase6（工場・ワーカー・生産・完成品在庫・契約履行）が出力する操業負荷指標
// （production/loadMetrics.ts）と、Phase4/6の契約履行実績を入力に、次を
// ターン間で蓄積する。
//   1. 商品別品質（会社×商品）
//   2. 市場別顧客信頼（会社×市場）
//   3. 市場別納期信頼性（会社×市場）
//   4. 無理な増産による品質悪化（会社×工場×商品の増産履歴）
//   5. 低頻度の重大品質事故（市場価格等とは独立した乱数ストリーム）
//   6. 次四半期の販売競争力への反映（sales/types.tsの既存フィールドへの接続）
//
// 【今回確定した数量設計（変更しない）】
//   - 頭・殻の除去はHOSO換算数量を減らさない
//   - 通常時のsaleableRecoveryRatioは1.00
//   - 品質問題による規格外・破損・廃棄だけが販売可能数量を減らす
//   - 物理重量換算は経営数量・契約数量・在庫数量には使わない
// 本モジュールは「廃棄」だけをHOSO換算数量の真の損失として扱い、格落ち・
// 再加工はPhase 7Aでは数量を減らさない（観測品質・記録用の数量として保持する）。
//
// 状態粒度（三宅さん指定、固定）:
//   品質: 会社×商品／顧客信頼: 会社×市場／納期信頼性: 会社×市場／
//   増産履歴: 会社×工場×商品

import { PeriodV2 } from "../core/period";
import { HosoEqTons, Ratio, Score0to100 } from "../core/units";
import { DemandMarketId, Product } from "../market/types";
import type { CompanyId } from "../sales/types";

export class QualityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityValidationError";
  }
}

// ---------------------------------------------------------------------
// 1. 蓄積状態（ターンをまたいで保持する）
// ---------------------------------------------------------------------

/** 会社×商品の蓄積品質。 */
export interface CompanyProductQualityState {
  readonly companyId: CompanyId;
  readonly product: Product;
  readonly qualityScore: Score0to100;
}

/** 会社×市場の顧客信頼・納期信頼性。 */
export interface CompanyMarketTrustState {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly customerTrustScore: Score0to100;
  readonly deliveryReliabilityScore: Score0to100;
}

/** 会社×工場×商品の増産履歴（急増産ストレス計算に必要な前期実績のみ保持）。 */
export interface CompanyFactoryProductRampState {
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: Product;
  /** 前四半期の実生産量（完成品HOSO換算量、廃棄適用後の販売可能量ではなく、品質調整前の生産量）。 */
  readonly lastQuarterProductionQuantity: HosoEqTons;
}

/** Phase 7Aが新たにターンをまたいで保持する状態一式。 */
export interface QualityReliabilityState {
  readonly qualityByCompanyProduct: readonly CompanyProductQualityState[];
  readonly trustByCompanyMarket: readonly CompanyMarketTrustState[];
  readonly rampHistory: readonly CompanyFactoryProductRampState[];
}

// ---------------------------------------------------------------------
// 2. 操業リスク（会社×工場×商品、当期の実績負荷から算出）
// ---------------------------------------------------------------------

/** 0〜1に正規化した操業ストレス要因一式と、その加重合計（operationalRisk）。すべて暫定値・要校正。 */
export interface OperationalRiskFactors {
  readonly utilizationStress: number;
  readonly overtimeStress: number;
  readonly temporaryWorkerStress: number;
  readonly complexityStress: number;
  readonly rawMaterialAgeStress: number;
  readonly productionRampStress: number;
  /** 上記6要因の加重合計（0〜1）。 */
  readonly operationalRisk: number;
}

// ---------------------------------------------------------------------
// 3. 重大品質事故（独立した決定論的乱数ストリーム）
// ---------------------------------------------------------------------

/** 1回の重大事故判定の結果（発生有無・重大度・使用したシード。監査用）。 */
export interface MajorIncidentDraw {
  readonly occurred: boolean;
  /** 重大度（0〜1）。発生しなかった場合は0。 */
  readonly severity: number;
  readonly probability: number;
  readonly seed: string;
}

// ---------------------------------------------------------------------
// 4. 品質結果（会社×工場×商品×当期）
// ---------------------------------------------------------------------

/**
 * 操業リスク・重大事故から算出した当期の品質結果。廃棄のみがHOSO換算数量の
 * 真の損失（saleableRecoveryRatio経由）であり、格落ち・再加工はPhase 7Aでは
 * 数量を減らさない（記録用）。
 */
export interface QualityOutcome {
  /** 総不適合率（0〜1、格落ち＋再加工＋廃棄の合計）。 */
  readonly nonConformanceRatio: number;
  /** 格落ち率（nonConformanceRatioのうちの内訳、数量は減らさない）。 */
  readonly downgradeRatio: number;
  /** 再加工率（nonConformanceRatioのうちの内訳、数量は減らさない）。 */
  readonly reworkRatio: number;
  /** 廃棄率（nonConformanceRatioの廃棄分＋重大事故による追加廃棄。数量の真の損失）。 */
  readonly discardRatio: number;
  /** 生産へ一度だけ適用する販売可能回収率（clamp(1-discardRatio, minimum, 1)）。 */
  readonly saleableRecoveryRatio: Ratio;
  /** 当期の観測品質スコア（0〜100）。 */
  readonly observedQualityScore: Score0to100;
  readonly majorIncident: MajorIncidentDraw;
}

/** 1生産バッチぶんの品質調整結果（監査・テスト・CLI表示用）。 */
export interface BatchQualityAdjustment {
  readonly batchId: string;
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: Product;
  readonly period: PeriodV2;
  readonly risk: OperationalRiskFactors;
  /**
   * 【Phase QI-I1新設】品質管理設備（qualityControlEquipment）による
   * operationalRisk低減乗数（0〜1、設備なし/未稼働なら1.0）。risk.operationalRisk
   * は設備の有無に関わらず「純粋な操業条件から計算されたリスク」のまま変更しない
   * （既存の6要因の意味を保つ）。この乗数を掛けた後の値がeffectiveOperationalRisk。
   */
  readonly qualityEquipmentRiskMultiplier: number;
  /** risk.operationalRisk × qualityEquipmentRiskMultiplier。outcome（downgrade/rework/discard/major incident）の算出に実際に使われる値。 */
  readonly effectiveOperationalRisk: number;
  readonly outcome: QualityOutcome;
  /** 品質調整前の完成品HOSO換算量（Phase6のsaleableRecoveryRatio=1.00基準の値）。 */
  readonly originalFinishedGoodsQuantity: HosoEqTons;
  /** 廃棄分だけを差し引いた後の完成品HOSO換算量（実際に完成品ロットへ計上される量）。 */
  readonly adjustedFinishedGoodsQuantity: HosoEqTons;
  /** 格落ち量（記録用、adjustedFinishedGoodsQuantityに含まれる＝数量は減らさない）。 */
  readonly downgradeQuantity: HosoEqTons;
  /** 再加工量（記録用、adjustedFinishedGoodsQuantityに含まれる＝数量は減らさない）。 */
  readonly reworkQuantity: HosoEqTons;
  /** 廃棄量（真の数量損失。originalFinishedGoodsQuantity - adjustedFinishedGoodsQuantity）。 */
  readonly discardQuantity: HosoEqTons;
}

// ---------------------------------------------------------------------
// 5. 納期信頼性・顧客信頼の観測（会社×市場×当期）
// ---------------------------------------------------------------------

/**
 * 会社×市場×当期の納期観測。dueQuantityは「当期が納期の契約」だけを対象と
 * する（過年度からの持ち越し未履行を毎期新しい失敗として重複加算しないため）。
 */
export interface MarketDeliveryObservation {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  /** 当期が納期の契約の合計数量（この四半期の評価対象コホート）。 */
  readonly dueQuantity: HosoEqTons;
  /** 当期が納期の契約のうち、当期中に履行された数量（期限内）。 */
  readonly onTimeQuantity: HosoEqTons;
  /** 当期が納期の契約のうち、当期末時点で未履行のまま納期超過になった数量。 */
  readonly newlyOverdueQuantity: HosoEqTons;
  /** 過年度から持ち越された、当期時点でなお納期超過のままの数量（小さな継続ペナルティにのみ使う）。 */
  readonly continuingOverdueQuantity: HosoEqTons;
}

/** 会社×市場×当期の顧客信頼観測（品質・納期の当期実績から算出）。 */
export interface MarketTrustObservation {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  /** 当期その市場向けに履行された数量で加重した平均品質スコア。 */
  readonly deliveredQualityScore: Score0to100;
  /** 当期の観測納期スコア（MarketDeliveryObservationから算出、0〜100）。 */
  readonly observedDeliveryScore: Score0to100;
  /** 当期その市場向け履行に重大事故の影響が及んだ場合の追加信頼低下（0〜100スケールの減点）。 */
  readonly majorIncidentTrustPenalty: number;
}
