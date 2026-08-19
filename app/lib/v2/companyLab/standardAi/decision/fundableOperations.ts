// ShrimpX V2 — Phase SAI-GROW-3B-2: Fundable Operations / Survival & Recovery
//
// 【解決する構造】PRE-AUDIT S-2 / F-5。
// 資金危機に入った会社が
//   調達縮小 → 生産縮小 → Cash悪化 → 調達0 → 生産0 → Worker固定費だけ残る → 永久崩壊
// となる原因は、Standard AIが「今いくらぶんの原料しか買えないか」を**判断前に**
// 把握していないことだった。生産計画は納品需要と設備能力だけで満額立ち、
// engine側の computeProcurementConstraint が事後的に調達を0へ削る。
// 生産計画が満額のままなので labor.ts の sustainedExcess は永久にfalseになり
// （F-5）、生産0でもWorkerが1人も減らない。
//
// 【このモジュールの責務】engineと同じ経済ロジックで
// 「当期に資金手当てできる原料量」を**事前に**求め、危機時にだけ
// 生産・調達・労務の規模をそこへ合わせる。
//
// 【新しいeconomic modelを作らない】調達資金の式は
// financing/liquidityClose.ts::computeProcurementConstraint と同一:
//     利用可能流動性 = max(0, 現金) × domesticPurchaseCashAllocationRatio + 承認融資
// 借入見込みは 3B-1/3B-1.1 の realisticallyAvailableBorrowingUsd をそのまま再利用する
// （借りられない会社に借入を捏造しない＝underwritingFrozen等では0）。
// 在庫ポジションは既存の pressures.rawMaterialInventoryPosition
// （＝手持ち原料 + パイプライン×0.5）をそのまま使う。
//
// 【NORMALでは何もしない】成長会社を抑制しないため、posture=NORMAL では
// 生産・調達・労務のいずれにも新しいcapを掛けない（現行挙動を維持）。

import { FINANCING_PARAMETERS_V1 } from "../../../financing/parameters";
import { StandardAiParameters } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { StandardAiCrisisState, StandardAiCrisisParameters, STANDARD_AI_CRISIS_PARAMETERS_V1 } from "../crisisState";
import { FinancialRiskTolerance } from "../../vision/types";
import { GROWTH_PRESSURE_PARAMETERS_V1, GrowthPressureParameters } from "../growth/growthPressure";
import { realisticallyAvailableBorrowingUsd } from "./liquidity";

const EPSILON = 1e-6;

/**
 * 【指示§1「新しい状態を増やす必要がないなら増やさない」】
 * crisisState（NORMAL / LIQUIDITY_STRESS / SEVERE_DISTRESS）はそのまま維持し、
 * その上に「規模をどう扱うか」だけの3値を重ねる。新しい永続stateは持たない
 * （すべてobservationの確定値から導出する純粋関数＝決定論・resume安全）。
 *
 *   NORMAL   … 現行挙動どおり。capを一切足さない。
 *   SURVIVAL … fundable levelまで規模を縮める。成長投資は停止。
 *   RECOVERY … 危機の痕跡はあるが資金は戻った。規模の再拡大は許すが、
 *              1Turn良かっただけで成長全開へ戻さない（bounded recovery）。
 */
export type SurvivalPosture = "NORMAL" | "SURVIVAL" | "RECOVERY";

export interface FundableOperationsInput {
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly params: StandardAiParameters;
  readonly crisisState: StandardAiCrisisState;
  readonly financialRiskTolerance: FinancialRiskTolerance | null;
  /** 当期の生産必要量合計（納品需要起点。cap前）。 */
  readonly productionRequirementTons: number;
  readonly growthParams?: GrowthPressureParameters;
  /** crisisState.tsと同じ較正済みパラメータを使う（新しい閾値を作らない）。 */
  readonly crisisParams?: StandardAiCrisisParameters;
}

export interface FundableOperationsAssessment {
  readonly posture: SurvivalPosture;
  /** engineと同じ式で求めた、当期の国内買付へ充てられる資金。 */
  readonly procurementFundingUsd: number;
  /** うち借入見込み（借りられない会社では0）。 */
  readonly expectedBorrowingForOperationsUsd: number;
  readonly expectedDomesticPriceUsdPerKg: number;
  /** その資金で買える国内原料量。 */
  readonly fundableDomesticProcurementTons: number;
  /** 当期の生産に実際に使える原料量 = 在庫ポジション + 資金手当て可能な買付量。 */
  readonly fundableRawMaterialTons: number;
  /** 生産計画へcapを掛けるか（NORMALでは常にfalse）。 */
  readonly appliesProductionCap: boolean;
  /** capを掛ける場合の上限量（掛けないときはproductionRequirementTonsと同じ）。 */
  readonly fundableProductionTons: number;
  /** 前四半期にも危機の痕跡があったか（段階的なWorker/営業縮小の条件）。 */
  readonly sustainedDistress: boolean;
  /** 営業組織の縮小まで許すか（severe かつ sustained のときだけ）。 */
  readonly allowsSalesForceReduction: boolean;
  readonly reason: string;
}

/**
 * 【指示§9】危機の痕跡。前四半期の確定値だけで判定する（新しい永続stateを作らない）。
 * ・国内買付が資金で**実質ゼロまで**削られていた
 * ・銀行審査が凍結されていた / 輸入発注が止まっていた
 * ・生産が実質ゼロだった
 *
 * 【scaleRatio<1 を痕跡にしない理由・実測による訂正】当初 scaleRatio<1 を痕跡に
 * していたが、crisisState.ts が既に実測で記録しているとおり、健全な会社でも
 * domesticPurchaseCashAllocationRatio による正常な資金繰りサイクルで
 * scaleRatio は 0.35〜0.49 まで日常的に下がる。これを痕跡とみなすと健全な会社が
 * 恒常的に RECOVERY になり、成長が止まって配分が乱高下した
 * （既存回帰テスト SAI-4「E社(JPQ)が8四半期で乱高下しない」が実際に落ちた）。
 * 閾値は新設せず、crisisState.ts が同じ目的で較正済みの
 * severeScaleRatioThreshold（=0.02、実質ゼロのみを検知する水準）を再利用する。
 */
function hasDistressFootprint(observation: StandardAiObservation, severeScaleRatioThreshold: number): boolean {
  const scaleRatio = observation.lastQuarterProcurementScaleRatio;
  if (scaleRatio !== null && scaleRatio !== undefined && scaleRatio <= severeScaleRatioThreshold) return true;
  if (observation.lastQuarterUnderwritingFrozen === true) return true;
  if (observation.lastQuarterImportOrdersBlocked === true) return true;
  const lastProduction = Object.values(observation.lastQuarterActualProductionByProduct ?? {}).reduce(
    (sum, v) => sum + (Number(v) || 0),
    0
  );
  const hadPriorQuarter = Object.keys(observation.lastQuarterActualProductionByProduct ?? {}).length > 0;
  return hadPriorQuarter && lastProduction <= EPSILON;
}

/**
 * 【指示§2】Fundable Procurement Volume（PRE-AUDIT S-2）。
 * engineの computeProcurementConstraint と同じ経済ロジックを、Standard AI側で
 * 意思決定の**前に**評価する。別のeconomic modelは作らない。
 */
export function assessFundableOperations(input: FundableOperationsInput): FundableOperationsAssessment {
  const { observation, pressures, params, crisisState, productionRequirementTons } = input;
  const growthParams = input.growthParams ?? GROWTH_PRESSURE_PARAMETERS_V1;
  const crisisParams = input.crisisParams ?? STANDARD_AI_CRISIS_PARAMETERS_V1;

  // --- 当期に国内買付へ充てられる資金（engineと同一式） ---
  // financing/liquidityClose.ts::computeProcurementConstraint:
  //   availableLiquidityUsd = max(0, prevCash) × domesticPurchaseCashAllocationRatio + approvedNormalLoanDrawUsd
  const expectedBorrowingForOperationsUsd = realisticallyAvailableBorrowingUsd(
    { observation, pressures, params, crisisState, financialRiskTolerance: input.financialRiskTolerance },
    growthParams
  );
  const procurementFundingUsd =
    Math.max(0, observation.cashUsd) * FINANCING_PARAMETERS_V1.liquidity.domesticPurchaseCashAllocationRatio +
    expectedBorrowingForOperationsUsd;

  // 前期の国内参照価格（既存observation）。未知なら資金制約を判定できないため、
  // 「制約なし」ではなく「capを掛けない」側へ倒す（捏造した価格を置かない）。
  const expectedDomesticPriceUsdPerKg = observation.vietnamDomesticPriorPrice ?? 0;
  const fundableDomesticProcurementTons =
    expectedDomesticPriceUsdPerKg > EPSILON ? procurementFundingUsd / (expectedDomesticPriceUsdPerKg * 1000) : 0;

  // 当期の生産に使える原料 = 既存在庫ポジション（手持ち+パイプライン。既存pressures）
  //                        + 当期に資金手当てできる買付量
  const fundableRawMaterialTons = Math.max(0, pressures.rawMaterialInventoryPosition) + Math.max(0, fundableDomesticProcurementTons);

  const sustainedDistress = hasDistressFootprint(observation, crisisParams.severeScaleRatioThreshold);
  const isSevere = crisisState === "SEVERE_DISTRESS";
  const isStress = crisisState === "LIQUIDITY_STRESS";

  // 【指示§3】「明確なfunding shortfall」= 計画どおり操業するのに必要な原料を
  // 資金で賄えず、かつ現金圧力が**深刻**な状態。
  //
  // 【現金が最低バッファ未満、では緩すぎる・実測による訂正】当初
  // cashUsd < targetMinimumCashUsd を条件にしていたが、成長期の健全な会社でも
  // 日常的に成立するため、健全なJPQで縮退が四半期ごとに点いたり消えたりし、
  // 養殖池入れ計画が60.4%振動して既存回帰テストSAI-4に抵触した。
  // 閾値は新設せず、procurement.tsが同じ「深刻な現金圧力」の判定に既に使っている
  // pressures.cashPressure >= params.severeCashPressureThreshold（=0.7）を再利用する。
  const rawMaterialShortfall = productionRequirementTons - fundableRawMaterialTons > EPSILON;
  const severeCashPressure = pressures.cashPressure >= params.severeCashPressureThreshold;
  //
  // 【さらにsustainedDistressも要求する理由・実測による訂正】severeCashPressureだけでも
  // 健全なJPQがturn3の資金繰りの谷で1四半期だけ縮退し、養殖池入れ計画が97.1%跳ねて
  // SAI-4に抵触した。crisisStateは前Turン確定値を読むことで自然な遅延を持つのに対し、
  // この限界条件は当期の値だけで立つため、単発の谷を拾ってしまう。
  // 前四半期にも危機の痕跡があること（sustainedDistress）を併せて要求し、
  // 「1四半期の谷では縮退しない／本当に崩れ始めた会社では縮退する」を分ける。
  const clearFundingShortfall =
    rawMaterialShortfall && severeCashPressure && sustainedDistress && expectedDomesticPriceUsdPerKg > EPSILON;

  let posture: SurvivalPosture = "NORMAL";
  let reason = "資金は十分で、規模の縮退は不要（現行どおり）。";
  if (isSevere || isStress || clearFundingShortfall) {
    posture = "SURVIVAL";
    reason = isSevere
      ? "深刻な資金危機のため、資金手当てできる規模まで操業を縮小する。"
      : isStress
        ? "資金調達能力が低下しているため、資金手当てできる規模へ操業を寄せる。"
        : "計画どおりの原料を資金で賄えず現金も最低バッファを下回るため、操業規模を資金手当て可能な水準へ縮小する。";
  } else if (sustainedDistress && !rawMaterialShortfall) {
    // 危機は抜けたが直前まで痕跡がある。規模の再拡大は許し、成長だけ止める。
    posture = "RECOVERY";
    reason = "資金は回復したが直前まで資金制約下にあったため、操業規模の回復を優先し新規の成長投資は見送る。";
  }

  // 参照価格が未知（Turn1等）のときは資金換算そのものができないため、capを掛けない
  // （0t扱いで生産を止める、という捏造をしない）。
  const priceKnown = expectedDomesticPriceUsdPerKg > EPSILON;

  // 【指示§3「縮退を強める」は段階的である・実測による訂正】
  // LIQUIDITY_STRESSは「まだ完全支払不能ではない」段階であり、crisisState.tsの
  // Commercial Commitment Gateでも0.7倍（30%縮小）に留めている。ここで
  // LIQUIDITY_STRESS単発でも生産をfundable levelまでハードにcapすると、
  // 健全なJPQがturn6の1四半期だけ縮退し、養殖池入れ計画が61.8%/83.4%跳ねて
  // 既存回帰テストSAI-4に抵触した（実測。5seed中2seed）。
  // ハードなcapは「深刻」または「持続している」ときだけに限定する:
  //   ・SEVERE_DISTRESS
  //   ・明確なfunding shortfall（既にsustainedDistressを要求済み）
  //   ・LIQUIDITY_STRESSが前四半期の痕跡を伴っている
  // LIQUIDITY_STRESS単発では、既存のCrisis Gate（新規商業拡大の抑制・成長投資停止）
  // だけが働く＝従来どおりの反応に留める。
  const distressIsDeepOrSustained = isSevere || clearFundingShortfall || (isStress && sustainedDistress);
  const appliesProductionCap = posture === "SURVIVAL" && distressIsDeepOrSustained && rawMaterialShortfall && priceKnown;
  const fundableProductionTons = appliesProductionCap
    ? Math.max(0, Math.min(productionRequirementTons, fundableRawMaterialTons))
    : productionRequirementTons;

  // 【指示§6】営業組織はCAPEXより後、Workerより慎重に。
  // 一時的なLiquidity Stressだけでは縮小しない（severe かつ sustained のときだけ）。
  const allowsSalesForceReduction = posture === "SURVIVAL" && isSevere && sustainedDistress;

  return {
    posture,
    procurementFundingUsd,
    expectedBorrowingForOperationsUsd,
    expectedDomesticPriceUsdPerKg,
    fundableDomesticProcurementTons,
    fundableRawMaterialTons,
    appliesProductionCap,
    fundableProductionTons,
    sustainedDistress,
    allowsSalesForceReduction,
    reason,
  };
}

/**
 * 【指示§9】RECOVERYからの復帰・成長再開の可否。
 * SURVIVAL/RECOVERY のあいだは成長投資（CAPEX・新工場・営業増員）を止める。
 * 1Turn良くなっただけでGrowth全開へ戻さないためのbounded recoveryであり、
 * NORMALへ戻るには「危機signalが消える」＋「前四半期に危機の痕跡が無い」の
 * 両方が必要になる（痕跡判定が1Turn遅延しているため、自然に1Turnのhysteresisになる）。
 */
export function growthPausedForRecovery(assessment: FundableOperationsAssessment): boolean {
  return assessment.posture !== "NORMAL";
}
