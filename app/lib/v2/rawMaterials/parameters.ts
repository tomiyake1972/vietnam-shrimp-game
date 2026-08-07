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

    /**
     * 調達人員 → 調達処理能力（HOSO換算トン、逓減曲線）。Phase4の
     * processingCapacityと同じ形。会社の実際の買付実務能力の上限であり、
     * 「有効買付意向」（信認上限付きの買付意向。§1参照）の算出にも、実配分の
     * cap算出にも使う。
     * 【Phase 6.3】工場能力情報が無い呼び出し（industryLabの小規模テスト会社等）
     * 向けのフォールバック絶対値カーブ。工場能力を持つ会社
     * （DomesticPurchasePlanEntry.factoryCommonProcessingCapacityTons指定時）は
     * capacityFactoryLinked（工場能力連動方式）を優先する。
     */
    readonly baselineCapacityTons: number;
    readonly capacityMaxIncrementTons: number;
    readonly capacitySaturationHeadcount: number;

    /**
     * 【Phase 6.3新規（実装指示 §6）】工場能力連動の調達処理能力。
     *   調達能力 = 工場共通原料処理能力 × (baseRatioAtZeroHeadcount
     *              + ratioMaxIncrement × 人員/(人員+saturationHeadcount))
     * 一律倍率（旧company-labの約100倍補正）を廃止し、会社別の工場能力と
     * 調達人員の双方を上限計算へ反映する。通常時の調達能力が工場の共通原料
     * 処理能力のおおむね1.0〜1.5倍になるよう校正した暫定値:
     *   - 通常操業では頻繁に制約になりすぎない（調達構成6〜7割の国内買付は余裕内）
     *   - 急増産・買い占め（工場能力を大きく超える買付）では制約になる
     *   - 調達人員を増やす効果は残るが飽和する
     */
    readonly capacityFactoryLinked: {
      readonly baseRatioAtZeroHeadcount: number;
      readonly ratioMaxIncrement: number;
      readonly saturationHeadcount: number;
    };

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
     * 実配分（allocateDomesticPurchase）のcapに使う。
     */
    readonly maximumBuyerShare: number;

    /**
     * 国内価格形成（Phase3）へ渡す「有効買付意向」の算出に使う、1社が
     * 基準国内供給量に対して持てる最大価格影響シェア（0〜1）。
     * 【暫定値・要校正・Task E差分】実配分のmaximumBuyerShareとは別の係数として
     * 分離している（実際に買える上限と、価格シグナルとして認める上限は、将来
     * 別々に調整したい場合があるため）。現段階では同値でもよい暫定値。
     * これにより「実際には買えない希望量を過大申告して国内価格だけを押し上げる」
     * 抜け道を防ぐ（会社の有効買付意向は、desiredQuantity・procurementCapacity・
     * approvedPurchaseCap・基準供給量×このシェアのうち最小値に制限される）。
     */
    readonly maximumPriceInfluenceShare: number;

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

    baselineCapacityTons: 150,
    capacityMaxIncrementTons: 3600,
    capacitySaturationHeadcount: 10,

    // Phase 6.3新規・要校正: 5社フィクスチャの工場能力（1.5万〜3.6万トン/四半期）に
    // 対し、人員8〜20人で調達能力が工場能力の約1.03〜1.30倍となる。
    capacityFactoryLinked: {
      baseRatioAtZeroHeadcount: 0.5,
      ratioMaxIncrement: 1.2,
      saturationHeadcount: 10,
    },

    competitivenessWeights: {
      price: 0.4,
      coverage: 0.25,
      farmerRelationship: 0.2,
      paymentReliability: 0.15,
    },

    neutralScore: score0to100(50),

    maximumBuyerShare: 0.35,
    maximumPriceInfluenceShare: 0.35,

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
