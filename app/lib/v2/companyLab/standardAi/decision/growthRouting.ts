// ShrimpX V2 — Phase SAI-GROW-3C: Deliverability Constraint Routing / Capacity Expansion
//
// 【解決する構造】3B-3で「売りたい量」と「今受けてよい量」は分離できたが、
// Deliverability capで提出量を縮めた情報が診断に留まり、能力側の判断へ戻っていなかった。
// その結果DS3 VAPで
//   Production / Worker不足 → Commitment縮小 → 実績規模縮小 → 次TurnのAmbition縮小
// という新しいdeadlockが露出した（Ambition 39.4kt → 32.2kt、生産 37.9kt → 29.3kt）。
//
// 【このモジュールの立場】Commitmentを無理に増やさない。3B-3のcapは1ミリも緩めない。
// 「売れない」のではなく「作れない」のだから、Deliverability Gapを**能力投資へrouteする**。
//
// 【Commercial Ambitionを書き換えない】この層はVision・Ambition・Commitmentの
// いずれにも書き戻さない。能力が伸びれば納品可能量が増え、3B-3のcapが自然に緩み、
// Ambition・salesが自力で戻る——という経路だけを作る。
//
// 【新しいmodelを作らない】使う値はすべて既存:
//   ・必要Worker人数   companyLab/workforce.ts::computeRequiredRegularHeadcount
//                     （商品別労働集約度 HOSO 1.0 / PD 1.2 / VAP 3.0 を内包する唯一の情報源）
//   ・納品可能量       3B-3 deliverableCommitment.ts の評価結果
//   ・資金手当て原料   3B-2 fundableOperations.ts::computeFundableRawMaterial
//   ・流動性           3B-1 liquidity.ts の LiquidityAssessment
//   ・実効生産能力     bindingCapacity.ts::computeBindingProductionCapacityTons
//   ・営業能力上限     policy.ts の salesCapacityCeilingTons（SalesParameters由来）
//   ・持続性           pressures.hadPriorQuarterUtilization ＋ capex側の既存sustained gate

import { Product } from "../../../market/types";
import { computeRequiredRegularHeadcount } from "../../workforce";
import { ProductAmount, StandardAiObservation, sumProductAmount, zeroProductAmount } from "../types";
import { PressureScores } from "../pressures";
import { StandardAiParameters } from "../parameters";
import { LiquidityAssessment } from "./liquidity";
import { DeliverableCommitmentState, DeliverabilityConstraint } from "./deliverableCommitment";
import { SurvivalPosture } from "./fundableOperations";

const EPSILON = 1e-6;
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 成長制約をどのドメインの意思決定へ返すか（§3・§16）。 */
export type GrowthRoute =
  | "NONE"
  | "PRODUCTION_CAPEX"
  | "WORKFORCE"
  | "PROCUREMENT"
  | "LIQUIDITY"
  | "SALES_HIRING"
  | "BACKLOG_RECOVERY";

export interface GrowthRoutingInput {
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly params: StandardAiParameters;
  readonly commercialAmbitionTons: number;
  /** 「どの商品で売りたいか」。営業希望（努力制約前）の構成比をそのまま使う。 */
  readonly desiredMixByProduct: ProductAmount;
  readonly deliverable: DeliverableCommitmentState;
  readonly liquidity: LiquidityAssessment;
  readonly fundableRawMaterialTons: number;
  /** 原料不足の原因が資金かどうか（3B-3と同じ判定を渡す）。 */
  readonly rawMaterialLimitedByFunding: boolean;
  /** 納期到来時点の実効生産能力（承認済みCAPEXのramp込み）。 */
  readonly nearTermBindingProductionCapacityTons: number;
  /** 営業組織が捌ける案件量。観測できない場合はnull。 */
  readonly salesCapacityTons: number | null;
  /**
   * 【Phase SAI-GROW-3C.1】当期の生産必要量（diagnosis/productionRequirement.tsが算出した
   * finalProductionRequirementByProductの合計。deliverability capを反映済み）。
   *
   * これは「今この会社が実際に作らなければならない量」であり、
   *   ・既存の未履行契約（backlog）を100%含む
   *   ・新規営業のうち期待転換率ぶんの成約見込みを含む
   *   ・通常在庫目標と期首完成品在庫を反映済み
   * したがって「現在の実績」だけでなく「近い将来に合理的に実行できる増分」を既に内包する
   * （実装指示§7）。新しい需要モデルは作っていない。
   */
  readonly currentPeriodProductionRequirementTons: number;
  /** 直近実績規模（policy.tsのrecentActualScaleTonsをそのまま渡す）。需要の谷で目標が落ち込まない下限。 */
  readonly recentActualScaleTons: number;
  readonly survivalPosture: SurvivalPosture;
  /** 3B-3のcapが実際に効いたか。 */
  readonly deliverabilityCapApplied: boolean;
}

export interface GrowthRoutingAssessment {
  /** Commercial Ambition − 持続的に納品できる量。成長投資のsignal。 */
  readonly deliverabilityGrowthGapTons: number;
  readonly sustainableDeliverableCapacityTons: number;

  // --- Worker（§4） ---
  /** 現有Workerで捌ける量（志の商品構成のまま換算）。 */
  readonly workerCapacitySupportedTons: number;
  /** 志を納品するのに要する常用Worker人数。 */
  readonly workerRequirementForAmbition: number;
  /**
   * 【Phase SAI-GROW-3C.1】Worker以外の制約の下で近い将来実行可能な規模。
   * Worker採用の目標はこちらを使う（Commercial Ambitionそのものは使わない）。
   */
  readonly workerExpansionTargetTons: number;
  /** 上記の規模を捌くのに要する常用Worker人数（＝labor.tsへ渡す下限）。 */
  readonly workerRequirementForExecutableTarget: number;
  /** 志ベースのgap（診断用。採用には使わない）。 */
  readonly workerGapForAmbition: number;
  /** 実行可能規模ベースのgap（＝実際に埋めにいく不足）。 */
  readonly workerGapForExecutableTarget: number;
  readonly currentWorkerHeadcount: number;
  readonly workerGap: number;
  readonly workerLimited: boolean;

  // --- 各domainのgap ---
  readonly productionGapTons: number;
  readonly rawMaterialGapTons: number;
  readonly liquidityBlocked: boolean;

  readonly bindingConstraint: DeliverabilityConstraint | "SALES_CAPACITY" | "WORKFORCE" | "NONE";
  readonly route: GrowthRoute;
  /** routeした先が埋めるべき量。 */
  readonly routedGrowthTons: number;
  /** その商品別内訳（Production CAPEXのshortfall判定へそのまま渡す）。 */
  readonly routedGrowthByProduct: ProductAmount;
  readonly actionTaken: boolean;
  readonly actionNotTakenReason: string;
  /** 一四半期だけのgapで大型投資をしないための持続性判定（§8）。 */
  readonly persistent: boolean;
}

/** 志の量を、営業が売りたい商品構成へ割り付ける（構成比が取れなければ能力構成比）。 */
function ambitionMixByProduct(ambitionTons: number, desiredMix: ProductAmount, capacityMix: ProductAmount): ProductAmount {
  const desiredTotal = sumProductAmount(desiredMix);
  const base = desiredTotal > EPSILON ? desiredMix : capacityMix;
  const baseTotal = sumProductAmount(base);
  const result = zeroProductAmount();
  if (baseTotal <= EPSILON || ambitionTons <= EPSILON) return result;
  for (const product of PRODUCTS) result[product] = (base[product] / baseTotal) * ambitionTons;
  return result;
}

/** 会社全体の平均skill・出勤率（工場別observationの実効能力加重ではなく単純平均。既存値のみ使用）。 */
function companyLaborProfile(observation: StandardAiObservation): { skillByProduct: ProductAmount; attendanceRate: number } {
  const skillByProduct = zeroProductAmount();
  let attendanceRate = 0;
  const factories = observation.factories;
  if (factories.length === 0) return { skillByProduct: { hoso: 1, pd: 1, vap: 1 }, attendanceRate: 1 };
  for (const product of PRODUCTS) {
    const samples = factories.map((f) => f.skillByProduct[product]).filter((v) => Number.isFinite(v) && v > 0);
    skillByProduct[product] = samples.length > 0 ? samples.reduce((s, v) => s + v, 0) / samples.length : 1;
  }
  attendanceRate = factories.reduce((s, f) => s + (Number.isFinite(f.attendanceRate) ? f.attendanceRate : 1), 0) / factories.length;
  return { skillByProduct, attendanceRate };
}

/**
 * 【§1・§3・§4】Deliverability Gapを、どのドメインの意思決定へ返すかを決める。
 * 純粋関数（同一入力なら常に同一出力）。会社IDによる分岐は一切しない
 * ——差は志の商品構成・労働集約度・financialRiskTolerance・既存profileから自然に出る。
 */
export function assessGrowthRouting(input: GrowthRoutingInput): GrowthRoutingAssessment {
  const { observation, pressures, params, deliverable, liquidity } = input;

  // --- Worker capacity（§4。新しいworker modelを作らない） ---
  const ambitionMix = ambitionMixByProduct(
    input.commercialAmbitionTons,
    input.desiredMixByProduct,
    observation.totalEffectiveCapacityByProduct
  );
  const { skillByProduct, attendanceRate } = companyLaborProfile(observation);
  const workerRequirementForAmbition = computeRequiredRegularHeadcount({
    quantityByProduct: ambitionMix,
    skillByProduct,
    attendanceRate,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  }).requiredRegularHeadcount;
  const currentWorkerHeadcount = observation.regularHeadcountTotal;
  const workerGap = Math.max(0, workerRequirementForAmbition - currentWorkerHeadcount);
  // 志の商品構成のまま、現有Workerで捌けるトン数へ逆換算する。
  // （VAPは労働集約度3.0なので、同じ人数でもHOSOより少ないトン数しか捌けない＝§5の差が自然に出る）
  const workerCapacitySupportedTons =
    workerRequirementForAmbition > EPSILON
      ? input.commercialAmbitionTons * Math.min(1, currentWorkerHeadcount / workerRequirementForAmbition)
      : input.commercialAmbitionTons;

  // 【§15】設備能力だけでは成長可能性を測れない。VAPは労働集約度3.0のため、
  // 設備能力が余っていてもWorkerが先に頭打ちになる（実測: DS3 VAPは設備能力35,012tに対し
  // 現有Workerで捌けるのは31,366t。設備基準だけで見るとgap=0となり、
  // 「能力側が動かないままAmbitionだけが縮む」deadlockから抜けられなかった）。
  // routing用の持続的納品可能量は設備側とWorker側のminとする。
  // **3B-3のDeliverable Commitment cap自体には一切影響させない**（§2 capを緩めない）。
  const equipmentBasedDeliverableTons = Math.max(
    deliverable.deliverableCapacityNearTermTons,
    deliverable.deliverableCapacityCurrentTons
  );
  // 【§8】設備・Worker・原料の3つのうち最も小さいものが、実際に持続的に納品できる量。
  // 原料を入れないとRAW_MATERIALが構造的にbindingになり得なかった（受入G3C-3で検出）。
  const sustainableDeliverableCapacityTons = Math.min(
    equipmentBasedDeliverableTons,
    workerCapacitySupportedTons,
    Math.max(0, input.fundableRawMaterialTons)
  );
  const deliverabilityGrowthGapTons = Math.max(0, input.commercialAmbitionTons - sustainableDeliverableCapacityTons);

  const productionGapTons = Math.max(0, input.commercialAmbitionTons - Math.max(0, input.nearTermBindingProductionCapacityTons));
  const rawMaterialGapTons = Math.max(0, input.commercialAmbitionTons - Math.max(0, input.fundableRawMaterialTons));
  const workerGapTons = Math.max(0, input.commercialAmbitionTons - workerCapacitySupportedTons);

  // --- 【Phase SAI-GROW-3C.1】Executable Workforce Growth Target ---
  //
  // 3CはWorker採用の目標を workerRequirementForAmbition（＝Commercial Ambition全量）
  // にしていた。Ambitionは capacityAnchor（能力 × salesUtilizationTarget）で決まるため、
  // 「売れる量」ではなく「作れる量」である。Ambition > 近い将来の実行可能規模 の局面では
  // 余剰人員を先行保有し、人件費がCashとOPを先に食う
  // （実測: DS2 ds2-s4 BAL T19 worker 7,333 → 8,930、T26 OP 75.0 → 59.6M。
  //   CAPEX・financing・production mixはほぼ同一で差はWorker側のみ）。
  //
  // Worker採用の目標は「Worker以外の制約の下で近い将来実行可能な規模」にする。
  //   ・commercialAmbition            … 志を超えては採らない
  //   ・nearTermBindingProductionCapacity … 設備で作れない量の人は要らない
  //   ・fundableRawMaterial           … 原料が買えない量の人は要らない
  //   ・商業的に実行可能な規模        … 売り先（既存backlog＋期待成約）が無い量の人は要らない
  //
  // 【workerCapacitySupportedTonsをこのminへ入れてはいけない】(実装指示§3)
  // 入れると「Worker不足だからWorkerを増やしたいのに、現在Workerで作れる量までしか
  // 採用しない」という循環になり、WORKFORCE routeが構造的に無効化される。
  //
  // 【現在の実績だけへ固定しない】(実装指示§7)
  // 商業側の指標には currentPeriodProductionRequirementTons を使う。これは
  // 既存backlogを100%含み、新規営業の期待成約ぶんも含むため、
  // 「現在の実績 ＋ 近い将来に合理的に実行できる増分」を既に内包している。
  // 直近実績を下回らないよう max を取り、一時的な需要の谷で人員目標が落ち込まないようにする。
  const commerciallySupportedScaleTons = Math.max(
    Math.max(0, input.recentActualScaleTons),
    Math.max(0, input.currentPeriodProductionRequirementTons)
  );
  const workerExpansionTargetTons = Math.max(
    0,
    Math.min(
      input.commercialAmbitionTons,
      Math.max(0, input.nearTermBindingProductionCapacityTons),
      Math.max(0, input.fundableRawMaterialTons),
      commerciallySupportedScaleTons
    )
  );
  const executableMix = ambitionMixByProduct(
    workerExpansionTargetTons,
    input.desiredMixByProduct,
    observation.totalEffectiveCapacityByProduct
  );
  const workerRequirementForExecutableTarget = computeRequiredRegularHeadcount({
    quantityByProduct: executableMix,
    skillByProduct,
    attendanceRate,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  }).requiredRegularHeadcount;
  const workerGapForExecutableTarget = Math.max(0, workerRequirementForExecutableTarget - currentWorkerHeadcount);
  const liquidityBlocked = liquidity.liquidityHeadroomUsd <= 0 || liquidity.currentTurnFundableHeadroomUsd <= 0;
  const workerLimited = workerGapTons > productionGapTons + EPSILON;

  // 【§8 持続性】一四半期だけのgapで大型投資をしない。新しいカウンタ・新しい閾値は
  // 足さず、既存の「前四半期に実際に満杯まで回していたか」だけを根拠にする
  // （新工場のpersistentCapacityCausedUnservedと同じ考え方）。
  //
  // 【計器をrouteに合わせる・実測による訂正】当初はどのrouteでも
  // pressures.equipmentUtilizationLastQuarter（設備稼働率）で判定し、さらに
  // 「3B-3のcapが実際に効いたこと」も要求していた。しかしWorkerがbindingな会社では
  //   ・設備稼働率は頭打ちにならない（VAP実測 0.90 < しきい値0.92）
  //   ・Workerが先に効くのでcapが発火する前に生産が止まる
  // ため、持続性が永久に成立せず能力側が動かないままだった（DS3 VAPで実測）。
  // Worker制約はlabor稼働率で、設備制約は設備稼働率で判定する。
  // しきい値はいずれも既存の capexSustainedUtilizationThreshold をそのまま使う。
  const sustainedThreshold = params.capexSustainedUtilizationThreshold;
  const equipmentSustained = pressures.hadPriorQuarterUtilization && pressures.equipmentUtilizationLastQuarter >= sustainedThreshold;
  const laborSustained = pressures.hadPriorQuarterUtilization && pressures.laborUtilizationLastQuarter >= sustainedThreshold;

  // --- Route選択（§3の優先順位） ---
  let bindingConstraint: GrowthRoutingAssessment["bindingConstraint"] = "NONE";
  let route: GrowthRoute = "NONE";
  let actionNotTakenReason = "";
  // persistentはroute確定後に評価する（下のBACKLOG分岐で参照するため先に設備側で仮置きする）。
  let persistent = equipmentSustained;

  if (deliverabilityGrowthGapTons <= EPSILON) {
    actionNotTakenReason = "志に対して納品能力が足りているため、能力側への回付は不要。";
  } else if (input.survivalPosture !== "NORMAL") {
    // 危機・回復中は3B-2の既存制約が優先。ここで成長投資を起こさない。
    bindingConstraint = "LIQUIDITY";
    route = "LIQUIDITY";
    actionNotTakenReason = "資金危機・回復途上のため、既存のSurvival / Liquidity制約を優先し能力投資は起こさない。";
  } else if (liquidityBlocked || (rawMaterialGapTons > EPSILON && input.rawMaterialLimitedByFunding)) {
    // 【§3 LIQUIDITY】原料不足の原因が資金なら、設備も営業採用も増やしてはいけない。
    bindingConstraint = "LIQUIDITY";
    route = "LIQUIDITY";
  } else if (deliverable.bindingDeliverabilityConstraint === "BACKLOG" && deliverable.overdueBacklogTons > EPSILON && !persistent) {
    // 【§3 BACKLOG】まず既存backlogの消化を優先する。
    bindingConstraint = "BACKLOG";
    route = "BACKLOG_RECOVERY";
  } else if (rawMaterialGapTons > EPSILON && rawMaterialGapTons >= productionGapTons && rawMaterialGapTons >= workerGapTons) {
    // 【§3 RAW_MATERIAL】能力はあるのに原料が足りない。Production CAPEXを増やさない。
    bindingConstraint = "RAW_MATERIAL";
    route = "PROCUREMENT";
  } else if (workerLimited && workerGap > EPSILON) {
    // 【§4】Workerがbindingなら、Factory CAPEXよりWorker増員を優先する
    //（「VAP設備を増やしたがWorkerが足りない」という誤投資をしない）。
    bindingConstraint = "WORKFORCE";
    route = "WORKFORCE";
  } else if (productionGapTons > EPSILON) {
    bindingConstraint = "PRODUCTION";
    route = "PRODUCTION_CAPEX";
  } else if (input.salesCapacityTons !== null && input.salesCapacityTons < input.commercialAmbitionTons - EPSILON) {
    // 【§6】他のconstraintがすべて解けていて、営業能力だけがbindingのときにだけ採用する。
    bindingConstraint = "SALES_CAPACITY";
    route = "SALES_HIRING";
  } else {
    actionNotTakenReason = "納品を縛っている主因を特定できないため、能力側への回付は行わない。";
  }

  // 【§7・§8】Production CAPEX / Workforce は持続的なconstraintのときだけ実行へ移す。
  // Procurement / Liquidity / Backlog / Sales Hiringは既存の各ドメイン判断側に
  // もともとガードがあるため、ここでは持続性を要求しない。
  const requiresPersistence = route === "PRODUCTION_CAPEX" || route === "WORKFORCE";
  persistent = route === "WORKFORCE" ? laborSustained : equipmentSustained;
  const actionTaken = route !== "NONE" && (!requiresPersistence || persistent);
  if (route !== "NONE" && !actionTaken) {
    actionNotTakenReason =
      "納品制約は観測できているが、一四半期だけの可能性があるため能力投資は見送る（持続性の確認待ち）。";
  }

  const routedGrowthTons = !actionTaken
    ? 0
    : route === "WORKFORCE"
      ? workerGapTons
      : route === "PRODUCTION_CAPEX"
        ? productionGapTons
        : route === "PROCUREMENT"
          ? rawMaterialGapTons
          : deliverabilityGrowthGapTons;

  // 商品別内訳は志の構成比のまま配る（Production CAPEXのボトルネック判定へそのまま渡す）。
  const routedGrowthByProduct = zeroProductAmount();
  if (routedGrowthTons > EPSILON) {
    const ambitionTotal = sumProductAmount(ambitionMix);
    if (ambitionTotal > EPSILON) {
      for (const product of PRODUCTS) routedGrowthByProduct[product] = (ambitionMix[product] / ambitionTotal) * routedGrowthTons;
    }
  }

  return {
    deliverabilityGrowthGapTons,
    sustainableDeliverableCapacityTons,
    workerCapacitySupportedTons,
    workerRequirementForAmbition,
    workerExpansionTargetTons,
    workerRequirementForExecutableTarget,
    workerGapForAmbition: workerGap,
    workerGapForExecutableTarget,
    currentWorkerHeadcount,
    workerGap,
    workerLimited,
    productionGapTons,
    rawMaterialGapTons,
    liquidityBlocked,
    bindingConstraint,
    route,
    routedGrowthTons,
    routedGrowthByProduct,
    actionTaken,
    actionNotTakenReason,
    persistent,
  };
}
