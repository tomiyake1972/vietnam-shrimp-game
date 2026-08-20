// ShrimpX V2 — Standard AI: physical production capacity（唯一の計算箇所）
//
// 【Phase 6D-1で確認された不一致の再発防止】
// 「実際に生産できる量」の算出が targetScale.ts・decision/newFactory.ts・policy.ts の
// 3箇所に別々に書かれていたため、将来どれか1箇所だけ変更されると値が食い違う
// リスクがあった（Phase 6D-1で実際に一度発生した不整合と同じ種類の事故）。
// 以後はこの1モジュールだけを唯一の情報源とする。
//
// 【Phase SAI-CAP-1・2026-08-20】ここに **冷凍・包装能力（freezingPackaging）** を追加した。
//
// 旧実装は min(商品別ライン合計, 共通前処理) であり、生産エンジンの制約段階のうち
// 段階3（冷凍・包装）が丸ごと抜けていた。生産エンジン production/allocation.ts の
// 実際の順序は
//
//   段階1 原料 →
//   段階2 共通前処理（**原料投入側**の上限。ここを通った量に歩留まりを掛けて完成品側へ変換）→
//   段階3 冷凍・包装（**完成品側**の上限）→
//   段階4 商品別ライン（完成品側）→
//   段階5 労働
//
// である（allocation.ts の commonProcessingRawAllocated → commonCapacityLimited →
// freezingPackagingLimited → productCapacityLimited の並び）。
//
// この欠落により、SAI-EXEC-1 監査（docs/v2/SAI_EXECUTION_BOTTLENECK_AUDIT.md）および
// #04 の DS3 能力監査の双方で、MASS の真のボトルネックが冷凍・包装（59,850t）であるにも
// かかわらず Standard AI は 63,270t（共通前処理）を上限と認識し続けていた。
// 結果として Deliverability の headroom が実行可能量より 35% 過大になり、
// 受注残が構造的に積み上がっていた。
//
// 【単位を混ぜない】共通前処理だけが原料投入側の量であるため、他の2プールと比較する前に
// **販売可能回収率（saleableRecoveryRatio）で完成品側へ換算**する。この換算は
// allocation.ts が段階2の直後に行っているものと同一の考え方であり、ここで新しい
// 歩留まりモデルを作らない。現行の saleableRecoveryRatio は全商品 1.0 のため、
// 換算後の値は換算前と一致する（＝この変更単体では挙動を変えない）。
//
// 【ここに混ぜないもの】労働力・原料・資金・営業能力は物理設備能力ではない。
// これらは既存どおり別 constraint（labor.ts / fundableOperations.ts / liquidity.ts /
// salesCapacity）として維持し、physicalFactoryCapacity へ合流させない。
//
// 【工場 lifecycle】能力値は必ず production/capacity.ts::calculateFactoryEffectiveCapacity
// を通った observation.totalEffective* / nearTermEffective* を受け取る。同関数は
// `factory.status !== "active"` の工場に対して全プール 0 を返すため、休止・売却等で
// 非稼働になった工場は構造的に集計へ入らない。**このモジュールは factory.status を
// 自前で判定しない**（Engine の lifecycle 判定を複製しないため。ENG-FAC-1 の
// MOTHBALLED / SOLD が導入された際も、canonical 関数側の変更だけで自動的に追従する）。

import { ProductAmount, sumProductAmount } from "./types";

/** 物理能力のうち、どのプールが律速しているか。 */
export type PhysicalCapacityPool = "PRODUCT_LINE" | "COMMON_PROCESSING" | "FREEZING_PACKAGING" | "TIED" | "NONE";

/**
 * 物理能力プールの入力。すべて **実効能力**（capex 反映後・稼働率／設備利用可能率適用後）
 * であること。名目能力を渡してはいけない。
 */
export interface PhysicalCapacityPools {
  /** 商品別ライン能力（完成品HOSO換算t/四半期）。 */
  readonly effectiveCapacityByProduct: ProductAmount;
  /** 共通前処理能力（**原料投入側** HOSO換算t/四半期）。 */
  readonly commonProcessingInputCapacityTons: number;
  /** 冷凍・包装処理能力（完成品HOSO換算t/四半期）。 */
  readonly freezingPackagingCapacityTons: number;
  /**
   * 販売可能回収率（商品別、0〜1）。共通前処理の原料投入側能力を完成品側へ換算するために使う。
   * production/parameters.ts の PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio を
   * そのまま渡すこと。省略時は 1.0（＝換算なし）とみなす。
   */
  readonly saleableRecoveryRatioByProduct?: Readonly<Partial<Record<keyof ProductAmount, number>>>;
  /**
   * 換算に使う商品構成の重み。省略時はライン能力の構成比を使う（能力構成＝その会社が
   * 物理的に作れる構成であり、追加の需要モデルを持ち込まない）。
   */
  readonly mixWeightByProduct?: ProductAmount;
}

export interface PhysicalCapacityAssessment {
  /** 商品別ライン能力の合計（完成品側）。 */
  readonly productLineCapacityTons: number;
  /** 共通前処理能力（原料投入側。換算前）。 */
  readonly commonProcessingInputCapacityTons: number;
  /** 共通前処理能力を販売可能回収率で完成品側へ換算した値。 */
  readonly commonProcessingSaleableCapacityTons: number;
  /** 冷凍・包装処理能力（完成品側）。 */
  readonly freezingPackagingCapacityTons: number;
  /** 3プールの最小値＝物理的に生産できる上限。 */
  readonly bindingPhysicalCapacityTons: number;
  /** どのプールが律速しているか。複数が同値なら TIED。 */
  readonly bindingPhysicalPool: PhysicalCapacityPool;
  /** 各プールが binding からどれだけ余裕を持っているか（プール値 − binding）。 */
  readonly headroomByPool: Readonly<Record<"PRODUCT_LINE" | "COMMON_PROCESSING" | "FREEZING_PACKAGING", number>>;
}

/** 同値判定の許容誤差。プール値は数万トン規模なので 1e-6 で十分。 */
const EPSILON = 1e-6;

const PRODUCTS = ["hoso", "pd", "vap"] as const;

/**
 * 共通前処理（原料投入側）を完成品側へ換算する際の、商品構成加重の販売可能回収率。
 * 重みが取れない場合は全商品の単純平均（現行はいずれも 1.0 なので同値）。
 */
function weightedRecoveryRatio(pools: PhysicalCapacityPools): number {
  const ratios = pools.saleableRecoveryRatioByProduct;
  if (!ratios) return 1;
  const weights = pools.mixWeightByProduct ?? pools.effectiveCapacityByProduct;
  let weightSum = 0;
  let weighted = 0;
  for (const p of PRODUCTS) {
    const w = Math.max(0, weights[p] ?? 0);
    if (w <= 0) continue;
    weightSum += w;
    weighted += w * (ratios[p] ?? 1);
  }
  if (weightSum > EPSILON) return weighted / weightSum;
  // 重みが全く無い（能力ゼロ）会社では構成比を決められない。平均で代替する。
  const sum = PRODUCTS.reduce((s, p) => s + (ratios[p] ?? 1), 0);
  return sum / PRODUCTS.length;
}

/**
 * 物理設備能力の唯一の評価関数。
 *
 * bindingPhysicalCapacityTons = min(
 *   Σ商品別ライン能力,
 *   共通前処理能力（原料投入側）× 販売可能回収率,
 *   冷凍・包装能力
 * )
 */
export function computePhysicalCapacity(pools: PhysicalCapacityPools): PhysicalCapacityAssessment {
  // 【観測できていないプールは律速にしない】値が有限でない（観測が無い）プールは
  // Infinity として扱い、min() から実質的に外す。NaN をそのまま伝播させると
  // bindingPhysicalCapacityTons が NaN になり、下流の Deliverability・CAPEX 判定が
  // 静かに壊れるため。production code は observation が必ず3プールとも埋めるので
  // ここが効くのは合成 observation を使うテストだけである。
  const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
  const productLine = finiteOr(sumProductAmount(pools.effectiveCapacityByProduct), Number.POSITIVE_INFINITY);
  const commonInput = finiteOr(pools.commonProcessingInputCapacityTons, Number.POSITIVE_INFINITY);
  const commonSaleable = commonInput * weightedRecoveryRatio(pools);
  const freezing = finiteOr(pools.freezingPackagingCapacityTons, Number.POSITIVE_INFINITY);

  const binding = Math.min(productLine, commonSaleable, freezing);

  const atBinding: PhysicalCapacityPool[] = [];
  if (productLine <= binding + EPSILON) atBinding.push("PRODUCT_LINE");
  if (commonSaleable <= binding + EPSILON) atBinding.push("COMMON_PROCESSING");
  if (freezing <= binding + EPSILON) atBinding.push("FREEZING_PACKAGING");

  const bindingPhysicalPool: PhysicalCapacityPool =
    atBinding.length === 0 ? "NONE" : atBinding.length > 1 ? "TIED" : atBinding[0];

  return {
    productLineCapacityTons: productLine,
    commonProcessingInputCapacityTons: commonInput,
    commonProcessingSaleableCapacityTons: commonSaleable,
    freezingPackagingCapacityTons: freezing,
    bindingPhysicalCapacityTons: binding,
    bindingPhysicalPool,
    headroomByPool: {
      PRODUCT_LINE: productLine - binding,
      COMMON_PROCESSING: commonSaleable - binding,
      FREEZING_PACKAGING: freezing - binding,
    },
  };
}

/**
 * 実際に生産できる上限（binding physical capacity）のスカラー版。
 *
 * 【SAI-CAP-1】第3引数 freezingPackagingCapacityTons は **必須**。省略可能にすると
 * 呼び出し側が冷凍・包装を渡し忘れても型検査を通ってしまい、今回修正したのと同じ
 * 「静かに過大評価する」不具合が再発するため、意図的に必須にしてある。
 */
export function computeBindingProductionCapacityTons(
  effectiveCapacityByProduct: ProductAmount,
  commonProcessingInputCapacityTons: number,
  freezingPackagingCapacityTons: number,
  saleableRecoveryRatioByProduct?: PhysicalCapacityPools["saleableRecoveryRatioByProduct"],
  mixWeightByProduct?: ProductAmount
): number {
  return computePhysicalCapacity({
    effectiveCapacityByProduct,
    commonProcessingInputCapacityTons,
    freezingPackagingCapacityTons,
    saleableRecoveryRatioByProduct,
    mixWeightByProduct,
  }).bindingPhysicalCapacityTons;
}
