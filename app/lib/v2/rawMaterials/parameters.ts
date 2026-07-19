// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール パラメータ定義（Phase 5）
//
// Phase4（app/lib/v2/sales/parameters.ts）と同じ方針で、計算ロジックに
// マジックナンバーを直接書かず、すべての係数をこの1ファイルへ集約する。
// すべて「Phase5新規・要校正」の暫定値であり、ゲームバランス調整フェーズで
// 再検討する前提とする（ChatGPT側の指示に数値そのものの指定はないため、
// 要求された「効果の方向性」を満たす最小限の暫定値として置く）。

import { CountryId, COUNTRY_IDS } from "../market/types";
import { Score0to100, score0to100 } from "../core/units";

export interface RawMaterialsParameters {
  readonly parametersVersion: string;

  readonly domesticPurchase: {
    /**
     * 提示買付価格の競争力感度。
     * priceScore = exp(purchasePriceSensitivity * (bidPrice - marketPrice) / marketPrice)
     * 高値を提示するほど1を超える（買付が有利）。Phase4の価格競争力式と対称（符号が逆）。
     */
    readonly purchasePriceSensitivity: number;
    /** priceScoreの結果（下限・上限）。法外な高値提示でも全量独占を防ぐ（暫定値・要校正）。 */
    readonly minimumBuyerPriceCompetitiveness: number;
    readonly maximumBuyerPriceCompetitiveness: number;

    /** 調達人員 → 調達カバレッジ（0〜1、逓減曲線）。Phase4のsalesForceと同じ形。 */
    readonly baselineCoverageAtZeroHeadcount: number;
    readonly coverageSaturationHeadcount: number;

    /** 競争力の合成ウェイト（合計1.0を推奨）。 */
    readonly competitivenessWeights: {
      readonly price: number;
      readonly coverage: number;
      readonly farmerRelationship: number;
      readonly paymentReliability: number;
    };

    /** 顧客関係・信頼性が未接続の場合に使う中立値（0〜100スケール）。 */
    readonly neutralScore: Score0to100;

    /**
     * 市場×四半期ごとに、1社が対象供給から買い付けられる最大比率（0〜1）。
     * Phase4のmaximumSupplierShareと対称の「最大買付シェア」（暫定値・要校正）。
     */
    readonly maximumBuyerShare: number;

    /** 提示買付価格の入力検証（marketPriceに対する比率）。 */
    readonly minBidPriceRatioOfMarket: number;
    readonly maxBidPriceRatioOfMarket: number;
  };

  readonly imports: {
    /** 運賃（HOSO換算kgあたり、USD）。 */
    readonly freightUsdPerHosoEqKg: number;
    /** 関税・諸税（起点価格に対する比率）。 */
    readonly dutyRatio: number;
    /** 保険・取扱費（HOSO換算kgあたり、USD）。 */
    readonly insuranceHandlingUsdPerHosoEqKg: number;
    /** 原産国別の着地価格調整額（HOSO換算kgあたり、USD。物流事情等の簡易反映）。 */
    readonly originCountryAdjustmentUsdPerHosoEqKg: Readonly<Record<CountryId, number>>;
    /** 標準リードタイム（発注四半期から到着四半期までのターン数）。 */
    readonly standardLeadTimeTurns: number;
    /**
     * 原産国別の輸入供給上限を、その国のexportableSupply（Phase1出力）に対する
     * 比率として定義する。5社の輸入がこの比率を超えて調達できないようにする
     * ことで、国際基準価格そのものへは直接影響させない（暫定値・要校正）。
     */
    readonly importAvailableSupplyRatio: number;
  };

  readonly aquaculture: {
    /** 養殖強度による予定生産量への最大上乗せ比率（intensity=1で+この比率）。 */
    readonly intensityYieldBonusMax: number;
    /** 養殖強度による疾病脆弱性への最大上乗せ比率（intensity=1で疾病影響が+この比率）。 */
    readonly intensityDiseaseVulnerabilityMax: number;
    /** バイオセキュリティによる疾病影響の最大緩和比率（bioSecurityLevel=1で疾病影響を最大この比率だけ相殺）。 */
    readonly bioSecurityMitigationMax: number;
    /** 生残率の下限（壊滅的な疾病でも0にはしない、暫定値）。 */
    readonly minSurvivalRatio: number;
    /** 自社養殖の単位取得原価（HOSO換算kgあたり、USD）。会計処理はまだ行わないための簡易固定値。 */
    readonly aquacultureUnitCostUsdPerHosoEqKg: number;
  };

  readonly inventory: {
    /**
     * ロットの標準使用期限（入庫からのターン数）。undefinedの場合は期限を設けない。
     * 【暫定値・要校正】原料の鮮度管理はまだ簡略化しており、期限切れの経済的帰結
     * （廃棄損の会計計上等）はPhase8で接続する前提。
     */
    readonly defaultShelfLifeTurns?: number;
  };
}

const defaultOriginCountryAdjustment: Readonly<Record<CountryId, number>> = COUNTRY_IDS.reduce(
  (acc, c) => ({ ...acc, [c]: 0 }),
  {} as Record<CountryId, number>
);

export const RAW_MATERIALS_PARAMETERS_V1: RawMaterialsParameters = {
  parametersVersion: "raw-materials-v0.1",

  domesticPurchase: {
    purchasePriceSensitivity: 3.0,
    minimumBuyerPriceCompetitiveness: 0.5,
    maximumBuyerPriceCompetitiveness: 1.6,

    baselineCoverageAtZeroHeadcount: 0.15,
    coverageSaturationHeadcount: 6,

    competitivenessWeights: {
      price: 0.4,
      coverage: 0.25,
      farmerRelationship: 0.2,
      paymentReliability: 0.15,
    },

    neutralScore: score0to100(50),

    maximumBuyerShare: 0.35,

    minBidPriceRatioOfMarket: 0.5,
    maxBidPriceRatioOfMarket: 2.0,
  },

  imports: {
    freightUsdPerHosoEqKg: 0.15,
    dutyRatio: 0.05,
    insuranceHandlingUsdPerHosoEqKg: 0.05,
    originCountryAdjustmentUsdPerHosoEqKg: defaultOriginCountryAdjustment,
    standardLeadTimeTurns: 2,
    importAvailableSupplyRatio: 0.1,
  },

  aquaculture: {
    intensityYieldBonusMax: 0.5,
    intensityDiseaseVulnerabilityMax: 0.8,
    bioSecurityMitigationMax: 0.7,
    minSurvivalRatio: 0.1,
    aquacultureUnitCostUsdPerHosoEqKg: 3.2,
  },

  inventory: {
    defaultShelfLifeTurns: undefined,
  },
};
