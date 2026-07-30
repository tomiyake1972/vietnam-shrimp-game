// ShrimpX V2 — Phase SAI-5D: 会社×市場×商品の営業基盤（sales base）ストック
//
// 【目的】過去の営業努力と販売実績が「顧客との接点・商品知識・販路・商談
// パイプライン・顧客承認実績・市場仕様への習熟」として会社×市場×商品の粒度で
// 蓄積される状態を導入する（例: JPQ×日本×VAP、MASS×中国×HOSO）。
//
// 【既存スコアとの役割分担（二重加算の防止、設計メモ§2.6）】
//  - 顧客信頼(customerTrust)・納期信頼(deliveryReliability)は「履行の品質・納期」
//    という観測系列から更新される（quality/scoreUpdates.ts）。
//  - 営業基盤は「その市場×商品への計画提示・人員配置・成約」という**別の観測
//    系列**から更新する。同じシグナルを両方の状態に入れない。
//  - 当期営業処理能力(coverage)は当期の人員配置そのもの（フロー）であり、
//    営業基盤は過去の配置・成約の蓄積（ストック）。
//
// 【時間順序（quality状態と同じ規約）】更新は四半期処理の最後（成約・履行が
// 確定した後）に行い、当期の成約競争力に使われるのは**前四半期末までの値のみ**
// （今期の納品成功を今期開始時点の競争力へ遡及させない）。
//
// 【決定論】乱数不使用。エントリはcompanyId→market→productの固定順でソート
// して保持する（反復順・保存順の非決定性を持ち込まない）。

import { Score0to100, score0to100, unwrapUnit } from "../core/units";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import { CompanyId, CompanySalesPlanEntry, MarketProductAllocationResult } from "../sales/types";
import { BatchQualityAdjustment } from "../quality/types";
import { MarketProductMix, PRODUCT_LIFECYCLE_PARAMETERS_V1 } from "../market/productLifecycle";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 1件の営業基盤エントリ（会社×市場×商品）。 */
export interface SalesBaseEntry {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly score: Score0to100;
}

/** 営業基盤の全体状態（スパース表現。存在しないキーは中立値=50とみなす）。 */
export interface SalesBaseState {
  readonly entries: readonly SalesBaseEntry[];
}

/** 営業基盤の更新パラメータ（一箇所集約。すべて校正対象の暫定値）。 */
export interface SalesBaseParameters {
  /** 中立値（新規参入・未活動の基準点。既存スコア体系の中立値50に合わせる）。 */
  readonly neutralScore: number;
  /** 活動時の獲得速度（点/四半期。ヘッドルーム(1-score/100)を乗じるため上限に漸近）。
   *  4.0 → 中立50から上限付近まで約3〜4年（12〜16四半期）。「営業基盤の形成には
   *  年単位の継続が必要」という意図の初期値。 */
  readonly activeAcquisitionPerQuarter: number;
  /** 成約成功による強化（点/四半期 × min(1, 成約量/希望量)）。 */
  readonly contractSuccessBoostPerQuarter: number;
  /** 放置時の減衰率（現在値に対する比率/四半期）。0.06 → 1四半期でゼロにならず、
   *  中立超過分が半減するのに約11四半期（ゆっくり失われる）。 */
  readonly idleDecayRatioPerQuarter: number;
  /** 重大品質事故時の毀損（点。当該会社×商品の全市場に適用）。 */
  readonly majorIncidentPenalty: number;
  /** 市場成熟度係数の下限（小さい初期市場での基盤形成速度の下限倍率）。 */
  readonly maturityFactorFloor: number;
  /** スコアの下限・上限。 */
  readonly floor: number;
  readonly cap: number;
}

export const SALES_BASE_PARAMETERS_V1: SalesBaseParameters = {
  neutralScore: 50,
  activeAcquisitionPerQuarter: 4.0,
  contractSuccessBoostPerQuarter: 2.0,
  idleDecayRatioPerQuarter: 0.06,
  majorIncidentPenalty: 8.0,
  maturityFactorFloor: 0.25,
  floor: 0,
  cap: 100,
};

const EPSILON = 1e-9;

/** 空の営業基盤状態（全キー中立）。 */
export function emptySalesBaseState(): SalesBaseState {
  return { entries: [] };
}

/** 会社×市場×商品の営業基盤スコアを引く（存在しなければ中立値）。 */
export function lookupSalesBaseScore(
  state: SalesBaseState | undefined,
  companyId: CompanyId,
  market: DemandMarketId,
  product: Product,
  params: SalesBaseParameters = SALES_BASE_PARAMETERS_V1
): number {
  if (!state) return params.neutralScore;
  const entry = state.entries.find((e) => e.companyId === companyId && e.market === market && e.product === product);
  return entry ? unwrapUnit(entry.score) : params.neutralScore;
}

/** 1社ぶんの営業基盤スライス（AIの観測・販売計画注入用）。 */
export function salesBaseSliceForCompany(
  state: SalesBaseState | undefined,
  companyId: CompanyId
): Readonly<Partial<Record<DemandMarketId, Readonly<Partial<Record<Product, Score0to100>>>>>> {
  if (!state) return {};
  const out: Partial<Record<DemandMarketId, Partial<Record<Product, Score0to100>>>> = {};
  for (const e of state.entries) {
    if (e.companyId !== companyId) continue;
    (out[e.market] ??= {})[e.product] = e.score;
  }
  return out;
}

/** 当期の活動・成約実績（updateSalesBaseStateの入力）。 */
export interface SalesBaseQuarterActivity {
  /** 当期に提出された全社の販売計画（活動判定: desiredQuantity>0 かつ headcount>0）。 */
  readonly salesPlans: readonly CompanySalesPlanEntry[];
  /** 当期の成約配分結果（成約強化: min(1, 成約量/希望量)）。 */
  readonly allocations: readonly MarketProductAllocationResult[];
  /** 当期の品質調整結果（重大事故の毀損: 会社×商品、全市場へ適用）。 */
  readonly qualityAdjustments: readonly BatchQualityAdjustment[];
  /** 【SAI-5C連動】当期の市場×商品構成比（省略時は成熟度係数=1）。
   *  小さい初期市場（例: 中国VAP）では基盤形成速度を
   *  clamp(構成比/成熟構成比, floor, 1) で抑える。 */
  readonly lifecycleMix?: MarketProductMix;
}

function maturityFactor(market: DemandMarketId, product: Product, mix: MarketProductMix | undefined, params: SalesBaseParameters): number {
  if (!mix || product === "hoso") return 1; // HOSOは成熟商品＝常に1
  const matureShare = PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket[market][product].matureShare;
  if (matureShare <= EPSILON) return 1;
  return Math.max(params.maturityFactorFloor, Math.min(1, mix[market][product] / matureShare));
}

/**
 * 四半期末の営業基盤更新（純粋関数・決定論的）。
 *
 *   次期基盤 = clamp( 前期基盤
 *                     + 活動獲得（提示あり: acquisition × (1-score/100) × 成熟度係数）
 *                     + 成約強化（contractBoost × min(1, 成約量/希望量)）
 *                     − 放置減衰（提示なし: score × decayRatio）
 *                     − 重大事故毀損, floor, cap )
 *
 * - 営業を止めても1四半期でゼロにはならない（減衰は比率6%/四半期）。
 * - 市場急成長時は成熟度係数が1へ近づき、後発企業の基盤形成も速くなる
 *   （＝新規顧客の増加による参入余地。実装指示§7）。
 * - 営業基盤だけで実需要以上の販売は発生しない（成約配分の需要上限・水位法は
 *   一切変更していない。基盤は競争力ウェイトの1項にすぎない）。
 */
export function updateSalesBaseState(
  prev: SalesBaseState | undefined,
  activity: SalesBaseQuarterActivity,
  companyIds: readonly CompanyId[],
  params: SalesBaseParameters = SALES_BASE_PARAMETERS_V1
): SalesBaseState {
  // 活動マップ: company::market::product → {desired}
  const activePlans = new Map<string, { desired: number }>();
  for (const plan of activity.salesPlans) {
    const desired = unwrapUnit(plan.desiredQuantity);
    if (desired > EPSILON && plan.salesForceHeadcount > 0) {
      activePlans.set(activkey(plan.companyId, plan.market, plan.product), { desired });
    }
  }
  // 成約マップ
  const allocated = new Map<string, number>();
  for (const alloc of activity.allocations) {
    for (const c of alloc.companies) {
      allocated.set(activkey(c.companyId, alloc.market, alloc.product), unwrapUnit(c.allocatedQuantity));
    }
  }
  // 重大事故マップ（会社×商品）
  const incidents = new Set<string>();
  for (const adj of activity.qualityAdjustments) {
    if (adj.outcome.majorIncident.occurred) {
      incidents.add(`${adj.companyId}::${adj.product}`);
    }
  }

  const prevScores = new Map<string, number>();
  for (const e of prev?.entries ?? []) {
    prevScores.set(activkey(e.companyId, e.market, e.product), unwrapUnit(e.score));
  }

  const entries: SalesBaseEntry[] = [];
  // companyId→market→productの固定順で決定論的に走査する。
  const sortedCompanyIds = [...companyIds].sort();
  for (const companyId of sortedCompanyIds) {
    for (const market of DEMAND_MARKET_IDS) {
      for (const product of PRODUCTS) {
        const key = activkey(companyId, market, product);
        let score = prevScores.get(key) ?? params.neutralScore;
        const active = activePlans.get(key);
        if (active) {
          const factor = maturityFactor(market, product, activity.lifecycleMix, params);
          score += params.activeAcquisitionPerQuarter * (1 - score / 100) * factor;
          const alloc = allocated.get(key) ?? 0;
          if (alloc > EPSILON && active.desired > EPSILON) {
            score += params.contractSuccessBoostPerQuarter * Math.min(1, alloc / active.desired);
          }
        } else {
          // 放置減衰は**中立値へ向かって**減衰する（0へ向かわない）。
          // 中立値50は「その市場×商品で無名の新規参入者」の基準点であり、
          // 一度も活動していない会社のセルが勝手に50未満へ沈むのは不合理
          // （全社の未活動セルが一斉にドリフトする）。築いた基盤（>50）は
          // 数四半期かけて中立へ戻り、毀損された基盤（<50）も時間とともに
          // 中立へ回復する（悪評の風化）。
          score = params.neutralScore + (score - params.neutralScore) * (1 - params.idleDecayRatioPerQuarter);
        }
        if (incidents.has(`${companyId}::${product}`)) {
          score -= params.majorIncidentPenalty;
        }
        score = Math.max(params.floor, Math.min(params.cap, score));
        // スパース表現: 中立値と実質同値（±0.005未満）のエントリは保存しない
        // （状態サイズを会社×市場×商品の実活動分に抑える）。
        if (Math.abs(score - params.neutralScore) >= 0.005) {
          entries.push({ companyId, market, product, score: score0to100(score) });
        }
      }
    }
  }
  return { entries };
}

// 内部ヘルパー（タイポ防止のためのエイリアス）。
function activkey(c: string, m: string, p: string): string {
  return `${c}::${m}::${p}`;
}
