// ShrimpX V2 — Crowding 共通 market-clearing 層（ENG-CROWDING-MARKDOWN-1 Phase 1）
//
// 【位置づけ】
// この層は legacy allocation / tiered allocation の **前段の共通層**である
// （tiered 専用にしない。§12）。どちらの allocation mode でも
//
//   preCrowdingStructuralPrice
//     → crowdingMultiplier
//     → postCrowdingClearingPrice
//     → 既存 allocation（legacy / tiered）
//     → company ask（= clearing price + priceAdjustment）
//     → 新規 SalesContract.unitPrice
//
// の順序を維持する。
//
// 【既存契約を再価格設定しない】この層が触るのは「これから作る新規契約」の
// 基準価格だけである。既存 SalesContract の unitPrice / originalQuantity /
// dueDate は一切変更しない。

import { PeriodV2 } from "../core/period";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import {
  CompanyProductPhysicalSupply,
  DesiredOfferEntry,
  ResolvedCredibleOffer,
  buildPhysicalSupplyPool,
  physicalSupplyPoolKey,
  resolveCredibleOffersForPool,
  CredibleOfferResolutionError,
} from "./credibleOffer";
import {
  CrowdingBucketDiagnostics,
  CrowdingCompanyOfferDiagnostics,
  CrowdingPolicy,
  blendBucketMultipliers,
  computeCrowdingBucket,
  crowdingBucketKey,
} from "./crowding";
import { CompanySalesPlanEntry, SalesContract } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** Crowding 層への入力（すべて呼び出し側が確定させた値のみ）。 */
export interface CrowdingLayerInput {
  readonly period: PeriodV2;
  readonly policy: CrowdingPolicy;
  /** 営業工数適用後の販売計画（sales/marketEffort.ts の adjustedPlans）。 */
  readonly adjustedPlans: readonly CompanySalesPlanEntry[];
  /** 既存契約（未完了分の集計に使う。**変更しない**）。 */
  readonly existingContracts: readonly SalesContract[];
  /** 会社 × 商品 の物理供給スナップショット（companyLab 側が構築する）。 */
  readonly physicalSupplies: readonly CompanyProductPhysicalSupply[];
  /** 構造価格（Crowding 前）。market × product。 */
  readonly preCrowdingStructuralPrices: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  /** 構造需要 proxy。market × product（当期の targetDemand をそのまま使う想定）。 */
  readonly forwardDemandProxyByMarketProduct: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  /** 各 plan entry の納期を解決する関数（sales/contracts.ts の正本を渡す）。 */
  readonly resolveDueDateForPlan: (entry: CompanySalesPlanEntry, period: PeriodV2) => PeriodV2;
}

/** Crowding 層の出力。 */
export interface CrowdingLayerResult {
  /** 既存 allocation へ渡す basePrice（market × product）。 */
  readonly clearingPrices: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  /** bucket（市場 × 商品 × 納期）ごとの診断。 */
  readonly buckets: readonly CrowdingBucketDiagnostics[];
  /** 会社 × 市場 × 商品 × 納期 の信頼可能提示量。 */
  readonly credibleOffers: readonly ResolvedCredibleOffer[];
  readonly policyVersion: string;
  readonly enabled: boolean;
}

/**
 * forward demand proxy の限界（§5 で診断へ記録することが要求されている）。
 * V2.00 Phase 1 は「現在 Turn 時点で利用可能な構造需要情報」だけを使い、
 * 将来の未公開 Scenario event（疾病 shock・需要 shock 等）の真値を先読みしない。
 */
export const FORWARD_DEMAND_PROXY_LIMITATIONS: readonly string[] = [
  "当期の構造需要（targetDemand）を将来納期へそのまま据え置くだけであり、納期までの需要成長・減衰を織り込まない。",
  "未公開 Scenario event（疾病 shock・需要 shock 等）の将来真値を一切参照しない（情報境界の遵守）。",
  "市場別・商品別の将来構成比変化（productLifecycle / consumerInventory の将来推移）を織り込まない。",
];

/** 既存契約のうち「その納期ちょうど」の未履行量（bucket の分子・分母に使う）。 */
function sumExistingCommittedOutstandingAtDueDate(
  contracts: readonly SalesContract[],
  market: DemandMarketId,
  product: Product,
  dueDate: PeriodV2
): number {
  let total = 0;
  for (const c of contracts) {
    if (c.market !== market || c.product !== product) continue;
    if (c.dueDate !== dueDate) continue;
    total += c.outstandingQuantity as unknown as number;
  }
  return total;
}

/** 会社 × 商品 で「その納期までに」納めるべき既存未履行量（ATP から差し引く）。 */
function sumBacklogDueByDueDate(
  contracts: readonly SalesContract[],
  companyId: string,
  product: Product,
  dueDate: PeriodV2
): number {
  let total = 0;
  for (const c of contracts) {
    if (c.companyId !== companyId || c.product !== product) continue;
    // PeriodV2 は "YYYY-Qn" 形式の昇順比較可能な文字列。
    if (c.dueDate > dueDate) continue;
    total += c.outstandingQuantity as unknown as number;
  }
  return total;
}

/**
 * Crowding 共通層の本体。
 *
 * policy.enabled === false の場合でも診断は作るが、multiplier は恒等的に 1 であり
 * clearingPrices は preCrowdingStructuralPrices と厳密に同一の数値になる。
 * （呼び出し側は enabled=false のとき、この層自体を呼ばずに素通りさせてもよい。
 *   sales/runner.ts は入力が未指定なら呼ばない＝既存挙動ビット単位不変。）
 */
export function applyCrowdingLayer(input: CrowdingLayerInput): CrowdingLayerResult {
  const {
    period,
    policy,
    adjustedPlans,
    existingContracts,
    physicalSupplies,
    preCrowdingStructuralPrices,
    forwardDemandProxyByMarketProduct,
    resolveDueDateForPlan,
  } = input;

  const supplyByKey = new Map<string, CompanyProductPhysicalSupply>();
  for (const s of physicalSupplies) {
    supplyByKey.set(`${s.companyId}::${s.product}`, s);
  }

  // --- 1. 希望提示を 会社 × 商品 × 納期 の pool へまとめる ---
  const desiredByPool = new Map<string, DesiredOfferEntry[]>();
  for (const entry of adjustedPlans) {
    const dueDate = resolveDueDateForPlan(entry, period);
    const key = physicalSupplyPoolKey(entry.companyId, entry.product, dueDate);
    const desiredOffer: DesiredOfferEntry = {
      companyId: entry.companyId,
      market: entry.market,
      product: entry.product,
      dueDate,
      desiredAfterSalesEffort: entry.desiredQuantity as unknown as number,
      commercialApprovedCap:
        entry.approvedAllocationCap !== undefined
          ? (entry.approvedAllocationCap as unknown as number)
          : Number.POSITIVE_INFINITY,
    };
    const list = desiredByPool.get(key);
    if (list) list.push(desiredOffer);
    else desiredByPool.set(key, [desiredOffer]);
  }

  // --- 2. pool ごとに physical ATP を解決し、市場へ決定論的に按分する ---
  const credibleOffers: ResolvedCredibleOffer[] = [];
  // 決定論のため pool キーでソートして処理する。
  for (const key of [...desiredByPool.keys()].sort()) {
    const entries = desiredByPool.get(key)!;
    const first = entries[0];
    const supply = supplyByKey.get(`${first.companyId}::${first.product}`);
    if (!supply) {
      // Crowding ON で信頼できる physical cap が無い場合、desiredQuantity への
      // silent fallback はしない（§7）。明示的な error とする。
      throw new CredibleOfferResolutionError(
        `physical supply スナップショットがありません（desiredQuantity へ fallback しない）: ` +
          `${first.companyId}/${first.product}`
      );
    }
    const pool = buildPhysicalSupplyPool({
      supply,
      dueDate: first.dueDate,
      existingBacklogDueByDueDate: sumBacklogDueByDueDate(
        existingContracts,
        first.companyId,
        first.product,
        first.dueDate
      ),
    });
    credibleOffers.push(...resolveCredibleOffersForPool(pool, entries));
  }

  // --- 3. bucket（市場 × 商品 × 納期）ごとに Crowding を計算する ---
  const offersByBucket = new Map<string, CrowdingCompanyOfferDiagnostics[]>();
  const bucketMeta = new Map<string, { market: DemandMarketId; product: Product; dueDate: PeriodV2 }>();
  for (const o of credibleOffers) {
    const key = crowdingBucketKey(o.market, o.product, o.dueDate);
    bucketMeta.set(key, { market: o.market, product: o.product, dueDate: o.dueDate });
    const diag: CrowdingCompanyOfferDiagnostics = {
      companyId: o.companyId,
      desiredOffer: o.desiredAfterSalesEffort,
      credibleOffer: o.credibleOffer,
      bindingReason: o.bindingReason,
    };
    const list = offersByBucket.get(key);
    if (list) list.push(diag);
    else offersByBucket.set(key, [diag]);
  }

  const buckets: CrowdingBucketDiagnostics[] = [];
  for (const key of [...bucketMeta.keys()].sort()) {
    const meta = bucketMeta.get(key)!;
    const offers = (offersByBucket.get(key) ?? []).slice().sort((a, b) => a.companyId.localeCompare(b.companyId));
    buckets.push(
      computeCrowdingBucket({
        market: meta.market,
        product: meta.product,
        dueDate: meta.dueDate,
        preCrowdingStructuralPrice: preCrowdingStructuralPrices[meta.market][meta.product],
        forwardDemandProxy: forwardDemandProxyByMarketProduct[meta.market][meta.product],
        existingCommittedOutstanding: sumExistingCommittedOutstandingAtDueDate(
          existingContracts,
          meta.market,
          meta.product,
          meta.dueDate
        ),
        offers,
        policy,
        forwardDemandProxyLimitations: FORWARD_DEMAND_PROXY_LIMITATIONS,
      })
    );
  }

  // --- 4. 市場 × 商品 ごとに 1 本の clearing price へ縮約する ---
  const bucketsByMarketProduct = new Map<string, CrowdingBucketDiagnostics[]>();
  for (const b of buckets) {
    const k = `${b.market}::${b.product}`;
    const list = bucketsByMarketProduct.get(k);
    if (list) list.push(b);
    else bucketsByMarketProduct.set(k, [b]);
  }

  const clearingPrices = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of DEMAND_MARKET_IDS) {
    clearingPrices[market] = {} as Record<Product, number>;
    for (const product of PRODUCTS) {
      const pre = preCrowdingStructuralPrices[market][product];
      const bs = bucketsByMarketProduct.get(`${market}::${product}`);
      const multiplier = bs && bs.length > 0 ? blendBucketMultipliers(bs) : 1;
      clearingPrices[market][product] = pre * multiplier;
    }
  }

  return {
    clearingPrices,
    buckets,
    credibleOffers,
    policyVersion: policy.policyVersion,
    enabled: policy.enabled,
  };
}
