// ShrimpX V2 — Standard AI Crisis Management（Phase CM-1）
//
// 【背景】Vision Calibration benchmarkの監査（MASS 32Q生産ゼロ異常）で、
// 資金繰りが完全に破綻し原料調達も生産もできない会社が、平常時と同じ販売計画で
// 新規契約を際限なく積み上げ続け、Backlogが30万t超まで膨張する挙動が見つかった。
// 原因はFinance側（computeProcurementConstraint・銀行underwriting）の
// 経営破綻メカニズムそのものではなく、Standard AIがその破綻状態を一切
// 認識していないこと。
//
// 【今回変更しないもの】Finance formula（computeProcurementConstraint・
// scaleRatio式・銀行underwriting・credit tier・loan approval・insolvency判定式）
// そのものは一切変更しない。ここは常にFinance側が既に計算した値を読むだけの層。
//
// 【既存SSoTの再利用】新しい財務スコアリング・新しい閾値体系は作らない。
// companyLab/types.ts:CompanyOwnState.lastFinancingResult（既存の
// FinancingQuarterResult。前Turnの資金繰りクローズでfinancing/liquidityClose.ts・
// bankUnderwriting.tsが既に算出した値）を、standardAi/observation.tsが
// StandardAiObservationへそのまま転記した4フィールドだけを入力とする
// （lastQuarterProcurementScaleRatio・lastQuarterUnderwritingFrozen・
// lastQuarterImportOrdersBlocked・lastQuarterFinancialHealthTier）。
//
// 【1Turn遅延という設計】前Turンの資金繰り結果は、当Turnの意思決定を作る時点では
// まだ存在しない（companyLab/runner.tsの処理順で、当TurnのprocurementConstraint等は
// Standard AIの意思決定より後に計算される）。したがってここで使えるのは常に
// 「前Turnまでに確定していた」値であり、これは既存のVision・Strategic Growth等と
// 同じ「未来を知らない」bounded rationality原則と一致する。
//
// 【Hysteresisについて・指示§12】複雑な多Turn平滑化ステートは追加しない。
// 前Turンの確定値を読むという設計自体が、当Turン内の1回だけの揺らぎで
// NORMAL↔STRESSが激しく往復することを避ける自然な遅延効果を持つため、
// 追加の多段階カウンタは導入しない（過剰実装をしない、指示の明示的な要請）。

import { FinancialHealthTier } from "../../financing/types";
import { CommercialCommitmentState } from "../vision/commercialCommitment";

export type StandardAiCrisisState = "NORMAL" | "LIQUIDITY_STRESS" | "SEVERE_DISTRESS";

/** SEVERE_DISTRESSへ分類する財務健全性tier（既存のFinancialHealthTierをそのまま使う）。 */
const SEVERE_DISTRESS_HEALTH_TIERS: ReadonlySet<FinancialHealthTier> = new Set(["insolvent", "paymentDefault"]);
/** LIQUIDITY_STRESSへ分類する財務健全性tier。 */
const LIQUIDITY_STRESS_HEALTH_TIERS: ReadonlySet<FinancialHealthTier> = new Set(["stressed", "covenantBreach", "paymentArrears"]);

export interface StandardAiCrisisParameters {
  /**
   * procurementConstraint.scaleRatioがこの値以下なら、国内買付がほぼ完全に
   * 止まっている（≈0）とみなしSEVERE_DISTRESSの根拠にする（指示§5の例示
   * 「scaleRatio ≈ 0」）。
   *
   * 【0.6ではなく0.02にした理由・実装後の実測による訂正】当初0.6（「調達能力が
   * 大きく低下している」の目安）をLIQUIDITY_STRESSの閾値にも使っていたが、
   * 32Qベンチマーク回帰テストで、財務的に健全なRun（baseline/
   * management-console-32qのMASS等）でもTurn2〜3の時点でscaleRatio≈0.35〜0.49
   * まで下がることが実測された。これはdomesticPurchaseCashAllocationRatioに
   * よる「今期使う→来期まで温存」という設計上の正常な資金繰りサイクルであり、
   * 危機ではない。0.6という閾値はこの正常なサイクルを危機と誤検知し、
   * Crisis Gateが新規受注を抑制→売上減→現金が回復しない→危機状態が続く、
   * という自己成就的な悪化ループを引き起こした（32Q統合回帰テスト
   * commercialCommitmentIntegration.test.tsで検出）。真に危機的な調達停止
   * （Vision Calibration benchmarkで監査したMASS 32Q生産ゼロ異常）では
   * scaleRatioは複数Turnにわたり厳密に0.000であり続けたため、0.02
   * （実質ゼロのみを検知し、通常の資金繰りサイクルの谷を検知しない水準）へ
   * 修正した。
   */
  readonly severeScaleRatioThreshold: number;
}

export const STANDARD_AI_CRISIS_PARAMETERS_V1: StandardAiCrisisParameters = {
  severeScaleRatioThreshold: 0.02,
};

export interface StandardAiCrisisAssessmentInput {
  readonly lastQuarterProcurementScaleRatio: number | null;
  readonly lastQuarterUnderwritingFrozen: boolean | null;
  readonly lastQuarterImportOrdersBlocked: boolean | null;
  readonly lastQuarterFinancialHealthTier: FinancialHealthTier | null;
  readonly params?: StandardAiCrisisParameters;
}

/** 【指示§13】検知シグナルとして残すreason code（診断へそのまま積む）。 */
export type StandardAiCrisisSignalCode = "CRISIS_UNDERWRITING_FROZEN" | "CRISIS_PROCUREMENT_BLOCKED" | "CRISIS_LIQUIDITY_STRESS";

export interface StandardAiCrisisAssessment {
  readonly state: StandardAiCrisisState;
  /** どのシグナルが根拠になったか（複数可）。UI・Analysis Pack・diagnosticsで使う。 */
  readonly signals: readonly StandardAiCrisisSignalCode[];
  /** 人間向けの短い説明（Company Inspector・Claude explanation向け）。 */
  readonly summary: string;
}

/**
 * Standard AIのCrisis State（NORMAL/LIQUIDITY_STRESS/SEVERE_DISTRESS）を、
 * 既存のFinance診断シグナルだけから導出する（純粋関数。新しい財務計算をしない）。
 */
export function assessStandardAiCrisisState(input: StandardAiCrisisAssessmentInput): StandardAiCrisisAssessment {
  const params = input.params ?? STANDARD_AI_CRISIS_PARAMETERS_V1;
  const signals: StandardAiCrisisSignalCode[] = [];

  const severeByHealth = input.lastQuarterFinancialHealthTier !== null && SEVERE_DISTRESS_HEALTH_TIERS.has(input.lastQuarterFinancialHealthTier);
  const severeByFrozen = input.lastQuarterUnderwritingFrozen === true;
  const severeByScaleRatio =
    input.lastQuarterProcurementScaleRatio !== null && input.lastQuarterProcurementScaleRatio <= params.severeScaleRatioThreshold;
  const severeByImportBlocked = input.lastQuarterImportOrdersBlocked === true;

  if (severeByFrozen) signals.push("CRISIS_UNDERWRITING_FROZEN");
  if (severeByScaleRatio || severeByImportBlocked) signals.push("CRISIS_PROCUREMENT_BLOCKED");

  if (severeByHealth || severeByFrozen || severeByScaleRatio || severeByImportBlocked) {
    return {
      state: "SEVERE_DISTRESS",
      signals,
      summary: "資金繰りが深刻に悪化しており（信用凍結・原料調達不能等）、新規の商業拡大を停止して既存Backlogの履行を優先している。",
    };
  }

  // 【scaleRatioをLIQUIDITY_STRESSの根拠に使わない理由】上のコメント参照。
  // scaleRatioは正常な資金繰りサイクルでも大きく上下するため、「まだ完全支払不能
  // ではないが調達能力が大きく低下している」状態は、既存Finance側が既に持つ
  // 持続的なシグナル（financialHealthTier: stressed/covenantBreach/
  // paymentArrears。いずれも単発の低scaleRatioではなくconsecutiveArrears等の
  // 累積指標から確定する）だけで判定する。
  const stressByHealth = input.lastQuarterFinancialHealthTier !== null && LIQUIDITY_STRESS_HEALTH_TIERS.has(input.lastQuarterFinancialHealthTier);

  if (stressByHealth) {
    signals.push("CRISIS_LIQUIDITY_STRESS");
    return {
      state: "LIQUIDITY_STRESS",
      signals,
      summary: "資金調達能力が低下しているため、新規の商業拡大を抑制し財務の立て直しを優先している（完全停止ではない）。",
    };
  }

  return { state: "NORMAL", signals: [], summary: "資金繰りは平常。通常どおりVision・Strategic Growthに沿って経営判断を行う。" };
}

export interface CrisisCommitmentGateParameters {
  /**
   * LIQUIDITY_STRESS時、computeCommercialCommitmentが出したsubmissionTargetTonsに
   * 掛ける縮小率（指示§4「新規販売を完全ゼロにはしない」）。
   *
   * 【0.3ではなく0.7にした理由・実装後の実測による訂正】LIQUIDITY_STRESSは
   * financialHealthTierがstressed/covenantBreach/paymentArrearsの単発Turnでも
   * 成立しうる（消えれば次Turnにはnormalへ戻る、一時的な悪化を含む）。0.3
   * （70%縮小）だと、既存の32Q回帰テスト（heterogeneousProfiles.test.ts、
   * SAI-4：健全なJPQ社が単発Turnの財務ノイズで販売希望量が1Turnだけ68%も
   * 急減する「振り子的挙動」を検出）に抵触した。LIQUIDITY_STRESSは指示§4が
   * 明示する「まだ完全支払不能ではない」段階であり、SEVERE_DISTRESS
   * （常に0へ）ほど強い反応をすべきではない。0.7（30%縮小）へ緩めることで、
   * 単発の財務ノイズによる過剰反応（指示§12が警告するhysteresis問題）を防ぎつつ、
   * 縮小そのものは維持する。
   */
  readonly liquidityStressSubmissionRatio: number;
}

export const STANDARD_AI_CRISIS_COMMITMENT_GATE_PARAMETERS_V1: CrisisCommitmentGateParameters = {
  liquidityStressSubmissionRatio: 0.7,
};

/**
 * 【指示§5/§6】Crisis Gate。computeCommercialCommitment自体の計算式は一切変更せず、
 * その出力（submissionTargetTons）だけを危機状態に応じて縮小・停止する。
 * Vision・Commercial Ambition（志そのもの）はこの関数の入力にも出力にも
 * 一切現れない＝志を書き換えない（指示§6/§23）。
 *
 * 【指示§7 Backlog First】ここでsubmissionTargetTons（新規提出量の上限）だけを
 * 下げる。既存受注残（backlogTons）はcomputeCommercialCommitmentの入力として
 * 別経路で扱われ、生産必要量の計算（diagnosis/currentPeriodDeliveryDemand.ts）でも
 * 確定受注残（confirmed）は常に100%のまま。ここで縮小されるのは
 * speculative（未成約の新規提出）分だけである。
 */
export function applyCrisisGateToCommercialCommitment(
  commitment: CommercialCommitmentState,
  crisis: StandardAiCrisisAssessment,
  params: CrisisCommitmentGateParameters = STANDARD_AI_CRISIS_COMMITMENT_GATE_PARAMETERS_V1
): CommercialCommitmentState {
  if (crisis.state === "SEVERE_DISTRESS") {
    return { ...commitment, submissionTargetTons: 0, limiter: "CRISIS" };
  }
  if (crisis.state === "LIQUIDITY_STRESS") {
    return {
      ...commitment,
      submissionTargetTons: commitment.submissionTargetTons * params.liquidityStressSubmissionRatio,
      limiter: "CRISIS",
    };
  }
  return commitment;
}
