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
import { computeMarketSalesCapacities } from "./salesCapacityModel";
import { CompanyId, CompanySalesPlanEntry, SalesValidationError } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const EPSILON = 1e-6;

/** 商品別数量から、営業工数換算数量（HOSO数量 + 1.2×PD数量 + 3.0×VAP数量）を計算する。 */
export function salesEffortWeightedQuantity(quantityByProduct: Readonly<Record<Product, number>>, params: SalesParameters): number {
  return PRODUCTS.reduce((sum, p) => sum + params.salesEffortCoefficients[p] * Math.max(0, quantityByProduct[p]), 0);
}

export interface MarketSalesEffortResult {
  /** その市場の営業人員から導かれる処理能力（HOSO換算トン、= processingCapacity(headcount)）。 */
  readonly capacityHosoEqTons: number;
  /** 縮小前（希望どおり）の営業工数換算数量。 */
  readonly desiredEffortWeightedQuantity: number;
  /** 縮小係数（1なら無制約、1未満なら能力超過による比例縮小が発生）。 */
  readonly scaleFactor: number;
  /** 縮小後の商品別希望数量。 */
  readonly adjustedQuantityByProduct: Readonly<Record<Product, number>>;
  /** 能力制約が実際に発動したか。 */
  readonly isConstrained: boolean;
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
  /**
   * 【Phase 6B】この市場が使える営業工数能力を外から与える。
   * 会社全体モデル（sales/salesCapacityModel.ts）では、能力は市場単位ではなく
   * 会社単位で決まるため、呼び出し側が配分済みの値を渡す。
   * 未指定なら従来どおり processingCapacity(headcount) を使う（挙動不変）。
   */
  capacityOverrideHosoEqTons?: number
): MarketSalesEffortResult {
  const capacityHosoEqTons = capacityOverrideHosoEqTons ?? unwrapUnit(processingCapacity(headcount, params));
  const desiredEffortWeightedQuantity = salesEffortWeightedQuantity(desiredQuantityByProduct, params);

  if (desiredEffortWeightedQuantity <= capacityHosoEqTons + EPSILON || desiredEffortWeightedQuantity <= EPSILON) {
    return {
      capacityHosoEqTons,
      desiredEffortWeightedQuantity,
      scaleFactor: 1,
      adjustedQuantityByProduct: { ...desiredQuantityByProduct },
      isConstrained: false,
    };
  }

  const scaleFactor = capacityHosoEqTons / desiredEffortWeightedQuantity;
  const adjustedQuantityByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const p of PRODUCTS) {
    adjustedQuantityByProduct[p] = Math.max(0, desiredQuantityByProduct[p]) * scaleFactor;
  }
  return { capacityHosoEqTons, desiredEffortWeightedQuantity, scaleFactor, adjustedQuantityByProduct, isConstrained: true };
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
  params: SalesParameters
): {
  readonly adjustedPlans: readonly CompanySalesPlanEntry[];
  readonly adjustments: readonly MarketSalesEffortAdjustment[];
  /**
   * 【Phase 6C・営業能力 SSoT】会社×市場ごとに実際に適用された営業工数能力
   * （キーは `${companyId}::${market}`、値は工数トン）。
   * sales/allocation.ts の個社成約上限が、ここと**同じ能力**を使えるようにするための公開値。
   * 従来 allocation.ts は processingCapacity(headcount) を自分で呼び直しており、
   * 会社全体営業能力モデルを通らない二重制約になっていた（Phase 6B の監査で発見）。
   */
  readonly capacityByCompanyMarket: ReadonlyMap<string, number>;
} {
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
  const appliedCapacityByGroup = new Map<string, number>();

  // 【Phase 6B】会社全体モデルでは、市場ごとの能力を会社単位で1回だけ求めて配分する。
  // perMarket（既定）では undefined のままとなり、従来の経路をそのまま通る。
  const capacityByGroup = new Map<string, number>();
  const model = params.salesCapacityModel;
  if (model && model.kind !== "perMarket") {
    const byCompany = new Map<CompanyId, CompanySalesPlanEntry[]>();
    for (const p of plans) {
      const arr = byCompany.get(p.companyId);
      if (arr) arr.push(p);
      else byCompany.set(p.companyId, [p]);
    }
    for (const [companyId, entries] of byCompany) {
      const effortDemandByMarket = new Map<DemandMarketId, number>();
      const headcountByMarket = new Map<DemandMarketId, number>();
      for (const e of entries) {
        const byProduct = effortDemandByMarket.get(e.market) ?? 0;
        effortDemandByMarket.set(e.market, byProduct + params.salesEffortCoefficients[e.product] * Math.max(0, unwrapUnit(e.desiredQuantity)));
        headcountByMarket.set(e.market, e.salesForceHeadcount);
      }
      const totalHeadcount = [...headcountByMarket.values()].reduce((s2, v) => s2 + v, 0);
      // 【Dynamic Scenario 3】会社別の営業能力モデルが宣言されていればそれを使う。
      // 未宣言なら共通モデル（model）のままで、従来挙動とビット単位で同一。
      const companyModel = params.salesCapacityModelByCompany?.[companyId] ?? model;
      const capacities = computeMarketSalesCapacities(totalHeadcount, effortDemandByMarket, headcountByMarket, params, companyModel);
      for (const [market, capacity] of capacities) capacityByGroup.set(`${companyId}::${market}`, capacity);
    }
  }

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

    const result = computeMarketSalesEffort(headcount, desiredByProduct, params, capacityByGroup.get(key));
    appliedCapacityByGroup.set(key, result.capacityHosoEqTons);
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

  return { adjustedPlans, adjustments: sortedAdjustments, capacityByCompanyMarket: appliedCapacityByGroup };
}
