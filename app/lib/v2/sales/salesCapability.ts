// ShrimpX V2 — 営業能力の再設計: 販売処理能力と顧客開発能力の分離（加工品市場進化 §e）
//
// 【監査で特定した3つの構造的欠陥（docs/v2/design/processed_market_evolution_audit.md §5）】
//  (i)  1市場あたりの処理能力が「200 + 4800×h/(h+10)」という**絶対トン数**で、
//       h→∞ でも 5,000t で頭打ち。市場規模・需要成長・自社の生産能力と一切連動しない。
//       → Phase6「新工場の能力増が販売へ変換されない」の直接原因。
//  (ii) VAP工数係数3.0が「販売可能トン数を1/3にする」形で効いており、
//       「同じ量を売るのにより多くの人手が要る（＝採用・再配置で解ける）」という
//       設計意図になっていなかった。→ Phase7「VAP支出が販売へ変換されない」の直接原因。
//  (iii) 能力超過時の縮小が全商品一律のため、会社が「VAPを優先して守る」という
//       意思を表現する手段が無かった。
//
// 【この再設計の考え方（実装指示§7）】
// 営業力を概念的に2つへ分ける。UI上で2種類の営業員を持たせる必要はなく、
// 既存の営業人員・VAP商品開発スコア・品質/信頼から**両方を導出する**。
//
//   販売処理能力（throughput）
//     = 商談・契約を処理できる数量の上限。**人数にほぼ線形**で増える。
//       市場規模（対象需要）にも比例するため、需要が伸びれば売れる量も伸びる。
//       → 欠陥(i)の解消。採用が効くため欠陥(ii)の「人手で解ける」性質も回復する。
//
//   顧客開発能力（customer development）
//     = ニーズ発掘・商品提案・プレミアム獲得・取引継続性。**人数に対して逓減**し
//       （既存の salesCoverageScore と同じ飽和曲線）、VAP商品開発スコア・品質・
//       顧客関係の蓄積で底上げされる。処理能力へ**乗算**で効く。
//
// 【非加算性（実装指示の必須要件）】
//   throughput = (基礎 + 1人あたり処理量 × 人数) × 市場規模係数 × 顧客開発倍率
// という構造のため、顧客開発倍率の改善（＝VAP商品開発投資の効果）がもたらす
// 増分は、人数が多いほど大きい。したがって「商品開発投資だけ」「営業増員だけ」
// のどちらも最大効果に届かず、**組み合わせて初めて交互作用項が立つ**。
// これは salesCapability.test.ts の 2×2 実験で実測している。
//
// 【営業工数制約を消していないこと（実装指示のハード制約）】
// 必要工数の式（HOSO 1.0 / PD 1.2 / VAP 3.0 の加重和）は**そのまま**である。
// VAPを売るには依然として3倍の工数がかかり、人数が足りなければ計画は縮小される。
// 変わったのは「足りないときに人を増やせば解ける」ようになったことだけ。
//
// 【決定論】純粋関数のみ。乱数不使用。

import { Product } from "../market/types";
import { salesCoverageScore } from "./salesForce";
import { SalesParameters } from "./parameters";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const EPSILON = 1e-6;

export interface SalesCapabilityParameters {
  // --- 販売処理能力（throughput） ---
  /**
   * 営業人員0人でも残る基礎処理能力（HOSO換算トン／市場・四半期）。
   * 既存顧客からの継続受注ぶん。既存 salesForce.baselineCapacityTons と同じ意味。
   */
  readonly baselineThroughputTons: number;
  /**
   * 営業員1人あたりの四半期処理能力（HOSO換算工数トン）。
   * **逓減させない**（人数に線形）。逓減は顧客開発能力側が担う。
   * 【初期値の根拠】既存曲線の実効水準（h=10で2,600t）とおおむね整合させつつ、
   * 増員が意味を持つよう h=10 で 200+2,600=2,800t になる 260 を採る。
   */
  readonly throughputTonsPerHead: number;

  // --- 市場規模による伸縮 ---
  /**
   * 市場規模係数の基準となる対象需要（HOSO換算トン／市場・四半期）。
   * この規模の市場で係数=1.0。【根拠】baselineシナリオturn1のベトナム獲得需要
   * 216,000t を5市場で割った 43,200t 相当を丸めた値。
   */
  readonly referenceMarketDemandTons: number;
  /** 市場規模係数の下限・上限（小さい市場でも0にならず、大きい市場でも青天井にしない）。 */
  readonly marketScaleFloor: number;
  readonly marketScaleCap: number;

  // --- 顧客開発能力（customer development） ---
  /**
   * 顧客開発スコアの合成ウェイト（合計1.0）。いずれも0〜100スケール。
   *  coverage: 営業人員から導く市場カバレッジ（既存 salesCoverageScore×100、逓減）
   *  vapCapability: VAP能力合成係数（VAP商品開発スコアを主因とする。premiumPolicy.ts）
   *  quality: 品質評価
   *  relationship: 顧客関係
   */
  readonly customerDevelopmentWeights: {
    readonly coverage: number;
    readonly vapCapability: number;
    readonly quality: number;
    readonly relationship: number;
  };
  /**
   * 顧客開発スコアが中立(50)から100へ振れたときの処理能力倍率の伸び。
   * 倍率 = 1 + uplift × (score/100 − 0.5) × 2。uplift=0.5 なら score100 で1.5倍。
   */
  readonly customerDevelopmentUplift: number;
  /** 顧客開発倍率の下限・上限。 */
  readonly customerDevelopmentMultiplierFloor: number;
  readonly customerDevelopmentMultiplierCap: number;
}

/**
 * 【加工品市場進化 v1 初期値・要校正】
 *
 * 単位・時期・範囲・事業上の意味はすべて上のフィールドコメントに記載。
 * すべて「四半期あたり・1市場あたり」の値。
 */
export const SALES_CAPABILITY_PARAMETERS_V1: SalesCapabilityParameters = {
  baselineThroughputTons: 200,
  throughputTonsPerHead: 260,
  referenceMarketDemandTons: 43_000,
  marketScaleFloor: 0.5,
  marketScaleCap: 2.5,
  customerDevelopmentWeights: { coverage: 0.3, vapCapability: 0.35, quality: 0.2, relationship: 0.15 },
  customerDevelopmentUplift: 0.5,
  customerDevelopmentMultiplierFloor: 0.6,
  customerDevelopmentMultiplierCap: 1.8,
};

const NEUTRAL_SCORE = 50;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 顧客開発スコアの入力（未接続の項目は中立値50として扱う）。 */
export interface CustomerDevelopmentInputs {
  readonly salesForceHeadcount: number;
  /** VAP能力合成係数（companyLab/premiumPolicy.ts）。VAP行に注入される値。 */
  readonly vapCapabilityScore?: number;
  readonly qualityReputation?: number;
  readonly customerRelationship?: number;
}

/**
 * 顧客開発能力スコア（0〜100）。営業人員は**逓減**して効き（salesCoverageScore）、
 * VAP商品開発・品質・顧客関係が底上げする。
 */
export function computeCustomerDevelopmentScore(
  inputs: CustomerDevelopmentInputs,
  salesParams: SalesParameters,
  params: SalesCapabilityParameters = SALES_CAPABILITY_PARAMETERS_V1
): number {
  const w = params.customerDevelopmentWeights;
  const coverage = salesCoverageScore(inputs.salesForceHeadcount, salesParams) * 100;
  const vap = inputs.vapCapabilityScore ?? NEUTRAL_SCORE;
  const quality = inputs.qualityReputation ?? NEUTRAL_SCORE;
  const relationship = inputs.customerRelationship ?? NEUTRAL_SCORE;
  const total = w.coverage + w.vapCapability + w.quality + w.relationship;
  if (!(total > 0)) return NEUTRAL_SCORE;
  const weighted = w.coverage * coverage + w.vapCapability * vap + w.quality * quality + w.relationship * relationship;
  return clamp(weighted / total, 0, 100);
}

/** 顧客開発スコア → 処理能力への乗算倍率。 */
export function customerDevelopmentMultiplier(
  customerDevelopmentScore: number,
  params: SalesCapabilityParameters = SALES_CAPABILITY_PARAMETERS_V1
): number {
  const raw = 1 + params.customerDevelopmentUplift * ((customerDevelopmentScore / 100 - 0.5) * 2);
  return clamp(raw, params.customerDevelopmentMultiplierFloor, params.customerDevelopmentMultiplierCap);
}

/** 市場の対象需要 → 処理能力への市場規模係数。 */
export function marketScaleFactor(
  marketTargetDemandTons: number | undefined,
  params: SalesCapabilityParameters = SALES_CAPABILITY_PARAMETERS_V1
): number {
  if (marketTargetDemandTons === undefined || !(marketTargetDemandTons > 0)) return 1;
  return clamp(marketTargetDemandTons / params.referenceMarketDemandTons, params.marketScaleFloor, params.marketScaleCap);
}

/** 1つの会社×市場についての販売処理能力（HOSO換算工数トン／四半期）。 */
export interface SalesThroughputResult {
  readonly headcount: number;
  /** 人数由来の素の処理能力（市場規模・顧客開発を掛ける前）。 */
  readonly headcountThroughputTons: number;
  readonly marketScaleFactor: number;
  readonly customerDevelopmentScore: number;
  readonly customerDevelopmentMultiplier: number;
  /** 最終的な処理能力（工数換算トン）。 */
  readonly throughputCapacityTons: number;
}

export function computeSalesThroughput(
  inputs: CustomerDevelopmentInputs,
  marketTargetDemandTons: number | undefined,
  salesParams: SalesParameters,
  params: SalesCapabilityParameters = SALES_CAPABILITY_PARAMETERS_V1
): SalesThroughputResult {
  const headcountThroughputTons = params.baselineThroughputTons + params.throughputTonsPerHead * Math.max(0, inputs.salesForceHeadcount);
  const scale = marketScaleFactor(marketTargetDemandTons, params);
  const customerDevelopmentScore = computeCustomerDevelopmentScore(inputs, salesParams, params);
  const multiplier = customerDevelopmentMultiplier(customerDevelopmentScore, params);
  return {
    headcount: inputs.salesForceHeadcount,
    headcountThroughputTons,
    marketScaleFactor: scale,
    customerDevelopmentScore,
    customerDevelopmentMultiplier: multiplier,
    throughputCapacityTons: headcountThroughputTons * scale * multiplier,
  };
}

/**
 * 商品別の優先度を考慮して、限られた処理能力（工数トン）を商品へ配分し、
 * 商品ごとの縮小率を返す。
 *
 * 【なぜ一律縮小ではないのか（欠陥(iii)の解消）】従来は超過時に全商品へ同一の
 * scaleFactor を掛けていたため、「VAPは守ってHOSOを削る」という判断を会社が
 * 表現できなかった。ここでは各商品の必要工数に優先度を掛けた重みで水位法配分し、
 * 自分の必要工数を満たした商品は打ち切って残りを他商品へ回す。
 *
 * 優先度がすべて等しい（既定1.0）場合、結果は従来の一律縮小と一致する。
 */
export function allocateThroughputByPriority(
  requiredEffortByProduct: Readonly<Record<Product, number>>,
  priorityByProduct: Readonly<Record<Product, number>>,
  throughputCapacityTons: number
): Readonly<Record<Product, number>> {
  const scaleByProduct = { hoso: 1, pd: 1, vap: 1 } as Record<Product, number>;
  const totalRequired = PRODUCTS.reduce((sum, p) => sum + Math.max(0, requiredEffortByProduct[p]), 0);
  if (totalRequired <= throughputCapacityTons + EPSILON || totalRequired <= EPSILON) return scaleByProduct;

  const allocated = { hoso: 0, pd: 0, vap: 0 } as Record<Product, number>;
  const active = new Set(PRODUCTS.filter((p) => requiredEffortByProduct[p] > EPSILON));
  let budget = throughputCapacityTons;
  let guard = 0;

  while (budget > EPSILON && active.size > 0 && guard < PRODUCTS.length + 2) {
    guard += 1;
    const activeList = PRODUCTS.filter((p) => active.has(p));
    const totalWeight = activeList.reduce((sum, p) => sum + requiredEffortByProduct[p] * Math.max(0, priorityByProduct[p]), 0);
    if (totalWeight <= EPSILON) break;

    const overflowing = activeList.filter((p) => {
      const tentative = budget * ((requiredEffortByProduct[p] * Math.max(0, priorityByProduct[p])) / totalWeight);
      return tentative > requiredEffortByProduct[p] - allocated[p] + EPSILON;
    });

    if (overflowing.length === 0) {
      for (const p of activeList) {
        allocated[p] += budget * ((requiredEffortByProduct[p] * Math.max(0, priorityByProduct[p])) / totalWeight);
      }
      budget = 0;
      break;
    }
    for (const p of overflowing) {
      const room = requiredEffortByProduct[p] - allocated[p];
      allocated[p] += room;
      budget -= room;
      active.delete(p);
    }
  }

  for (const p of PRODUCTS) {
    scaleByProduct[p] = requiredEffortByProduct[p] > EPSILON ? clamp(allocated[p] / requiredEffortByProduct[p], 0, 1) : 1;
  }
  return scaleByProduct;
}
