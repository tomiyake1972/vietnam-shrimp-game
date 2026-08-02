// ShrimpX V2 — SAI-2追加作業: 市場別営業配置・商品別営業工数（実装指示対応）
//
// 【背景】従来、営業人員(salesForceHeadcount)は CompanySalesPlanEntry（市場×商品の
// 1行）ごとに独立した値として扱われ、processingCapacity(headcount)による処理能力
// 上限もその行単独で評価されていた（sales/allocation.ts）。このため同じ市場の
// HOSO/PD/VAPが同じ営業チームを奪い合う関係にならず、「PDはHOSOに近く、VAPだけ
// 大幅に営業負荷が高い」という設計が反映できなかった（SAI-2標準初期条件レポート
// で三宅さんから指摘された既知の課題）。
//
// 【この実装の要点】
//   1. 営業人員は「会社×市場」単位で共有される（同じ市場のHOSO/PD/VAP行は
//      同一のsalesForceHeadcountを持つ、という前提を検証する）。
//   2. 営業工数換算数量 = HOSO数量 + 1.2×PD数量 + 3.0×VAP数量
//      （salesEffortCoefficients、parameters.ts）が、その市場の処理能力
//      C(h) = processingCapacity(h)（既存のsalesForce.tsの式をそのまま流用、
//      headcount=0でも200tの基礎能力が残る現行仕様は維持）を超えないよう、
//      超過時は市場内の全商品のdesiredQuantityを同一のscaleFactorで比例縮小する。
//   3. 【二重適用の防止】sales/allocation.tsのallocateMarketProduct内には既存の
//      商品行ごとのprocessingCapacity上限（capacity = processingCapacity(headcount)）
//      がそのまま残っている。本モジュールのapplyMarketSalesEffortCapacityを
//      適用した後は、係数が全商品で1.0以上（hoso=1.0が最小）であるため、
//      縮小後のdesiredQuantity_p は必ず C(h)/coef_p <= C(h) を満たす
//      （証明: Σcoef_i*q_i <= C(h) かつ coef_p*q_p <= Σcoef_i*q_i なので
//      q_p <= C(h)/coef_p <= C(h)）。したがって allocation.ts 側の
//      既存の行単位capacity上限は、本関数適用後の入力に対しては数学的に
//      非拘束（cap=min(...)の最小値には決してならない）であり、同じ制約を
//      二重に掛けることにはならない。allocateMarketProductを直接呼ぶ既存の
//      単体テスト・呼び出し元（本モジュールの前処理を経由しない）に対しては、
//      引き続き唯一の安全網として機能するため、あえて削除していない。

import { DemandMarketId, Product } from "../market/types";
import { HosoEqTons, hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { SalesParameters } from "./parameters";
import { processingCapacity } from "./salesForce";
import {
  allocateThroughputByPriority,
  computeSalesThroughput,
  CustomerDevelopmentInputs,
  SALES_CAPABILITY_PARAMETERS_V1,
  SalesCapabilityParameters,
  SalesThroughputResult,
} from "./salesCapability";
import { CompanyId, CompanySalesPlanEntry, SalesValidationError } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const EPSILON = 1e-6;

/** 商品別数量から、営業工数換算数量（HOSO数量 + 1.2×PD数量 + 3.0×VAP数量）を計算する。 */
export function salesEffortWeightedQuantity(quantityByProduct: Readonly<Record<Product, number>>, params: SalesParameters): number {
  return PRODUCTS.reduce((sum, p) => sum + params.salesEffortCoefficients[p] * Math.max(0, quantityByProduct[p]), 0);
}

/**
 * 【加工品市場進化 §e】営業能力再設計を有効にするための追加文脈。
 * 省略時は従来の「200 + 4800×h/(h+10)」による一律縮小（既存挙動とビット単位一致）。
 *
 * この文脈オブジェクトは**エンジン（本モジュール）と標準AIのミラー実装
 * （companyLab/standardAi/decision/sales.ts）の双方が同じものを渡す**ことで、
 * 「AIが提出する計画」と「エンジン適用後の結果」が食い違わないようにする。
 */
export interface MarketSalesCapabilityContext {
  /** 当該市場の対象需要（HOSO換算トン）。市場規模係数の算出に使う。 */
  readonly marketTargetDemandTons?: number;
  /** 顧客開発スコアの入力（VAP能力・品質・顧客関係。未接続は中立50）。 */
  readonly customerDevelopment?: Omit<CustomerDevelopmentInputs, "salesForceHeadcount">;
  /** 商品別の販売優先度（既定すべて1.0＝従来の一律縮小と一致）。 */
  readonly priorityByProduct?: Readonly<Partial<Record<Product, number>>>;
  readonly parameters?: SalesCapabilityParameters;
}

export interface MarketSalesEffortResult {
  /** その市場の営業人員から導かれる処理能力（HOSO換算トン、= processingCapacity(headcount)）。 */
  readonly capacityHosoEqTons: number;
  /** 縮小前（希望どおり）の営業工数換算数量。 */
  readonly desiredEffortWeightedQuantity: number;
  /**
   * 縮小係数（1なら無制約、1未満なら能力超過による縮小が発生）。
   * 【§e有効時】商品別に異なる縮小率になり得るため、この値は
   * 「工数換算での全体縮小率（= 能力 ÷ 必要工数、上限1）」を表す代表値になる。
   * 商品別の実際の縮小率は adjustedQuantityByProduct を参照すること。
   */
  readonly scaleFactor: number;
  /** 縮小後の商品別希望数量。 */
  readonly adjustedQuantityByProduct: Readonly<Record<Product, number>>;
  /** 能力制約が実際に発動したか。 */
  readonly isConstrained: boolean;
  /** 【§e有効時のみ】販売処理能力の内訳（人数由来／市場規模／顧客開発の分解）。 */
  readonly throughput?: SalesThroughputResult;
  /** 【§e有効時のみ】商品別の縮小率（優先度を反映した結果）。 */
  readonly scaleByProduct?: Readonly<Record<Product, number>>;
}

/**
 * 1つの「会社×市場」について、共有された営業人員(headcount)と商品別希望数量から、
 * 営業工数換算数量が処理能力C(h)を超えないよう、超過時は全商品を同一のscaleFactorで
 * 比例縮小した結果を返す。headcount=0人でも200tの基礎能力（既存仕様）はそのまま
 * 適用される（今回のご指示により維持）。
 */
export function computeMarketSalesEffort(
  headcount: number,
  desiredQuantityByProduct: Readonly<Record<Product, number>>,
  params: SalesParameters,
  capability?: MarketSalesCapabilityContext
): MarketSalesEffortResult {
  // 【§e】必要工数の式は変えない（HOSO 1.0 / PD 1.2 / VAP 3.0）。
  // 変わるのは「その工数を賄える能力がどう決まるか」だけである。
  const desiredEffortWeightedQuantity = salesEffortWeightedQuantity(desiredQuantityByProduct, params);

  const throughput = capability
    ? computeSalesThroughput(
        { salesForceHeadcount: headcount, ...capability.customerDevelopment },
        capability.marketTargetDemandTons,
        params,
        capability.parameters ?? SALES_CAPABILITY_PARAMETERS_V1
      )
    : undefined;
  const capacityHosoEqTons = throughput ? throughput.throughputCapacityTons : unwrapUnit(processingCapacity(headcount, params));

  if (desiredEffortWeightedQuantity <= capacityHosoEqTons + EPSILON || desiredEffortWeightedQuantity <= EPSILON) {
    return {
      capacityHosoEqTons,
      desiredEffortWeightedQuantity,
      scaleFactor: 1,
      adjustedQuantityByProduct: { ...desiredQuantityByProduct },
      isConstrained: false,
      ...(throughput ? { throughput, scaleByProduct: { hoso: 1, pd: 1, vap: 1 } } : {}),
    };
  }

  const scaleFactor = capacityHosoEqTons / desiredEffortWeightedQuantity;
  const adjustedQuantityByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };

  if (!throughput) {
    for (const p of PRODUCTS) {
      adjustedQuantityByProduct[p] = Math.max(0, desiredQuantityByProduct[p]) * scaleFactor;
    }
    return { capacityHosoEqTons, desiredEffortWeightedQuantity, scaleFactor, adjustedQuantityByProduct, isConstrained: true };
  }

  // 【§e】商品別優先度を考慮した水位法配分。優先度がすべて等しければ一律縮小と一致する。
  const requiredEffortByProduct = { hoso: 0, pd: 0, vap: 0 } as Record<Product, number>;
  for (const p of PRODUCTS) {
    requiredEffortByProduct[p] = params.salesEffortCoefficients[p] * Math.max(0, desiredQuantityByProduct[p]);
  }
  const priorityByProduct = {
    hoso: capability?.priorityByProduct?.hoso ?? 1,
    pd: capability?.priorityByProduct?.pd ?? 1,
    vap: capability?.priorityByProduct?.vap ?? 1,
  } as Record<Product, number>;
  const scaleByProduct = allocateThroughputByPriority(requiredEffortByProduct, priorityByProduct, capacityHosoEqTons);
  for (const p of PRODUCTS) {
    adjustedQuantityByProduct[p] = Math.max(0, desiredQuantityByProduct[p]) * scaleByProduct[p];
  }
  return {
    capacityHosoEqTons,
    desiredEffortWeightedQuantity,
    scaleFactor,
    adjustedQuantityByProduct,
    isConstrained: true,
    throughput,
    scaleByProduct,
  };
}

/**
 * 実在する営業人員(totalHeadcount)を、市場ごとの重み（通常は営業工数換算需要）に
 * 比例して配分する（最大剰余法、合計は必ずtotalHeadcountと一致する）。
 * 重みが全市場0（需要が無い）場合は市場数で均等割りする。
 * 入力Mapの反復順には依存しない（内部でmarket名によりソートしてから処理する）。
 */
export function allocateHeadcountAcrossMarkets(
  totalHeadcount: number,
  weightByMarket: ReadonlyMap<DemandMarketId, number>
): Map<DemandMarketId, number> {
  const markets = Array.from(weightByMarket.keys()).sort();
  const result = new Map<DemandMarketId, number>(markets.map((m) => [m, 0]));
  if (markets.length === 0 || totalHeadcount <= 0) return result;

  const totalWeight = markets.reduce((sum, m) => sum + Math.max(0, weightByMarket.get(m) ?? 0), 0);

  if (totalWeight <= EPSILON) {
    const base = Math.floor(totalHeadcount / markets.length);
    let remainder = totalHeadcount - base * markets.length;
    for (const m of markets) {
      result.set(m, base + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder -= 1;
    }
    return result;
  }

  const raw = markets.map((m) => ({ m, exact: totalHeadcount * (Math.max(0, weightByMarket.get(m) ?? 0) / totalWeight) }));
  let assigned = 0;
  for (const r of raw) {
    const floor = Math.floor(r.exact);
    result.set(r.m, floor);
    assigned += floor;
  }
  let remainder = totalHeadcount - assigned;
  const byFractionDesc = [...raw].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.m.localeCompare(b.m));
  for (const r of byFractionDesc) {
    if (remainder <= 0) break;
    result.set(r.m, (result.get(r.m) ?? 0) + 1);
    remainder -= 1;
  }
  return result;
}

export interface MarketSalesEffortAdjustment {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly headcount: number;
  readonly capacityHosoEqTons: number;
  readonly desiredEffortWeightedQuantity: number;
  readonly scaleFactor: number;
}

/**
 * 販売計画(plans)全体（複数会社・複数市場・複数商品を含む）に対し、会社×市場ごとに
 * 共有される営業人員から導かれる営業工数換算能力の制約を適用する。
 *   1. 会社×市場でグループ化し、同一グループ内のsalesForceHeadcountが全行で
 *      一致していることを検証する（不一致はSalesValidationError）。
 *   2. computeMarketSalesEffortで、超過時は当該グループの全商品のdesiredQuantityを
 *      比例縮小する。
 * 戻り値のadjustedPlansは入力plansと同じ順序・同じ行数を保つ（グループ化・
 * 縮小はいずれも順序非依存の演算のみで構成）。
 */
export function applyMarketSalesEffortCapacity(
  plans: readonly CompanySalesPlanEntry[],
  params: SalesParameters,
  /**
   * 【加工品市場進化 §e】営業能力再設計を有効にする場合の追加情報。
   * 省略時は完全に従来経路（既存挙動とビット単位一致）。
   */
  capabilityOptions?: {
    /** 市場ごとの対象需要（HOSO換算トン、全商品合計）。市場規模係数に使う。 */
    readonly targetDemandByMarket?: Readonly<Partial<Record<DemandMarketId, number>>>;
    readonly parameters?: SalesCapabilityParameters;
  }
): { readonly adjustedPlans: readonly CompanySalesPlanEntry[]; readonly adjustments: readonly MarketSalesEffortAdjustment[] } {
  const groupKey = (p: CompanySalesPlanEntry) => `${p.companyId}::${p.market}`;
  const groups = new Map<string, CompanySalesPlanEntry[]>();
  for (const p of plans) {
    const key = groupKey(p);
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  const adjustments: MarketSalesEffortAdjustment[] = [];
  const adjustedGroups = new Map<string, CompanySalesPlanEntry[]>();

  for (const [key, entries] of groups) {
    const headcounts = new Set(entries.map((e) => e.salesForceHeadcount));
    if (headcounts.size > 1) {
      throw new SalesValidationError(
        `会社 "${entries[0].companyId}" の市場 "${entries[0].market}" 内で、商品ごとに異なる営業人員(salesForceHeadcount)が` +
          `指定されています（同一市場内の全商品は同一の営業人員数を共有する必要があります）。値: ${Array.from(headcounts).join(", ")}`
      );
    }
    const headcount = entries[0].salesForceHeadcount;
    const desiredByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
    for (const e of entries) desiredByProduct[e.product] = unwrapUnit(e.desiredQuantity);

    const result = computeMarketSalesEffort(
      headcount,
      desiredByProduct,
      params,
      capabilityOptions ? buildCapabilityContext(entries, capabilityOptions) : undefined
    );
    if (result.isConstrained) {
      adjustments.push({
        companyId: entries[0].companyId,
        market: entries[0].market,
        headcount,
        capacityHosoEqTons: result.capacityHosoEqTons,
        desiredEffortWeightedQuantity: result.desiredEffortWeightedQuantity,
        scaleFactor: result.scaleFactor,
      });
    }

    adjustedGroups.set(
      key,
      entries.map((e) => ({
        ...e,
        desiredQuantity: hosoEqTons(roundHosoEqTons(result.adjustedQuantityByProduct[e.product])) as HosoEqTons,
      }))
    );
  }

  // 元のplans配列と同じ順序を保つため、グループ内の出現順インデックスを使って復元する。
  const consumedIndexByKey = new Map<string, number>();
  const adjustedPlans = plans.map((p) => {
    const key = groupKey(p);
    const idx = consumedIndexByKey.get(key) ?? 0;
    consumedIndexByKey.set(key, idx + 1);
    return adjustedGroups.get(key)![idx];
  });

  // adjustmentsは会社ID→市場IDの順で決定論的に並べ替える（Mapの反復順に依存しない）。
  const sortedAdjustments = [...adjustments].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.market.localeCompare(b.market));

  return { adjustedPlans, adjustments: sortedAdjustments };
}


/**
 * 【加工品市場進化 §e】1つの会社×市場の販売計画行から、営業能力再設計の文脈を組み立てる。
 *
 * 顧客開発スコアの入力は次のように取る（未接続はすべて中立50）。
 *  - vapCapabilityScore: VAP行に注入されている会社レベルのVAP能力合成係数
 *    （companyLab/runner.ts applyAuthoritativeVapCapabilityScores）。VAP行が無ければ未接続。
 *  - qualityReputation / customerRelationship: 同一市場の行の最大値
 *    （商品ごとに異なり得るが、顧客開発は市場単位の概念のため代表値を取る）。
 *  - salesPriority: 各行の販売優先度（未指定は1.0）。
 */
function buildCapabilityContext(
  entries: readonly CompanySalesPlanEntry[],
  options: {
    readonly targetDemandByMarket?: Readonly<Partial<Record<DemandMarketId, number>>>;
    readonly parameters?: SalesCapabilityParameters;
  }
): MarketSalesCapabilityContext {
  const market = entries[0].market;
  const vapEntry = entries.find((e) => e.product === "vap");
  const maxOf = (pick: (e: CompanySalesPlanEntry) => number | undefined): number | undefined => {
    const values = entries.map(pick).filter((v): v is number => v !== undefined);
    return values.length > 0 ? Math.max(...values) : undefined;
  };
  const priorityByProduct: Partial<Record<Product, number>> = {};
  for (const e of entries) {
    if (e.salesPriority !== undefined) priorityByProduct[e.product] = e.salesPriority;
  }
  return {
    marketTargetDemandTons: options.targetDemandByMarket?.[market],
    customerDevelopment: {
      vapCapabilityScore: vapEntry?.vapCapabilityScore !== undefined ? unwrapUnit(vapEntry.vapCapabilityScore) : undefined,
      qualityReputation: maxOf((e) => (e.qualityReputation !== undefined ? unwrapUnit(e.qualityReputation) : undefined)),
      customerRelationship: maxOf((e) => (e.customerRelationship !== undefined ? unwrapUnit(e.customerRelationship) : undefined)),
    },
    priorityByProduct,
    ...(options.parameters ? { parameters: options.parameters } : {}),
  };
}
