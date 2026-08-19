// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 オーケストレーター
//
// 【目的（SAI-1、実装指示の非目標を明示）】本モジュールは「最強のAI」でも
// 「個性を演じ分けるAI」でもない。目的は (1) バランス調整用の自動テストプレイヤー、
// (2) 将来のAI改善の比較対象となるベースライン方針、(3) 将来のAI取締役会提案機能の
// 土台、(4) 意思決定→結果の因果関係を追跡・診断する基盤の4つである。
//
// 【全社同一ロジック】5社すべてに同一の判断ロジック・同一の閾値
// （parameters.ts、STANDARD_AI_PARAMETERS_V1）・同一の情報範囲を適用する。
// 会社IDによる分岐は一切行わない。結果が会社ごとに異なるのは各社の実際の状態
// （CompanyFixture・CompanyOwnState）が異なるためであり、AI側のロジックが
// 会社を特別扱いしているからではない。
//
// 【情報境界】本モジュールが呼び出す各ドメイン生成関数は、いずれも
// StandardAiObservation（fixture・ownState・publicInfoだけから機械的に導出した
// スナップショット、observation.ts参照）とPressureScoresだけを主入力として使う。
// 生のturn runner状態・他社の非公開情報・将来の乱数は、関数シグネチャ上そもそも
// 受け取れない。

import { PeriodV2 } from "../../core/period";
import { unwrapUnit } from "../../core/units";
import { unwrapUsd } from "../../finance/types";
import { CompanyDecisionInput, CompanyDecisionProvider, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { buildStandardAiObservation } from "./observation";
import { computePressureScores } from "./pressures";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "./parameters";
import { buildStandardAiSalesPlans } from "./decision/sales";
import { buildStandardAiProductionPlans } from "./decision/production";
import { buildStandardAiProcurementPlan } from "./decision/procurement";
import { buildStandardAiWorkerAssignments } from "./decision/labor";
import { buildStandardAiFinancingRequest } from "./decision/finance";
import { buildStandardAiCapexDecision, LiquidityGateContext } from "./decision/capex";
import { assessCommittedCashRequirement, LiquidityAssessment } from "./decision/liquidity";
import { assessFundableOperations, computeFundableRawMaterial, FundableOperationsAssessment, growthPausedForRecovery } from "./decision/fundableOperations";
import { computeDeliverableCommitment, DeliverableCommitmentState } from "./decision/deliverableCommitment";
import { COMMITTED_CAPEX_HORIZON_QUARTERS } from "./observation";
import { buildStandardAiVapProductDevelopmentDecision } from "./decision/vapProductDevelopment";
import { buildStandardAiDividendDecision } from "./decision/dividend";
import { sumProductAmount } from "./types";
import { computeBindingProductionCapacityTons } from "./bindingCapacity";
import { StandardAiDiagnosticEntry } from "./reasonCodes";
import { SalesWishEntry } from "./decision/sales";
import { PressureScores } from "./pressures";
import { AppliedManagementBiasItem } from "./managementProfile";
import { buildCurrentPeriodDeliveryDemand, CurrentPeriodDeliveryDemand } from "./diagnosis/currentPeriodDeliveryDemand";
import { buildStandardAiSituationDiagnosis, StandardAiSituationDiagnosis } from "./diagnosis/situationDiagnosis";
import {
  computeBasicCurrentPeriodProductionRequirement,
  computeEligibleCurrentPeriodDemand,
  computeFinalProductionRequirement,
  computeNormalInventoryTargetByProduct,
} from "./diagnosis/productionRequirement";
import { buildStandardAiUnitEconomics } from "./diagnosis/forwardUnitEconomics";
import { buildStandardAiSalesForceHiringDecision, SalesHiringDiagnosticsRecord } from "./decision/salesForceHiring";
import { SALES_PARAMETERS_V1, SalesParameters } from "../../sales/parameters";
import { computeTargetScaleBand } from "./targetScale";
import { computeTargetCapability } from "./targetCapability";
import { STANDARD_AI_STRATEGIC_INTENT_V1 } from "./strategicIntent";
import { CompanyVision } from "../vision/types";
import { resolveCompanyVision, CompanyLabVisionOverrides } from "../vision/overrides";
import { computeStrategicGrowthState, StrategicGrowthState } from "../vision/strategicGrowth";
import { CommercialAmbition, COMMERCIAL_AMBITION_PARAMETERS_V1, computeCommercialAmbition } from "../vision/commercialAmbition";
import { computeUnservedOpportunity, UnservedOpportunity } from "../vision/unservedOpportunity";
import { buildCommercialGrowthDiagnostics } from "./diagnosis/commercialGrowth";
import { computeObservableCommercialOpportunity, computeOrientationWeightedOpportunity, ObservableCommercialOpportunity } from "./decision/sales";
import { evaluateNewFactoryDecision, NewFactoryAssessment } from "./decision/newFactory";
import { computeCommercialCommitment, COMMERCIAL_COMMITMENT_PARAMETERS_V1, CommercialCommitmentState } from "../vision/commercialCommitment";
import { ConversionObservation, observeContractConversion } from "./commercialHistory";
import { companySalesOrganizationCapacity, marketFragmentationFactor } from "../../sales/salesCapacityModel";
import { processingCapacity } from "../../sales/salesForce";
import { StandardAiObservation } from "./types";
import { assessGrowthPressure, computeGrowthPressureCore } from "./growth";
import { GrowthPressureAssessment } from "./growth/types";
import {
  assessStandardAiCrisisState,
  applyCrisisGateToCommercialCommitment,
  StandardAiCrisisAssessment,
  StandardAiCrisisState,
  StandardAiCrisisSignalCode,
} from "./crisisState";

// 【SAI-1.5 追記／マージ前受入修正】原因分解レポート（三宅さん指示）のため、
// 診断情報にこれまで捨てていた圧力スコア(pressures)と、当四半期の意思決定
// そのもの(decision＝「希望値」)を追加で保持する。計算そのものは重複させない
// （generateStandardAiDecisionWithDiagnostics内で既に計算済みの値をそのまま
// 詰め直すだけ）。既存の`entries`の意味・件数は変更しない。
export interface StandardAiQuarterDiagnostics {
  readonly companyId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly entries: readonly StandardAiDiagnosticEntry[];
  /** 当四半期の圧力スコア一式（レポートの「圧力値推移」節で使用）。 */
  readonly pressures: PressureScores;
  /** 当四半期にAIが提出した意思決定（＝「希望値」。ゲーム側の実行値・補正後の
   *  値と対比するため、レポート生成側で companySummaries 等と突き合わせる）。 */
  readonly decision: CompanyDecisionInput;
  /** 【SAI-3A】営業工数制約を適用する前の、会社×市場×商品ぶんの希望販売数量
   *  （decision.salesPlansは制約適用後の値のため、両者を突き合わせることで
   *  「事前希望案→営業工数調整後」の差分を再計算なしで追跡できる）。 */
  readonly salesWishByMarketProduct: readonly SalesWishEntry[];
  /**
   * 【SAI-4追加】経営性格プロファイルが有効な場合のみ設定される（createStandardAiProvider
   * に resolveParams オプションを渡した場合。既定=undefinedであり、既存の全出力・
   * 全テストへの影響はゼロ）。実装指示§8「基準値→バイアス後」の追跡用。
   */
  readonly managementProfile?: StandardAiManagementProfileDiagnostics;
  /**
   * 【SAI-6.1・6.3追加】Situation Diagnosis（不足型／過剰型の6カテゴリ診断）と
   * Current Period Delivery Demand（当期納品需要、Standard AI内部の中間概念）。
   * 診断専用の並行計算であり、本インターフェースの`decision`（実際の意思決定）には
   * 一切影響しない（今回のスコープでは意思決定ロジックを変更していない）。
   *
   * 【永続化の後方互換】optionalとしているのは、Phase Aで永続化を始めた
   * 既存の`aiProposalDiagnostics`（persistence/types.ts）に、この変更より前に
   * 保存されたドラフトが存在する場合、これらのフィールドを持たないため
   * （persistence/schema.tsのshallow validatorはこの2フィールドを必須にしていない）。
   * generateStandardAiDecisionWithDiagnosticsが新規生成する値では常に設定される。
   */
  readonly situationDiagnosis?: StandardAiSituationDiagnosis;
  readonly currentPeriodDeliveryDemand?: CurrentPeriodDeliveryDemand;
  /**
   * 【2026-08-09新設・Vision駆動の戦略成長】その四半期に有効だった Vision と、
   * 志に対する現在地（strategic scale gap / growth pressure）。
   * Vision が与えられていない会社では undefined（架空の Vision を作らない）。
   */
  readonly vision?: CompanyVision;
  readonly strategicGrowth?: StrategicGrowthState;
  /**
   * 【Phase 6】観測できる商業機会・今期目指した販売規模・取れなかった採算つき機会。
   * Vision がどこまで商業判断へ伝わったかを、画面と Pack の双方から追えるようにする。
   */
  readonly commercialAmbition?: CommercialAmbition;
  readonly observableOpportunity?: ObservableCommercialOpportunity;
  readonly unservedOpportunity?: UnservedOpportunity;
  /** 新工場を検討した結果（提案しなかった場合も、どのゲートで止まったかを保持する）。 */
  readonly newFactoryAssessment?: NewFactoryAssessment;
  /**
   * 【Phase 6C】今期どこまで市場へ取りに行くか（Commercial Commitment）と、
   * その根拠になった「提出 → 成約」転換率の観測。
   */
  readonly commercialCommitment?: CommercialCommitmentState;
  readonly conversionObservation?: ConversionObservation;
  /** 【Phase 6C・#05 §6】営業採用判断の構造化記録（採用0でも必ず理由が入る）。 */
  readonly salesHiring?: SalesHiringDiagnosticsRecord;
  /**
   * 【Phase SAI-GROW-3B-1】Liquidity SSoT の評価内訳。
   * Finance決定・既存増設CAPEX・新工場のすべてがこの同一assessmentを参照している。
   */
  readonly liquidity?: LiquidityAssessment;
  /** 当期にゲートを通した新規投資の支払額（horizon内合計）。 */
  readonly approvedInvestmentPaymentsThisTurnUsd?: number;
  /**
   * 【Phase SAI-GROW-3B-2】Fundable Operations / Survival & Recovery の評価結果。
   * ベンチマーク・受入テスト・Management Consoleがこの1件だけを読めば、
   * posture・fundable量・縮退の有無を追跡できる。
   */
  readonly fundableOperations?: FundableOperationsAssessment;
  /**
   * 【Phase SAI-GROW-3B-3】Deliverable Commitment の評価結果。
   * Commercial Ambition・cap前のCommitment・納品余力・backlog内訳・
   * binding constraint をこの1件から追跡できる。
   */
  readonly deliverableCommitment?: DeliverableCommitmentState;
  /**
   * 【Phase SAI-GROW-1】Shadow Growth Pressure（診断専用）。
   *
   * **この値はStandard AIの意思決定に一切使われない。** 販売希望量・営業採用・
   * 生産・調達・CAPEX・配当のいずれもこのassessmentを読まない（実装指示§0・§26）。
   * すべての意思決定が確定した**後**に、確定済みの値だけを入力として評価するため、
   * 構造的にDecisionへ影響し得ない。GROW-2以降で接続を検討する。
   */
  readonly growthPressure?: GrowthPressureAssessment;
  /**
   * 【Standard AI Crisis Management・Phase CM-1・指示§15】この四半期のCrisis State
   * 判断そのもの。Management Console・Analysis Pack・Claude explanationが読む
   * 唯一のSSoT。旧スナップショット（この機能追加前に保存されたドラフト）には
   * 存在しないためoptional（架空の値を捏造しない）。
   */
  readonly crisis?: {
    readonly state: StandardAiCrisisState;
    readonly signals: readonly StandardAiCrisisSignalCode[];
    readonly summary: string;
    readonly procurementScaleRatio: number | null;
    readonly underwritingFrozen: boolean | null;
    readonly newSalesSuppressed: boolean;
    readonly capexPaused: boolean;
    readonly salesHiringStopped: boolean;
  };
}

/**
 * 【SAI-4追加】1社・1四半期ぶんの経営性格プロファイル適用結果（診断専用）。
 * 「STANDARD_AI_PARAMETERS_V1による基準判断」と「プロファイル適用後の判断
 * （＝実際にゲームへ提出される決定。安全ガードは既にdecision内に反映済み）」を
 * 区別できるようにするためのもの。
 */
export interface StandardAiManagementProfileDiagnostics {
  readonly profileId: string;
  /** このプロファイルが基準値から実際に変更したパラメータ項目一覧（0件=A社balanced相当）。 */
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
  /**
   * バイアスなし（STANDARD_AI_PARAMETERS_V1）で同一入力を評価した場合の判断。
   * appliedBiasItemsが1件もない場合（バイアスなし＝decisionと数学的に同一になる）は
   * 無駄な二重計算を避けるため計算しない（undefined）。
   *
   * 【実装指示§4の制約への対応】Standard AI全体を大規模に二重実行するのではなく、
   * 「entryポイント（generateStandardAiDecisionWithDiagnostics）をもう一度、
   * 基準パラメータで呼ぶだけ」という最小実装にとどめている。ゲームエンジン・
   * 状態遷移・他四半期への影響は一切ない（純粋関数の再呼び出しのみ）。
   */
  readonly baselineDecision?: CompanyDecisionInput;
}

export interface StandardAiDecisionWithDiagnostics {
  readonly decision: CompanyDecisionInput;
  readonly diagnostics: StandardAiQuarterDiagnostics;
}


/**
 * 【Phase 6C】営業組織が今期に捌ける案件量の上限（HOSO換算トン）。
 *
 * 【重要】これは「必ず成約する量」ではなく「提出できる量の上限要因の一つ」である
 * （#05 §9）。市場配分（誰がどれだけ取れるか）とは無関係。
 *
 * 【SSoT】能力そのものは sales/salesCapacityModel.ts の1箇所からしか取らない。
 * perMarket（既定）では市場ごとの曲線の合計、会社全体モデルでは会社1回ぶんの能力に
 * 市場分散係数を掛けた値になる。工数（effort）→ トン換算には、最も軽い HOSO の
 * 係数を使う。商品構成はこの時点でまだ確定していないため、**上限として最も緩い**
 * 換算を採る（この上限が実際の商品構成より厳しくなって成長を止めることを避ける）。
 */
function salesCapacityCeilingTons(observation: StandardAiObservation, salesParams: SalesParameters): number | null {
  const model = salesParams.salesCapacityModel;
  const totalHeadcount = observation.salesForceHeadcountTotal;
  const marketCount = observation.markets.length;
  if (!Number.isFinite(totalHeadcount) || marketCount <= 0) return null;

  const lightestCoefficient = Math.min(
    salesParams.salesEffortCoefficients.hoso,
    salesParams.salesEffortCoefficients.pd,
    salesParams.salesEffortCoefficients.vap
  );
  if (lightestCoefficient <= 0) return null;

  let effortCapacity: number;
  if (!model || model.kind === "perMarket") {
    // 市場別モデルでは、能力曲線が凹関数であるため**均等配置のときに合計が最大**になる。
    // ここは上限（最も緩い見積り）を求める場所なので、均等配置で評価する。
    // processingCapacity は整数人数しか受け付けないため、均等配置を整数で近似する
    // （端数は切り上げ側の市場へ寄せる。上限見積りとしての意味は変わらない）。
    const base = Math.floor(totalHeadcount / marketCount);
    const remainder = Math.max(0, Math.round(totalHeadcount) - base * marketCount);
    effortCapacity =
      (marketCount - remainder) * unwrapUnit(processingCapacity(base, salesParams)) +
      remainder * unwrapUnit(processingCapacity(base + 1, salesParams));
  } else {
    effortCapacity = companySalesOrganizationCapacity(totalHeadcount, model) * marketFragmentationFactor(marketCount, model);
  }
  return effortCapacity / lightestCoefficient;
}


/** 【Phase 6C】Commercial Commitment の判断根拠を理由コードとして残す（#05 §14）。 */
function buildCommitmentDiagnostics(
  companyId: string,
  commitment: CommercialCommitmentState,
  conversion: ConversionObservation
): StandardAiDiagnosticEntry[] {
  const entries: StandardAiDiagnosticEntry[] = [];

  const limiterCode: Partial<Record<CommercialCommitmentState["limiter"], StandardAiDiagnosticEntry["code"]>> = {
    RECENT_CONVERSION: "SALES_SUBMISSION_LIMITED_BY_RECENT_CONVERSION",
    SALES_CAPACITY: "SALES_SUBMISSION_LIMITED_BY_SALES_CAPACITY",
    MARKET_OPPORTUNITY: "SALES_SUBMISSION_LIMITED_BY_MARKET_OPPORTUNITY",
    STRETCH_LIMIT: "SALES_SUBMISSION_EXPANDED_FOR_GROWTH",
    NONE: "SALES_SUBMISSION_EXPANDED_FOR_GROWTH",
  };
  const code = limiterCode[commitment.limiter];
  if (code) {
    entries.push({
      code,
      domain: "sales",
      companyId,
      severity: "info",
      keyValues: {
        submissionTargetTons: commitment.submissionTargetTons,
        ambitionTons: commitment.caps.ambitionTons,
        stretchOverAmbition: commitment.stretchOverAmbition,
        expectedConversionRatio: commitment.expectedConversionRatio,
        observedConversionRatio: conversion.conversionRatio ?? -1,
        observedQuarters: conversion.observedQuarters,
        salesCapacityCeilingTons: commitment.caps.salesCapacityTons ?? -1,
        marketOpportunityTons: commitment.caps.opportunityTons ?? -1,
      },
      message:
        `今期の提出目標は${Math.round(commitment.submissionTargetTons)}トン` +
        `（志${Math.round(commitment.caps.ambitionTons)}トンの${(commitment.stretchOverAmbition * 100).toFixed(0)}%）。` +
        (conversion.conversionRatio === null
          ? "直近の成約実績が無いため、提出どおり成約する前提は置かず目標成約率で見積もった。"
          : `直近${conversion.observedQuarters}四半期の成約率${(conversion.conversionRatio * 100).toFixed(0)}%を踏まえ、` +
            `期待成約率${(commitment.expectedConversionRatio * 100).toFixed(0)}%で逆算した。`),
    });
  }

  if (commitment.overSubmissionRisk) {
    entries.push({
      code: "OVER_SUBMISSION_RISK_HIGH",
      domain: "sales",
      companyId,
      severity: "warning",
      keyValues: {
        observedConversionRatio: conversion.conversionRatio ?? -1,
        submittedTons: conversion.submittedTons,
        contractedTons: conversion.contractedTons,
      },
      message:
        `直近${conversion.observedQuarters}四半期で${Math.round(conversion.submittedTons)}トン提出して` +
        `${Math.round(conversion.contractedTons)}トンしか成約していない。提出量に対する成約率が低い状態が続いている。`,
    });
  }

  return entries;
}

/**
 * 【Standard AI Crisis Management・Phase CM-1・指示§13】Crisis Stateの検知シグナルと、
 * 実際に抑制が発動したことを、既存のreason-code体系で必ず残す。
 */
function buildCrisisDiagnostics(
  companyId: string,
  crisis: StandardAiCrisisAssessment,
  observation: StandardAiObservation,
  actions: { readonly newSalesSuppressed: boolean; readonly capexPaused: boolean; readonly salesHiringStopped: boolean }
): StandardAiDiagnosticEntry[] {
  const entries: StandardAiDiagnosticEntry[] = [];
  const keyValues = {
    scaleRatio: observation.lastQuarterProcurementScaleRatio ?? -1,
    underwritingFrozen: observation.lastQuarterUnderwritingFrozen ? 1 : 0,
    importOrdersBlocked: observation.lastQuarterImportOrdersBlocked ? 1 : 0,
  };

  for (const signal of crisis.signals) {
    entries.push({
      code: signal,
      domain: "crisis",
      companyId,
      severity: crisis.state === "SEVERE_DISTRESS" ? "critical" : "warning",
      keyValues,
      decisionSummary: `Crisis State: ${crisis.state}`,
      message: crisis.summary,
    });
  }

  if (actions.newSalesSuppressed) {
    entries.push({
      code: "CRISIS_NEW_SALES_SUPPRESSED",
      domain: "crisis",
      companyId,
      severity: "critical",
      keyValues,
      decisionSummary: "新規Commercial Commitmentを縮小・停止",
      message: "資金制約により原料調達が停止・大幅縮小しているため、新規受注（Commercial Commitment）を縮小・停止し、既存Backlogの履行を優先している。Vision・Commercial Ambition自体は変更していない。",
    });
  }
  if (actions.capexPaused) {
    entries.push({
      code: "CRISIS_CAPEX_PAUSED",
      domain: "crisis",
      companyId,
      severity: "critical",
      keyValues,
      decisionSummary: "新規設備投資提案を停止（着工済み案件は継続）",
      message: "資金繰り危機のため、新規の設備投資提案（既存増設・新工場を含む）を停止した。既に着工済みの案件は勝手にキャンセルしていない。",
    });
  }
  if (actions.salesHiringStopped) {
    entries.push({
      code: "CRISIS_SALES_HIRING_STOPPED",
      domain: "crisis",
      companyId,
      severity: "critical",
      keyValues,
      decisionSummary: "営業採用を停止",
      message: "資金繰り危機のため、営業人員の新規採用を停止した。既存営業人員の自動解雇はこの判断では行っていない。",
    });
  }

  return entries;
}

/**
 * 標準AIの意思決定一式を、診断情報つきで生成する（純粋関数。副作用・内部状態を
 * 一切持たない。同一入力・同一パラメータなら常に同一出力＝決定論的）。
 */
export function generateStandardAiDecisionWithDiagnostics(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1,
  /** 【Phase 6B】営業パラメータの上書き（比較用。未指定なら既定）。 */
  salesParams: SalesParameters = SALES_PARAMETERS_V1,
  /**
   * 【Management Console Vision Calibration・指示§17】Run固有のVision上書き
   * （未指定なら従来どおりvision/defaults.tsの既定Visionのみを使う。挙動不変）。
   * Vision解決は必ずvision/overrides.tsのresolveCompanyVision（唯一のSSoT）を
   * 通す。ここでdefaultVisionDocumentFor/resolveVisionAtTurnを直接呼ばない。
   */
  visionOverrides?: CompanyLabVisionOverrides
): StandardAiDecisionWithDiagnostics {
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, params);

  // 【Standard AI Crisis Management・Phase CM-1】既存Finance診断シグナル
  // （前Turnの調達制約・銀行underwriting・財務健全性）だけからCrisis Stateを導出する。
  // Finance formula自体（computeProcurementConstraint・銀行underwriting・
  // insolvency判定式）は一切ここで再計算しない（crisisState.ts参照）。
  // Vision・Strategic Growth・Strategy Profileより下位の安全層として、以降の
  // Commercial Commitment・CAPEX・Sales Hiringの各判断へこの結果を通す。
  const crisisAssessment: StandardAiCrisisAssessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: observation.lastQuarterProcurementScaleRatio,
    lastQuarterUnderwritingFrozen: observation.lastQuarterUnderwritingFrozen,
    lastQuarterImportOrdersBlocked: observation.lastQuarterImportOrdersBlocked,
    lastQuarterFinancialHealthTier: observation.lastQuarterFinancialHealthTier,
  });

  // 【2026-08-09・Phase 6】Vision → Commercial Ambition を**販売計画より前**に求める。
  // Phase 5 では Vision が新工場判断にしか届いておらず、販売希望量は
  // 「自社能力 × salesUtilizationTarget」だけで決まっていた（監査で実測）。
  const targetScaleResult = computeTargetScaleBand(fixture, observation, STANDARD_AI_STRATEGIC_INTENT_V1, params);
  const vision: CompanyVision | null = resolveCompanyVision(fixture.companyId, turn, visionOverrides);
  const strategicGrowth: StrategicGrowthState | null = vision
    ? computeStrategicGrowthState({ vision, turn, currentSustainableScaleTons: targetScaleResult.currentSustainableScaleTons })
    : null;

  // 観測できる商業機会（採算つき）。未来の TRUE WORLD は含まれない。
  const observableOpportunity = computeObservableCommercialOpportunity(observation, salesParams);
  const capacityAnchorTons = sumProductAmount({ ...observation.totalCapacityByProduct }) * params.salesUtilizationTarget;
  const recentActualScaleTons =
    (observation.lastQuarterActualProductionByProduct.hoso ?? 0) +
    (observation.lastQuarterActualProductionByProduct.pd ?? 0) +
    (observation.lastQuarterActualProductionByProduct.vap ?? 0);
  // 【Phase SAI-GROW-2】Adaptive Opportunity Share。
  //
  // Growth Pressureの中心部（core）を**意思決定より前**に評価し、そこから
  // Commercial Ambition / Commercial Commitment の機会shareだけを可変にする。
  //
  // 【非循環である理由】coreのopportunity headroomの分母は「現在の自社規模」
  // （= max(能力×salesUtilizationTarget, 前期実績生産)）であり、提出量にも
  // 0.35/0.5にも依存しない。したがってshareを動かしてもheadroomは動かない。
  //
  // 【Growth Pressure LOWでは現行と完全同一】shareExpansionRatio=0のとき
  // effectiveShareはlegacy値そのものになるため、LOWの会社・LOWのTurnの判断は
  // 従来とビット単位で同一になる（実装指示§9）。
  const orientationWeighted = computeOrientationWeightedOpportunity(
    observation,
    salesParams,
    params.marketOrientationMultipliers,
    params.productOrientationMultipliers
  );
  const growthCore = computeGrowthPressureCore({
    companyId: fixture.companyId,
    period,
    observation,
    contracts: ownState.contracts,
    visionReferenceScaleTons: strategicGrowth ? strategicGrowth.visionTargetScaleAtCurrentTurn : null,
    growthAmbition: vision ? vision.growthAmbition : null,
    strategicPosture: vision?.strategicPosture ?? null,
    financialRiskTolerance: vision ? vision.financialRiskTolerance : null,
    currentRelevantScaleTons: Math.max(capacityAnchorTons, recentActualScaleTons),
    attainableProfitableTons: observableOpportunity.attainableProfitableTons,
    orientationWeightedOpportunityTons: orientationWeighted.weightedAttainableProfitableTons,
    weightedContributionUsdPerKg: observableOpportunity.weightedContributionUsdPerKg,
    priceObservationMissing: observableOpportunity.priceObservationMissing,
    observedConversionRatio: observeContractConversion({ records: ownState.recentSalesSubmissions ?? [] }, ownState.contracts, turn).conversionRatio,
    finishedGoodsExcessRatioByProduct: pressures.finishedGoodsExcessRatioByProduct,
    crisisState: crisisAssessment.state,
    lastQuarterFinancialHealthTier: observation.lastQuarterFinancialHealthTier,
    salesParams,
    params: params.growthPressure,
  });

  const commercialAmbitionInput = {
    vision,
    strategicGrowth,
    capacityAnchorTons,
    recentActualScaleTons,
    // 【GROW-2】機会shareだけをGrowth Pressureで可変にする（他の式は無変更）。
    params: { ...COMMERCIAL_AMBITION_PARAMETERS_V1, realisticShareOfProfitableOpportunity: growthCore.effectiveOpportunityShare.ambition },
    // 【GROW-3A】1四半期の伸び幅上限に掛ける倍率（observable evidenceが無ければ1＝従来と同一）。
    stepLimitMultiplier: growthCore.growthEvidenceMultiplier,
    attainableProfitableTons: observableOpportunity.attainableProfitableTons,
    weightedContributionUsdPerKg: observableOpportunity.weightedContributionUsdPerKg,
    priceObservationMissing: observableOpportunity.priceObservationMissing,
    maxFinishedGoodsExcessRatio: Math.max(
      pressures.finishedGoodsExcessRatioByProduct.hoso,
      pressures.finishedGoodsExcessRatioByProduct.pd,
      pressures.finishedGoodsExcessRatioByProduct.vap
    ),
  };
  const commercialAmbition = computeCommercialAmbition(commercialAmbitionInput);
  // 【GROW-3A診断用】step倍率を掛けなかった場合のambition（差分＝拡大の効果）。
  // 純粋関数の再評価のみで、ゲーム状態・他の判断には一切影響しない。
  const commercialAmbitionWithBaseStep =
    growthCore.growthEvidenceMultiplier > 1
      ? computeCommercialAmbition({ ...commercialAmbitionInput, stepLimitMultiplier: 1 })
      : commercialAmbition;


  // 【Phase 6C】Commercial Ambition（売りたい量）から Commercial Commitment
  // （今期どこまで取りに行くか）を分離する。過去の「提出 → 成約」転換率を
  // bounded rational に学習し、成約しない量まで市場へ提出しない。
  const conversionObservation = observeContractConversion(
    { records: ownState.recentSalesSubmissions ?? [] },
    ownState.contracts,
    turn
  );
  const salesCapacityTonsForCommitment = salesCapacityCeilingTons(observation, salesParams);
  const commercialCommitmentBeforeCrisisGate = computeCommercialCommitment({
    // 【GROW-2】提出shareだけをGrowth Pressureで可変にする（転換率学習等は無変更）。
    params: { ...COMMERCIAL_COMMITMENT_PARAMETERS_V1, realisticShareOfOpportunity: growthCore.effectiveOpportunityShare.commitment },
    ambition: commercialAmbition,
    capacityAnchorTons,
    attainableProfitableTons: observableOpportunity.attainableProfitableTons,
    observedConversionRatio: conversionObservation.conversionRatio,
    observedQuarters: conversionObservation.observedQuarters,
    salesCapacityTons: salesCapacityTonsForCommitment,
    backlogTons: sumProductAmount({ ...observation.outstandingContractByProduct } as never),
    finishedGoodsTons: sumProductAmount({ ...observation.finishedGoodsByProduct }),
  });
  // 【Phase SAI-GROW-3B-3・実装指示§2/§3/§6】Deliverable Commitment。
  // Commercial Ambition（志）は一切変更せず、「今期の提出量」だけを納品可能量で抑える。
  //
  // 【§12 Survivalとの適用順】危機時（LIQUIDITY_STRESS / SEVERE_DISTRESS）は既存の
  // Crisis Gateと3B-2のFundable Operationsが先に効いているため、ここで重ねて抑えると
  // 二重抑制になる。deliverability capはcrisisStateがNORMALのときだけ適用し、
  // 危機会社には既存のCrisis / Operations制約を優先させる。
  const fundableRawMaterialView = computeFundableRawMaterial({
    observation,
    pressures,
    params,
    crisisState: crisisAssessment.state,
    financialRiskTolerance: vision ? vision.financialRiskTolerance : null,
    growthParams: params.growthPressure,
  });
  const nearTermBindingProductionCapacityTons = computeBindingProductionCapacityTons(
    observation.nearTermEffectiveCapacityByProduct,
    observation.nearTermEffectiveCommonProcessingCapacity
  );
  const deliverableCommitment: DeliverableCommitmentState = computeDeliverableCommitment({
    commitmentBeforeDeliverabilityTons: commercialCommitmentBeforeCrisisGate.submissionTargetTons,
    expectedConversionRatio: commercialCommitmentBeforeCrisisGate.expectedConversionRatio,
    finishedGoodsByProduct: observation.finishedGoodsByProduct,
    bindingProductionCapacityTons: computeBindingProductionCapacityTons(
      observation.totalEffectiveCapacityByProduct,
      observation.totalEffectiveCommonProcessingCapacity
    ),
    nearTermBindingProductionCapacityTons,
    fundableRawMaterialTons: fundableRawMaterialView.fundableRawMaterialTons,
    overdueBacklogByProduct: observation.overdueBacklogByProduct,
    healthyForwardBacklogByProduct: observation.healthyForwardBacklogByProduct,
    rawMaterialLimitedByFunding:
      fundableRawMaterialView.priceKnown &&
      fundableRawMaterialView.fundableDomesticProcurementTons < nearTermBindingProductionCapacityTons,
    deliveryLeadTimeQuarters: observation.deliveryLeadTimeQuarters,
    minimumMarketPresenceRatio: params.minDomesticPurchaseRatioOfBase,
  });
  const applyDeliverabilityCap = crisisAssessment.state === "NORMAL" && deliverableCommitment.applied;
  const commercialCommitmentAfterDeliverability: CommercialCommitmentState = applyDeliverabilityCap
    ? {
        ...commercialCommitmentBeforeCrisisGate,
        submissionTargetTons: deliverableCommitment.finalSubmissionTargetTons,
        limiter: "DELIVERABILITY",
      }
    : commercialCommitmentBeforeCrisisGate;

  // 【指示§5/§6/§7】Crisis Gate。computeCommercialCommitment自体（志の量・
  // 転換率学習等）は一切変更しない。危機時はこの出力（新規提出量の上限）だけを
  // 縮小・停止する。Vision Ambition（commercialAmbition）はこの後も一切変更しない
  // ため、「志は残るが今は守りに入っている」が両立する。既存Backlogは
  // outstandingContractByProduct経由で別途、生産必要量計算（confirmed）へ
  // 100%反映され続ける（このgateの影響を受けない）。
  const commercialCommitment: CommercialCommitmentState = applyCrisisGateToCommercialCommitment(
    commercialCommitmentAfterDeliverability,
    crisisAssessment
  );

  const salesResult = buildStandardAiSalesPlans(
    fixture,
    observation,
    pressures,
    params,
    salesParams,
    commercialAmbition.ambitionMultiplier,
    commercialCommitment.submissionTargetTons
  );

  // 【SAI-6.4】生産計画の営業側inputを、工場能力起点の理論希望量（desiredByProduct）から
  // Standard AI内部の当期納品需要（currentPeriodDeliveryDemand、SAI-6.3）起点の
  // 「基本当期生産必要量」へ切り替える。当期納品需要は既にrealisticSalesByProduct
  // （現実的販売可能量）＋outstandingContractByProduct（既存契約）を含んでいるため、
  // ここで既存契約を再度加算しない（二重計上防止。実装指示C-2、および
  // diagnosis/productionRequirement.tsのコメント参照）。
  //
  // 【Unit Economics差し込み口（実装指示C-4）】computeEligibleCurrentPeriodDemand()は
  // 今回identity実装（当期納品需要をそのまま返す）。将来Unit Economics採算フィルターを
  // 実装する際は、この関数の内部だけを置き換える想定であり、production.ts・policy.tsの
  // 側は密結合させない。
  //
  // 【戦略先行生産（実装指示C-3）】今回は常に0（strategicProductionAdjustmentByProduct省略時
  // のデフォルト）。Test14 Turn1を含む今回のスコープでは戦略在庫理由が観測されていない。
  // 【Phase 6C・#05 §10】生産必要量の需要側は、提出量をそのまま使わない。
  // 確定した受注残は100%、未成約の販売計画は期待成約率を掛けて織り込む。
  const deliveryDemandResult = buildCurrentPeriodDeliveryDemand(
    fixture.companyId,
    observation,
    salesResult.realisticSalesByProduct,
    commercialCommitment.productionExpectedConversionRatio
  );
  const eligibleCurrentPeriodDemand = computeEligibleCurrentPeriodDemand(deliveryDemandResult.deliveryDemand);
  const normalInventoryTargetByProduct = computeNormalInventoryTargetByProduct(observation, params);
  const basicProductionRequirementByProduct = computeBasicCurrentPeriodProductionRequirement(
    eligibleCurrentPeriodDemand,
    normalInventoryTargetByProduct,
    observation.finishedGoodsByProduct
  );
  const finalProductionRequirementByProduct = computeFinalProductionRequirement(basicProductionRequirementByProduct);

  // 【Phase SAI-GROW-3B-2・実装指示§2】Fundable Operations。
  // engineのcomputeProcurementConstraintと同じ式で「当期に資金手当てできる原料量」を
  // 生産計画より**前**に求める。procurementCashPlanには依存しないため循環しない
  // （借入見込みは3B-1のrealisticallyAvailableBorrowingUsdをそのまま再利用する）。
  const fundableOperations: FundableOperationsAssessment = assessFundableOperations({
    observation,
    pressures,
    params,
    crisisState: crisisAssessment.state,
    financialRiskTolerance: vision ? vision.financialRiskTolerance : null,
    productionRequirementTons: sumProductAmount(finalProductionRequirementByProduct),
    growthParams: params.growthPressure,
  });

  const productionResult = buildStandardAiProductionPlans(
    fixture,
    observation,
    pressures,
    finalProductionRequirementByProduct,
    // NORMAL時はundefinedを渡す＝現行挙動を完全に維持する（実装指示§3）。
    fundableOperations.appliesProductionCap ? fundableOperations.fundableRawMaterialTons : undefined
  );
  const requiredRawMaterial = productionResult.productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const requiredRawMaterialUnconstrained = sumProductAmount(productionResult.neededByProduct);

  // 【実装指示§4】調達計画は縮退後のproduction requirementへ自動的に追従する
  // （requiredRawMaterialが縮退後の生産計画から算出されるため、
  //  「毎期18,963t希望し続けてengine側で0へ削られる」状態にならない）。
  const procurementResult = buildStandardAiProcurementPlan(fixture, observation, pressures, requiredRawMaterial, period, params);
  const laborResult = buildStandardAiWorkerAssignments(fixture, observation, pressures, productionResult.productionPlans, params);
  // 【Test16】資金繰り判断へ当期の原料調達計画を渡す。これにより「原料を買うのに
  // 資金が要る」ことが借入判断の入力になる（従来は最低現金バッファだけで決めていた）。
  // 調達計画は上で確定済みであり、循環しない。
  const procurementCashPlan = {
    domesticDesiredQuantityTons: unwrapUnit(procurementResult.domesticPurchasePlan.desiredQuantity),
    importOrderedQuantityTons: procurementResult.importOrders.reduce((sum, o) => sum + unwrapUnit(o.orderedQuantity), 0),
  };

  // 【Phase SAI-GROW-3B-1・実装指示§1・§9】Liquidity SSoT。
  //
  // 【decision ordering の解き方（選択肢A+B）】
  //  (A) 「いくらまで投資に回せるか」は、CAPEXとFinanceの**両方より前**に、
  //      1つのpure resolverで確定させる（この行）。両者は同じassessmentを見る。
  //  (B) 借入額はCAPEX確定後に決める。investment → financing の順にしたのは、
  //      「当期承認した投資の支払」を借入必要額へ織り込むためであり、
  //      逆順（従来）では CAPEX が Finance の結果を見られず、両者が矛盾していた。
  //      capex/newFactory は financingResult を参照しないため、循環は生じない。
  const liquidityAssessment = assessCommittedCashRequirement({
    observation,
    pressures,
    params,
    procurementCashPlan,
    crisisState: crisisAssessment.state,
    financialRiskTolerance: vision ? vision.financialRiskTolerance : null,
    growthParams: params.growthPressure,
  });
  // 同一Turn内に承認した提案の支払を積み上げる（各案件が同じ現金を満額使う旧構造を塞ぐ）。
  let approvedInvestmentPaymentsThisTurnUsd = 0;
  let approvedInvestmentPaymentsThisQuarterUsd = 0;
  const liquidityGate: LiquidityGateContext = {
    assessment: liquidityAssessment,
    horizonQuarters: COMMITTED_CAPEX_HORIZON_QUARTERS,
    alreadyApprovedThisTurnUsd: () => approvedInvestmentPaymentsThisTurnUsd,
    alreadyApprovedThisQuarterUsd: () => approvedInvestmentPaymentsThisQuarterUsd,
    commit: (paymentsUsd: number, paymentsThisQuarterUsd: number) => {
      approvedInvestmentPaymentsThisTurnUsd += Math.max(0, paymentsUsd);
      approvedInvestmentPaymentsThisQuarterUsd += Math.max(0, paymentsThisQuarterUsd);
    },
  };

  const liquidityDiagnostic: StandardAiDiagnosticEntry = {
    code: "LIQUIDITY_ASSESSED",
    domain: "finance",
    companyId: fixture.companyId,
    severity: liquidityAssessment.liquidityHeadroomUsd < 0 ? "warning" : "info",
    keyValues: {
      currentCash: liquidityAssessment.currentCashUsd,
      expectedArCollection: liquidityAssessment.expectedArCollectionUsd,
      realisticallyAvailableBorrowing: liquidityAssessment.realisticallyAvailableBorrowingUsd,
      availableLiquidity: liquidityAssessment.availableLiquidityUsd,
      operatingWorkingCapitalRequirement: liquidityAssessment.operatingWorkingCapitalRequirementUsd,
      minimumProtectedOperatingRequirement: liquidityAssessment.minimumProtectedOperatingRequirementUsd,
      debtServiceRequirement: liquidityAssessment.debtServiceRequirementUsd,
      committedCapitalPayments: liquidityAssessment.committedCapitalPaymentsUsd,
      committedCapitalPaymentsThisQuarter: liquidityAssessment.committedCapitalPaymentsThisQuarterUsd,
      minimumOperatingCashReserve: liquidityAssessment.minimumOperatingCashReserveUsd,
      crisisBuffer: liquidityAssessment.crisisBufferUsd,
      protectedFundingRequirement: liquidityAssessment.protectedFundingRequirementUsd,
      liquidityHeadroom: liquidityAssessment.liquidityHeadroomUsd,
      cashBasedHeadroom: liquidityAssessment.cashBasedHeadroomUsd,
      currentTurnFundableBorrowing: liquidityAssessment.currentTurnFundableBorrowingUsd,
      currentTurnFundableHeadroom: liquidityAssessment.currentTurnFundableHeadroomUsd,
      financingNeed: liquidityAssessment.financingNeedUsd,
    },
    decisionSummary:
      liquidityAssessment.liquidityHeadroomUsd >= 0
        ? `投資へ回せる流動性 ${Math.round(liquidityAssessment.liquidityHeadroomUsd).toLocaleString()} USD`
        : `流動性が守るべき資金を ${Math.round(-liquidityAssessment.liquidityHeadroomUsd).toLocaleString()} USD 下回っている`,
    message:
      `利用可能流動性 ${Math.round(liquidityAssessment.availableLiquidityUsd).toLocaleString()} USD` +
      `（現金 ${Math.round(liquidityAssessment.currentCashUsd).toLocaleString()} ＋ 売掛回収 ${Math.round(
        liquidityAssessment.expectedArCollectionUsd
      ).toLocaleString()} ＋ 現実的な借入余力 ${Math.round(liquidityAssessment.realisticallyAvailableBorrowingUsd).toLocaleString()}）に対し、` +
      `守るべき資金 ${Math.round(liquidityAssessment.protectedFundingRequirementUsd).toLocaleString()} USD` +
      `（最低操業 ${Math.round(liquidityAssessment.minimumProtectedOperatingRequirementUsd).toLocaleString()} ＋ 元利 ${Math.round(
        liquidityAssessment.debtServiceRequirementUsd
      ).toLocaleString()} ＋ 承認済み投資 ${Math.round(liquidityAssessment.committedCapitalPaymentsUsd).toLocaleString()} ＋ 最低現金 ${Math.round(
        liquidityAssessment.minimumOperatingCashReserveUsd
      ).toLocaleString()}${liquidityAssessment.crisisBufferUsd > 0 ? ` ＋ 危機buffer ${Math.round(liquidityAssessment.crisisBufferUsd).toLocaleString()}` : ""}）。`,
  };

  const capexResult = buildStandardAiCapexDecision(
    fixture,
    observation,
    pressures,
    productionResult.neededByProduct,
    requiredRawMaterialUnconstrained,
    params,
    undefined,
    liquidityGate
  );
  // 【Standard AI Capability Expansion・Phase CE-2】VAP商品開発費（tier選択）。
  // capex.tsのnewProjectProposalsとは独立した意思決定軸（CapitalProjectTypeでは
  // ない・factory非依存）だが、経済性・戦略適合・財務ゲート・Crisis Gateという
  // 判断の骨格はPD Mechanization（CE-1）と同じ思想を踏襲する。
  const vapProductDevelopmentResult = buildStandardAiVapProductDevelopmentDecision(fixture, observation, pressures, params);

  // 【SAI-6.4改訂】Current Period Delivery Demand（当期納品需要）は、今回から
  // decision.productionPlansの実際の入力として使われている（上で計算済みの
  // deliveryDemandResult）。診断出力としても、実際に使われた値をそのまま再利用する
  // （計算を重複させない）。
  //
  // 【SAI-6.1】Situation Diagnosis（不足型／過剰型の6カテゴリ診断）は、依然として
  // 診断専用の並行計算であり、上のdecisionには影響しない（診断内部で再計算する
  // 基本当期生産必要量は、上のfinalProductionRequirementByProductと同じ共通実装
  // diagnosis/productionRequirement.tsを使うため、値は一致する）。
  const situationDiagnosisResult = buildStandardAiSituationDiagnosis(
    fixture,
    observation,
    pressures,
    salesResult.desiredByProduct,
    salesResult.realisticSalesByProduct,
    deliveryDemandResult.deliveryDemand,
    params
  );

  // 【2026-08-05新設・営業採用/減員】market opportunity(Forward Unit Economics)→
  // sales capacity→production capacity→raw material→cashの連鎖で、1人ずつの
  // marginal economicsを確認しながらsalesForceHireCount/salesForceLayoffCountを
  // 決定する。production decision・Worker decision・procurement decision・
  // finance decisionのいずれの計算結果も変更しない（既に計算済みの値を読むだけ）。
  const unitEconomicsResult = buildStandardAiUnitEconomics(observation);

  // 【2026-08-05新設・Strategic Intent / Target Scale】三宅さんご指示により、
  // 「限界利益が正な間は増員」ではなく「この会社が目指す規模（Target Scale Band）
  // に必要な人数」を営業採用判断の中心に据える。Strategic Intentは今回、Standard AI
  // 共通のBALANCED_GROWTHを使う（会社別性格への拡張は将来、この定数を差し替える
  // だけで済む設計）。8期先市場の精密予測は行わず、現在の会社規模・実効生産能力・
  // 成長姿勢から算定する（targetScale.ts参照）。
  const liquidityFloorUsdForCapability = observation.cashUsd - pressures.targetMinimumCashUsd;
  const approxVariableCostUsdPerTon =
    (observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg.hoso +
      observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg.pd +
      observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg.vap) /
    3 /
    1000; // USD/kg -> USD/トン簡易換算（3商品単純平均。精密な商品別配分はここでは行わない）。
  const targetCapabilityResult = computeTargetCapability({
    fixture,
    observation,
    targetScaleBand: targetScaleResult.targetScaleBand,
    liquidityFloorUsd: liquidityFloorUsdForCapability,
    approxVariableCostUsdPerTon,
  });

  // 【2026-08-09新設・Vision駆動の戦略成長】会社の「志」（Vision）を外から与え、
  // その志と現在地の差（strategic scale gap）から成長圧力を測る。
  //
  // 【役割分担】Vision を決めるのは人間の経営者であり、Standard AI ではない。
  // Standard AI はここで成長目標を発明せず、与えられた志に対する遅れへ反応するだけ。
  // 未来の TRUE WORLD は computeStrategicGrowthState の引数に存在しない。
  // 【Phase 6】取りたかったが取れなかった採算つき機会と、その原因分解。
  // 「稼働率がまだ75%だから新工場は不要」だけで判断しないための一次情報である。
  const submittedSalesTons = salesResult.salesPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const desiredBeforeEffortTons = salesResult.salesWishByMarketProduct.reduce(
    (sum, w) => sum + w.desiredQuantityBeforeEffortConstraint,
    0
  );
  const bindingProductionCapacityTons = computeBindingProductionCapacityTons(
    observation.totalEffectiveCapacityByProduct,
    observation.totalEffectiveCommonProcessingCapacity
  );
  const unservedOpportunity = computeUnservedOpportunity({
    commercialAmbitionTons: commercialAmbition.ambitionTons,
    desiredBeforeEffortTons,
    submittedSalesTons,
    bindingProductionCapacityTons,
    heldByInventory: commercialAmbition.limiter === "INVENTORY_EXCESS",
    // 【推測しない】労働・原料が制約かどうかは、既存の状況診断が名指しした場合だけ。
    laborIsBindingConstraint: situationDiagnosisResult.diagnosis.workerLoadState === "shortage",
    rawMaterialIsBindingConstraint: situationDiagnosisResult.diagnosis.rawMaterialSupplyConstraintState === "shortage",
  });

  const commercialGrowthDiagnostics = buildCommercialGrowthDiagnostics({
    companyId: fixture.companyId,
    vision,
    strategicGrowth,
    opportunity: observableOpportunity,
    ambition: commercialAmbition,
    unserved: unservedOpportunity,
    submittedSalesTons,
  });

  // 【新工場は既存増設とは別の判断】既存の capex.ts（今期このラインが足りるか）とは
  // 独立した戦略評価を行う。提案しなかった場合も理由コードを必ず残す。
  const newFactoryResult = evaluateNewFactoryDecision({
    turn,
    fixture,
    observation,
    pressures,
    vision,
    strategicGrowth,
    productionNeededByProductBeforeCap: productionResult.neededByProduct,
    existingExpansionProposedThisQuarter: capexResult.capexDecision.newProjectProposals.length > 0,
    commercialAmbition,
    unservedOpportunity,
    // 【§23 持続性】一時的な好況で工場を建てない。
    // 「前四半期に工場を実際に満杯まで回していた（既存の sustained しきい値を再利用）」
    // かつ「今期の志がその能力を超えている」ときだけ、持続的な能力不足の根拠とみなす。
    // 新しい閾値は発明していない（capexSustainedUtilizationThreshold をそのまま使う）。
    liquidity: liquidityGate,
    persistentCapacityCausedUnserved:
      pressures.hadPriorQuarterUtilization &&
      bindingProductionCapacityTons > 0 &&
      recentActualScaleTons >= bindingProductionCapacityTons * params.capexSustainedUtilizationThreshold,
  });

  const salesForceHiringResult = buildStandardAiSalesForceHiringDecision({
    fixture,
    observation,
    pressures,
    params,
    salesParams,
    salesWishByMarketProduct: salesResult.salesWishByMarketProduct,
    finalProductionRequirementByProduct: finalProductionRequirementByProduct,
    totalEffectiveCapacityByProduct: observation.totalEffectiveCapacityByProduct,
    unitEconomics: unitEconomicsResult,
    rawMaterialSupplyConstraintState: situationDiagnosisResult.diagnosis.rawMaterialSupplyConstraintState,
    targetScaleBand: targetScaleResult.targetScaleBand,
    hasNearTermCapexUnderConstruction: targetCapabilityResult.hasNearTermCapexUnderConstruction,
    commercialAmbitionTons: commercialAmbition.ambitionTons,
    // 【Phase SAI-GROW-3B-2・実装指示§6】深刻かつ持続する危機のときだけ、
    // 既存の減員ロジックの在庫制約ブロックを外す（一時的Stressでは外さない）。
    allowsSurvivalReduction: fundableOperations.allowsSalesForceReduction,
  });

  // 【指示§9・Crisis Gate】SEVERE_DISTRESS時、新規設備投資提案（既存増設＋新工場の
  // 両方）を止める。capex.ts・newFactory.tsの計算そのものは変更せず、ここで
  // 「新規提案（newProjectProposals）」だけを空にする（指示§9「既に着工済み
  // projectを勝手にキャンセルしない」ため、cancelRequests/resumeRequestsは
  // capexResultの計算結果をそのまま使う＝一切触らない）。
  const isSevereDistress = crisisAssessment.state === "SEVERE_DISTRESS";
  // 【Phase SAI-GROW-3B-2・実装指示§9】SURVIVAL/RECOVERYのあいだは新規の成長投資を
  // 止める。1Turn資金が戻っただけでGrowth全開へ戻さない（bounded recovery）。
  // 既に着工済みprojectはCM-1と同じくキャンセルしない（cancel/resumeには触れない）。
  const growthPaused = growthPausedForRecovery(fundableOperations);
  const suppressNewGrowth = isSevereDistress || growthPaused;
  const newFactoryProposalsAfterCrisisGate = suppressNewGrowth ? [] : newFactoryResult.proposals;
  const capexDecisionAfterCrisisGate = suppressNewGrowth
    ? { ...capexResult.capexDecision, newProjectProposals: [] }
    : capexResult.capexDecision;
  const capexSuppressedByCrisis = suppressNewGrowth && (capexResult.capexDecision.newProjectProposals.length > 0 || newFactoryResult.proposals.length > 0);

  // 【指示§10・Crisis Gate】SEVERE_DISTRESS時、営業採用を0にする。既存営業人員の
  // 自動大量解雇は今回追加しない（salesForceLayoffCountはそのまま。指示§10
  // 「人員リストラは別Phase」）。Worker（正社員）拡大は、危機時に縮小される生産
  // 必要量（Commercial Commitment Gate経由）にbuildStandardAiWorkerAssignments自体が
  // 追随するため、別途のgateを追加していない（laborResult.workerAssignmentsは
  // 生産計画から逆算する既存ロジックそのまま）。
  const salesForceHireCountAfterCrisisGate = suppressNewGrowth ? 0 : salesForceHiringResult.salesForceHireCount;
  const salesHiringSuppressedByCrisis = suppressNewGrowth && salesForceHiringResult.salesForceHireCount > 0;
  // 【Standard AI Capability Expansion・Phase CE-2・Crisis Gate】SEVERE_DISTRESSでは
  // 新規のVAP商品開発支出（新たな裁量的コミットメント）も停止する（CM-1の
  // 「新規提案・新規採用を止める」思想をそのまま踏襲。既に投じたスコアの蓄積
  // 自体はここでは変更しない＝過去の開発成果を取り消さない）。
  const vapProductDevelopmentSpendUsdAfterCrisisGate = isSevereDistress ? 0 : vapProductDevelopmentResult.spendUsd;
  const vapProductDevelopmentSuppressedByCrisis = isSevereDistress && vapProductDevelopmentResult.spendUsd > 0;

  // 【Phase DIV-3】新規設備投資提案（既存増設＋新工場）をCrisis Gate適用後の
  // 最終形へ合流させる。この最終形は下のdecision.capexDecisionでそのまま使い、
  // 同時に配当判断の「当期CAPEX新規提案なし」条件の入力にもなる（同じ値を2度
  // 計算しない）。
  const finalCapexDecision =
    newFactoryProposalsAfterCrisisGate.length > 0
      ? {
          ...capexDecisionAfterCrisisGate,
          newProjectProposals: [...capexDecisionAfterCrisisGate.newProjectProposals, ...newFactoryProposalsAfterCrisisGate],
        }
      : capexDecisionAfterCrisisGate;

  // 【Phase SAI-GROW-3B-1・実装指示§8・§9】借入判断は投資確定後に行う。
  // 当期に承認した新規投資の当期支払ぶんも資金需要へ含めるため、Crisis Gate適用後の
  // 最終CAPEX（finalCapexDecision）が決まってから評価する。
  const financingResult = buildStandardAiFinancingRequest(observation, pressures, params, procurementCashPlan, {
    assessment: liquidityAssessment,
    approvedInvestmentPaymentsThisQuarterUsd: isSevereDistress ? 0 : approvedInvestmentPaymentsThisQuarterUsd,
    // 【Phase SAI-GROW-3B-1.1】当期承認した投資のうち、手元現金の余力
    // （cashBasedHeadroomUsd）を超える分＝当期借入を前提に承認した額。
    approvedInvestmentBorrowingThisQuarterUsd: isSevereDistress
      ? 0
      : Math.max(0, approvedInvestmentPaymentsThisQuarterUsd - Math.max(0, liquidityAssessment.cashBasedHeadroomUsd)),
  });

  // 【Phase DIV-4】Standard AI配当ポリシー（Flow-Based Annual Dividend Policy）。
  // 年度末Q4のみ・当期純利益基準・distributableEarningsは上限としてのみ使用。
  // 新しい会計ロジックは作らず、上限は必ずPlayerと同じcomputeMaxDividendUsdで
  // クランプする（decision/dividend.ts参照）。
  //
  // 【当期純利益のsingle source（実装指示§3）】ownState.lastFinancialResultは
  // runner.tsが確定させstate.historyへ保存済みのCompanyFinancialQuarterResultその
  // ものであり、ここで独自計算はしない。Operating Profit・Cash Flowで代用もしない。
  const dividendResult = buildStandardAiDividendDecision({
    companyId: fixture.companyId,
    period,
    financeState: ownState.financeState,
    currentQuarterNetIncomeUsd: ownState.lastFinancialResult ? unwrapUsd(ownState.lastFinancialResult.profitAndLoss.netIncome) : null,
    netIncomeSourcePeriod: ownState.lastFinancialResult?.period ?? null,
    lastQuarterFinancialHealthTier: observation.lastQuarterFinancialHealthTier,
    crisisState: crisisAssessment.state,
    newCapexProposalCount: finalCapexDecision.newProjectProposals.length,
    params,
  });

  const decision: CompanyDecisionInput = {
    companyId: fixture.companyId,
    salesPlans: salesResult.salesPlans,
    salesForceHireCount: salesForceHireCountAfterCrisisGate > 0 ? salesForceHireCountAfterCrisisGate : undefined,
    salesForceLayoffCount: salesForceHiringResult.salesForceLayoffCount > 0 ? salesForceHiringResult.salesForceLayoffCount : undefined,
    domesticPurchasePlan: procurementResult.domesticPurchasePlan,
    importOrders: procurementResult.importOrders,
    aquacultureStockingPlans: procurementResult.aquacultureStockingPlans,
    productionPlans: productionResult.productionPlans,
    workerAssignments: laborResult.workerAssignments,
    financingRequest: financingResult.financingRequest,
    vapProductDevelopmentSpendUsd: vapProductDevelopmentSpendUsdAfterCrisisGate > 0 ? vapProductDevelopmentSpendUsdAfterCrisisGate : undefined,
    // 【Phase DIV-4】DIV-1では「Standard AIは配当を一切行わない」（dividendDecision
    // 固定undefined）だった。DIV-3で条件つき配当を導入し、DIV-4で算定baseを
    // 累計利益stock（distributableEarnings）から当期純利益flowへ変更し、
    // 頻度を年1回（年度末Q4のみ）へ変更した。条件を満たさないTurnは
    // undefined（＝配当0）となり、DIV-1と同一の挙動に戻る。
    dividendDecision: dividendResult.dividendDecision,
    // 【新工場の提案を既存 capex 提案と同じ意思決定へ合流させる】
    // 既存増設の提案内容は一切変更せず、新工場ぶんを末尾へ足すだけにする
    // （既存の設備投資判断の挙動を変えない）。
    capexDecision: finalCapexDecision,
  };

  const strategicTargetScaleDiagnostic: StandardAiDiagnosticEntry = {
    code: "STRATEGIC_TARGET_SCALE_SET",
    domain: "diagnosis",
    companyId: fixture.companyId,
    severity: "info",
    keyValues: {
      targetMinTons: targetScaleResult.targetScaleBand.quarterlySalesTons.min,
      targetPreferredTons: targetScaleResult.targetScaleBand.quarterlySalesTons.preferred,
      targetMaxTons: targetScaleResult.targetScaleBand.quarterlySalesTons.max,
      currentSustainableScaleTons: targetScaleResult.currentSustainableScaleTons,
    },
    decisionSummary: `Target Scale Band: ${Math.round(targetScaleResult.targetScaleBand.quarterlySalesTons.min)}〜${Math.round(
      targetScaleResult.targetScaleBand.quarterlySalesTons.max
    )}t/期（preferred ${Math.round(targetScaleResult.targetScaleBand.quarterlySalesTons.preferred)}t/期）`,
    message: `Strategic Intent（${STANDARD_AI_STRATEGIC_INTENT_V1.growthPosture}）と現在の持続可能規模（約${Math.round(
      targetScaleResult.currentSustainableScaleTons
    )}t/期）から、Target Scale Bandを${Math.round(targetScaleResult.targetScaleBand.quarterlySalesTons.min)}〜${Math.round(
      targetScaleResult.targetScaleBand.quarterlySalesTons.max
    )}t/期（preferred ${Math.round(
      targetScaleResult.targetScaleBand.quarterlySalesTons.preferred
    )}t/期）と算定した。8期先市場の精密予測ではなく、現時点の会社規模・実効生産能力・成長姿勢からの逆算である${
      targetScaleResult.marketOpportunityDirection ? `（補助情報: 市場機会の方向性=${targetScaleResult.marketOpportunityDirection}）` : ""
    }。`,
  };

  // 【Phase SAI-GROW-3B-2・実装指示§11】Survival / Recovery の1Turn追跡。
  // crisisState・posture・fundable量・計画量・人員・流動性を1件で追える形にする。
  const plannedProductionTons = productionResult.productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const plannedWorkerTotal = laborResult.workerAssignments.reduce((sum, w) => sum + w.regularHeadcount, 0);
  const fundableOperationsDiagnostic: StandardAiDiagnosticEntry = {
    code:
      fundableOperations.posture === "SURVIVAL"
        ? "SURVIVAL_MODE"
        : fundableOperations.posture === "RECOVERY"
          ? "RECOVERY_MODE"
          : "GROWTH_PAUSED_FOR_RECOVERY",
    domain: "finance",
    companyId: fixture.companyId,
    severity: fundableOperations.posture === "SURVIVAL" ? "warning" : "info",
    keyValues: {
      crisisStateIsSevere: crisisAssessment.state === "SEVERE_DISTRESS" ? 1 : 0,
      crisisStateIsStress: crisisAssessment.state === "LIQUIDITY_STRESS" ? 1 : 0,
      postureIsSurvival: fundableOperations.posture === "SURVIVAL" ? 1 : 0,
      postureIsRecovery: fundableOperations.posture === "RECOVERY" ? 1 : 0,
      sustainedDistress: fundableOperations.sustainedDistress ? 1 : 0,
      procurementFundingUsd: fundableOperations.procurementFundingUsd,
      expectedBorrowingForOperationsUsd: fundableOperations.expectedBorrowingForOperationsUsd,
      fundableProcurementTons: fundableOperations.fundableDomesticProcurementTons,
      fundableRawMaterialTons: fundableOperations.fundableRawMaterialTons,
      fundableProductionTons: fundableOperations.fundableProductionTons,
      productionRequirementTons: sumProductAmount(finalProductionRequirementByProduct),
      plannedProductionTons,
      plannedProcurementTons: unwrapUnit(procurementResult.domesticPurchasePlan.desiredQuantity),
      workerCurrent: observation.regularHeadcountTotal,
      workerPlanned: plannedWorkerTotal,
      workerChange: plannedWorkerTotal - observation.regularHeadcountTotal,
      salesHeadcountCurrent: observation.salesForceHeadcountTotal,
      salesHeadcountChange: salesForceHireCountAfterCrisisGate - salesForceHiringResult.salesForceLayoffCount,
      liquidityHeadroomUsd: liquidityAssessment.liquidityHeadroomUsd,
      availableBorrowingUsd: liquidityAssessment.realisticallyAvailableBorrowingUsd,
      growthPaused: growthPaused ? 1 : 0,
    },
    decisionSummary:
      fundableOperations.posture === "NORMAL"
        ? "通常運転（資金による規模の縮退なし）"
        : fundableOperations.posture === "SURVIVAL"
          ? `資金手当て可能な規模（原料${Math.round(fundableOperations.fundableRawMaterialTons).toLocaleString()}t）で操業する`
          : "資金は回復。規模の回復を優先し、新規の成長投資は見送る",
    message: fundableOperations.reason,
  };

  // 【実装指示§11】縮退が実際に効いたときだけ、対象ドメインの理由codeを立てる。
  const survivalActionDiagnostics: StandardAiDiagnosticEntry[] = [];
  if (fundableOperations.appliesProductionCap) {
    survivalActionDiagnostics.push({
      code: "PROCUREMENT_REDUCED_BY_LIQUIDITY",
      domain: "procurement",
      companyId: fixture.companyId,
      severity: "warning",
      keyValues: {
        plannedProcurementTons: unwrapUnit(procurementResult.domesticPurchasePlan.desiredQuantity),
        fundableProcurementTons: fundableOperations.fundableDomesticProcurementTons,
        procurementFundingUsd: fundableOperations.procurementFundingUsd,
      },
      decisionSummary: "資金手当て可能な調達規模へ計画を合わせる",
      message:
        "生産計画を資金手当て可能な規模へ縮退させたため、原料調達計画もその生産必要量へ追従させる" +
        "（engine側で事後的に削られる量を希望し続けない）。",
    });
  }
  if (fundableOperations.posture === "SURVIVAL" && plannedWorkerTotal < observation.regularHeadcountTotal) {
    survivalActionDiagnostics.push({
      code: "WORKFORCE_REDUCED_FOR_SURVIVAL",
      domain: "labor",
      companyId: fixture.companyId,
      severity: "warning",
      keyValues: {
        workerCurrent: observation.regularHeadcountTotal,
        workerPlanned: plannedWorkerTotal,
        workerChange: plannedWorkerTotal - observation.regularHeadcountTotal,
      },
      decisionSummary: `常用ワーカーを${observation.regularHeadcountTotal - plannedWorkerTotal}人縮小`,
      message:
        "資金手当て可能な生産規模に合わせて必要人数が下がったため、既存の段階的な人員調整" +
        "（regularHeadcountAdjustmentDamping）の範囲で常用ワーカーを縮小する（一括解雇はしない）。",
    });
  }

  // 【Phase SAI-GROW-3B-3・実装指示§13】Deliverable Commitment の1Turn追跡。
  // 【§9 Constraint Routing】capが効いたときは「成長機会が無い」ではなく、
  // 「何が納品を縛っているか」＝次に何へ投資すべきかをrouteする。
  const deliverabilityConstraintCode = {
    PRODUCTION: "DELIVERABLE_LIMIT_PRODUCTION",
    RAW_MATERIAL: "DELIVERABLE_LIMIT_RAW_MATERIAL",
    BACKLOG: "DELIVERABLE_LIMIT_BACKLOG",
    LIQUIDITY: "DELIVERABLE_LIMIT_LIQUIDITY",
    NONE: "DELIVERABLE_COMMITMENT_ASSESSED",
  } as const;
  const deliverableCommitmentDiagnostic: StandardAiDiagnosticEntry = {
    code: applyDeliverabilityCap
      ? deliverabilityConstraintCode[deliverableCommitment.bindingDeliverabilityConstraint]
      : "DELIVERABLE_COMMITMENT_ASSESSED",
    domain: "sales",
    companyId: fixture.companyId,
    severity: applyDeliverabilityCap ? "warning" : "info",
    keyValues: {
      commercialAmbitionTons: commercialAmbition.ambitionTons,
      commercialCommitmentBeforeDeliverability: deliverableCommitment.commitmentBeforeDeliverabilityTons,
      deliverableCapacityCurrentTons: deliverableCommitment.deliverableCapacityCurrentTons,
      deliverableCapacityNearTermTons: deliverableCommitment.deliverableCapacityNearTermTons,
      existingBacklogTons: deliverableCommitment.existingBacklogTons,
      healthyForwardBacklogTons: deliverableCommitment.healthyForwardBacklogTons,
      overdueBacklogTons: deliverableCommitment.overdueBacklogTons,
      carryOverBacklogTons: deliverableCommitment.carryOverBacklogTons,
      normalBacklogAllowanceTons: deliverableCommitment.normalBacklogAllowanceTons,
      excessBacklogTons: deliverableCommitment.excessBacklogTons,
      backlogDeliveryHorizonQuarters: Number.isFinite(deliverableCommitment.backlogDeliveryHorizonQuarters)
        ? deliverableCommitment.backlogDeliveryHorizonQuarters
        : -1,
      remainingDeliverableHeadroomTons: deliverableCommitment.remainingDeliverableHeadroomTons,
      deliverabilityCapTons: deliverableCommitment.deliverabilityCapTons,
      finalSubmissionTargetTons: commercialCommitment.submissionTargetTons,
      incrementalSubmissionReductionTons: applyDeliverabilityCap ? deliverableCommitment.incrementalSubmissionReductionTons : 0,
      deliveryLeadTimeQuarters: observation.deliveryLeadTimeQuarters,
      applied: applyDeliverabilityCap ? 1 : 0,
    },
    decisionSummary: applyDeliverabilityCap
      ? `納品可能量に合わせて新規提出を ${Math.round(deliverableCommitment.incrementalSubmissionReductionTons).toLocaleString()}t 抑える`
      : "納品可能量は新規提出の制約になっていない",
    message: applyDeliverabilityCap
      ? `志（Commercial Ambition ${Math.round(commercialAmbition.ambitionTons).toLocaleString()}t）は変えないまま、` +
        `納期到来時点の納品余力 ${Math.round(deliverableCommitment.remainingDeliverableHeadroomTons).toLocaleString()}t` +
        `（納品能力 ${Math.round(deliverableCommitment.deliverableCapacityNearTermTons).toLocaleString()}t − 正常水準超の受注残 ` +
        `${Math.round(deliverableCommitment.excessBacklogTons).toLocaleString()}t）に合わせて` +
        `今期の新規提出を ${Math.round(deliverableCommitment.commitmentBeforeDeliverabilityTons).toLocaleString()}t → ` +
        `${Math.round(commercialCommitment.submissionTargetTons).toLocaleString()}t へ抑える。` +
        `納品を縛っているのは ${deliverableCommitment.bindingDeliverabilityConstraint} であり、成長機会が無いのではない` +
        `（受注残消化 ${deliverableCommitment.backlogDeliveryHorizonQuarters.toFixed(2)} 四半期分）。`
      : `納品余力 ${Math.round(deliverableCommitment.remainingDeliverableHeadroomTons).toLocaleString()}t が` +
        `提出目標 ${Math.round(deliverableCommitment.commitmentBeforeDeliverabilityTons).toLocaleString()}t を上回るため、` +
        `納品可能量による抑制は行っていない。`,
  };

  const newSalesSuppressedByCrisis = crisisAssessment.state !== "NORMAL";
  const crisisDiagnostics = buildCrisisDiagnostics(fixture.companyId, crisisAssessment, observation, {
    newSalesSuppressed: newSalesSuppressedByCrisis,
    capexPaused: capexSuppressedByCrisis,
    salesHiringStopped: salesHiringSuppressedByCrisis,
  });
  const vapDevCrisisDiagnostic: StandardAiDiagnosticEntry | null = vapProductDevelopmentSuppressedByCrisis
    ? {
        code: "CRISIS_VAP_DEV_PAUSED",
        domain: "crisis",
        companyId: fixture.companyId,
        severity: "warning",
        keyValues: { attemptedSpendUsd: vapProductDevelopmentResult.spendUsd },
        message: "危機（SEVERE_DISTRESS）のため、新規のVAP商品開発支出を停止した（既存スコアの蓄積は取り消していない）。",
      }
    : null;

  const entries: StandardAiDiagnosticEntry[] = [
    ...salesResult.diagnostics,
    ...productionResult.diagnostics,
    ...procurementResult.diagnostics,
    ...laborResult.diagnostics,
    ...financingResult.diagnostics,
    ...capexResult.diagnostics,
    ...dividendResult.diagnostics,
    ...vapProductDevelopmentResult.diagnostics,
    ...deliveryDemandResult.diagnostics,
    ...situationDiagnosisResult.diagnostics,
    strategicTargetScaleDiagnostic,
    ...targetCapabilityResult.diagnostics,
    ...salesForceHiringResult.diagnostics,
    ...commercialGrowthDiagnostics,
    ...newFactoryResult.diagnostics,
    ...buildCommitmentDiagnostics(fixture.companyId, commercialCommitment, conversionObservation),
    liquidityDiagnostic,
    fundableOperationsDiagnostic,
    deliverableCommitmentDiagnostic,
    ...survivalActionDiagnostics,
    ...crisisDiagnostics,
    ...(vapDevCrisisDiagnostic ? [vapDevCrisisDiagnostic] : []),
  ];

  // 【Phase SAI-GROW-1・実装指示§26】Shadow Growth Pressure。
  //
  // **すべての意思決定（decision）が確定した後**に、確定済みの値だけを読んで評価する。
  // ここより上のコードはこの結果を参照しないため、Shadowの有無でDecisionが変わることは
  // 構造上あり得ない（テストSAI-GROW-18/19で bit-equivalence を固定している）。
  const growthPressure = assessGrowthPressure({
    core: growthCore,
    observation,
    unservedOpportunity,
    commercialAmbition,
    ambitionTonsWithBaseStep: commercialAmbitionWithBaseStep.ambitionTons,
    // step limitが無ければ到達していた水準（Visionと観測機会の小さい方）。
    ambitionTonsWithoutStepLimit: Math.min(
      Math.max(commercialAmbition.baselineTons, strategicGrowth ? strategicGrowth.visionTargetScaleAtCurrentTurn : commercialAmbition.baselineTons),
      commercialAmbition.realisticOpportunityTons > 0 ? commercialAmbition.realisticOpportunityTons : commercialAmbition.baselineTons
    ),
    salesHiringZeroReason: salesForceHiringResult.hiringDiagnostics.zeroHireReason,
    salesForceHireCount: salesForceHireCountAfterCrisisGate,
    newCapexProposalCount: finalCapexDecision.newProjectProposals.length,
    salesParams,
    params: params.growthPressure,
  });

  return {
    decision,
    diagnostics: {
      companyId: fixture.companyId,
      turn,
      period,
      entries,
      pressures,
      situationDiagnosis: situationDiagnosisResult.diagnosis,
      currentPeriodDeliveryDemand: deliveryDemandResult.deliveryDemand,
      decision,
      salesWishByMarketProduct: salesResult.salesWishByMarketProduct,
      ...(vision ? { vision } : {}),
      ...(strategicGrowth ? { strategicGrowth } : {}),
      commercialAmbition,
      observableOpportunity,
      unservedOpportunity,
      newFactoryAssessment: newFactoryResult.assessment,
      commercialCommitment,
      conversionObservation,
      salesHiring: salesForceHiringResult.hiringDiagnostics,
      // 【Phase SAI-GROW-3B-1】Liquidity SSoT の評価内訳。Finance・CAPEX・新工場が
      // 参照したのとまったく同じ値（実装指示§13）。
      liquidity: liquidityAssessment,
      fundableOperations,
      deliverableCommitment,
      approvedInvestmentPaymentsThisTurnUsd,
      // 【Phase SAI-GROW-1】診断専用のShadow Growth Pressure（Decisionには未接続）。
      growthPressure,
      // 【Standard AI Crisis Management・Phase CM-1・指示§15】Analysis Pack・
      // Company Inspector・Claude explanationが読む、この四半期のCrisis判断そのもの。
      crisis: {
        state: crisisAssessment.state,
        signals: crisisAssessment.signals,
        summary: crisisAssessment.summary,
        procurementScaleRatio: observation.lastQuarterProcurementScaleRatio,
        underwritingFrozen: observation.lastQuarterUnderwritingFrozen,
        newSalesSuppressed: newSalesSuppressedByCrisis,
        capexPaused: capexSuppressedByCrisis,
        salesHiringStopped: salesHiringSuppressedByCrisis,
      },
    },
  };
}

/**
 * CompanyDecisionProvider型に一致する、標準AIの意思決定生成関数
 * （companyLab/runner.tsのrunCompanyLabWithAutoPolicyForAllCompaniesへ
 * そのまま渡せる）。診断情報が不要な呼び出し元（既存の自動テスト・CLI標準実行）
 * 向けの薄いラッパーであり、内部でgenerateStandardAiDecisionWithDiagnosticsを
 * 呼ぶだけで計算を重複させない。
 */
export function generateStandardAiDecision(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
): CompanyDecisionInput {
  return generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn).decision;
}

// CompanyDecisionProvider型と完全に一致することをコンパイル時に保証する。
const _typeCheck: CompanyDecisionProvider = generateStandardAiDecision;
void _typeCheck;

/**
 * 【診断情報の収集】自動テストプレイ・CLI（--format=json等）が、計算を一切
 * 重複させずに全社・全四半期の診断情報を読み取れるようにするためのクロージャ。
 * providerはCompanyDecisionProviderと完全に同じ形（純粋関数として呼び出し可能）で
 * あり、副作用は「呼ばれるたびにdiagnostics配列へ今回ぶんを追記する」ことだけに
 * 限定される（意思決定の計算結果そのものは、直接generateStandardAiDecisionを
 * 呼んだ場合と完全に同一。決定論性・再現性に影響しない）。
 */
export interface StandardAiParamsResolution {
  readonly params: StandardAiParameters;
  readonly profileId: string;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
}

export interface StandardAiProviderOptions {
  /** 【Phase 6B】営業パラメータの上書き（候補モデル比較用）。 */
  readonly salesParams?: SalesParameters;
  /**
   * 【SAI-4追加】会社IDごとにStandardAiParametersを解決する関数（省略時=undefinedなら
   * 従来どおり全社STANDARD_AI_PARAMETERS_V1固定。既存の呼び出し元は一切変更不要で、
   * 既存の全出力・全テストへの影響はゼロ）。
   *
   * 【会社IDによる分岐の集約】本オプションを注入する側（managementProfile.tsの
   * createManagementProfileParamsResolver等）だけが会社IDによる分岐を持ち、
   * policy.ts自身は「渡された関数をfixture.companyIdで呼ぶ」以外の分岐を
   * 一切持たない。decision/*.tsの内部にも会社ID分岐は存在しない。
   */
  readonly resolveParams?: (companyId: string) => StandardAiParamsResolution;
  /** 【Management Console Vision Calibration】Run固有のVision上書き（未指定なら既定Visionのみ）。 */
  readonly visionOverrides?: CompanyLabVisionOverrides;
}

export function createStandardAiProvider(
  options: StandardAiProviderOptions = {}
): {
  readonly provider: CompanyDecisionProvider;
  readonly diagnostics: StandardAiQuarterDiagnostics[];
} {
  const { resolveParams, visionOverrides } = options;
  const salesParams = options.salesParams ?? SALES_PARAMETERS_V1;
  const diagnostics: StandardAiQuarterDiagnostics[] = [];
  const provider: CompanyDecisionProvider = (fixture, ownState, publicInfo, period, turn) => {
    if (!resolveParams) {
      const result = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        period,
        turn,
        STANDARD_AI_PARAMETERS_V1,
        salesParams,
        visionOverrides
      );
      diagnostics.push(result.diagnostics);
      return result.decision;
    }

    const resolution = resolveParams(fixture.companyId);
    const result = generateStandardAiDecisionWithDiagnostics(
      fixture,
      ownState,
      publicInfo,
      period,
      turn,
      resolution.params,
      salesParams,
      visionOverrides
    );

    // 【実装指示§4】バイアスが1件でも適用されている場合のみ、基準パラメータでの
    // 判断も計算し診断へ残す（バイアスなしの会社・四半期では省略し、Standard AI
    // 全体の実行コストを不必要に倍増させない）。
    const baselineDecision =
      resolution.appliedBiasItems.length > 0
        ? generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, STANDARD_AI_PARAMETERS_V1).decision
        : undefined;

    diagnostics.push({
      ...result.diagnostics,
      managementProfile: {
        profileId: resolution.profileId,
        appliedBiasItems: resolution.appliedBiasItems,
        baselineDecision,
      },
    });
    return result.decision;
  };
  return { provider, diagnostics };
}
