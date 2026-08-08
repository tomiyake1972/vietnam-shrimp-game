// ShrimpX V2 — Test15 管理会計ワーキングブックの共有モデル層
//
// 【この層の役割】Excel生成コードが「自分で管理会計を計算しない」ようにするための、
// ゲームエンジン側の正式ロジックだけを使った純粋な組み立て関数群。
//
// 【最重要方針】新しい原価・固変分解・限界利益・在庫評価・営業能力・労働負荷・
// 歩留まりのロジックをここで作らない。すべて既存のエンジン関数・パラメータを
// import して使う。Excelとゲーム本体で計算結果がずれることを構造的に防ぐ。
//
//   固変分解         → finance/types.ts CostRecord.fixedPortion / variablePortion
//   限界利益         → finance/quarterClose.ts が算出した ContributionMarginReport
//   在庫評価         → finance/types.ts FinishedGoodsUnitCostBreakdown と
//                      variableUnitCostPerTon / fixedUnitCostPerTon / totalUnitCostPerTon
//   営業能力         → sales/salesForce.ts processingCapacity（飽和カーブ本体）
//   営業工数係数     → sales/parameters.ts salesEffortCoefficients
//   労働負荷         → production/labor.ts computeRequiredRegularHeadcount /
//                      laborIntensityCoefficientFor
//   原料歩留まり     → production/parameters.ts の歩留まり係数
//
// 【単位の約束】数量はHOSO換算トン、金額はUSD、単価はUSD/HOSO換算kg。
// トン→kgは1000倍。ゼロ除算はundefinedを返し、呼び出し側が「－」を表示する
// （NaN/Infinityを絶対に外へ出さない）。

import { Product } from "../../market/types";
import { DemandMarketId } from "../../market/types";
import { SALES_PARAMETERS_V1, SalesParameters } from "../../sales/parameters";
import { processingCapacity } from "../../sales/salesForce";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../../production/parameters";
import { effectiveEfficiencyPerHeadTons, laborIntensityCoefficientFor } from "../../production/labor";
import { computeRequiredRegularHeadcount } from "../workforce";
import { unwrapUnit } from "../../core/units";

export const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
export const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];

const EPSILON = 1e-9;

/** 数量0・非有限のときにNaN/Infinityを外へ出さないための安全な除算。 */
export function safeDivide(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || Math.abs(denominator) <= EPSILON) return undefined;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : undefined;
}

/** トン建ての金額を USD/kg 単価へ変換する（数量0ならundefined）。 */
export function usdPerKg(totalUsd: number, quantityTons: number): number | undefined {
  return safeDivide(totalUsd, quantityTons * 1000);
}

// ---------------------------------------------------------------------
// 1. 原料調達（調達元別）
// ---------------------------------------------------------------------

/** 調達元1件ぶんの当期調達実績。 */
export interface RawProcurementBySource {
  /** "import" | "aquaculture" | "domesticPurchase" 等（ロットのsourceをそのまま使う）。 */
  readonly source: string;
  readonly quantityTons: number;
  readonly totalCostUsd: number;
  /** 加重平均単価（USD/HOSO換算kg）。数量0ならundefined。 */
  readonly averageUnitCostUsdPerKg: number | undefined;
}

/** 全社の原料調達サマリー（商品別には配賦しない。理由は下記コメント）。 */
export interface RawProcurementSummary {
  readonly bySource: readonly RawProcurementBySource[];
  readonly totalQuantityTons: number;
  readonly totalCostUsd: number;
  /** 全調達の加重平均単価 = 総原料費 ÷ 総調達量kg。数量0ならundefined。 */
  readonly weightedAverageUnitCostUsdPerKg: number | undefined;
}

/** 原料ロット1件（exportDtoのExportRawMaterialLotと同じ形。この層は型に依存しない）。 */
export interface RawLotLike {
  readonly source: string;
  readonly inboundPeriod: string;
  readonly originalQuantity: number;
  readonly unitCost: number;
}

/**
 * 当期に入庫した原料ロットを調達元別に集計する。
 *
 * 【商品別に配賦しない理由】原料ロットは会社単位のプールであり、どのロットが
 * どの商品になったかは完成品ロットのsourceRawMaterialLotsを辿れば個別には
 * 分かるが、「調達元 × 商品」の対応は生産バッチの投入順序に依存する。
 * 存在しない配賦を作らないという方針に従い、調達情報は全社共通の情報として
 * 提示する（指示 §1-2 の但し書きに対応）。
 */
export function summarizeRawProcurement(lots: readonly RawLotLike[], period: string): RawProcurementSummary {
  const acquired = lots.filter((l) => l.inboundPeriod === period);
  const bySourceMap = new Map<string, { quantityTons: number; totalCostUsd: number }>();
  for (const lot of acquired) {
    const bucket = bySourceMap.get(lot.source) ?? { quantityTons: 0, totalCostUsd: 0 };
    bucket.quantityTons += lot.originalQuantity;
    // unitCost は USD/HOSO換算kg なので、金額はトン→kg換算して掛ける。
    bucket.totalCostUsd += lot.originalQuantity * 1000 * lot.unitCost;
    bySourceMap.set(lot.source, bucket);
  }

  const bySource: RawProcurementBySource[] = [...bySourceMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, v]) => ({
      source,
      quantityTons: v.quantityTons,
      totalCostUsd: v.totalCostUsd,
      averageUnitCostUsdPerKg: usdPerKg(v.totalCostUsd, v.quantityTons),
    }));

  const totalQuantityTons = bySource.reduce((s, e) => s + e.quantityTons, 0);
  const totalCostUsd = bySource.reduce((s, e) => s + e.totalCostUsd, 0);

  return {
    bySource,
    totalQuantityTons,
    totalCostUsd,
    weightedAverageUnitCostUsdPerKg: usdPerKg(totalCostUsd, totalQuantityTons),
  };
}

// ---------------------------------------------------------------------
// 2. 商品別 期末製品在庫の評価
// ---------------------------------------------------------------------

export interface ProductInventoryValuation {
  readonly product: Product;
  readonly quantityTons: number;
  /** 期末在庫に含まれる原料費（USD）。 */
  readonly rawMaterialCostUsd: number;
  /** 期末在庫に含まれる加工費等（原料費以外のすべて。変動・固定を含む）（USD）。 */
  readonly processingAndOtherCostUsd: number;
  /** 在庫評価額合計（USD）= 原料費 + 加工費等。 */
  readonly totalValueUsd: number;
}

/** 完成品原価台帳エントリ（finance/types.ts の FinishedGoodsCostLedgerEntry と同形）。 */
export interface CostLedgerEntryLike {
  readonly product: string;
  readonly remainingQuantity: number;
  readonly unitCost: {
    readonly rawMaterialPerTon: number;
    readonly processingPerTon: number;
    readonly laborVariablePerTon: number;
    readonly utilityVariablePerTon: number;
    readonly laborFixedPerTon: number;
    readonly factoryFixedPerTon: number;
    readonly utilityFixedPerTon: number;
    readonly depreciationPerTon: number;
  };
}

/**
 * 完成品原価台帳から商品別の期末在庫評価を組み立てる。
 *
 * 【既存の在庫評価ロジックをそのまま使う】単位原価の内訳は
 * finance/types.ts の FinishedGoodsUnitCostBreakdown をそのまま読み、
 * 「原料費」と「それ以外（加工費等）」に分けるだけ。合計は必ず
 * totalUnitCostPerTon と一致する（＝BSの完成品在庫と同じ評価）。
 */
export function summarizeInventoryValuation(ledger: readonly CostLedgerEntryLike[]): readonly ProductInventoryValuation[] {
  return PRODUCTS.map((product) => {
    const entries = ledger.filter((e) => e.product === product);
    let quantityTons = 0;
    let rawMaterialCostUsd = 0;
    let processingAndOtherCostUsd = 0;
    for (const e of entries) {
      const u = e.unitCost;
      quantityTons += e.remainingQuantity;
      rawMaterialCostUsd += e.remainingQuantity * u.rawMaterialPerTon;
      processingAndOtherCostUsd +=
        e.remainingQuantity *
        (u.processingPerTon +
          u.laborVariablePerTon +
          u.utilityVariablePerTon +
          u.laborFixedPerTon +
          u.factoryFixedPerTon +
          u.utilityFixedPerTon +
          u.depreciationPerTon);
    }
    return {
      product,
      quantityTons,
      rawMaterialCostUsd,
      processingAndOtherCostUsd,
      totalValueUsd: rawMaterialCostUsd + processingAndOtherCostUsd,
    };
  });
}

// ---------------------------------------------------------------------
// 3. 固変分解（CostRecord から商品別・市場別の変動費単価を導く）
// ---------------------------------------------------------------------

/** コスト記録（finance/types.ts の CostRecord と同形。金額はUSD）。 */
export interface CostRecordLike {
  readonly account: string;
  readonly behavior: string;
  readonly fixedPortion: number;
  readonly variablePortion: number;
  /** 商品への帰属。帰属しない費目は未設定（Export DTOはnullで表す）。 */
  readonly product?: string | null;
  /** 市場への帰属。帰属しない費目は未設定（Export DTOはnullで表す）。 */
  readonly market?: string | null;
}

export interface FixedCostBreakdown {
  /** 売上原価に含まれる固定費（製造固定費）。 */
  readonly inCostOfSales: readonly { readonly account: string; readonly amountUsd: number }[];
  readonly inCostOfSalesTotalUsd: number;
  /** 販管費に含まれる固定費。 */
  readonly inSellingGeneralAdmin: readonly { readonly account: string; readonly amountUsd: number }[];
  readonly inSellingGeneralAdminTotalUsd: number;
  readonly totalUsd: number;
}

/**
 * 売上原価側の固定費とみなす勘定。ゲーム側の正式な費用分類（CostRecord.account）を
 * そのまま使い、Excel側で分類を変えない。
 */
const COST_OF_SALES_FIXED_ACCOUNTS: readonly string[] = [
  "regularLaborCost",
  "factoryFixedCost",
  "utilityFixed",
  "depreciation",
  "idleLaborCost",
  "capexMaintenanceCost",
  "unabsorbedFixedManufacturingCost",
];

/**
 * CostRecordの固定費部分を「売上原価に含まれる固定費」と
 * 「販管費に含まれる固定費」の2種類へ分けて集計する（指示 §3-2）。
 *
 * 分類は勘定科目（CostRecord.account）に基づく。変動費／固定費の区分そのものは
 * CostRecord.fixedPortion / variablePortion をそのまま使い、Excel側で組み替えない。
 */
export function summarizeFixedCosts(records: readonly CostRecordLike[]): FixedCostBreakdown {
  const cogsMap = new Map<string, number>();
  const sgaMap = new Map<string, number>();
  for (const r of records) {
    if (!Number.isFinite(r.fixedPortion) || Math.abs(r.fixedPortion) <= EPSILON) continue;
    const target = COST_OF_SALES_FIXED_ACCOUNTS.includes(r.account) ? cogsMap : sgaMap;
    target.set(r.account, (target.get(r.account) ?? 0) + r.fixedPortion);
  }
  const toRows = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([account, amountUsd]) => ({ account, amountUsd }));
  const inCostOfSales = toRows(cogsMap);
  const inSellingGeneralAdmin = toRows(sgaMap);
  const inCostOfSalesTotalUsd = inCostOfSales.reduce((s, r) => s + r.amountUsd, 0);
  const inSellingGeneralAdminTotalUsd = inSellingGeneralAdmin.reduce((s, r) => s + r.amountUsd, 0);
  return {
    inCostOfSales,
    inCostOfSalesTotalUsd,
    inSellingGeneralAdmin,
    inSellingGeneralAdminTotalUsd,
    totalUsd: inCostOfSalesTotalUsd + inSellingGeneralAdminTotalUsd,
  };
}

// ---------------------------------------------------------------------
// 4. 市場×商品別の限界利益
// ---------------------------------------------------------------------

export interface MarketProductMarginRow {
  readonly market: DemandMarketId;
  readonly product: Product;
  /** 販売（納入）数量（HOSO換算トン）。 */
  readonly quantityTons: number;
  readonly netRevenueUsd: number;
  /** 販売単価（USD/kg）。数量0ならundefined。 */
  readonly sellingPriceUsdPerKg: number | undefined;
  /** 売上原価単価（USD/kg）。商品別平均を全市場共通で使う（指示 §2-1）。 */
  readonly cogsUnitUsdPerKg: number | undefined;
  readonly cogsAmountUsd: number | undefined;
  /** 変動費単価（USD/kg）。商品別変動費 ＋ 市場別の変動販売費。 */
  readonly variableCostUnitUsdPerKg: number | undefined;
  readonly variableCostAmountUsd: number;
  readonly contributionMarginUnitUsdPerKg: number | undefined;
  readonly contributionMarginUsd: number;
  readonly contributionMarginRatio: number | undefined;
  readonly grossProfitUsd: number | undefined;
  readonly grossProfitUnitUsdPerKg: number | undefined;
}

/** 商品別の集計値（ContributionMarginReport.byProduct 相当）。 */
export interface ProductMarginAggregate {
  readonly product: Product;
  readonly netRevenueUsd: number;
  readonly variableCostUsd: number;
  readonly contributionMarginUsd: number;
  readonly contributionMarginRatio: number | undefined;
  readonly directFixedCostUsd: number;
}

export interface MarketProductMarginModel {
  readonly rows: readonly MarketProductMarginRow[];
  readonly byProduct: readonly ProductMarginAggregate[];
  readonly companyTotal: {
    readonly netRevenueUsd: number;
    readonly variableCostUsd: number;
    readonly contributionMarginUsd: number;
    readonly contributionMarginRatio: number | undefined;
  };
  readonly fixedCosts: FixedCostBreakdown;
  /** 商品別・市場別へ配賦していない共通変動費（配賦しないことを明示するために保持）。 */
  readonly commonVariableCostUsd: number;
}

/** 限界利益レポートの1次元集計（ContributionMarginByDimension と同形）。 */
export interface MarginDimensionLike {
  readonly key: string;
  readonly netRevenue: number;
  readonly variableCost: number;
  readonly contributionMargin: number;
  /** 純売上高0のときは未定義。Export DTOはnullで表すためnullも受ける。 */
  readonly contributionMarginRatio?: number | null;
  readonly directFixedCost: number;
}

/** 市場×商品の納入・売上明細（成約ではなく実納入ベース）。 */
export interface MarketProductSalesLike {
  readonly market: string;
  readonly product: string;
  readonly quantityTons: number;
  readonly netRevenueUsd: number;
}

/**
 * 市場×商品別の限界利益を組み立てる。
 *
 * 【設計上の前提（指示 §2-1）】ゲームエンジンの ContributionMarginReport は
 * byProduct と byMarket を別々に持ち、market × product の交差は保持していない。
 * したがって:
 *   - 売上原価単価・製造変動費単価 … 商品別平均を全市場共通で適用する
 *   - 市場差                       … 販売価格と、市場別の変動販売費（物流費等）で表現する
 * これは指示どおりの扱いであり、存在しない交差配賦を作っていない。
 *
 * @param productVariableCostUnitUsdPerKg 商品別の製造変動費単価（byProductから導出）
 * @param marketVariableSellingUnitUsdPerKg 市場別の変動販売費単価（byMarketとbyProductの差から導出）
 */
export function buildMarketProductMarginModel(input: {
  readonly sales: readonly MarketProductSalesLike[];
  readonly byProduct: readonly MarginDimensionLike[];
  /**
   * 市場別集計（参考。市場別の変動販売費は CostRecord.market から直接読むため、
   * ここでは按分の根拠には使わない。呼び出し側が持つ情報を明示するために受け取る）。
   */
  readonly byMarket: readonly MarginDimensionLike[];
  readonly productCogsUnitUsdPerKg: Readonly<Partial<Record<Product, number>>>;
  readonly costRecords: readonly CostRecordLike[];
  readonly commonVariableCostUsd: number;
}): MarketProductMarginModel {
  const { sales, byProduct, productCogsUnitUsdPerKg, costRecords, commonVariableCostUsd } = input;

  // 商品別の製造変動費単価: byProduct の変動費 ÷ 商品別の納入数量。
  const quantityByProduct = new Map<string, number>();
  for (const s of sales) quantityByProduct.set(s.product, (quantityByProduct.get(s.product) ?? 0) + s.quantityTons);

  const productVariableUnit = new Map<string, number | undefined>();
  for (const p of byProduct) {
    productVariableUnit.set(p.key, usdPerKg(p.variableCost, quantityByProduct.get(p.key) ?? 0));
  }

  // 市場別の変動販売費単価: 市場別変動費のうち、商品別変動費で説明できない差分。
  // （物流費など市場に直課される変動費。CostRecord.market が設定された変動費から直接読む方が
  //  正確なので、まずそちらを試し、無ければ0とする＝推測で埋めない。）
  const marketVariableSellingByMarket = new Map<string, number>();
  for (const r of costRecords) {
    if (!r.market) continue;
    if (!Number.isFinite(r.variablePortion) || Math.abs(r.variablePortion) <= EPSILON) continue;
    marketVariableSellingByMarket.set(r.market, (marketVariableSellingByMarket.get(r.market) ?? 0) + r.variablePortion);
  }
  const quantityByMarket = new Map<string, number>();
  for (const s of sales) quantityByMarket.set(s.market, (quantityByMarket.get(s.market) ?? 0) + s.quantityTons);
  const marketSellingUnit = new Map<string, number | undefined>();
  for (const m of MARKETS) {
    marketSellingUnit.set(m, usdPerKg(marketVariableSellingByMarket.get(m) ?? 0, quantityByMarket.get(m) ?? 0));
  }

  const rows: MarketProductMarginRow[] = [];
  for (const market of MARKETS) {
    for (const product of PRODUCTS) {
      const entry = sales.find((s) => s.market === market && s.product === product);
      const quantityTons = entry?.quantityTons ?? 0;
      const netRevenueUsd = entry?.netRevenueUsd ?? 0;
      if (quantityTons <= EPSILON && Math.abs(netRevenueUsd) <= EPSILON) continue;

      const cogsUnit = productCogsUnitUsdPerKg[product];
      const manufacturingVariableUnit = productVariableUnit.get(product);
      const sellingVariableUnit = marketSellingUnit.get(market);
      const variableCostUnit =
        manufacturingVariableUnit === undefined && sellingVariableUnit === undefined
          ? undefined
          : (manufacturingVariableUnit ?? 0) + (sellingVariableUnit ?? 0);
      const variableCostAmountUsd = variableCostUnit === undefined ? 0 : variableCostUnit * quantityTons * 1000;
      const contributionMarginUsd = netRevenueUsd - variableCostAmountUsd;
      const cogsAmountUsd = cogsUnit === undefined ? undefined : cogsUnit * quantityTons * 1000;

      rows.push({
        market,
        product,
        quantityTons,
        netRevenueUsd,
        sellingPriceUsdPerKg: usdPerKg(netRevenueUsd, quantityTons),
        cogsUnitUsdPerKg: cogsUnit,
        cogsAmountUsd,
        variableCostUnitUsdPerKg: variableCostUnit,
        variableCostAmountUsd,
        contributionMarginUnitUsdPerKg: usdPerKg(contributionMarginUsd, quantityTons),
        contributionMarginUsd,
        contributionMarginRatio: safeDivide(contributionMarginUsd, netRevenueUsd),
        grossProfitUsd: cogsAmountUsd === undefined ? undefined : netRevenueUsd - cogsAmountUsd,
        grossProfitUnitUsdPerKg:
          cogsAmountUsd === undefined ? undefined : usdPerKg(netRevenueUsd - cogsAmountUsd, quantityTons),
      });
    }
  }

  const byProductAggregate: ProductMarginAggregate[] = PRODUCTS.map((product) => {
    const dim = byProduct.find((p) => p.key === product);
    return {
      product,
      netRevenueUsd: dim?.netRevenue ?? 0,
      variableCostUsd: dim?.variableCost ?? 0,
      contributionMarginUsd: dim?.contributionMargin ?? 0,
      contributionMarginRatio: dim?.contributionMarginRatio ?? undefined,
      directFixedCostUsd: dim?.directFixedCost ?? 0,
    };
  });

  const totalNetRevenue = byProductAggregate.reduce((s, p) => s + p.netRevenueUsd, 0);
  const totalVariable = byProductAggregate.reduce((s, p) => s + p.variableCostUsd, 0);
  const totalCm = byProductAggregate.reduce((s, p) => s + p.contributionMarginUsd, 0);

  return {
    rows,
    byProduct: byProductAggregate,
    companyTotal: {
      netRevenueUsd: totalNetRevenue,
      variableCostUsd: totalVariable,
      contributionMarginUsd: totalCm,
      contributionMarginRatio: safeDivide(totalCm, totalNetRevenue),
    },
    fixedCosts: summarizeFixedCosts(costRecords),
    commonVariableCostUsd,
  };
}

// ---------------------------------------------------------------------
// 5. 必要営業人数の逆算（ゲームの正式な営業能力ロジックを使う）
// ---------------------------------------------------------------------

/**
 * 指定した市場の商品ミックスを売り切るために必要な、最小の営業人員数を求める。
 *
 * 【固定換算を使わない】参考Excelにあった「HOSO 600t/人・PD 300t/人・VAP 200t/人」の
 * ような線形換算は使わない。ゲームエンジンの営業能力は
 *   sales/salesForce.ts processingCapacity(h) = baseline + M·h/(h+k)
 * という飽和（逓減）カーブであり、線形換算では必ずずれる。
 *
 * 【営業工数換算】商品ごとに営業工数の重みが違う（sales/parameters.ts
 * salesEffortCoefficients。HOSO 1.0 / PD 1.2 / VAP 3.0）。必要工数は
 *   Σ_p 数量_p × 係数_p
 * であり、これが processingCapacity(h) 以下になる最小の h を探索する。
 *
 * 【マジックナンバーを再定義しない】24000 / 70 / 1.0:1.2:3.0 等はここに一切書かず、
 * SALES_PARAMETERS_V1 と processingCapacity() をそのまま参照する。エンジン側の
 * パラメータが変われば、この関数の結果も自動的に追随する。
 *
 * 【この値の意味】前期実績と現在の営業能力パラメータに基づく参考値であり、
 * 市場競争・価格・CTS等により実際の成約は異なる。成約を保証する人数ではない。
 *
 * @returns 必要な最小人員数。上限（maxHeadcount）でも足りない場合はundefined。
 */
export function requiredSalesHeadcountForMix(
  quantityByProduct: Readonly<Partial<Record<Product, number>>>,
  params: SalesParameters = SALES_PARAMETERS_V1,
  maxHeadcount = 5000
): number | undefined {
  const requiredEffort = PRODUCTS.reduce(
    (sum, p) => sum + (quantityByProduct[p] ?? 0) * params.salesEffortCoefficients[p],
    0
  );
  if (!(requiredEffort > EPSILON)) return 0;

  const capacityAt = (h: number) => unwrapUnit(processingCapacity(h, params));
  if (capacityAt(maxHeadcount) < requiredEffort) return undefined;

  // 飽和カーブは headcount に対して単調増加なので二分探索できる。
  let low = 0;
  let high = maxHeadcount;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (capacityAt(mid) >= requiredEffort) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** 営業能力の参照値（シートに根拠として書き出すための読み取り専用スナップショット）。 */
export interface SalesCapacityReference {
  readonly baselineCapacityTons: number;
  readonly capacityMaxIncrementTons: number;
  readonly capacitySaturationHeadcount: number;
  readonly effortCoefficients: Readonly<Record<Product, number>>;
  readonly maximumSupplierShare: number;
}

export function salesCapacityReference(params: SalesParameters = SALES_PARAMETERS_V1): SalesCapacityReference {
  return {
    baselineCapacityTons: params.salesForce.baselineCapacityTons,
    capacityMaxIncrementTons: params.salesForce.capacityMaxIncrementTons,
    capacitySaturationHeadcount: params.salesForce.capacitySaturationHeadcount,
    effortCoefficients: params.salesEffortCoefficients,
    maximumSupplierShare: params.maximumSupplierShare,
  };
}

// ---------------------------------------------------------------------
// 6. 労働負荷（ゲームの正式な労働集約度を使う）
// ---------------------------------------------------------------------

/** 商品別の労働集約度係数（production/parameters.ts をそのまま読む）。 */
export function laborIntensityByProduct(
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): Readonly<Record<Product, number>> {
  return {
    hoso: laborIntensityCoefficientFor("hoso", params),
    pd: laborIntensityCoefficientFor("pd", params),
    vap: laborIntensityCoefficientFor("vap", params),
  };
}

/**
 * 商品別の「常用ワーカー1人あたり実効処理量（トン/四半期）」。
 * production/labor.ts effectiveEfficiencyPerHeadTons（＝基準効率 ÷ 労働集約度係数）を
 * そのまま呼ぶ。Excel側で別の生産性を定義しない。
 */
export function effectiveTonsPerRegularWorker(
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): Readonly<Record<Product, number>> {
  const base = params.labor.regularEfficiencyPerHeadTons;
  return {
    hoso: effectiveEfficiencyPerHeadTons(base, "hoso", params),
    pd: effectiveEfficiencyPerHeadTons(base, "pd", params),
    vap: effectiveEfficiencyPerHeadTons(base, "vap", params),
  };
}

/**
 * 生産予定数量から必要な常用ワーカー数を求める。
 *
 * 【正式ロジックをそのまま使う】companyLab/workforce.ts の
 * computeRequiredRegularHeadcount（Standard AIの労働判断・エンジンの人員検証が
 * 使うのと同じ関数）を呼ぶだけで、Excel側に独自の逆算式を持たない。
 */
export function requiredRegularWorkersForPlan(input: {
  readonly quantityByProduct: Readonly<Partial<Record<Product, number>>>;
  readonly skillByProduct: Readonly<Partial<Record<Product, number>>>;
  readonly attendanceRate: number;
  readonly appliedOvertimeRate: number;
  readonly temporaryHeadcount: number;
  readonly params?: ProductionParameters;
}): number {
  return computeRequiredRegularHeadcount({
    quantityByProduct: input.quantityByProduct,
    skillByProduct: input.skillByProduct,
    attendanceRate: input.attendanceRate,
    appliedOvertimeRate: input.appliedOvertimeRate,
    temporaryHeadcount: input.temporaryHeadcount,
    params: input.params,
  }).requiredRegularHeadcount;
}
