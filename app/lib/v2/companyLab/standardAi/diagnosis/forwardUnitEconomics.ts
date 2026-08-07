// ShrimpX V2 — 2026-08-03 Phase B: Forward Unit Economics 診断モジュール
//
// 【目的】Standard AIが観測できる情報（StandardAiObservation + CompanyFixtureの
// 既存経済性パラメータ + production/finance両モジュールの既存原価パラメータ）だけ
// から、市場×商品ごとの参照売価・原料費・その他変動費・貢献利益・配賦固定費・
// 製造フルコスト・許容原料価格・3区分の採算分類を診断する。
//
// 【本モジュールの位置づけ】診断専用（read-only, pure functions）。この結果を
// 販売・生産・調達の意思決定へ接続することは今回のスコープ外（2026-08-03指示
// Section B「まだ販売判断へは接続しない」）。situatuonDiagnosis.ts/decision/*.ts
// のいずれからも呼び出されず、独立して呼び出し・テストできる。
//
// 【新しい原価計算ロジック・新しい市場ルールは一切作らない。既存パラメータの
// そのままの再利用のみ】
//   - production/parameters.ts: cost.baseProcessingCostUsdPerTon
//     （商品別加工変動費。HOSO $350/t・PD $520/t・VAP $780/t。これはHOSO基準の
//     絶対額であり、premiumPolicy.ts側のCompanyPremiumEconomics（HOSOに対する
//     プレミアムとしての増分値）とは別の、生産エンジン本体が使う絶対値パラメータ）
//   - finance/parameters.ts:
//       manufacturing.factoryUtilityVariableUsdPerTon（$25/t、商品共通の変動費）
//       sellingGeneralAdmin.sellingLogisticsUsdPerTon（$100/t、商品共通の変動費）
//       manufacturing.factoryFixedCostUsdPerQuarter / factoryUtilityFixedUsdPerQuarter
//         （工場1拠点あたりの固定費プールの構成要素）
//       managementAccounting.fixedCostAllocationCoefficientByProduct
//         （HOSO 1.0 / PD 1.5 / VAP 2.4。商品別固定費配賦の重み）
//   - observation.vietnamDomesticPriorPrice（国内原料の前四半期参照価格）
//   - observation.lastHosoPriceVn（国際HOSO参照価格。輸入原料コストの実測値では
//     ないため、あくまで「輸入コストの目安の下限」として明示的にラベル付けする）
//   - observation.markets[].referencePriceByProduct（市場×商品の前期参照販売価格）
//
// 【原料費の出典を明示（捏造しない）】StandardAiObservationには、会社が実際に
// どの原料源（国内／輸入／養殖）から仕入れているかの構成比も、輸入・養殖の
// 実際の原価も露出していない。したがって:
//   - domestic: vietnamDomesticPriorPriceが存在する場合のみ使用（無い場合はnull）。
//   - importReferenceOnly: lastHosoPriceVnを「輸入コストの目安の下限」として
//     参考値としてのみ保持する（実際の輸入約定価格ではないことを明示する）。
//   - aquaculture: 観測に存在しないため常にnull。
//   本モジュールの主たる原料費（rawMaterialCostUsdPerKg、Contribution Margin計算に
//   使う値）は、会社の主要な調達源である国内原料の参照価格を採用する
//   （dataQuality.rawMaterialCostSource="domesticReferencePrice"で明示）。
//   国内価格が観測できない場合（turn1等）は、原料費・貢献利益以降の全ての
//   派生値がnullになり、憶測で埋めない。
//
// 【配賦固定費の簡略化を明示（憶測ではないが、実際の四半期決算とは一致しない）】
// 実際の会計処理（finance/quarterClose.ts）は「当期に実際に生産した品質調整後
// 生産量」を配賦基準にするが、本モジュールは意思決定前の“将来”診断であるため
// 当期生産量は未定である。そこで、実効能力（totalEffectiveCapacityByProduct）を
// 「参考生産ミックス」とみなし、既存配賦係数で重み付けした比率だけを使う
// （下記コメント参照）。これは意図的な簡略化であり、実際の四半期決算の
// 配賦固定費とは一致しない旨をdataQuality.fixedCostAllocationNoteに明記する。

import { DemandMarketId, Product } from "../../../market/types";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { StandardAiObservation } from "../types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export type StandardAiProfitabilityClass = "FULLY_PROFITABLE" | "CONTRIBUTION_POSITIVE_ONLY" | "UNECONOMIC";

/** 1件（会社×市場×商品）ぶんのForward Unit Economics診断結果。 */
export interface StandardAiUnitEconomicsEntry {
  readonly companyId: string;
  readonly market: DemandMarketId;
  readonly product: Product;

  /** 前期実績の参照販売価格（USD/HOSO換算kg）。観測に存在しない場合null（捏造しない）。 */
  readonly referenceSalesPriceUsdPerKg: number | null;

  /** 主たる原料費として採用した値（USD/HOSO換算kg）。国内参照価格が無い場合null。 */
  readonly rawMaterialCostUsdPerKg: number | null;
  /** 国内・輸入(参考値のみ)・養殖(常にnull)の内訳。出典の透明性のため保持する。 */
  readonly rawMaterialCostBySourceUsdPerKg: {
    readonly domestic: number | null;
    readonly importReferenceOnly: number | null;
    readonly aquaculture: null;
  };

  /** 原料以外の変動費（加工変動費＋ユーティリティ変動費＋販売物流変動費）合計（USD/kg）。 */
  readonly nonRawVariableCostUsdPerKg: number;
  /** 原料費＋原料以外の変動費（rawMaterialCostUsdPerKgがnullならnull）。 */
  readonly totalVariableCostUsdPerKg: number | null;

  /** 貢献利益 = 参照売価 − 原料費 − 原料以外の変動費全て（USD/kg）。 */
  readonly contributionMarginUsdPerKg: number | null;
  readonly contributionMarginRate: number | null;

  /** 配賦固定費（実効能力ベースの参考生産ミックスによる簡略配賦。USD/kg）。 */
  readonly allocatedManufacturingFixedCostUsdPerKg: number;
  /** 製造フルコスト = 原料費＋原料以外の変動費＋配賦固定費（USD/kg）。 */
  readonly manufacturingFullCostUsdPerKg: number | null;
  readonly manufacturingFullCostMarginUsdPerKg: number | null;
  readonly manufacturingFullCostMarginRate: number | null;

  /** 貢献利益ゼロを許容する原料費上限（USD/kg）。参照売価が未観測ならnull。 */
  readonly contributionAffordableRawPriceUsdPerKg: number | null;
  /** 製造フルコストゼロを許容する原料費上限（USD/kg）。参照売価が未観測ならnull。 */
  readonly fullCostAffordableRawPriceUsdPerKg: number | null;

  readonly profitabilityClass: StandardAiProfitabilityClass | null;

  readonly dataQuality: {
    /** trueなら、referenceSalesPriceUsdPerKgまたはrawMaterialCostUsdPerKgが
     *  観測不足でnullであり、この市場×商品の採算判断は不可（primary/secondary
     *  制約候補やopportunity診断では「unknown」として扱うべきことの明示）。 */
    readonly hasMissingCriticalInput: boolean;
    readonly missingInputs: readonly string[];
    readonly rawMaterialCostSource: "domesticReferencePrice" | "unavailable";
    readonly fixedCostAllocationNote: string;
  };
}

export interface StandardAiUnitEconomicsResult {
  readonly companyId: string;
  readonly entries: readonly StandardAiUnitEconomicsEntry[];
}

const FIXED_COST_ALLOCATION_NOTE =
  "配賦固定費は、当期の実際の生産ミックスではなく、実効能力（totalEffectiveCapacityByProduct）を" +
  "参考生産ミックスとみなし既存配賦係数（fixedCostAllocationCoefficientByProduct）で重み付けした" +
  "簡略推計である。減価償却費は観測に露出していないため含んでいない（過小推計方向の限界であり、" +
  "憶測で加算していない）。四半期決算の実際の配賦固定費とは一致しない。";

/** 商品別「原料以外の変動費」合計（USD/kg）。加工変動費＋ユーティリティ変動費＋販売物流変動費。 */
function nonRawVariableCostUsdPerKg(product: Product): number {
  const hosoEqKgPerTon = PRODUCTION_PARAMETERS_V1.cost.hosoEqKgPerTon;
  const processingUsdPerTon = PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon[product];
  const utilityVariableUsdPerTon = FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityVariableUsdPerTon;
  const sellingLogisticsUsdPerTon = FINANCE_PARAMETERS_V1.sellingGeneralAdmin.sellingLogisticsUsdPerTon;
  return (processingUsdPerTon + utilityVariableUsdPerTon + sellingLogisticsUsdPerTon) / hosoEqKgPerTon;
}

/**
 * 商品別の配賦固定費（USD/kg）。実効能力を参考生産ミックスとした簡略配賦
 * （ファイル冒頭コメント参照）。totalEffectiveCapacityByProductの合計が0
 * （ほぼありえないが、極端な人工ケース用の安全策）の場合は配賦不能として0を返す
 * （固定費が消えるのではなく、この診断が単に配賦できないことの表明。
 * dataQuality側で別途明示はしないが、manufacturingFullCost全体がその場合
 * variableCostのみに近似される）。
 */
function allocatedManufacturingFixedCostByProductUsdPerKg(observation: StandardAiObservation): Readonly<Record<Product, number>> {
  const numberOfFactories = observation.factories.length;
  const fixedCostPoolUsd =
    numberOfFactories *
    (FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter + FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter);
  const coeffs = FINANCE_PARAMETERS_V1.managementAccounting.fixedCostAllocationCoefficientByProduct;
  const referenceMix = observation.totalEffectiveCapacityByProduct;
  const totalWeight = PRODUCTS.reduce((sum, p) => sum + coeffs[p] * referenceMix[p], 0);
  const hosoEqKgPerTon = PRODUCTION_PARAMETERS_V1.cost.hosoEqKgPerTon;

  const result: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  if (totalWeight <= 1e-6 || fixedCostPoolUsd <= 0) return result;
  for (const p of PRODUCTS) {
    // perTon[p] = fixedCostPoolUsd × coeffs[p] / totalWeight（referenceMix[p]自身には
    // 依存しない。上記コメントの導出参照）。
    const perTonUsd = (fixedCostPoolUsd * coeffs[p]) / totalWeight;
    result[p] = perTonUsd / hosoEqKgPerTon;
  }
  return result;
}

/**
 * 会社×市場×商品の全組み合わせについてForward Unit Economicsを計算する。
 * 純粋関数（observationのみを入力とし、副作用・グローバル状態を持たない）。
 */
export function buildStandardAiUnitEconomics(observation: StandardAiObservation): StandardAiUnitEconomicsResult {
  const domesticRawPrice = observation.vietnamDomesticPriorPrice ?? null;
  const importReferenceOnly = observation.lastHosoPriceVn ?? null;
  const allocatedFixedCostByProduct = allocatedManufacturingFixedCostByProductUsdPerKg(observation);

  const rawMaterialCostUsdPerKg = domesticRawPrice;
  const rawMaterialCostSource: "domesticReferencePrice" | "unavailable" = domesticRawPrice !== null ? "domesticReferencePrice" : "unavailable";

  const entries: StandardAiUnitEconomicsEntry[] = [];

  for (const marketEntry of observation.markets) {
    for (const product of PRODUCTS) {
      const referenceSalesPriceUsdPerKg = marketEntry.referencePriceByProduct?.[product] ?? null;
      const nonRawCost = nonRawVariableCostUsdPerKg(product);
      const allocatedFixedCost = allocatedFixedCostByProduct[product];

      const missingInputs: string[] = [];
      if (referenceSalesPriceUsdPerKg === null) missingInputs.push("referenceSalesPriceUsdPerKg");
      if (rawMaterialCostUsdPerKg === null) missingInputs.push("rawMaterialCostUsdPerKg(domesticReferencePrice未観測)");
      const hasMissingCriticalInput = missingInputs.length > 0;

      const totalVariableCostUsdPerKg = rawMaterialCostUsdPerKg === null ? null : rawMaterialCostUsdPerKg + nonRawCost;

      const contributionMarginUsdPerKg =
        referenceSalesPriceUsdPerKg === null || totalVariableCostUsdPerKg === null ? null : referenceSalesPriceUsdPerKg - totalVariableCostUsdPerKg;
      const contributionMarginRate =
        contributionMarginUsdPerKg === null || referenceSalesPriceUsdPerKg === null || referenceSalesPriceUsdPerKg <= 0
          ? null
          : contributionMarginUsdPerKg / referenceSalesPriceUsdPerKg;

      const manufacturingFullCostUsdPerKg = totalVariableCostUsdPerKg === null ? null : totalVariableCostUsdPerKg + allocatedFixedCost;
      const manufacturingFullCostMarginUsdPerKg =
        referenceSalesPriceUsdPerKg === null || manufacturingFullCostUsdPerKg === null ? null : referenceSalesPriceUsdPerKg - manufacturingFullCostUsdPerKg;
      const manufacturingFullCostMarginRate =
        manufacturingFullCostMarginUsdPerKg === null || referenceSalesPriceUsdPerKg === null || referenceSalesPriceUsdPerKg <= 0
          ? null
          : manufacturingFullCostMarginUsdPerKg / referenceSalesPriceUsdPerKg;

      // 許容原料価格は「参照売価が既知」であれば常に計算できる（原料費自体が
      // 未観測でも、逆算した上限値そのものは意味を持つ診断値のため）。
      const contributionAffordableRawPriceUsdPerKg = referenceSalesPriceUsdPerKg === null ? null : referenceSalesPriceUsdPerKg - nonRawCost;
      const fullCostAffordableRawPriceUsdPerKg =
        referenceSalesPriceUsdPerKg === null ? null : referenceSalesPriceUsdPerKg - nonRawCost - allocatedFixedCost;

      let profitabilityClass: StandardAiProfitabilityClass | null = null;
      if (manufacturingFullCostMarginUsdPerKg !== null && contributionMarginUsdPerKg !== null) {
        if (manufacturingFullCostMarginUsdPerKg > 0) profitabilityClass = "FULLY_PROFITABLE";
        else if (contributionMarginUsdPerKg > 0) profitabilityClass = "CONTRIBUTION_POSITIVE_ONLY";
        else profitabilityClass = "UNECONOMIC";
      }

      entries.push({
        companyId: observation.companyId,
        market: marketEntry.market,
        product,
        referenceSalesPriceUsdPerKg,
        rawMaterialCostUsdPerKg,
        rawMaterialCostBySourceUsdPerKg: {
          domestic: domesticRawPrice,
          importReferenceOnly,
          aquaculture: null,
        },
        nonRawVariableCostUsdPerKg: nonRawCost,
        totalVariableCostUsdPerKg,
        contributionMarginUsdPerKg,
        contributionMarginRate,
        allocatedManufacturingFixedCostUsdPerKg: allocatedFixedCost,
        manufacturingFullCostUsdPerKg,
        manufacturingFullCostMarginUsdPerKg,
        manufacturingFullCostMarginRate,
        contributionAffordableRawPriceUsdPerKg,
        fullCostAffordableRawPriceUsdPerKg,
        profitabilityClass,
        dataQuality: {
          hasMissingCriticalInput,
          missingInputs,
          rawMaterialCostSource,
          fixedCostAllocationNote: FIXED_COST_ALLOCATION_NOTE,
        },
      });
    }
  }

  return { companyId: observation.companyId, entries };
}
