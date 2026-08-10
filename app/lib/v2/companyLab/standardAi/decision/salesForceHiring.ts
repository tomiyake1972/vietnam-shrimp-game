// ShrimpX V2 — Standard AI 経営ボトルネック起点の営業採用・減員判断（新設）
//
// 【設計意図（三宅さんご指示）】単に「salesForceHireCountを付け足す」実装ではない。
// 営業採用を、
//   market opportunity → sales capacity → production capacity → Worker
//   → raw material → cash / borrowing capacity
// という連鎖の中で、1人ずつ（incremental）marginal economicsを確認しながら
// 判断する。marginal contribution（追加1人による貢献利益の増分）が
// salesperson salaryを上回り、かつ生産・Worker・原料・資金のいずれの制約にも
// ブロックされない場合にのみ採用候補にする。
//
// 【hard-code禁止（三宅さんご指示）】営業人員容量の式・パラメータ・商品別営業工数
// 係数は、必ず既存の共有モジュール（sales/salesForce.ts・sales/marketEffort.ts・
// sales/parameters.ts）をそのまま呼ぶ。#04が将来これらの値・式自体を変更しても
// （例: 飽和曲線から線形容量モデルへの変更）、本モジュールは一切変更せずに追随する
// （呼んでいる関数のシグネチャが変わらない限り）。同様に、営業人員給与
// （finance/parameters.ts）・退職金四半期数（finance/quarterClose.ts、現状は
// エクスポートされていないローカル定数のため、値だけを参照コメント付きで引用する。
// #04へ「共有定数としてexportする」ことを申し送る。§後述docs参照）も、
// #05側で新しい数値を発明しない。
//
// 【スコープ外（変更しないこと）】production decision・Worker decision（labor.ts）・
// raw procurement decision（procurement.ts）・finance decisionのロジック自体は
// 一切変更しない。本モジュールは「これらの既存モジュールが既に計算した結果
// （観測・診断値）を読むだけ」で営業採用/減員を判断する。

import { DemandMarketId, Product } from "../../../market/types";
import { hosoEqTons, unwrapUnit } from "../../../core/units";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { allocateHeadcountAcrossMarkets, computeMarketSalesEffort, salesEffortWeightedQuantity } from "../../../sales/marketEffort";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry, StandardAiReasonCode } from "../reasonCodes";
import { applySalesHireRampLimit } from "../../salesForceHiring";
import { SalesWishEntry } from "./sales";
import { StandardAiUnitEconomicsResult } from "../diagnosis/forwardUnitEconomics";
import { TargetScaleBand } from "../targetScale";

const EPSILON = 1e-6;
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * 【#04へ申し送り】finance/quarterClose.tsのSALES_FORCE_SEVERANCE_QUARTERS（値=2）は
 * ローカル定数でexportされていないため、ここでは値を直接引用するのではなく、
 * この定数をfinance/parameters.ts（FINANCE_PARAMETERS_V1）へ共有定数として
 * 追加exportしてもらうことを推奨する。現時点では#04コードのコメント上の値（2四半期分）
 * を根拠を明示した上で参照する（推測ではなく実際のコード値の引用）。
 */
const SALES_FORCE_SEVERANCE_QUARTERS_REFERENCE = 2; // 根拠: app/lib/v2/finance/quarterClose.ts:945

/** 1人分の営業人員採用/減員の増分評価（marginal economics）。 */
export interface MarginalSalespersonEvaluation {
  readonly direction: "hire" | "layoff";
  readonly headcountBefore: number;
  readonly headcountAfter: number;
  /** その1人による、商品別の受注量変化（HOSO換算トン。hireなら正、layoffなら負を絶対値で保持し方向はdirectionで表す）。 */
  readonly incrementalSalesTonsByProduct: ProductAmount;
  readonly incrementalSalesTonsTotal: number;
  /** 既存完成品在庫（FG）で賄える増分（追加生産不要な部分）。 */
  readonly incrementalSalesCoveredByExistingFgTons: number;
  /** 既存FGで賄えず、追加生産が必要になる部分。 */
  readonly incrementalSalesRequiringNewProductionTons: number;
  readonly incrementalContributionMarginUsd: number | null;
  readonly salespersonQuarterlySalaryUsd: number;
  readonly marginalContributionAfterSalesSalaryUsd: number | null;
  readonly productionHeadroomSufficient: boolean;
  readonly rawMaterialPathUncertain: boolean;
  readonly liquidityAfterHiringUsd: number | null;
  readonly liquidityOk: boolean;
  /** 生産・原料・資金・経済性のいずれの制約にも達しない、「必要な将来営業能力」の一部として正当化されたかどうか。 */
  readonly accepted: boolean;
  /**
   * acceptedはtrueだが、営業組織の増員速度制約（ゲーム共通ルール
   * computeMaxSalesHiresPerQuarter）により、今四半期の実際の採用数には含まれず、
   * 次四半期以降へ繰り越された候補。
   */
  readonly deferredByOrganizationalRamp?: boolean;
  /** acceptedがfalseの場合、その理由コード（受理された場合はundefined）。 */
  readonly blockedReasonCode?:
    | "SALES_HIRING_NOT_ECONOMIC"
    | "SALES_HIRING_BLOCKED_BY_PRODUCTION"
    | "SALES_HIRING_BLOCKED_BY_LIQUIDITY"
    | "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY"
    | "SALES_HIRING_LIMITED_BY_TARGET_SCALE"
    | "SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION";
}

/**
 * 【Phase 6C・#05 §6】営業採用判断の構造化記録。
 *
 * Phase 6B の監査で「required > current なのに採用0、しかも理由コードが1件も無い」
 * 会社×四半期が29件見つかった。人数だけを見て理由を推測させないため、
 * 「何人必要で、経済的には何人欲しくて、組織上・資金上は何人まで許され、
 * 結局何人採ったのか」を毎四半期かならず残す。
 *
 * **採用0のときは必ず zeroHireReason が入る**（不明のまま黙って0にしない）。
 */
export interface SalesHiringDiagnosticsRecord {
  /** 現在の稼働営業人員（前期末までに確定した人数）。 */
  readonly currentHeadcount: number;
  /** 今期の販売希望を営業工数制約なしで捌くのに必要な人数（目標販売量からの逆算）。 */
  readonly requiredHeadcount: number;
  /** 経済合理性だけで決めた場合に欲しい総人数（組織・資金の上限を掛ける前）。 */
  readonly unconstrainedEconomicDesiredHeadcount: number;
  /** 組織の吸収能力（1四半期の増員上限）を適用した後に到達できる総人数。 */
  readonly organizationallyAllowedHeadcount: number;
  /** 資金余力（最低現金バッファ）で許される総人数。 */
  readonly financiallyAllowedHeadcount: number;
  /** 実際に目標とした総人数。 */
  readonly actualTargetHeadcount: number;
  /** 今期実際に採用した人数。 */
  readonly actualHireCount: number;
  /** 今期実際に減員した人数。 */
  readonly actualLayoffCount: number;
  /** 営業組織が捌ける案件量（工数トン）と、そのうち実際に使った量。 */
  readonly salesCapacityTons: number;
  readonly usedSalesCapacityTons: number;
  /** 採用0だった場合の理由（0でなければ null）。 */
  readonly zeroHireReason: StandardAiReasonCode | null;
}

export interface SalesForceHiringDecisionResult {
  /** 今四半期に実際へ反映する採用数（組織吸収能力の上限を適用した後）。 */
  readonly salesForceHireCount: number;
  readonly salesForceLayoffCount: number;
  /**
   * 生産・原料・資金・経済性のいずれの制約にも達しない、「必要な将来営業能力」
   * （Target Sales Force）。currentHeadcount + targetSalesForceHeadcountGap。
   * salesForceHireCountはこの目標に対する今四半期の反映分（ガバナー適用後）であり、
   * 目標そのものではない（目標 > 反映分の場合、残りは次四半期以降に繰り越される）。
   */
  readonly targetSalesForceHeadcount: number;
  /** 【Phase 6C・#05 §6】採用判断の構造化記録（採用0でも必ず理由が入る）。 */
  readonly hiringDiagnostics: SalesHiringDiagnosticsRecord;
  readonly evaluations: readonly MarginalSalespersonEvaluation[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

/**
 * 【2026-08-05修正・三宅さんレビュー反映】旧設計では「1回の判断で極端な人数を
 * 動かさない」ための安全上限を「現在の（既に増員済みの）営業人員数」に対する
 * 相対値としていた。これは実際には安全上限として機能せず、採用が起きるたびに
 * 次の四半期の上限自体も膨張する複利成長の式になっていた（8Qシミュレーションで
 * 18→27→41→62→93→140人という指数的増加が実際に発生し、三宅さんより
 * 「バグというより設計通り暴走した」とご指摘を受けた）。
 *
 * 修正方針（三宅さんご指示）:
 *   1) まず生産・原料・資金いずれの制約にも達しないマージナル経済性の
 *      自然停止点まで評価し、「必要な将来営業能力（Target Sales Force）」を
 *      先に計算する。
 *   2) 必要人数 − 現在人数 = 採用必要数（不足分）を求める。
 *   3) 1四半期に実際へ反映する人数の上限（ガバナー）は、「その四半期ごとに
 *      膨張する現在人数」ではなく、会社の静的な基準規模
 *      （fixture.salesForceHeadcountTotal、会社設立時の値でターンをまたいでも
 *      変わらない）に対する相対値とする。これにより採用が起きても次四半期の
 *      ガバナー自体は膨張せず、複利成長を構造的に排除する。
 */
/**
 * 【2026-08-08・ゲーム共通ルールへの置換】上記の静的な会社規模ベースのガバナー
 * （max(5, 静的基準規模 × 50%)。BALなら 18 × 0.5 = 9人）は **廃止した**。
 *
 * 理由:
 *   ・あれはStandard AI内部だけの自制であり、人間プレイヤーには適用されなかった。
 *     同じゲームで主体によって増員速度が違うのは、ゲームルールとして一貫していない。
 *   ・基準が「会社設立時の静的な規模」だったため、会社が実際に成長しても
 *     1四半期の増員上限が永久に変わらなかった（74人になっても上限9人のまま）。
 *
 * 置換後は salesForceHiring.ts（ゲーム共通ロジック）の
 * computeMaxSalesHiresPerQuarter = max(3, ceil(現在の稼働人員 × 30%)) を使う。
 * Standard AI側でこの式を再実装しない（Single Source of Truth）。
 * 二重制限を避けるため、旧ガバナーは残していない。
 */


/**
 * マージナル経済性ループ自体の反復回数上限。ビジネス上の意思決定ガバナーでは
 * なく、純粋な暴走防止のための機械的セーフガード（万一のロジック不具合で
 * 無限ループにならないための安全弁）。実際の停止は、A（機会消滅）・
 * D（非経済的）・E（生産余力超）・G（原料供給制約）・H（資金バッファ超）の
 * いずれかの自然な停止条件で先に発生する想定。
 */
const NATURAL_STOP_SAFETY_ITERATION_CEILING = 2000;

/** 会社×市場×商品の希望量マップ（salesWishByMarketProductから再構成）。 */
function buildWishMap(salesWish: readonly SalesWishEntry[]): Map<DemandMarketId, Record<Product, number>> {
  const map = new Map<DemandMarketId, Record<Product, number>>();
  for (const w of salesWish) {
    const key = w.market;
    if (!map.has(key)) map.set(key, { hoso: 0, pd: 0, vap: 0 });
    map.get(key)![w.product] = w.desiredQuantityBeforeEffortConstraint;
  }
  return map;
}

/**
 * ある総営業人員数(headcount)における、市場別の営業工数配分と、
 * effort容量制約を適用した後の商品別realistic sales合計を計算する。
 * sales/marketEffort.tsの既存関数（エンジン本体・decision/sales.tsと同一の
 * 純粋関数）をそのまま呼ぶだけであり、飽和曲線・effort係数のいずれも
 * 本モジュールでは再実装しない（#04が値・式を変更しても自動的に追随する）。
 */
function realisticSalesAtHeadcount(
  headcount: number,
  wishByMarket: ReadonlyMap<DemandMarketId, Record<Product, number>>,
  salesParams: SalesParameters
): ProductAmount {
  const effortDemandByMarket = new Map<DemandMarketId, number>();
  for (const [market, byProduct] of wishByMarket) {
    effortDemandByMarket.set(market, salesEffortWeightedQuantity(byProduct, salesParams));
  }
  const headcountByMarket = allocateHeadcountAcrossMarkets(headcount, effortDemandByMarket);
  const total: ProductAmount = { hoso: 0, pd: 0, vap: 0 };
  for (const [market, byProduct] of wishByMarket) {
    const h = headcountByMarket.get(market) ?? 0;
    const result = computeMarketSalesEffort(h, byProduct, salesParams);
    for (const p of PRODUCTS) total[p] += result.adjustedQuantityByProduct[p];
  }
  return total;
}

/** Forward Unit Economicsから、商品別の「参考貢献利益（USD/トン）」を導出する（市場をまたいだ単純平均。null=採算不明）。 */
function averageContributionMarginUsdPerTonByProduct(unitEconomics: StandardAiUnitEconomicsResult): Readonly<Record<Product, number | null>> {
  const hosoEqKgPerTon = PRODUCTION_PARAMETERS_V1.cost.hosoEqKgPerTon;
  const sums: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  const counts: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const e of unitEconomics.entries) {
    if (e.contributionMarginUsdPerKg === null) continue;
    sums[e.product] += e.contributionMarginUsdPerKg * hosoEqKgPerTon;
    counts[e.product] += 1;
  }
  const result: Record<Product, number | null> = { hoso: null, pd: null, vap: null };
  for (const p of PRODUCTS) {
    result[p] = counts[p] > 0 ? sums[p] / counts[p] : null;
  }
  return result;
}

export interface SalesForceHiringDecisionInput {
  readonly fixture: CompanyFixture;
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly params: StandardAiParameters;
  readonly salesParams: SalesParameters;
  readonly salesWishByMarketProduct: readonly SalesWishEntry[];
  /** 現在の営業人員数での基本当期生産必要量（productionRequirement.ts、既に計算済みの値をそのまま受け取る）。 */
  readonly finalProductionRequirementByProduct: ProductAmount;
  /** Standard AIが現在認識できる生産能力（binding capacity相当。situationDiagnosis.tsのbindingCapacityTotal系と同じ考え方）。 */
  readonly totalEffectiveCapacityByProduct: ProductAmount;
  readonly unitEconomics: StandardAiUnitEconomicsResult;
  /**
   * 追加原料調達の確実性（situationDiagnosis.rawMaterialSupplyConstraintStateを
   * そのまま渡す）。"shortage"なら「真の供給制約」であり、増産を前提とした
   * 採用を積極的にブロックする。"unknown"なら断定せず、警告のみに留める
   * （§憶測しない、という本セッション全体の原則を維持）。
   */
  readonly rawMaterialSupplyConstraintState: "shortage" | "balanced" | "surplus" | "unknown";
  /**
   * 【2026-08-05新設・三宅さんご指示】Target Sales Force算定の中心をmarginal-positive
   * loopから、「Target Scaleに必要な営業能力に対して何人不足しているか」へ移す。
   * targetScale.tsで算定したTarget Scale Band（8期程度先の会社像。市場精密予測では
   * ない）を受け取り、min(strategic target scale, production-supported scale)を
   * 販売量の上限として使う（market opportunity側の上限は、既存のwishベースの
   * realisticSalesAtHeadcountが自然に飽和するため、ここでは別途キャップしない）。
   */
  readonly targetScaleBand: TargetScaleBand;
  /**
   * 4Q以内に稼働見込みの自社設備投資案件があるか（targetCapability.ts算出）。
   * trueの場合、現在の生産能力を超えてもTarget Scale（max）までの営業採用の
   * 先行を許容する（三宅さんご指示§14）。falseの場合は現在の実効生産能力を
   * 販売量上限のキャップとして使い、production_capacity_gapとして診断する。
   */
  readonly hasNearTermCapexUnderConstruction: boolean;
  /**
   * 【Phase 6】今期目指す販売規模（Commercial Ambition）。
   * 未指定なら従来どおり TargetScaleBand だけで目標を決める。
   */
  readonly commercialAmbitionTons?: number;
}

/**
 * 営業人員の採用/減員を、1人ずつのmarginal economics評価で決定する
 * （純粋関数。副作用なし、同一入力なら常に同一出力）。
 */
export function buildStandardAiSalesForceHiringDecision(input: SalesForceHiringDecisionInput): SalesForceHiringDecisionResult {
  const {
    fixture,
    observation,
    pressures,
    salesParams = SALES_PARAMETERS_V1,
    salesWishByMarketProduct,
    finalProductionRequirementByProduct,
    totalEffectiveCapacityByProduct,
    unitEconomics,
    rawMaterialSupplyConstraintState,
    targetScaleBand,
    hasNearTermCapexUnderConstruction,
    commercialAmbitionTons,
    params,
  } = input;

  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const evaluations: MarginalSalespersonEvaluation[] = [];

  const wishByMarket = buildWishMap(salesWishByMarketProduct);
  const currentHeadcount = observation.salesForceHeadcountTotal;
  const contributionPerTon = averageContributionMarginUsdPerTonByProduct(unitEconomics);
  const salaryUsdPerQuarter = FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter;
  const severanceUsdPerPerson = SALES_FORCE_SEVERANCE_QUARTERS_REFERENCE * salaryUsdPerQuarter;

  // 生産余力（既存の当期生産必要量に対する、実行可能な生産上限の余り）。
  // 負の場合は既に生産が詰まっている（余力なし）ことを意味する。
  const productionHeadroomByProduct: ProductAmount = {
    hoso: totalEffectiveCapacityByProduct.hoso - finalProductionRequirementByProduct.hoso,
    pd: totalEffectiveCapacityByProduct.pd - finalProductionRequirementByProduct.pd,
    vap: totalEffectiveCapacityByProduct.vap - finalProductionRequirementByProduct.vap,
  };

  // 資金余力（§13）。簡易版: 現金 − 最低現金バッファ − これまでの追加採用による
  // 累積年間人件費相当（四半期給与×採用数。将来四半期分は今回のスコープでは
  // 簡略化し、当四半期分の給与増分のみで判定する。より厳密な多四半期キャッシュ
  // フロー投影はFinancial Capacity診断モジュール（診断専用）と併用することを
  // #04/#05引き続きの課題として明記する）。
  let cumulativeAddedSalaryUsd = 0;
  const liquidityFloorUsd = observation.cashUsd - pressures.targetMinimumCashUsd;

  const currentFg = observation.finishedGoodsByProduct;
  // 【2026-08-05修正】ここは「今四半期に反映してよい上限」ではなく、マージナル
  // 経済性ループが自然停止条件（A/D/E/G/H）へ到達するまで評価を続けるための
  // 純粋な暴走防止セーフガード。Target Sales Force（必要な将来営業能力）を
  // 現在人数の大小に関わらず正しく計算するため、ここで打ち切ってはならない。
  const naturalStopCeiling = NATURAL_STOP_SAFETY_ITERATION_CEILING;

  // 【2026-08-05新設・三宅さんご指示】Target Sales Volume（販売量ベースの上限）。
  // min(strategic target scale, production-supported scale)を使う。市場機会側の
  // 上限は、realisticSalesAtHeadcountがwish（希望量）で自然に飽和するため、
  // ここで別途キャップしない（§12「min(strategic target scale, realistic
  // obtainable market opportunity, production-supported sales scale)」のうち、
  // market opportunity項は既存のwish飽和メカニズムがそのまま担う）。
  const effectiveCapacityTons = PRODUCTS.reduce((s, p) => s + totalEffectiveCapacityByProduct[p], 0);
  const productionSupportedScaleTons = hasNearTermCapexUnderConstruction ? targetScaleBand.quarterlySalesTons.max : effectiveCapacityTons;
  // 【Phase 6・§26】Vision 由来の Commercial Ambition を営業採用の目標へ届ける。
  //
  // 【なぜ必要か】監査では、営業採用の目標が
  //   min(TargetScaleBand.max, 実効生産能力)
  // であり、TargetScaleBand 自体も実効能力から導かれていたため、
  // 「能力 → 販売希望 → 営業人数 → 生産 → 能力」の循環が閉じていた。
  //
  // 【Vision だけで大量採用しない】ambition は observable な採算つき機会と
  // 段階的成長で既に抑制されており（vision/commercialAmbition.ts）、さらにここでも
  // **生産能力（productionSupportedScaleTons）を超えない**。作れない量を売るための
  // 営業は採らない。1人ずつの限界採算評価・資金ゲート・採用ガバナーも従来どおり効く。
  const strategicTargetTons = Math.max(targetScaleBand.quarterlySalesTons.max, commercialAmbitionTons ?? 0);
  const targetSalesVolumeTons = Math.min(strategicTargetTons, productionSupportedScaleTons);
  const cappedByProductionNotStrategicTarget = productionSupportedScaleTons < targetScaleBand.quarterlySalesTons.max;

  // --- 採用方向（+1ずつ、自然停止条件まで評価し、Target Sales Forceを求める） ---
  let hireCount = 0;
  let salesAtCurrent = realisticSalesAtHeadcount(currentHeadcount + hireCount, wishByMarket, salesParams);

  // 【営業能力の実測と未使用量（2026-08-08・指示6）】
  // 能力式は realisticSalesAtHeadcount（既存のsales capability計算）をそのまま使う。
  // 診断用に能力式を再実装しない（Single Source of Truth）。
  //
  //   totalSalesCapacity … 現在の営業人員が売り切れる量
  //   usedSalesCapacity  … そのうち実際に販売計画（wish）で使っている量
  //   unusedSalesCapacity… 使い切れていない営業能力
  //
  // 「営業人数だけ増えて成約が伸びない」状態を後から機械的に検出するための一次情報。
  const currentSalesCapacityTons = salesAtCurrent.hoso + salesAtCurrent.pd + salesAtCurrent.vap;
  const totalWishTons = [...wishByMarket.values()].reduce(
    (sum, byProduct) => sum + PRODUCTS.reduce((s, p) => s + (byProduct[p] ?? 0), 0),
    0
  );
  // 販売計画は営業能力を超えられないため、使用量は能力で頭打ちにする。
  const usedSalesCapacityTons = Math.min(currentSalesCapacityTons, totalWishTons);
  const unusedSalesCapacityTons = Math.max(0, currentSalesCapacityTons - usedSalesCapacityTons);
  diagnostics.push({
    code: "SALES_CAPACITY_UTILIZATION",
    domain: "sales",
    companyId: fixture.companyId,
    severity: "info",
    keyValues: {
      currentHeadcount,
      totalSalesCapacityTons: currentSalesCapacityTons,
      usedSalesCapacityTons,
      unusedSalesCapacityTons,
      salesCapacityUtilization: currentSalesCapacityTons > EPSILON ? usedSalesCapacityTons / currentSalesCapacityTons : 0,
      totalDesiredSalesTons: totalWishTons,
    },
    message:
      `営業人員${currentHeadcount}人の販売能力は約${Math.round(currentSalesCapacityTons)}t/期。` +
      `販売計画で使っているのは約${Math.round(usedSalesCapacityTons)}t（稼働率` +
      `${currentSalesCapacityTons > EPSILON ? Math.round((usedSalesCapacityTons / currentSalesCapacityTons) * 100) : 0}%）、` +
      `未使用は約${Math.round(unusedSalesCapacityTons)}t。`,
  });
  let stoppedByTargetScaleCeiling = false;
  for (let i = 0; i < naturalStopCeiling; i++) {
    // Target Sales Volume（Target Scale帯・production-supported scaleの小さい方）に
    // 既に到達している場合、限界利益が正であってもこれ以上は採用しない
    // （三宅さんご指示§9「まず『何人必要か』→その範囲内でmarginal economicsを確認」。
    // 逆順にしない、という明示的な指示への対応。市場機会飽和による自然停止（A）とは
    // 独立した、Target Scale側からの上限）。
    const currentTotal = salesAtCurrent.hoso + salesAtCurrent.pd + salesAtCurrent.vap;
    if (currentTotal >= targetSalesVolumeTons - EPSILON) {
      stoppedByTargetScaleCeiling = true;
      break;
    }

    const before = currentHeadcount + hireCount;
    const after = before + 1;
    const salesAfter = realisticSalesAtHeadcount(after, wishByMarket, salesParams);

    const incrementalByProduct: ProductAmount = {
      hoso: Math.max(0, salesAfter.hoso - salesAtCurrent.hoso),
      pd: Math.max(0, salesAfter.pd - salesAtCurrent.pd),
      vap: Math.max(0, salesAfter.vap - salesAtCurrent.vap),
    };
    const incrementalTotal = incrementalByProduct.hoso + incrementalByProduct.pd + incrementalByProduct.vap;

    if (incrementalTotal <= EPSILON) {
      // A. profitable unserved opportunityが消滅（希望量に対し既に容量が十分足りている）。
      break;
    }

    // 既存FGで賄える分／新規生産が必要な分を分離（§8・§9・Turn3在庫優先ロジック）。
    let coveredByFg = 0;
    let requiringNewProduction = 0;
    for (const p of PRODUCTS) {
      const fgAvailableForThis = Math.max(0, currentFg[p]); // 簡略化: 他の増分と共有せず、各評価ステップで独立に参照（1人単位の小さな増分のため、FG取り合いの誤差は小さいと判断）。
      const covered = Math.min(incrementalByProduct[p], fgAvailableForThis);
      coveredByFg += covered;
      requiringNewProduction += incrementalByProduct[p] - covered;
    }

    // 経済性（marginal contribution after salary）。
    let incrementalContribution: number | null = 0;
    let hasUnknownContribution = false;
    for (const p of PRODUCTS) {
      const perTon = contributionPerTon[p];
      if (incrementalByProduct[p] <= EPSILON) continue;
      if (perTon === null) {
        hasUnknownContribution = true;
        continue; // 採算不明分は貢献利益に加算しない（憶測しない。保守的に0扱い）。
      }
      incrementalContribution = (incrementalContribution ?? 0) + perTon * incrementalByProduct[p];
    }
    if (hasUnknownContribution && incrementalContribution === 0) incrementalContribution = null;
    const marginalAfterSalary = incrementalContribution === null ? null : incrementalContribution - salaryUsdPerQuarter;

    if (marginalAfterSalary === null || marginalAfterSalary <= EPSILON) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_NOT_ECONOMIC",
      });
      break; // D. marginal contribution <= cost（これ以上増やしても経済的に非合理）。
    }

    // 生産余力チェック（§5-E・§10・§17）。既存FGで賄える分は生産不要のため対象外。
    // 【簡略化・明示】商品別の生産余力を厳密に商品ごとに追跡せず、会社全体の
    // 生産余力合計（余力がある商品の合計）に対して、新規生産が必要な増分の合計を
    // 比較する単純化を採用している。商品別の生産余力が偏っている場合（例:
    // HOSOには余力があるがVAPには無い）、この単純化は実際より緩い判定になりうる
    // ことを設計上の既知の制約として明示する（#05引き続きの精緻化課題）。
    const productionHeadroomTotal = PRODUCTS.reduce((s, p) => s + Math.max(0, productionHeadroomByProduct[p]), 0);
    const blockedByProduction = requiringNewProduction > productionHeadroomTotal + EPSILON;

    if (blockedByProduction) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: false,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_BLOCKED_BY_PRODUCTION",
      });
      break; // E. 「営業を増やしてもproductionが完全に詰まっている」状態（三宅さんご指示§4）。
    }

    // 原料供給の確実性チェック（§4-G・§12）。真の供給制約（"shortage"）が既に
    // 診断されている場合のみブロックする。"unknown"では断定せず、警告のみに留める
    // （既存のRAW_MATERIAL_SUPPLY_CONSTRAINT_UNKNOWN診断の設計方針を継承）。
    const rawBlocked = requiringNewProduction > EPSILON && rawMaterialSupplyConstraintState === "shortage";
    if (rawBlocked) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: true,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY",
      });
      break;
    }

    // 資金余力チェック（§13）。当四半期の追加給与コストの累積が、現金の
    // 最低バッファ余力を超えないか（簡略化した単四半期判定。多四半期の
    // キャッシュタイミングは今回のスコープでは近似しない＝#04/#05引き続きの課題）。
    const liquidityAfter = liquidityFloorUsd - (cumulativeAddedSalaryUsd + salaryUsdPerQuarter);
    if (liquidityAfter < 0) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: liquidityAfter,
        liquidityOk: false,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_BLOCKED_BY_LIQUIDITY",
      });
      break; // H. liquidityが危険水準（三宅さんご指示§4-H・§13）。
    }

    // すべてのゲートを通過 → この1人を採用候補として受理し、次の+1へ進む。
    cumulativeAddedSalaryUsd += salaryUsdPerQuarter;
    hireCount += 1;
    salesAtCurrent = salesAfter;
    evaluations.push({
      direction: "hire",
      headcountBefore: before,
      headcountAfter: after,
      incrementalSalesTonsByProduct: incrementalByProduct,
      incrementalSalesTonsTotal: incrementalTotal,
      incrementalSalesCoveredByExistingFgTons: coveredByFg,
      incrementalSalesRequiringNewProductionTons: requiringNewProduction,
      incrementalContributionMarginUsd: incrementalContribution,
      salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
      marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
      productionHeadroomSufficient: true,
      rawMaterialPathUncertain: false,
      liquidityAfterHiringUsd: liquidityAfter,
      liquidityOk: true,
      accepted: true,
      blockedReasonCode: undefined,
    });
  }

  // hireCountはここまでで、生産・原料・資金・経済性いずれの制約にも達しない
  // 「必要な将来営業能力」（Target Sales Force）の不足分＝targetGapである。
  const targetGap = hireCount;
  const targetSalesForceHeadcount = currentHeadcount + targetGap;

  // 【2026-08-05修正】1四半期に実際へ反映する人数は、targetGapそのものではなく、
  // 会社の静的な基準規模に対するガバナー上限でキャップする。上限を超えた分は
  // 「今四半期は反映しない（次四半期以降に繰り越し。次四半期はその時点の新しい
  // wish/observationで target を再計算するため、単純な繰り越しキューではない）」
  // として扱う。
  // 【Economic Desired Hiring → Organizational Ramp Constraint → Actual Hiring】
  // targetGapは経済合理性（marginal contribution・生産余力・原料・資金）だけで
  // 決まった希望採用数。そこへゲーム共通の組織吸収能力の上限を掛ける。
  // 基準は「会社設立時の静的規模」ではなく「現在の稼働営業人員」である。
  const ramp = applySalesHireRampLimit(currentHeadcount, targetGap);
  const organizationalHireLimit = ramp.limit;
  const hireCountThisQuarter = ramp.actualHireCount;
  const deferredCount = ramp.deferredCount;

  // 採用方向の評価一覧のうち、ガバナー上限を超えた分（acceptedだが今四半期は
  // 反映しない候補）にdeferredByOrganizationalRampを付与する。
  let acceptedSeen = 0;
  for (const evalEntry of evaluations) {
    if (evalEntry.direction !== "hire" || !evalEntry.accepted) continue;
    acceptedSeen += 1;
    if (acceptedSeen > hireCountThisQuarter) {
      (evalEntry as { deferredByOrganizationalRamp?: boolean }).deferredByOrganizationalRamp = true;
    }
  }

  hireCount = hireCountThisQuarter;

  if (targetGap > 0) {
    diagnostics.push({
      code: "SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        economicallyDesiredHireCount: targetGap,
        economicallyDesiredTotalHeadcount: targetSalesForceHeadcount,
        organizationalHireLimit,
        actualHireCount: hireCountThisQuarter,
        deferredByOrganizationalRamp: deferredCount,
        targetSalesForceHeadcount,
        currentHeadcount,
        // 【なぜその人数なのか（2026-08-08追加）】
        // 目標人数は「目標販売量を売り切るのに何人必要か」から逆算される。
        // その2つの入力値を必ず一緒に残す（後から人数だけ見て理由を推測させない）。
        currentSalesCapacityTons: currentSalesCapacityTons,
        targetSalesVolumeTons,
        unusedSalesCapacityTons: unusedSalesCapacityTons,
        // 目標販売量がどちらの上限で決まったか（生産能力か戦略Target Scaleか）。
        productionSupportedScaleTons,
        targetScaleMaxTons: targetScaleBand.quarterlySalesTons.max,
        cappedByProduction: cappedByProductionNotStrategicTarget ? 1 : 0,
      },
      decisionSummary:
        deferredCount > 0
          ? `Target Sales Force ${targetSalesForceHeadcount}人（不足${targetGap}人）のうち、今四半期は${hireCountThisQuarter}人を採用（${deferredCount}人は次四半期以降へ繰り越し）`
          : `Target Sales Force ${targetSalesForceHeadcount}人へ向け、営業${hireCountThisQuarter}人の新規採用を提案`,
      message:
        deferredCount > 0
          ? `収益性のある未充足の販売機会があり、必要な将来営業能力（Target Sales Force）は${targetSalesForceHeadcount}人（現在${currentHeadcount}人比+${targetGap}人）と評価されたが、営業組織が1四半期に吸収できる人数の上限（現在${currentHeadcount}人の30%＝${organizationalHireLimit}人）により、今四半期は${hireCountThisQuarter}人までに抑え、残り${deferredCount}人は次四半期以降の再評価に委ねる。`
          : `収益性のある未充足の販売機会があり、必要な将来営業能力（Target Sales Force）${targetSalesForceHeadcount}人まではmarginal contributionが給与を上回り、生産・原料・資金のいずれのボトルネックにも達しないため、営業${hireCountThisQuarter}人の新規採用を提案する。`,
    });
  }
  const lastEval = evaluations[evaluations.length - 1];
  if (lastEval && lastEval.direction === "hire" && !lastEval.accepted) {
    const codeToMessage: Record<string, string> = {
      SALES_HIRING_NOT_ECONOMIC: "これ以上の営業採用は、追加1人あたりのmarginal contributionが給与を下回るため経済的でない。",
      SALES_HIRING_BLOCKED_BY_PRODUCTION: "販売機会はあるが、生産能力（binding capacity）に余力がないため、これ以上の営業採用を見送る。",
      SALES_HIRING_BLOCKED_BY_LIQUIDITY: "追加採用の給与コストが、当期の最低現金バッファ余力を超えるため、これ以上の営業採用を見送る。",
      SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY: "追加販売には新規生産（＝追加原料）が必要だが、真の原料供給制約が診断されているため、これ以上の営業採用を見送る。",
    };
    diagnostics.push({
      code: lastEval.blockedReasonCode ?? "SALES_HIRING_NOT_ECONOMIC",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { targetSalesForceHeadcount, hireCountThisQuarter },
      message: codeToMessage[lastEval.blockedReasonCode ?? "SALES_HIRING_NOT_ECONOMIC"],
    });
  }

  // 【2026-08-05新設】ループがTarget Sales Volumeの上限（Target Scale帯または
  // production-supported scaleの小さい方）に到達して自然停止した場合、その旨を
  // 診断として明示する（三宅さんご指示§28のreason code）。
  if (stoppedByTargetScaleCeiling) {
    if (cappedByProductionNotStrategicTarget) {
      diagnostics.push({
        code: "SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { targetSalesForceHeadcount, productionSupportedScaleTons, targetScaleMaxTons: targetScaleBand.quarterlySalesTons.max },
        message: `Target Scale（max ${Math.round(
          targetScaleBand.quarterlySalesTons.max
        )}t/期）自体には届いていないが、現在の生産能力（稼働中の設備投資も無い）が${Math.round(
          productionSupportedScaleTons
        )}t/期にとどまるため、営業採用をこれ以上Target Scale方向へ進めることを見送る（production capacity gapが先に解消されるべき）。`,
      });
    } else {
      diagnostics.push({
        code: "SALES_HIRING_LIMITED_BY_TARGET_SCALE",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { targetSalesForceHeadcount, targetSalesVolumeTons },
        message: `Target Scale帯の上限相当の販売量（約${Math.round(
          targetSalesVolumeTons
        )}t/期）に既に達しているため、追加1人の限界利益が正であってもこれ以上の営業採用は提案しない（会社が目指す規模を超えて無意味に増員しないため）。`,
      });
    }
  }

  // 【2026-08-05新設】現在の営業人員数が実現する販売量が、Target Scale帯の
  // どこにあるか（不足/範囲内/過剰）を診断する（三宅さんご指示§24「現在38人が
  // Target Scaleから見て不足/適正/過剰のどれか」）。
  {
    const currentSalesVolumeTons = (() => {
      const s = realisticSalesAtHeadcount(currentHeadcount, wishByMarket, salesParams);
      return s.hoso + s.pd + s.vap;
    })();
    const band = targetScaleBand.quarterlySalesTons;
    const tolerance = params.targetScaleWithinBandTolerance;
    const minWithTolerance = band.min * (1 - tolerance);
    const maxWithTolerance = band.max * (1 + tolerance);
    let code: "SALES_CAPACITY_BELOW_TARGET_SCALE" | "SALES_CAPACITY_WITHIN_TARGET_BAND" | "SALES_CAPACITY_ABOVE_TARGET_SCALE";
    let message: string;
    if (currentSalesVolumeTons < minWithTolerance) {
      code = "SALES_CAPACITY_BELOW_TARGET_SCALE";
      message = `現在の営業人員（${currentHeadcount}人）が実現する販売量（約${Math.round(
        currentSalesVolumeTons
      )}t/期）は、Target Scale帯（${Math.round(band.min)}〜${Math.round(band.max)}t/期）のminを下回っている（不足）。`;
    } else if (currentSalesVolumeTons > maxWithTolerance) {
      code = "SALES_CAPACITY_ABOVE_TARGET_SCALE";
      message = `現在の営業人員（${currentHeadcount}人）が実現する販売量（約${Math.round(
        currentSalesVolumeTons
      )}t/期）は、Target Scale帯（${Math.round(band.min)}〜${Math.round(band.max)}t/期）のmaxを上回っている（過剰）。`;
    } else {
      code = "SALES_CAPACITY_WITHIN_TARGET_BAND";
      message = `現在の営業人員（${currentHeadcount}人）が実現する販売量（約${Math.round(
        currentSalesVolumeTons
      )}t/期）は、Target Scale帯（${Math.round(band.min)}〜${Math.round(band.max)}t/期）の範囲内にある（適正）。`;
    }
    diagnostics.push({
      code,
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { currentHeadcount, currentSalesVolumeTons, targetMinTons: band.min, targetMaxTons: band.max },
      message,
    });
  }

  // --- 減員方向（§7）。既存の1人（末尾）のmarginal contributionを評価し、
  // 0以下（=既に過剰）かつ在庫が制約になっていない場合のみ、退職金を考慮して
  // 減員候補にする。既存採用がある場合（hireCount>0）は同時に評価しない
  // （game engine側の「同一四半期に採用と減員を両方>0で入力することは禁止」制約と整合）。
  let layoffCount = 0;
  if (hireCount === 0 && currentHeadcount > 0) {
    let headcountForLayoffEval = currentHeadcount;
    const inventoryIsLimiting = PRODUCTS.some((p) => currentFg[p] <= EPSILON) || pressures.finishedGoodsExcessRatioByProduct.hoso < 0.5;
    for (let i = 0; i < naturalStopCeiling && headcountForLayoffEval > 0; i++) {
      const after = headcountForLayoffEval - 1;
      const salesAtCurrentH = realisticSalesAtHeadcount(headcountForLayoffEval, wishByMarket, salesParams);
      const salesAtLower = realisticSalesAtHeadcount(after, wishByMarket, salesParams);
      const lostByProduct: ProductAmount = {
        hoso: Math.max(0, salesAtCurrentH.hoso - salesAtLower.hoso),
        pd: Math.max(0, salesAtCurrentH.pd - salesAtLower.pd),
        vap: Math.max(0, salesAtCurrentH.vap - salesAtLower.vap),
      };
      const lostTotal = lostByProduct.hoso + lostByProduct.pd + lostByProduct.vap;

      let lostContribution: number | null = 0;
      let unknown = false;
      for (const p of PRODUCTS) {
        const perTon = contributionPerTon[p];
        if (lostByProduct[p] <= EPSILON) continue;
        if (perTon === null) {
          unknown = true;
          continue;
        }
        lostContribution = (lostContribution ?? 0) + perTon * lostByProduct[p];
      }
      if (unknown && lostContribution === 0) lostContribution = null;

      // marginal contributionが給与以下（＝この人がいなくても損失が小さい）かつ
      // 在庫が販売のボトルネックになっていない場合のみ減員候補にする（三宅さんご指示§7、
      // 「今期売るものが少ないだけで大量解雇しない」ため、在庫制約チェックを必須にする）。
      const excessCapacity = lostContribution !== null && lostContribution - salaryUsdPerQuarter <= EPSILON;
      if (!excessCapacity || inventoryIsLimiting || lostTotal <= EPSILON) {
        break;
      }
      // 節約額（今後の四半期給与）が退職金（2四半期分）を上回るかを確認する
      // （2四半期目以降は必ず正のため、実質的には常に真だが、明示的に検証する）。
      const savingsExceedSeverance = salaryUsdPerQuarter * 2 > severanceUsdPerPerson - EPSILON;
      if (!savingsExceedSeverance) break;

      layoffCount += 1;
      headcountForLayoffEval = after;
      evaluations.push({
        direction: "layoff",
        headcountBefore: headcountForLayoffEval + 1,
        headcountAfter: headcountForLayoffEval,
        incrementalSalesTonsByProduct: lostByProduct,
        incrementalSalesTonsTotal: -lostTotal,
        incrementalSalesCoveredByExistingFgTons: 0,
        incrementalSalesRequiringNewProductionTons: 0,
        incrementalContributionMarginUsd: lostContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: lostContribution === null ? null : lostContribution - salaryUsdPerQuarter,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: true,
        blockedReasonCode: undefined,
      });
    }
    // 【2026-08-08】減員側のガバナーは廃止した。
    // 組織の吸収能力の制約は「増やす方向」にのみ働く。人を減らすことは、
    // 引継ぎ・育成・関係構築の追いつかなさとは別問題であり、人数としては
    // 任意に減らせる（ゲーム共通ルール。salesForceHiring.ts のコメント参照）。
    //
    // ただし「自由に減らせる」ことと「費用ゼロ」は別である。退職金（1人あたり
    // 四半期給与2四半期分）・当期は戦力と給与に残るという反映遅延は、
    // いずれも既存ルールのまま変更していない。
    if (layoffCount > 0) {
      diagnostics.push({
        code: "SALES_FORCE_EXCESS_CAPACITY",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { layoffCount, currentHeadcount, severanceUsdPerPerson },
        decisionSummary: `営業${layoffCount}人の減員を提案`,
        message: `持続的な営業容量過剰（追加販売機会が乏しく、在庫も販売のボトルネックになっていない）と診断し、退職金（1人あたり${Math.round(
          severanceUsdPerPerson
        )}USD）を考慮しても節約効果が上回るため、営業${layoffCount}人の減員を提案する。`,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 【Phase 6C・#05 §6】採用0に理由コードが無い状態を構造的に無くす。
  // ---------------------------------------------------------------------
  const HIRING_REASON_CODES: readonly StandardAiReasonCode[] = [
    "SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY",
    "SALES_HIRING_BLOCKED_BY_PRODUCTION",
    "SALES_HIRING_BLOCKED_BY_LIQUIDITY",
    "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY",
    "SALES_HIRING_NOT_ECONOMIC",
    "SALES_HIRING_LIMITED_BY_TARGET_SCALE",
    "SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION",
    "SALES_FORCE_EXCESS_CAPACITY",
  ];
  let zeroHireReason: StandardAiReasonCode | null = null;
  if (hireCount === 0) {
    zeroHireReason = diagnostics.find((d) => HIRING_REASON_CODES.includes(d.code))?.code ?? null;
    if (zeroHireReason === null) {
      // ここへ来るのは「経済評価ループが1人目の評価すら行わずに終わった」場合。
      // 目標販売量が現在の営業能力で既に満たされている（＝追加の販売機会が観測
      // できない）ことを意味する。黙って0にせず、明示的に記録する。
      zeroHireReason = "SALES_HIRING_NOT_ECONOMIC";
      diagnostics.push({
        code: "SALES_HIRING_NOT_ECONOMIC",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          currentHeadcount,
          targetSalesVolumeTons,
          currentSalesCapacityTons,
          unusedSalesCapacityTons,
        },
        decisionSummary: "営業採用は提案しない",
        message:
          `現在の営業人員${currentHeadcount}人で目標販売量（約${Math.round(targetSalesVolumeTons)}t/期）を既に捌けており、` +
          `追加1人が担う販売機会が観測できないため、営業採用を提案しない。`,
      });
    }
  }

  const hiringDiagnostics: SalesHiringDiagnosticsRecord = {
    currentHeadcount,
    requiredHeadcount: targetSalesForceHeadcount,
    unconstrainedEconomicDesiredHeadcount: currentHeadcount + targetGap,
    organizationallyAllowedHeadcount: currentHeadcount + organizationalHireLimit,
    // 資金余力で許される追加人数 = 最低現金バッファ余力 ÷ 1人あたり四半期給与。
    financiallyAllowedHeadcount:
      currentHeadcount + (salaryUsdPerQuarter > 0 ? Math.max(0, Math.floor(liquidityFloorUsd / salaryUsdPerQuarter)) : 0),
    actualTargetHeadcount: targetSalesForceHeadcount,
    actualHireCount: hireCount,
    actualLayoffCount: layoffCount,
    salesCapacityTons: currentSalesCapacityTons,
    usedSalesCapacityTons: Math.max(0, currentSalesCapacityTons - unusedSalesCapacityTons),
    zeroHireReason,
  };

  return {
    salesForceHireCount: hireCount,
    salesForceLayoffCount: layoffCount,
    targetSalesForceHeadcount,
    hiringDiagnostics,
    evaluations,
    diagnostics,
  };
}

// 型チェック用（未使用importの検知回避・将来の呼び出し側の参考）。
export type { ProductAmount, CompanySalesPlanEntry };
void hosoEqTons;
void unwrapUnit;
void STANDARD_AI_PARAMETERS_V1;
