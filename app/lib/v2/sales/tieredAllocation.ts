// ShrimpX V2 — ENG-TIERED-MKT-1 三層顧客＋全社同時市場配分（opt-in）
//
// 【なぜ必要か】現行の水位法（allocation.ts）は、対象需要をウェイト比例で按分し、
// 各社の上限（希望量・営業能力・供給者シェア）で打ち切る。市場需要が5社の希望量より
// 大きい局面（baseline 実測で対象需要の38%しか5社が希望していない）では全社が自分の
// 希望量capで止まるため、**価格競争力が成約数量へ一切伝わらない**。
// 結果として「値上げしても数量が減らない＝値上げが支配戦略」になっていた。
//
// 【この方式の考え方】
//   1. market×product の対象需要を、顧客層（PRICE_SENSITIVE / STANDARD / PREMIUM）へ
//      demandShare で分割する（合計 1.0）。
//   【外部選択肢の正式定義・TIERED-MKT-P1D】Phase 1 の産地間配分後にベトナムへ
//   割り当てられた需要のうち、(a) ゲームに登場しない他のベトナム企業へ流れる需要と
//   (b) 購買を見送る需要をまとめた仮想選択肢。**Ecuador / India / Indonesia など
//   他産地の供給者は含まない**（他産地との競争は targetDemand 算出前に決着済み）。
//
//   2. 各層について、**5社＋外部選択肢を同一分母へ一度に入れて**効用ベースの
//      選択確率（数値安定化 softmax）で層需要を配分する。
//      1社ずつ独立に対象需要を評価することは決してしない。
//   3. 効用は price / quality / differentiation / その他非価格 / 留保価格超過ペナルティ
//      に明示的に分解する。**下限（minimumPriceCompetitiveness 相当）は使わない。**
//      clamp は softmax の overflow 防止のみ。
//   4. cap 前の配分（unconstrained）を確定した後、各社へ cap を適用する。
//      cap は現行 Engine に実在するものだけ:
//        unconstrained / desired / salesCapacity / supplierShare / approvedAllocation
//      【ENG-TIERED-MKT-1A】「物理的な将来納品可能量（deliverable supply）」の正本は
//      現行 Engine に存在しない（sales モジュールは完成品在庫・生産能力・受注残の
//      いずれも入力として受け取らない）。存在しない cap を Infinity で入れて
//      実装済みと表現しない。接続は別Phaseの仕様設計が必要。
//      cap で削られた数量は**他社へ再配分せず外部選択肢へ移す**（水位法の
//      「競争力が低くても他社cap後の残余で埋まる」構造を再導入しないため）。
//
// 【需要保存】Σ(各社 final) + external final = targetDemand（丸め誤差を除く）。
//
// 【永続化しない】診断（TieredAllocationDiagnostics）はこの関数の戻り値としてのみ返し、
// MarketProductAllocationResult へは一切足さない（履歴・Redis schema へ入れない）。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, roundHosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { PeriodV2 } from "../core/period";
import { DemandMarketId, Product } from "../market/types";
import {
  CUSTOMER_TIER_IDS,
  CustomerTierId,
  CustomerTierParameters,
  SalesParameters,
  TieredMarketAllocationParameters,
} from "./parameters";
import { CompanyAllocationEntry, CompanySalesPlanEntry, MarketProductAllocationResult, SalesValidationError } from "./types";
import { computeCompetitivenessBreakdown } from "./allocation";
import { salesCoverageScore } from "./salesForce";

const EPSILON = 1e-9;
export const EXTERNAL_OPTION_PARTICIPANT_ID = "__external_option__";

// ---------------------------------------------------------------------
// 1. 診断（非永続）
// ---------------------------------------------------------------------

/** どの上限が最終成約量を決めたか。 */
/**
 * どの上限が最終成約量を決めたか。
 *
 * 【ENG-TIERED-MKT-1A】APPROVED_ALLOCATION は CompanySalesPlanEntry.approvedAllocationCap
 * （承認済み取引枠・供給信認枠）であり、**物理的な納品可能量ではない**。
 * Engine には現時点で「将来納品可能量（physical deliverable supply）」の正本が存在しない
 * ため、その名前の cap は用意していない（存在しない cap を Infinity で入れて
 * 実装済みと表現しない）。
 */
export type TieredBindingCap = "UNCONSTRAINED_DEMAND" | "DESIRED" | "SALES_CAPACITY" | "SUPPLIER_SHARE" | "APPROVED_ALLOCATION";

export interface TieredCompanyTierDiagnostics {
  readonly companyId: string;
  readonly askPrice: number;
  readonly priceComponent: number;
  readonly qualityComponent: number;
  readonly differentiationComponent: number;
  /** 【TIERED-MKT-P1D】顧客関係の寄与（旧 nonPriceComponent の内訳）。 */
  readonly relationshipComponent: number;
  /** 【TIERED-MKT-P1D】納期信頼性の寄与（旧 nonPriceComponent の内訳）。 */
  readonly deliveryComponent: number;
  /** 【TIERED-MKT-P1D】営業基盤の寄与（旧 nonPriceComponent の内訳）。 */
  readonly salesBaseComponent: number;
  /**
   * 【TIERED-MKT-P1D】説明用の集約値（既存consumer互換）。
   * = relationshipComponent + deliveryComponent + salesBaseComponent。
   */
  readonly nonPriceComponent: number;
  readonly reservationPrice: number;
  readonly reservationExcess: number;
  readonly reservationPenalty: number;
  readonly utility: number;
  readonly normalizedWeight: number;
  readonly unconstrainedAllocation: number;
  /** cap 適用後にこの層へ残った数量。 */
  readonly finalAllocation: number;
  /** cap によりこの層から削られた数量（外部選択肢へ移る）。 */
  readonly reductionByCap: number;
}

export interface TieredExternalTierDiagnostics {
  readonly utility: number;
  readonly normalizedWeight: number;
  readonly unconstrainedAllocation: number;
  /** 各社の cap 削減分がこの層で外部へ移ってきた量。 */
  readonly capRedistributionInflow: number;
  readonly finalAllocation: number;
}

export interface TieredTierDiagnostics {
  readonly tier: CustomerTierId;
  readonly tierDemand: number;
  readonly tierShare: number;
  readonly companies: readonly TieredCompanyTierDiagnostics[];
  readonly external: TieredExternalTierDiagnostics;
}

export interface TieredCompanyCapDiagnostics {
  readonly companyId: string;
  readonly unconstrainedAllocation: number;
  readonly desiredCap: number;
  readonly salesCapacityCap: number;
  readonly supplierShareCap: number;
  /** 承認済み取引枠・供給信認枠（sales/types.ts の approvedAllocationCap）。未指定なら Infinity。 */
  readonly approvedAllocationCap: number;
  readonly bindingCap: TieredBindingCap;
  readonly reductionByCap: number;
  readonly finalAllocation: number;
}

export interface TieredAllocationDiagnostics {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly period: PeriodV2;
  readonly referencePrice: number;
  readonly targetDemand: number;
  readonly tiers: readonly TieredTierDiagnostics[];
  readonly companies: readonly TieredCompanyCapDiagnostics[];
  readonly externalFinalAllocation: number;
  /** Σ(各社 final) + external final − targetDemand（丸め前。0であること）。 */
  readonly demandConservationResidual: number;
}

// ---------------------------------------------------------------------
// 2. パラメータ解決
// ---------------------------------------------------------------------

/** market×product の上書きを適用した層パラメータを返す。 */
export function resolveTierParameters(
  tiered: TieredMarketAllocationParameters,
  market: DemandMarketId,
  product: Product
): Readonly<Record<CustomerTierId, CustomerTierParameters>> {
  const resolved = { ...tiered.tiers } as Record<CustomerTierId, CustomerTierParameters>;
  for (const override of tiered.overrides ?? []) {
    if (override.market !== market || override.product !== product) continue;
    for (const tierId of CUSTOMER_TIER_IDS) {
      const patch = override.tiers[tierId];
      if (!patch) continue;
      resolved[tierId] = { ...resolved[tierId], ...patch };
    }
  }
  return resolved;
}

function assertDemandShareSumsToOne(tiers: Readonly<Record<CustomerTierId, CustomerTierParameters>>, market: string, product: string): void {
  const sum = CUSTOMER_TIER_IDS.reduce((s, t) => s + tiers[t].demandShare, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new SalesValidationError(
      `市場 "${market}" 商品 "${product}" の顧客層 demandShare の合計が1.0ではありません（${sum}）。3層の合計は必ず1.0である必要があります。`
    );
  }
}

// ---------------------------------------------------------------------
// 3. 効用
// ---------------------------------------------------------------------

/**
 * 非価格スコアの取り出し。**同じ要素を二重に評価しない**ため、次の1対1対応に固定する。
 *   quality         ← qualityReputation
 *   differentiation ← vapCapabilityScore（VAP のみ。他商品は中立=0.5）
 *   nonPrice        ← customerRelationship / deliveryReliability / salesBaseScore の平均
 * 未接続（undefined）は中立値（params.neutralScore）を使う。会社IDによる分岐は持たない。
 */
function scoreInputs(entry: CompanySalesPlanEntry, params: SalesParameters): {
  readonly quality: number;
  readonly differentiation: number;
  readonly relationship: number;
  readonly delivery: number;
  readonly salesBase: number;
  /** 【TIERED-MKT-P1D】旧式（3要素の単純平均）。診断・後方互換の説明用にのみ残す。 */
  readonly nonPrice: number;
} {
  const neutral = unwrapUnit(params.neutralScore) / 100;
  const pick = (v: number | undefined): number => (v === undefined ? neutral : v / 100);
  const quality = pick(entry.qualityReputation !== undefined ? unwrapUnit(entry.qualityReputation) : undefined);
  const differentiation =
    entry.product === "vap" ? pick(entry.vapCapabilityScore !== undefined ? unwrapUnit(entry.vapCapabilityScore) : undefined) : neutral;
  const relationship = pick(entry.customerRelationship !== undefined ? unwrapUnit(entry.customerRelationship) : undefined);
  const reliability = pick(entry.deliveryReliability !== undefined ? unwrapUnit(entry.deliveryReliability) : undefined);
  const salesBase = pick(entry.salesBaseScore !== undefined ? unwrapUnit(entry.salesBaseScore) : undefined);
  return {
    quality,
    differentiation,
    relationship,
    delivery: reliability,
    salesBase,
    nonPrice: (relationship + reliability + salesBase) / 3,
  };
}

interface UtilityBreakdown {
  readonly priceComponent: number;
  readonly qualityComponent: number;
  readonly differentiationComponent: number;
  /** 【TIERED-MKT-P1D】顧客関係の寄与。 */
  readonly relationshipComponent: number;
  /** 【TIERED-MKT-P1D】納期信頼性の寄与。 */
  readonly deliveryComponent: number;
  /** 【TIERED-MKT-P1D】営業基盤の寄与。 */
  readonly salesBaseComponent: number;
  /**
   * 【TIERED-MKT-P1D】説明用の集約値。
   * nonPriceComponent = relationshipComponent + deliveryComponent + salesBaseComponent。
   * 既存 diagnostics consumer を壊さないために残している（保存schemaへは入れない）。
   */
  readonly nonPriceComponent: number;
  readonly reservationPrice: number;
  readonly reservationExcess: number;
  readonly reservationPenalty: number;
  readonly utility: number;
}

/**
 * 1社×1層の効用。
 *
 *   priceComponent      = -priceSensitivity × (ask − ref) / ref
 *   qualityComponent    =  qualitySensitivity × (quality − 0.5)
 *   differentiationComponent = differentiationSensitivity × (differentiation − 0.5)
 *   relationshipComponent = relationshipSensitivity × (relationship − 0.5)
 *   deliveryComponent     = deliverySensitivity     × (delivery − 0.5)
 *   salesBaseComponent    = salesBaseSensitivity    × (salesBase − 0.5)
 *   nonPriceComponent     = 上記3項の和（説明用の集約値）
 *     【TIERED-MKT-P1D】3つの感応度が未指定なら、いずれも nonPriceSensitivity/3 へ
 *     fallback する。この場合、旧式 nonPriceSensitivity × (3要素平均 − 0.5) と
 *     数学的に恒等（浮動小数点誤差のみ）。
 *   reservationPrice    =  ref × reservationPriceMultiplier
 *   reservationExcess   =  max(0, (ask − reservationPrice) / ref)          ← hard cutoff にしない
 *   reservationPenalty  = -reservationSoftPenaltySlope × reservationExcess²  ← 連続・加速的
 *   utility             =  上記の総和（clamp は overflow 防止のみ）
 */
export interface NonPriceSensitivities {
  readonly relationship: number;
  readonly delivery: number;
  readonly salesBase: number;
}

/**
 * 【TIERED-MKT-P1D・legacy tiered fallback】非価格3要素の感応度を解決する。
 * 明示指定が無い項目だけ nonPriceSensitivity/3 へ落とす（旧 tiered parameter は
 * nonPriceSensitivity しか持たないため、この fallback で旧式と数学的に一致する）。
 * TypeScript level の optional のみで解決しており、保存schema・Redis・migration は
 * 一切必要ない（SalesParameters は CompanyLabConfig.salesParamsOverride 経由の
 * in-memory 値であり、persistence/schema.ts の validateCompanyLabConfig は
 * この項目を復元対象に含めていない）。
 */
export function resolveNonPriceSensitivities(tier: CustomerTierParameters): NonPriceSensitivities {
  const third = tier.nonPriceSensitivity / 3;
  return {
    relationship: tier.relationshipSensitivity ?? third,
    delivery: tier.deliverySensitivity ?? third,
    salesBase: tier.salesBaseSensitivity ?? third,
  };
}

export function computeTierUtility(
  askPrice: number,
  referencePrice: number,
  scores: {
    readonly quality: number;
    readonly differentiation: number;
    readonly relationship: number;
    readonly delivery: number;
    readonly salesBase: number;
  },
  tier: CustomerTierParameters,
  utilityClamp: number
): UtilityBreakdown {
  const priceGap = (askPrice - referencePrice) / referencePrice;
  const priceComponent = -tier.priceSensitivity * priceGap;
  const qualityComponent = tier.qualitySensitivity * (scores.quality - 0.5);
  const differentiationComponent = tier.differentiationSensitivity * (scores.differentiation - 0.5);
  const nonPrice = resolveNonPriceSensitivities(tier);
  const relationshipComponent = nonPrice.relationship * (scores.relationship - 0.5);
  const deliveryComponent = nonPrice.delivery * (scores.delivery - 0.5);
  const salesBaseComponent = nonPrice.salesBase * (scores.salesBase - 0.5);
  const nonPriceComponent = relationshipComponent + deliveryComponent + salesBaseComponent;
  const reservationPrice = referencePrice * tier.reservationPriceMultiplier;
  const reservationExcess = Math.max(0, (askPrice - reservationPrice) / referencePrice);
  const reservationPenalty = -tier.reservationSoftPenaltySlope * reservationExcess * reservationExcess;
  const raw = priceComponent + qualityComponent + differentiationComponent + nonPriceComponent + reservationPenalty;
  // 【clampの位置づけ】経済的な下限ではなく、exp() のoverflow防止のみ。
  const utility = Math.min(utilityClamp, Math.max(-utilityClamp, raw));
  return {
    priceComponent,
    qualityComponent,
    differentiationComponent,
    relationshipComponent,
    deliveryComponent,
    salesBaseComponent,
    nonPriceComponent,
    reservationPrice,
    reservationExcess,
    reservationPenalty,
    utility,
  };
}

/** 数値安定化 softmax（最大値を引いてから exp する）。入力順に依存しない。 */
function stableSoftmax(utilities: readonly number[]): number[] {
  if (utilities.length === 0) return [];
  const max = Math.max(...utilities);
  const exps = utilities.map((u) => Math.exp(u - max));
  const sum = exps.reduce((s, e) => s + e, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) {
    // すべてが -Infinity 相当。外部選択肢が必ず参加者に含まれるため通常到達しない。
    return utilities.map(() => 1 / utilities.length);
  }
  return exps.map((e) => e / sum);
}

// ---------------------------------------------------------------------
// 4. 配分本体
// ---------------------------------------------------------------------

export interface TieredAllocationInput {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly period: PeriodV2;
  readonly entries: readonly CompanySalesPlanEntry[];
  readonly basePrice: UsdPerHosoEqKg;
  readonly targetDemand: HosoEqTons;
  readonly params: SalesParameters;
  /** 会社×市場ごとの営業工数能力（allocation.ts と同じ規約）。 */
  readonly salesCapacityByCompanyMarket?: ReadonlyMap<string, number>;
}

export interface TieredAllocationOutput {
  readonly result: MarketProductAllocationResult;
  readonly diagnostics: TieredAllocationDiagnostics;
}

/**
 * 三層顧客＋全社同時配分。純粋関数。入力配列の順序に依存しない
 * （内部で companyId 昇順へ整列してから処理する）。
 */
export function allocateMarketProductTiered(input: TieredAllocationInput): TieredAllocationOutput {
  const { market, product, period, basePrice, targetDemand, params } = input;
  const tiered = params.tieredMarketAllocation;
  if (!tiered) {
    throw new SalesValidationError(
      `marketAllocationMode="tieredSimultaneousAllocation" が指定されていますが、SalesParameters.tieredMarketAllocation がありません。` +
        `既定値を推測しません（検証用には SALES_PARAMETERS_TIERED_FIXTURE_V0 を使ってください）。`
    );
  }
  const tiers = resolveTierParameters(tiered, market, product);
  assertDemandShareSumsToOne(tiers, market, product);

  const relevant = input.entries.filter((e) => e.market === market && e.product === product);
  const sorted = [...relevant].sort((a, b) => a.companyId.localeCompare(b.companyId));
  const seen = new Set<string>();
  for (const e of sorted) {
    if (seen.has(e.companyId)) {
      throw new SalesValidationError(`会社 "${e.companyId}" の market="${market}" product="${product}" 販売計画が重複しています。`);
    }
    seen.add(e.companyId);
  }

  const ref = unwrapUnit(basePrice);
  const demand = unwrapUnit(targetDemand);

  const prepared = sorted.map((entry) => {
    const askPrice = ref + entry.priceAdjustmentUsdPerHosoEqKg;
    if (!Number.isFinite(askPrice) || askPrice <= 0) {
      throw new SalesValidationError(`会社 "${entry.companyId}" の提示価格が不正です（0より大きい有限数である必要があります）。受け取った値: ${askPrice}`);
    }
    const scores = scoreInputs(entry, params);
    // 【cap の算出元】legacy と同一の定義をそのまま使う（式を二重実装しない）。
    const effortCapacity = input.salesCapacityByCompanyMarket?.get(`${entry.companyId}::${entry.market}`);
    const salesCapacityCap =
      effortCapacity !== undefined ? effortCapacity / params.salesEffortCoefficients[entry.product] : Number.POSITIVE_INFINITY;
    const supplierShareCap = demand * params.maximumSupplierShare;
    // 【ENG-TIERED-MKT-1A】approvedAllocationCap は「承認済み取引枠・供給信認枠」
    // （与信・取引先管理・外部承認から与えられる任意の成約上限）であり、
    // **「生産・在庫・受注残から見て何t追加納品できるか」という物理量ではない**。
    // 名前と意味をそのまま維持し、physical deliverable supply として扱わない。
    const approvedAllocationCap =
      entry.approvedAllocationCap !== undefined ? unwrapUnit(entry.approvedAllocationCap) : Number.POSITIVE_INFINITY;
    return {
      entry,
      askPrice,
      scores,
      desiredCap: unwrapUnit(entry.desiredQuantity),
      salesCapacityCap,
      supplierShareCap,
      approvedAllocationCap,
    };
  });

  // ---- 層ごとの同時配分（cap 適用前） ----
  const tierDiagnostics: TieredTierDiagnostics[] = [];
  const unconstrainedByCompany = new Map<string, number>(prepared.map((p) => [p.entry.companyId, 0]));
  const perTierUnconstrained = new Map<CustomerTierId, Map<string, number>>();
  const externalUnconstrainedByTier = new Map<CustomerTierId, number>();
  const utilityByTier = new Map<CustomerTierId, Map<string, UtilityBreakdown>>();
  const weightByTier = new Map<CustomerTierId, Map<string, number>>();
  const externalUtilityByTier = new Map<CustomerTierId, number>();
  const externalWeightByTier = new Map<CustomerTierId, number>();
  /** 層需要で加重した正規化ウェイト（全社合計 + 外部シェア = 1）。 */
  const aggregateWeightByCompany = new Map<string, number>(prepared.map((p) => [p.entry.companyId, 0]));

  for (const tierId of CUSTOMER_TIER_IDS) {
    const tier = tiers[tierId];
    const tierDemand = demand * tier.demandShare;
    const breakdowns = prepared.map((p) => computeTierUtility(p.askPrice, ref, p.scores, tier, tiered.utilityClamp));
    const externalUtility = Math.min(tiered.utilityClamp, Math.max(-tiered.utilityClamp, tier.externalOptionBaseUtility));
    // 【全社同時】5社＋外部選択肢を同一分母（同一 softmax）へ一度に入れる。
    const weights = stableSoftmax([...breakdowns.map((b) => b.utility), externalUtility]);
    const companyWeights = weights.slice(0, prepared.length);
    const externalWeight = weights[prepared.length];

    const uMap = new Map<string, number>();
    const wMap = new Map<string, number>();
    const uBreak = new Map<string, UtilityBreakdown>();
    prepared.forEach((p, i) => {
      const alloc = tierDemand * companyWeights[i];
      uMap.set(p.entry.companyId, alloc);
      wMap.set(p.entry.companyId, companyWeights[i]);
      uBreak.set(p.entry.companyId, breakdowns[i]);
      unconstrainedByCompany.set(p.entry.companyId, (unconstrainedByCompany.get(p.entry.companyId) ?? 0) + alloc);
    });
    prepared.forEach((p, i) => {
      aggregateWeightByCompany.set(
        p.entry.companyId,
        (aggregateWeightByCompany.get(p.entry.companyId) ?? 0) + tier.demandShare * companyWeights[i]
      );
    });
    perTierUnconstrained.set(tierId, uMap);
    weightByTier.set(tierId, wMap);
    utilityByTier.set(tierId, uBreak);
    externalUnconstrainedByTier.set(tierId, tierDemand * externalWeight);
    externalUtilityByTier.set(tierId, externalUtility);
    externalWeightByTier.set(tierId, externalWeight);
  }

  // ---- cap の適用（会社単位。市場×商品の cap は層を跨いだ合計に対して効く） ----
  const capDiagnostics: TieredCompanyCapDiagnostics[] = [];
  const finalByCompany = new Map<string, number>();
  const reductionByCompany = new Map<string, number>();
  for (const p of prepared) {
    const unconstrained = unconstrainedByCompany.get(p.entry.companyId) ?? 0;
    const caps: readonly [TieredBindingCap, number][] = [
      ["UNCONSTRAINED_DEMAND", unconstrained],
      ["DESIRED", p.desiredCap],
      ["SALES_CAPACITY", p.salesCapacityCap],
      ["SUPPLIER_SHARE", p.supplierShareCap],
      ["APPROVED_ALLOCATION", p.approvedAllocationCap],
    ];
    let bindingCap: TieredBindingCap = "UNCONSTRAINED_DEMAND";
    let final = unconstrained;
    for (const [name, value] of caps) {
      if (value < final - EPSILON) {
        final = value;
        bindingCap = name;
      }
    }
    final = Math.max(0, final);
    finalByCompany.set(p.entry.companyId, final);
    reductionByCompany.set(p.entry.companyId, Math.max(0, unconstrained - final));
    capDiagnostics.push({
      companyId: p.entry.companyId,
      unconstrainedAllocation: unconstrained,
      desiredCap: p.desiredCap,
      salesCapacityCap: p.salesCapacityCap,
      supplierShareCap: p.supplierShareCap,
      approvedAllocationCap: p.approvedAllocationCap,
      bindingCap,
      reductionByCap: Math.max(0, unconstrained - final),
      finalAllocation: final,
    });
  }

  // ---- 層別の最終値と、cap 削減分の外部選択肢への移送（他社へは再配分しない） ----
  let externalFinal = 0;
  for (const tierId of CUSTOMER_TIER_IDS) {
    const tier = tiers[tierId];
    const tierDemand = demand * tier.demandShare;
    const uMap = perTierUnconstrained.get(tierId)!;
    const wMap = weightByTier.get(tierId)!;
    const uBreak = utilityByTier.get(tierId)!;
    let inflow = 0;
    const companies: TieredCompanyTierDiagnostics[] = prepared.map((p) => {
      const unconstrainedTotal = unconstrainedByCompany.get(p.entry.companyId) ?? 0;
      const tierUnconstrained = uMap.get(p.entry.companyId) ?? 0;
      // 会社単位の cap 削減を、その会社の層別 unconstrained に比例して割り当てる
      // （層ごとの需要保存を保つため）。
      const share = unconstrainedTotal > EPSILON ? tierUnconstrained / unconstrainedTotal : 0;
      const tierReduction = (reductionByCompany.get(p.entry.companyId) ?? 0) * share;
      const tierFinal = Math.max(0, tierUnconstrained - tierReduction);
      inflow += tierReduction;
      const b = uBreak.get(p.entry.companyId)!;
      return {
        companyId: p.entry.companyId,
        askPrice: p.askPrice,
        priceComponent: b.priceComponent,
        qualityComponent: b.qualityComponent,
        differentiationComponent: b.differentiationComponent,
        relationshipComponent: b.relationshipComponent,
        deliveryComponent: b.deliveryComponent,
        salesBaseComponent: b.salesBaseComponent,
        nonPriceComponent: b.nonPriceComponent,
        reservationPrice: b.reservationPrice,
        reservationExcess: b.reservationExcess,
        reservationPenalty: b.reservationPenalty,
        utility: b.utility,
        normalizedWeight: wMap.get(p.entry.companyId) ?? 0,
        unconstrainedAllocation: tierUnconstrained,
        finalAllocation: tierFinal,
        reductionByCap: tierReduction,
      };
    });
    const externalUnconstrained = externalUnconstrainedByTier.get(tierId)!;
    const externalTierFinal = externalUnconstrained + inflow;
    externalFinal += externalTierFinal;
    tierDiagnostics.push({
      tier: tierId,
      tierDemand,
      tierShare: tier.demandShare,
      companies,
      external: {
        utility: externalUtilityByTier.get(tierId)!,
        normalizedWeight: externalWeightByTier.get(tierId)!,
        unconstrainedAllocation: externalUnconstrained,
        capRedistributionInflow: inflow,
        finalAllocation: externalTierFinal,
      },
    });
  }

  const companiesTotal = prepared.reduce((s, p) => s + (finalByCompany.get(p.entry.companyId) ?? 0), 0);
  const residual = companiesTotal + externalFinal - demand;

  // ---- 既存の出力型へ写す（新しいフィールドは足さない＝永続化に影響しない） ----
  const companies: CompanyAllocationEntry[] = prepared.map((p) => {
    const coverage = salesCoverageScore(p.entry.salesForceHeadcount, params);
    const askPriceUnit = usdPerHosoEqKg(p.askPrice);
    // competitivenessBreakdown は legacy と同じ関数で埋める（新方式では配分に使わないが、
    // 出力型の必須フィールドであり、UI・Export が読む既存の説明用データであるため）。
    const breakdown = computeCompetitivenessBreakdown(p.entry, askPriceUnit, basePrice, coverage, params);
    return {
      companyId: p.entry.companyId,
      askPrice: askPriceUnit,
      coverageScore: coverage,
      processingCapacity: hosoEqTons(Number.isFinite(p.salesCapacityCap) ? roundHosoEqTons(p.salesCapacityCap) : 0),
      // 【ENG-TIERED-MKT-1A】以前はここを 0 固定にしていたが、この値は表示専用ではなく
      // companyLab/runner.ts:1555 が computeAddressableDemand の分子として読む
      // **エンジン入力**である。0 のままだと addressable demand が
      // targetDemand × 0/(0+externalOptionWeight) = 0 へ潰れ、PD/VAP の供給圧力
      // （marketEvolution）が壊れる。
      // そこで「層需要で加重した正規化ウェイト（＝この会社が対象需要のうち
      // 何割を選好されたか）」を入れる。捏造値ではなく、新方式が実際に使った
      // 選択確率そのものの集約であり、全社合計 + 外部シェア = 1 になる。
      // 【scale の注意】legacy の competitivenessWeight（0〜1程度の合成競争力）とは
      // 定義が異なる。【ENG-TIERED-MKT-COMPAT-1 で解決済み】companyLab/runner.ts は
      // marketAllocationMode で分岐し、tiered では
      //   addressableDemand = targetDemand × Σ(この正規化ウェイト)
      // を用いる（legacy の w/(w+externalOptionWeight) を再適用すると外部を
      // 二重計上するため）。
      competitivenessWeight: aggregateWeightByCompany.get(p.entry.companyId) ?? 0,
      competitivenessBreakdown: breakdown,
      allocatedQuantity: hosoEqTons(roundHosoEqTons(Math.max(0, finalByCompany.get(p.entry.companyId) ?? 0))),
    };
  });

  return {
    result: {
      market,
      product,
      period,
      basePrice,
      targetDemand,
      companies,
      externalOptionQuantity: hosoEqTons(roundHosoEqTons(Math.max(0, externalFinal))),
    },
    diagnostics: {
      market,
      product,
      period,
      referencePrice: ref,
      targetDemand: demand,
      tiers: tierDiagnostics,
      companies: capDiagnostics,
      externalFinalAllocation: externalFinal,
      demandConservationResidual: residual,
    },
  };
}
