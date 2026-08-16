// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール パラメータ定義（Phase 7A）
//
// production/parameters.ts・sales/parameters.tsと同じ方針で、計算ロジックに
// マジックナンバーを直接書かず、すべての係数をこの1ファイルへ集約する。
// すべて「Phase7A新規・要校正」の暫定値であり、ゲームバランス調整フェーズで
// 再検討する前提とする。三宅さんの実装指示に明示された数値（utilizationの
// 閾値0.80・帯域0.20・指数2、operationalRiskの各重み、maximumNonConformanceRatio
// =0.08、downgrade/rework/discardShare、minimumSaleableRecoveryRatio=0.90、
// majorIncidentの各確率、品質・納期・顧客信頼の更新alpha）はそのまま採用し、
// 指示に数値のない箇所（重大事故の重大度→追加廃棄率／品質減点／信頼減点の
// 換算係数、継続納期超過への小さなペナルティ、baselineOperationalQualityの
// 由来）だけを本ファイルの責務で「要校正」の暫定値として補う。

import { Score0to100, score0to100 } from "../core/units";

export interface QualityParameters {
  readonly parametersVersion: string;

  readonly operationalRisk: {
    /** 設備稼働ストレス: utilizationStress = clamp((rate - threshold) / band, 0, 1) ^ exponent。 */
    readonly utilizationThreshold: number;
    readonly utilizationBand: number;
    readonly utilizationExponent: number;
    /**
     * 原料経過期間ストレスの分母（usableShelfLife、四半期数）。rawMaterials側の
     * 原料ロットは現状defaultShelfLifeTurns=undefined（期限を設けない運用）のため、
     * 品質モジュール独自の参考基準としてここで定義する（原料の実務的な鮮度限界の
     * 暫定値。要校正）。
     */
    readonly rawMaterialUsableShelfLifeQuarters: number;
    /** 総合操業リスクの加重合計に使う重み（実装指示の値をそのまま採用。合計1.0）。 */
    readonly weights: {
      readonly utilization: number;
      readonly overtime: number;
      readonly temporaryWorker: number;
      readonly complexity: number;
      readonly rawMaterialAge: number;
      readonly productionRamp: number;
    };
  };

  readonly qualityOutcome: {
    /** nonConformanceRatio = maximumNonConformanceRatio * operationalRisk ^ exponent。 */
    readonly maximumNonConformanceRatio: number;
    readonly nonConformanceExponent: number;
    readonly downgradeShare: number;
    readonly reworkShare: number;
    readonly discardShare: number;
    /** saleableRecoveryRatio = clamp(1 - discardRatio, minimumSaleableRecoveryRatio, 1)。 */
    readonly minimumSaleableRecoveryRatio: number;
    /** 既存フィクスチャに品質能力の値がなかったため、全社共通の中立値として採用（要校正・§文書化参照）。 */
    readonly baselineOperationalQuality: Score0to100;
    /** observedQualityScore = clamp(baseline - qualityRiskPenaltyPerUnitRisk * operationalRisk - 重大事故減点, 0, 100)。 */
    readonly qualityRiskPenaltyPerUnitRisk: number;
  };

  readonly majorIncident: {
    readonly baseIncidentProbability: number;
    readonly maximumRiskIncidentProbability: number;
    readonly riskExponent: number;
    readonly maximumIncidentProbability: number;
    /**
     * 重大度（0〜1、独立乱数から算出）→ 追加廃棄率・品質減点・信頼減点への換算係数。
     * 【要校正】実装指示に具体的な換算式の指定はないため、「事故一発で会社が
     * 再起不能にならない」（minimumSaleableRecoveryRatio=0.90のフロアで数量影響は
     * 既にバッチ単位10%までに制限される。品質・信頼スコアはalpha付き更新により
     * 単発事故でも即座にゼロへ張り付かない）という設計方針を満たす範囲の
     * 暫定値として置く。
     */
    readonly severityToAdditionalDiscardRatio: number;
    readonly severityToQualityPenalty: number;
    readonly severityToTrustPenalty: number;
  };

  readonly qualityScoreUpdate: {
    /** 悪化時（observed < previous）のalpha。品質は急落しやすい。 */
    readonly alphaDown: number;
    /** 改善時のalpha。回復は遅い。 */
    readonly alphaUp: number;
  };

  readonly deliveryReliabilityUpdate: {
    readonly alphaDown: number;
    readonly alphaUp: number;
    /**
     * 過年度から持ち越された継続納期超過数量に対する小さな追加ペナルティの係数
     * （dueQuantityに対する継続超過量の比率に、この係数を掛けた分だけ
     * observedOnTimeScoreへ追加で減点する。継続分を「毎期新しい失敗」として
     * 無制限に重複加算しないよう、上限も設ける）。【要校正】
     */
    readonly continuingOverduePenaltyPerRatio: number;
    readonly continuingOverduePenaltyCap: number;
  };

  readonly customerTrustUpdate: {
    readonly alphaDown: number;
    readonly alphaUp: number;
    readonly qualityWeight: number;
    readonly deliveryWeight: number;
  };

  /** 品質・顧客関係・納期信頼性が未接続・初期状態の場合に使う中立値（sales/parameters.tsのneutralScoreと同じ思想）。 */
  readonly neutralScore: Score0to100;

  /**
   * 【Phase QI-I1新設】品質管理設備（capex/types.ts CapitalProjectType
   * "qualityControlEquipment"）の効果パラメータ。設計方針（docs/v2/
   * quality_control_equipment_design_qi_d1.md）どおり、Quality Scoreへ直接
   * 加点せず、batch単位のoperationalRiskを完成済み設備のあるFactoryのぶんだけ
   * 有界な乗算で低減する。パラメータは意図的に最小限（2項目）とし、
   * PD省人化投資（capex/pdMechanization.ts）と同じ線形ランプの考え方を再利用する。
   */
  readonly qualityControlEquipment: {
    /**
     * 完成・フル習熟時（ramp=1.0）に達成される、operationalRiskの最大削減率
     * （0〜1）。effectiveOperationalRisk = baseOperationalRisk ×
     * (1 − fullEffectRiskReductionRatio × rampProgress)。1.0にはしない
     * （設備だけでリスクをゼロにしない設計方針、指示§4）。
     */
    readonly fullEffectRiskReductionRatio: number;
    /** 稼働開始からフル効果に達するまでの四半期数（線形ランプ、PD省人化投資と同じ形）。 */
    readonly rampQuarters: number;
  };
}

export const QUALITY_PARAMETERS_V1: QualityParameters = {
  parametersVersion: "quality-v0.1",

  operationalRisk: {
    utilizationThreshold: 0.8,
    utilizationBand: 0.2,
    utilizationExponent: 2,
    rawMaterialUsableShelfLifeQuarters: 4,
    weights: {
      utilization: 0.35,
      overtime: 0.2,
      temporaryWorker: 0.15,
      complexity: 0.1,
      rawMaterialAge: 0.1,
      productionRamp: 0.1,
    },
  },

  qualityOutcome: {
    maximumNonConformanceRatio: 0.08,
    nonConformanceExponent: 1.5,
    downgradeShare: 0.45,
    reworkShare: 0.25,
    discardShare: 0.3,
    minimumSaleableRecoveryRatio: 0.9,
    baselineOperationalQuality: score0to100(85),
    qualityRiskPenaltyPerUnitRisk: 30,
  },

  majorIncident: {
    baseIncidentProbability: 0.002,
    maximumRiskIncidentProbability: 0.08,
    riskExponent: 2,
    maximumIncidentProbability: 0.1,
    severityToAdditionalDiscardRatio: 0.5,
    severityToQualityPenalty: 40,
    severityToTrustPenalty: 25,
  },

  qualityScoreUpdate: {
    alphaDown: 0.2,
    alphaUp: 0.08,
  },

  deliveryReliabilityUpdate: {
    alphaDown: 0.25,
    alphaUp: 0.08,
    continuingOverduePenaltyPerRatio: 10,
    continuingOverduePenaltyCap: 8,
  },

  customerTrustUpdate: {
    alphaDown: 0.18,
    alphaUp: 0.06,
    qualityWeight: 0.5,
    deliveryWeight: 0.5,
  },

  neutralScore: score0to100(50),

  // 【Phase QI-I1・#04指示】第一候補は30%削減・2Qランプ（PD省人化投資と同じ
  // ランプ長）。20%/30%/40%はscripts/qualityControlEquipmentCapabilityQI1.tsの
  // ベンチマークで比較し、初回benchmark前には値を確定しない（指示§14/§42）。
  qualityControlEquipment: {
    fullEffectRiskReductionRatio: 0.3,
    rampQuarters: 2,
  },
};
