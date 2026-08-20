// ShrimpX V2 — Standard AI 新工場建設の戦略判断（2026-08-09新設）
//
// 【なぜ専用モジュールなのか】
// 新工場建設を「Standard AI が提案できる案件種別」の配列へ足すだけでは足りない。
// 既存のライン増設は「今期このラインが足りない」という**戦術的**な判断だが、
// 新工場は 2,200万USD・建設3四半期・稼働まで4四半期・工場数上限4という
// **戦略的**な決定であり、判断材料も時間軸もまったく違う。
// そのため、既存の capex.ts（戦術）とは独立したこのモジュール（戦略）を置く。
//
// 【限定合理性】ここは未来を当てるAIではない。
//  ・使ってよいのは Standard AI が観測できる値（現在の能力・工場スペース・
//    前期実績・観測需要・自社財務）と、外から与えられた Vision だけ。
//  ・将来の需要・価格・シナリオイベントは引数に存在しない。
//  ・したがって「読み違えて建てすぎる」「慎重すぎて建て遅れる」ことは
//    バグではなく、この経営AIの性格である。
//
// 【建てなかったことも決定である】
// 全ゲートの評価結果を必ず理由コードとして残す。単一の不透明なスコアは作らない。

import { CapexProjectProposalInput } from "../../../capex/types";
import { CAPEX_PARAMETERS_V1, CapexParameters } from "../../../capex/parameters";
import { CompanyFixture } from "../../types";
import { evaluateInvestmentAffordability, plannedInvestmentPaymentsWithinHorizonUsd } from "./liquidity";
import { NEW_FACTORY_STRATEGY_PARAMETERS_V1, NewFactoryStrategyParameters } from "./newFactoryStrategyParameters";
import { LiquidityGateContext } from "./capex";
import { CompanyVision } from "../../vision/types";
import { GrowthPressure, StrategicGrowthState, growthPressureAtLeast } from "../../vision/strategicGrowth";
import { CommercialAmbition } from "../../vision/commercialAmbition";
import { UnservedOpportunity } from "../../vision/unservedOpportunity";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, sumProductAmount } from "../types";
import { StandardAiDiagnosticEntry, StandardAiReasonCode } from "../reasonCodes";
import { computeBindingProductionCapacityTons } from "../bindingCapacity";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { StrategicPosture } from "../../vision/types";
import { computeForwardCapacityGap, ForwardCapacityGapResult, MarketGrowthEvidence } from "../forwardCapacityGap";

const EPSILON = 1e-6;

/** 新工場に対する検討の到達段階。「建てない」も段階として明示的に持つ。 */
export type NewFactoryConsiderationStatus =
  /** Vision が無い、または志に対して規模が足りているため、候補にすら上げていない。 */
  | "NOT_CONSIDERED"
  /** 候補としては認識しているが、まだ具体的な検討には入っていない。 */
  | "MONITORING"
  /** 具体的に検討しているが、一部のゲートを満たしていない。 */
  | "CONSIDERING"
  /** 全ゲートを満たし、提案可能な状態になった。 */
  | "READY_TO_BUILD"
  /** 検討したうえで、特定の理由により今期は見送った。 */
  | "DEFERRED"
  /** すでに承認済み・建設中の新工場案件がある。 */
  | "APPROVED";

/** 1つのゲートの評価結果。**通ったゲートも落ちたゲートも等しく残す。** */
export interface NewFactoryGateResult {
  readonly gate: string;
  readonly passed: boolean;
  /** 判定に使った値と閾値（説明可能性のための一次情報）。 */
  readonly keyValues: Readonly<Record<string, number>>;
  readonly note: string;
}

export interface NewFactoryAssessment {
  readonly status: NewFactoryConsiderationStatus;
  readonly reasonCodes: readonly StandardAiReasonCode[];
  readonly gates: readonly NewFactoryGateResult[];
  /** 提案した場合の投資額（提案しなかった場合も「いくらの話だったか」を残す）。 */
  readonly projectCostUsd: number;
  /** 着工四半期に出ていく現金（支払比率の初回ぶん）。 */
  readonly firstPaymentUsd: number;
  readonly growthPressure: GrowthPressure;
  readonly strategicScaleGapTons: number;
  readonly strategicScaleGapRatio: number;
  /**
   * 【Phase 6】商業側の需要根拠。ChatGPT が
   * 「需要が無いから建てなかった」と「需要はあるがWorker不足だから建てなかった」を
   * 区別できるようにするための記録。
   */
  readonly commercialAmbitionTons: number | null;
  readonly profitableOpportunityTons: number | null;
  readonly unservedProfitableTons: number | null;
  readonly capacityCausedUnservedTons: number | null;
  readonly persistentCapacityCausedUnserved: boolean;
  /**
   * 【Strategic Posture・§29/§30】この判断がどちらの経路を通ったか。
   * NONE ＝ 提案しなかった（reactiveも strategic も READY_TO_BUILD に届かなかった）。
   */
  readonly decisionRoute: "REACTIVE" | "STRATEGIC_FORWARD_CAPACITY" | "NONE";
  readonly strategicPosture: StrategicPosture | null;
  /** Forward Capacity Gap の計算結果。AGGRESSIVE_EARLY_CAPACITY以外・Vision無しではnull。 */
  readonly forwardCapacityGap: ForwardCapacityGapResult | null;
  readonly marketGrowthEvidence: MarketGrowthEvidence | null;
  /** 既存増設だけでforward gapを解消できると判断した場合の、その根拠比率（gapJustifiesOverlapの判定に使った値）。 */
  readonly existingExpansionAlternativeSufficientTons: number | null;
  readonly postConstructionActivationFeasible: boolean | null;
  /**
   * 【Phase G・§31/§34】strategic routeが評価された場合、その同じ四半期に
   * reactive routeがどの段階で止まっていたか（READY_TO_BUILDでなかったことの
   * 直接証拠。「reactiveがまだ準備できていない時にstrategicが提案した」を
   * 事後に再構成できるようにする）。strategic route自体が評価されなかった
   * 四半期（DEMAND_CONFIRMED/VALUE_FIRST、またはreactiveが自力でREADY_TO_BUILD
   * に届いた四半期）はnull。
   */
  readonly reactiveStatusAtStrategicDecision: NewFactoryConsiderationStatus | null;
  readonly reactiveBlockerAtStrategicDecision: string | null;
}

export interface NewFactoryDecisionResult {
  readonly assessment: NewFactoryAssessment;
  /** 提案する場合の1件（提案しない場合は空）。 */
  readonly proposals: readonly CapexProjectProposalInput[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export { NEW_FACTORY_STRATEGY_PARAMETERS_V1 } from "./newFactoryStrategyParameters";
export type { NewFactoryStrategyParameters } from "./newFactoryStrategyParameters";

export interface NewFactoryDecisionInput {
  readonly fixture: CompanyFixture;
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly vision: CompanyVision | null;
  readonly strategicGrowth: StrategicGrowthState | null;
  /** 【Strategic Posture】Forward Capacity Gapの完成予定ターン算出に使う現在ターン。 */
  readonly turn: number;
  /** 制約適用前の当期生産必要量（需要の裏づけ判定に使う。capex.ts と同じ値）。 */
  readonly productionNeededByProductBeforeCap: ProductAmount;
  /** 当期、既存設備の増設案件を提案したか（既存増設を先に使う原則の判定材料）。 */
  readonly existingExpansionProposedThisQuarter: boolean;
  /**
   * 【Phase 6】商業側の需要根拠。
   * 「稼働率がまだ低いから不要」だけで判断しないための一次情報である。
   */
  readonly commercialAmbition?: CommercialAmbition;
  readonly unservedOpportunity?: UnservedOpportunity;
  /**
   * 直近数四半期にわたり、生産能力起因の未充足機会が続いているか
   * （一時的な好況で工場を建てないための持続性条件）。
   */
  readonly persistentCapacityCausedUnserved?: boolean;
  readonly capexParams?: CapexParameters;
  readonly strategyParams?: NewFactoryStrategyParameters;
  /**
   * 【Phase SAI-GROW-3B-1】Liquidity SSoT。既存増設CAPEXとまったく同じ評価を使い、
   * 「新工場だけ別の財務ルール」という状態を解消する（実装指示§7）。
   * 未指定なら従来式（後方互換）。
   */
  readonly liquidity?: LiquidityGateContext;
}

function gate(gateName: string, passed: boolean, keyValues: Record<string, number>, note: string): NewFactoryGateResult {
  return { gate: gateName, passed, keyValues, note };
}

/**
 * 【Phase 6D・表示専用の SSoT】この assessment を実際に止めている条件のラベル。
 *
 * 【なぜ必要か（監査で確認した logging semantic bug）】
 * MONITORING は Gate C（GROWTH_PRESSURE）で評価が終わるが、その gate の passed は
 * 「検討開始（monitoring）圧力に達したか」を記録する。したがって MONITORING の
 * assessment には failed な gate が1つも存在せず、従来の表示各所
 * （firstFailedGate ?? "全ゲート通過"）は**提案圧力に達していないのに
 * 「全ゲート通過」と表示していた**。実際に止めている条件
 * （growthPressure < 提案に必要な圧力）はどの gate の fail としても現れない。
 *
 * この関数は判断そのものを一切変えない。表示・ログが参照する「止めている条件」を
 * 1箇所に集約するだけである。
 */
export function describeNewFactoryBlocker(assessment: {
  readonly status: string;
  readonly gates: readonly { readonly gate: string; readonly passed: boolean }[];
}): string | null {
  const failed = assessment.gates.find((g) => !g.passed);
  if (failed) return failed.gate;
  // 全 gate が passed のまま止まるのは MONITORING だけ（Gate C の passed が
  // monitoring 閾値を記録するため）。READY_TO_BUILD は本当に全ゲート通過。
  if (assessment.status === "MONITORING") return "GROWTH_PRESSURE_BELOW_PROPOSAL";
  return null;
}

/**
 * 【Reactive Route】現行の新工場検討（今の稼働率・受注残・需要に反応する経路）。
 * 提案するかどうかに関わらず、必ず assessment と診断エントリを返す。
 * この関数のゲート順・判断ロジックはStrategic Posture導入前と一切変更していない
 * （DEMAND_CONFIRMED/VALUE_FIRSTの会社は常にこの関数の結果だけで決まる＝STRAT-1）。
 */
function evaluateReactiveNewFactoryRoute(input: NewFactoryDecisionInput): NewFactoryDecisionResult {
  const { fixture, observation, pressures, vision, strategicGrowth } = input;
  const capexParams = input.capexParams ?? CAPEX_PARAMETERS_V1;
  const sp = input.strategyParams ?? NEW_FACTORY_STRATEGY_PARAMETERS_V1;

  const template = capexParams.templatesByType.newFactoryConstruction;
  const projectCostUsd = template.standardBudgetUsd;
  const firstPaymentUsd = projectCostUsd * (template.paymentRatios[0] ?? 1);

  const gates: NewFactoryGateResult[] = [];
  const reasonCodes: StandardAiReasonCode[] = [];
  const diagnostics: StandardAiDiagnosticEntry[] = [];

  const finish = (status: NewFactoryConsiderationStatus, proposals: readonly CapexProjectProposalInput[] = []): NewFactoryDecisionResult => ({
    assessment: {
      status,
      reasonCodes,
      gates,
      projectCostUsd,
      firstPaymentUsd,
      growthPressure: strategicGrowth?.growthPressure ?? "LOW",
      strategicScaleGapTons: strategicGrowth?.strategicScaleGapTons ?? 0,
      strategicScaleGapRatio: strategicGrowth?.strategicScaleGapRatio ?? 0,
      commercialAmbitionTons: input.commercialAmbition?.ambitionTons ?? null,
      profitableOpportunityTons: input.commercialAmbition?.realisticOpportunityTons ?? null,
      unservedProfitableTons: input.unservedOpportunity?.unservedProfitableTons ?? null,
      capacityCausedUnservedTons: input.unservedOpportunity?.blockedByProductionCapacityTons ?? null,
      persistentCapacityCausedUnserved: input.persistentCapacityCausedUnserved ?? false,
      decisionRoute: status === "READY_TO_BUILD" ? "REACTIVE" : "NONE",
      strategicPosture: vision?.strategicPosture ?? null,
      forwardCapacityGap: null,
      marketGrowthEvidence: null,
      existingExpansionAlternativeSufficientTons: null,
      postConstructionActivationFeasible: null,
      reactiveStatusAtStrategicDecision: null,
      reactiveBlockerAtStrategicDecision: null,
    },
    proposals,
    diagnostics,
  });

  const record = (
    code: StandardAiReasonCode,
    severity: StandardAiDiagnosticEntry["severity"],
    keyValues: Record<string, number>,
    decisionSummary: string,
    message: string
  ) => {
    reasonCodes.push(code);
    diagnostics.push({ code, domain: "capex", companyId: fixture.companyId, severity, keyValues, decisionSummary, message });
  };

  // --- Gate A: Vision が与えられているか -------------------------------
  if (!vision || !strategicGrowth) {
    gates.push(gate("VISION_PRESENT", false, {}, "この会社には Vision が与えられていないため、戦略的成長投資の判断自体を行わない。"));
    record(
      "NEW_FACTORY_NOT_NEEDED",
      "info",
      {},
      "新工場は検討対象外（Visionが未設定）",
      "この会社には Vision（志）が与えられていない。Vision を与えるのは人間の経営者の役割であり、Standard AI が勝手に成長目標を発明することはしない。"
    );
    return finish("NOT_CONSIDERED");
  }
  gates.push(gate("VISION_PRESENT", true, { effectiveFromTurn: vision.effectiveFromTurn }, `Vision ${vision.visionId} が有効。`));

  const growthKeyValues = {
    visionTargetScaleAtCurrentTurn: strategicGrowth.visionTargetScaleAtCurrentTurn,
    visionTargetScaleAtQ32: strategicGrowth.visionTargetScaleAtQ32,
    currentSustainableScaleTons: strategicGrowth.currentSustainableScaleTons,
    strategicScaleGapTons: strategicGrowth.strategicScaleGapTons,
    strategicScaleGapRatio: strategicGrowth.strategicScaleGapRatio,
    ambitionAdjustedGapRatio: strategicGrowth.ambitionAdjustedGapRatio,
  };

  // --- Gate B: 志に対して遅れているか ---------------------------------
  if (strategicGrowth.onTrack) {
    gates.push(gate("VISION_GROWTH_GAP", false, growthKeyValues, "志の参考成長軌道に対して遅れていない。"));
    record(
      "VISION_ON_TRACK",
      "info",
      growthKeyValues,
      "志の軌道に乗っており、成長投資を急がない",
      `Vision の参考規模 ${Math.round(strategicGrowth.visionTargetScaleAtCurrentTurn).toLocaleString()}t/期 に対し、現在の持続可能規模は ${Math.round(
        strategicGrowth.currentSustainableScaleTons
      ).toLocaleString()}t/期。遅れは小さく、いま無理に能力を増やす理由がない。`
    );
    record("NEW_FACTORY_NOT_NEEDED", "info", growthKeyValues, "新工場は不要", "志に対する規模の不足が小さいため、新工場を必要としない。");
    return finish("NOT_CONSIDERED");
  }
  gates.push(gate("VISION_GROWTH_GAP", true, growthKeyValues, "志の参考成長軌道に対して規模が不足している。"));
  record(
    "VISION_GROWTH_GAP",
    "info",
    growthKeyValues,
    `志に対して ${Math.round(strategicGrowth.strategicScaleGapTons).toLocaleString()}t/期 不足`,
    `Vision の参考規模 ${Math.round(strategicGrowth.visionTargetScaleAtCurrentTurn).toLocaleString()}t/期 に対し、現在の持続可能規模は ${Math.round(
      strategicGrowth.currentSustainableScaleTons
    ).toLocaleString()}t/期。不足は ${(strategicGrowth.strategicScaleGapRatio * 100).toFixed(1)}%。これは達成義務ではなく、成長投資を検討する入口である。`
  );

  // --- Gate C: 志の強さ・工場への前向きさから見た検討段階 ---------------
  const monitoringPressure = sp.monitoringPressureByWillingness[vision.willingnessToBuildFactories];
  const proposalPressure = sp.proposalPressureByWillingness[vision.willingnessToBuildFactories];
  const reachesMonitoring = growthPressureAtLeast(strategicGrowth.growthPressure, monitoringPressure);
  const reachesProposal = growthPressureAtLeast(strategicGrowth.growthPressure, proposalPressure);
  gates.push(
    gate(
      "GROWTH_PRESSURE",
      reachesMonitoring,
      growthKeyValues,
      `growthPressure=${strategicGrowth.growthPressure} / 検討開始に必要=${monitoringPressure} / 提案に必要=${proposalPressure}（工場への前向きさ ${vision.willingnessToBuildFactories}）。`
    )
  );
  if (!reachesMonitoring) {
    record(
      "GROWTH_PRESSURE_LOW",
      "info",
      growthKeyValues,
      "新工場は検討段階に入らない",
      `志に対する遅れは ${strategicGrowth.growthPressure} であり、この会社の工場建設への前向きさ（${vision.willingnessToBuildFactories}）では検討段階に入らない。`
    );
    return finish("NOT_CONSIDERED");
  }
  if (!reachesProposal) {
    // 【監視段階】候補としては見ているが、まだ動かない。これも記録すべき経営判断である。
    record(
      "NEW_FACTORY_MONITORING",
      "info",
      growthKeyValues,
      `新工場を候補として監視（成長圧力 ${strategicGrowth.growthPressure}）`,
      `志に対する遅れは ${strategicGrowth.growthPressure} に達しており新工場を候補として認識しているが、提案に踏み切るには ${proposalPressure} が必要であり、今期は監視にとどめる。`
    );
    return finish("MONITORING");
  }
  record(
    "GROWTH_PRESSURE_HIGH",
    "info",
    growthKeyValues,
    `成長圧力 ${strategicGrowth.growthPressure}`,
    `志に対する遅れが ${strategicGrowth.growthPressure} に達しており、成長投資を検討する段階にある。`
  );

  // --- Gate D: すでに新工場案件が進行中か ------------------------------
  const factoryKeyValues = {
    factoryCount: observation.factoryCount,
    pendingNewFactoryProjectCount: observation.pendingNewFactoryProjectCount,
    prospectiveFactoryCount: observation.prospectiveFactoryCount,
    maxFactoriesPerCompany: observation.maxFactoriesPerCompany,
  };
  if (observation.pendingNewFactoryProjectCount > 0) {
    gates.push(gate("NO_PENDING_NEW_FACTORY", false, factoryKeyValues, "すでに新工場建設案件が進行中である。"));
    record(
      "NEW_FACTORY_MONITORING",
      "info",
      factoryKeyValues,
      "新工場は建設中のため追加提案しない",
      "すでに新工場建設案件が進行中であり、その稼働を待つ。同時に2つ建てることはしない。"
    );
    return finish("APPROVED");
  }
  gates.push(gate("NO_PENDING_NEW_FACTORY", true, factoryKeyValues, "進行中の新工場案件は無い。"));

  // --- Gate E: 工場数の上限 --------------------------------------------
  if (observation.prospectiveFactoryCount >= observation.maxFactoriesPerCompany) {
    gates.push(gate("FACTORY_LIMIT", false, factoryKeyValues, "工場数が上限に達している。"));
    record(
      "NEW_FACTORY_NOT_NEEDED",
      "info",
      factoryKeyValues,
      "工場数の上限に到達",
      `工場数が上限（${observation.maxFactoriesPerCompany}）に達しているため、これ以上は建てられない。`
    );
    return finish("DEFERRED");
  }
  gates.push(gate("FACTORY_LIMIT", true, factoryKeyValues, "工場数にはまだ余地がある。"));

  // 以降のゲートは「検討はしている」段階。落ちた場合は DEFERRED として理由を残す。
  const deferred = (code: StandardAiReasonCode, keyValues: Record<string, number>, summary: string, message: string) => {
    record("NEW_FACTORY_CONSIDERING", "info", growthKeyValues, "新工場を検討中", "志に対する規模の不足を埋める手段として、新工場を具体的に検討している。");
    record(code, "info", keyValues, summary, message);
    return finish("DEFERRED");
  };

  // --- Gate F: 既存工場の増設余地を先に使う ----------------------------
  const spaceKeyValues = {
    factorySpaceRemainingUnits: observation.factorySpaceRemainingUnits,
    factorySpaceTotalUnits: observation.factorySpaceTotalUnits,
    factorySpaceUsedUnits: observation.factorySpaceUsedUnits,
    existingSpaceSufficientUnits: sp.existingSpaceSufficientUnits,
    overlapGapRatio: sp.overlapGapRatio,
    strategicScaleGapRatio: strategicGrowth.strategicScaleGapRatio,
  };
  const gapJustifiesOverlap = strategicGrowth.strategicScaleGapRatio > sp.overlapGapRatio;
  const hasExistingSpace = observation.factorySpaceRemainingUnits > sp.existingSpaceSufficientUnits;
  gates.push(
    gate(
      "EXISTING_SPACE_FIRST",
      !hasExistingSpace || gapJustifiesOverlap,
      spaceKeyValues,
      hasExistingSpace
        ? gapJustifiesOverlap
          ? "既存工場に余地はあるが、志との差が大きいため新工場の検討を併走させる。"
          : "既存工場にまだ増設余地があるため、新工場より既存増設を先に使う。"
        : "既存工場に十分な増設余地が無い。"
    )
  );
  if (hasExistingSpace && !gapJustifiesOverlap) {
    return deferred(
      "NEW_FACTORY_DEFERRED_EXISTING_SPACE",
      spaceKeyValues,
      "既存工場の増設余地を優先",
      `既存工場に ${Math.round(observation.factorySpaceRemainingUnits).toLocaleString()} スペース単位の余地が残っており、志との差（${(
        strategicGrowth.strategicScaleGapRatio * 100
      ).toFixed(1)}%）も新工場を併走させるほど大きくないため、まず既存工場内の増設で対応する。`
    );
  }

  // --- Gate G: 当期すでに既存増設を提案しているか ----------------------
  if (input.existingExpansionProposedThisQuarter && !gapJustifiesOverlap) {
    const keyValues = { ...spaceKeyValues, existingExpansionProposed: 1 };
    gates.push(gate("EXISTING_EXPANSION_FIRST", false, keyValues, "当期は既存設備の増設を提案済みであり、その効果を先に見る。"));
    return deferred(
      "NEW_FACTORY_DEFERRED_EXISTING_EXPANSION",
      keyValues,
      "既存増設の効果を先に確認",
      "当期は既存設備の増設案件を提案しており、まずその能力増加で志との差がどこまで縮まるかを見る。"
    );
  }
  gates.push(
    gate(
      "EXISTING_EXPANSION_FIRST",
      true,
      { ...spaceKeyValues, existingExpansionProposed: input.existingExpansionProposedThisQuarter ? 1 : 0 },
      "既存増設だけでは志との差を埋められない、または当期の既存増設提案が無い。"
    )
  );

  // --- Gate H: 既存能力が実際に使われているか --------------------------
  //
  // 【分母を間違えない】共通前処理能力（25,650t）だけを分母にすると、商品別ライン
  // 合計（17,100t）がそれより小さい現在の工場設計では、理論上の最大稼働率が
  // 0.67 程度にしかならず、いかなる閾値も算術的に到達不可能になる
  // （decision/capex.ts の Test16 修正と同じ落とし穴）。
  // 実際に生産を縛るのは「商品別ライン合計」と「共通前処理」の**小さい方**なので、
  // それを分母にする。ここで新しい能力計算式は作らず、観測値だけを使う。
  const bindingCapacityTons = computeBindingProductionCapacityTons(
    observation.totalEffectiveCapacityByProduct,
    observation.totalEffectiveCommonProcessingCapacity,
    observation.totalEffectiveFreezingPackagingCapacity,
    PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio
  );
  const lastQuarterProduction = sumProductAmount({
    hoso: observation.lastQuarterActualProductionByProduct.hoso ?? 0,
    pd: observation.lastQuarterActualProductionByProduct.pd ?? 0,
    vap: observation.lastQuarterActualProductionByProduct.vap ?? 0,
  });
  const utilization = bindingCapacityTons > EPSILON ? lastQuarterProduction / bindingCapacityTons : 0;
  const utilizationKeyValues = {
    lastQuarterProductionTons: lastQuarterProduction,
    bindingEffectiveCapacityTons: bindingCapacityTons,
    utilization,
    minimumUtilizationForNewFactory: sp.minimumUtilizationForNewFactory,
    hadPriorQuarter: pressures.hadPriorQuarterUtilization ? 1 : 0,
  };
  const utilizationOk = pressures.hadPriorQuarterUtilization && utilization >= sp.minimumUtilizationForNewFactory;
  gates.push(
    gate(
      "EXISTING_CAPACITY_IN_USE",
      utilizationOk,
      utilizationKeyValues,
      `前期の共通前処理稼働率 ${(utilization * 100).toFixed(1)}%（必要 ${(sp.minimumUtilizationForNewFactory * 100).toFixed(0)}%）。`
    )
  );
  if (!utilizationOk) {
    return deferred(
      "NEW_FACTORY_DEFERRED_MARKET",
      utilizationKeyValues,
      "既存能力に余力があるため見送り",
      `既存の工場がまだ ${(utilization * 100).toFixed(1)}% しか稼働していない。能力を増やしても売れる量が増えるわけではないため、新工場は建てない。`
    );
  }

  // --- Gate I: 需要の裏づけ（当期の生産必要量） ------------------------
  const neededTotal = sumProductAmount(input.productionNeededByProductBeforeCap);
  const demandPullRatio = bindingCapacityTons > EPSILON ? neededTotal / bindingCapacityTons : 0;
  const demandKeyValues: Record<string, number> = {
    productionNeededTons: neededTotal,
    bindingEffectiveCapacityTons: bindingCapacityTons,
    demandPullRatio,
    minimumDemandPullRatio: sp.minimumDemandPullRatio,
  };
  // 【Phase 6・§21/§22】需要根拠を「今期の生産必要量 ÷ 能力」だけで見ない。
  //
  // その指標は「今期作る必要がある量」であり、**商業的な成長機会を構造的に見落とす**。
  // 監査では、販売希望量そのものが自社能力×0.8で決まっていたため、この比率は
  // 定義上0.8前後から動きようがなかった（閾値を下げても意味が無い＝§22）。
  //
  // そこで第2の根拠として「取りたかったのに生産能力が理由で取れなかった量が、
  // 複数四半期にわたって続いている」ことを認める。閾値そのものは変更していない。
  const capacityCausedUnserved = input.unservedOpportunity?.blockedByProductionCapacityTons ?? 0;
  const persistentCapacityEvidence = (input.persistentCapacityCausedUnserved ?? false) && capacityCausedUnserved > EPSILON;
  const demandOk = demandPullRatio >= sp.minimumDemandPullRatio || persistentCapacityEvidence;
  Object.assign(demandKeyValues, {
    commercialAmbitionTons: input.commercialAmbition?.ambitionTons ?? 0,
    capacityCausedUnservedTons: capacityCausedUnserved,
    persistentCapacityCausedUnserved: persistentCapacityEvidence ? 1 : 0,
  });
  gates.push(
    gate(
      "DEMAND_PULL",
      demandOk,
      demandKeyValues,
      persistentCapacityEvidence
        ? `生産能力が理由で取り切れなかった採算つき機会が持続している（当期 ${Math.round(capacityCausedUnserved).toLocaleString()}t）。`
        : `当期の生産必要量 ÷ 実効能力 = ${(demandPullRatio * 100).toFixed(1)}%。`
    )
  );
  if (!demandOk) {
    return deferred(
      "NEW_FACTORY_DEFERRED_MARKET",
      demandKeyValues,
      "需要の裏づけが不足するため見送り",
      `当期の生産必要量は既存の実効能力の ${(demandPullRatio * 100).toFixed(1)}% にとどまる。志との差はあるが、いま能力を増やしても行き先が無い。`
    );
  }

  // --- Gate J: 原料供給の裏づけ ----------------------------------------
  // 【捏造しない】この会社が実際に買える量の上限は観測できない。
  // 観測できるのは「前四半期に国内市場で売れ残った供給があったか」だけである。
  const priorMarket = observation.vietnamDomesticPriorMarket;
  const rawKeyValues = {
    rawMaterialAvailable: observation.rawMaterialAvailable,
    rawMaterialPipeline: observation.rawMaterialPipeline,
    priorUnsoldSupply: priorMarket?.unsoldSupply ?? 0,
    priorMarketObserved: priorMarket ? 1 : 0,
  };
  // 前四半期の市場結果が観測できない（turn1等）場合は、原料を理由に否定も肯定もしない
  // （不明を「安全」と読み替えない）。観測できる場合のみ、売れ残りが無い＝タイトと判定する。
  const rawTight = priorMarket !== undefined && priorMarket.unsoldSupply <= EPSILON;
  gates.push(
    gate(
      "RAW_MATERIAL_SUPPORT",
      !rawTight,
      rawKeyValues,
      priorMarket
        ? `前四半期の国内市場の売れ残り供給 ${Math.round(priorMarket.unsoldSupply).toLocaleString()}t。`
        : "前四半期の国内市場の公開清算結果が観測できない（この段階では原料を理由に判断しない）。"
    )
  );
  if (rawTight) {
    return deferred(
      "NEW_FACTORY_DEFERRED_RAW",
      rawKeyValues,
      "原料供給の裏づけが不足するため見送り",
      "前四半期の国内原料市場に売れ残り供給が無く、市場全体がタイトである。工場を増やしても回す原料を確保できる保証がないため見送る。"
    );
  }

  // --- Gate K: 労働力の裏づけ ------------------------------------------
  const laborKeyValues = {
    laborUtilizationLastQuarter: pressures.laborUtilizationLastQuarter,
    laborStrainCeiling: sp.laborStrainCeiling,
    regularHeadcountTotal: observation.regularHeadcountTotal,
  };
  const laborOk = pressures.laborUtilizationLastQuarter <= sp.laborStrainCeiling;
  gates.push(
    gate("LABOR_SUPPORT", laborOk, laborKeyValues, `前期の労働稼働率 ${(pressures.laborUtilizationLastQuarter * 100).toFixed(1)}%。`)
  );
  if (!laborOk) {
    return deferred(
      "NEW_FACTORY_DEFERRED_LABOR",
      laborKeyValues,
      "労働力に無理があるため見送り",
      `既存工場の労働稼働率が ${(pressures.laborUtilizationLastQuarter * 100).toFixed(
        1
      )}% と逼迫しており、新工場を回す人員まで確保できる状態ではない。`
    );
  }

  // --- Gate L: 財務 ----------------------------------------------------
  // 【「現金 > 投資額」だけでは判断しない】
  //   ・着工四半期に出ていくのは初回支払ぶんだけだが、残りも建設中に出ていく。
  //   ・投資後も最低現金バッファを割ってはならない。
  //   ・借入余力（borrowingPressure）を著しく損なわない。
  //   ・どれだけ手元で用意しておきたいかは、Vision の財務リスク許容度で変わる。
  const coverageRatio = sp.upfrontCoverageRatioByRiskTolerance[vision.financialRiskTolerance];
  // 【Phase SAI-GROW-3B-1】affordabilityの定義はLiquidity SSoTへ統一する。
  // upfrontCoverageRatio は「会社の財務リスク許容度」を表す固有の意味を持つため削除せず、
  // SSoTの上に載る **profile固有の安全余裕** として残す（実装指示§7）。
  const liquidity = input.liquidity;
  const paymentsWithinHorizonUsd = liquidity
    ? plannedInvestmentPaymentsWithinHorizonUsd(projectCostUsd, capexParams.templatesByType.newFactoryConstruction.paymentRatios, liquidity.horizonQuarters)
    : projectCostUsd;
  const paymentsThisQuarterUsd = liquidity
    ? plannedInvestmentPaymentsWithinHorizonUsd(projectCostUsd, capexParams.templatesByType.newFactoryConstruction.paymentRatios, 1)
    : projectCostUsd;
  const affordability = liquidity
    ? evaluateInvestmentAffordability(
        liquidity.assessment,
        paymentsWithinHorizonUsd,
        liquidity.alreadyApprovedThisTurnUsd(),
        coverageRatio,
        paymentsThisQuarterUsd,
        liquidity.alreadyApprovedThisQuarterUsd()
      )
    : null;
  const requiredCashUsd = liquidity
    ? liquidity.assessment.protectedFundingRequirementUsd + paymentsWithinHorizonUsd + (affordability?.safetyMarginUsd ?? 0)
    : pressures.targetMinimumCashUsd + projectCostUsd * coverageRatio;
  const cashSafe = affordability ? affordability.affordable : observation.cashUsd > requiredCashUsd;
  const borrowingSafe = pressures.borrowingPressure < 1;
  const financeKeyValues = {
    cashUsd: observation.cashUsd,
    projectCostUsd,
    firstPaymentUsd,
    upfrontCoverageRatio: coverageRatio,
    targetMinimumCashUsd: pressures.targetMinimumCashUsd,
    requiredCashUsd,
    cashAfterFirstPaymentUsd: observation.cashUsd - firstPaymentUsd,
    borrowingPressure: pressures.borrowingPressure,
    financialGateCashSafe: cashSafe ? 1 : 0,
    financialGateBorrowingSafe: borrowingSafe ? 1 : 0,
    ...(liquidity
      ? {
          liquidityHeadroomUsd: liquidity.assessment.liquidityHeadroomUsd,
          protectedFundingRequirementUsd: liquidity.assessment.protectedFundingRequirementUsd,
          committedCapitalPaymentsUsd: liquidity.assessment.committedCapitalPaymentsUsd,
          realisticallyAvailableBorrowingUsd: liquidity.assessment.realisticallyAvailableBorrowingUsd,
          proposedInvestmentPaymentsUsd: paymentsWithinHorizonUsd,
          alreadyApprovedThisTurnUsd: affordability?.alreadyApprovedThisTurnUsd ?? 0,
          postInvestmentLiquidityUsd: affordability?.postInvestmentLiquidityUsd ?? 0,
          profileSafetyMarginUsd: affordability?.safetyMarginUsd ?? 0,
        }
      : {}),
  };
  gates.push(
    gate(
      "FINANCIAL_FEASIBILITY",
      cashSafe && borrowingSafe,
      financeKeyValues,
      `必要現金 ${Math.round(requiredCashUsd).toLocaleString()} USD（最低バッファ ＋ 投資額×${coverageRatio}、財務リスク許容度 ${
        vision.financialRiskTolerance
      }）に対し手元現金 ${Math.round(observation.cashUsd).toLocaleString()} USD。`
    )
  );
  if (!cashSafe || !borrowingSafe) {
    return deferred(
      "NEW_FACTORY_DEFERRED_FINANCE",
      financeKeyValues,
      "資金・財務健全性の条件を満たさないため見送り",
      `新工場（${Math.round(projectCostUsd / 1e6)}百万USD）に対し、財務リスク許容度 ${
        vision.financialRiskTolerance
      } では最低現金バッファ込みで ${Math.round(requiredCashUsd).toLocaleString()} USD の手元資金を求める。現在は ${Math.round(
        observation.cashUsd
      ).toLocaleString()} USD${borrowingSafe ? "" : "、かつ借入水準も余力を失っている"}であり、今期は見送る。`
    );
  }

  // --- 全ゲート通過 ----------------------------------------------------
  record("NEW_FACTORY_CONSIDERING", "info", growthKeyValues, "新工場を検討中", "志に対する規模の不足を埋める手段として、新工場を具体的に検討している。");
  record(
    "NEW_FACTORY_PROPOSED",
    "info",
    { ...growthKeyValues, ...financeKeyValues, ...utilizationKeyValues, ...factoryKeyValues },
    `新工場建設を提案（${Math.round(projectCostUsd / 1e6)}百万USD、${observation.factoryCount} → ${observation.factoryCount + 1}工場）`,
    `Vision（${vision.preferredEndState}、Q32で ${vision.targetScaleTonsPerQuarterAtQ32.toLocaleString()}t/期）に対して規模が ${Math.round(
      strategicGrowth.strategicScaleGapTons
    ).toLocaleString()}t/期 不足しており、既存工場の増設余地・稼働率・需要・原料・労働・財務のすべての条件を満たすため、新工場の建設を提案する。`
  );
  liquidity?.commit(paymentsWithinHorizonUsd, paymentsThisQuarterUsd);
  return finish("READY_TO_BUILD", [{ projectType: "newFactoryConstruction" }]);
}

// =========================================================================
// Strategic Posture: AGGRESSIVE_EARLY_CAPACITY — Strategic Forward Capacity Route
//
// 設計文書: docs/standard_ai/STRATEGIC_POSTURE_AGGRESSIVE_EARLY_CAPACITY.md
//
// 【limited rationality】ここで使うのは Vision（会社自身の志）・
// currentSustainableScaleTons（bindingCapacity.tsの唯一の計算）・
// commercialAmbition/unservedOpportunity（既存モジュールが観測情報だけから
// 既に計算した値）だけである。シナリオの将来イベント・TRUE需要は一切読まない。
//
// 【reactiveゲートを緩めない】財務ゲートはreactive route（Gate L）とまったく
// 同じ cashSafe && borrowingSafe を再計算する。ここでは閾値を下げない。
// =========================================================================

/**
 * Forward Capacity Gap の算出に使う、観測可能な成長根拠を組み立てる。
 * 新しいtrend検出ロジックは作らず、既存モジュールの出力をそのまま使う
 * （設計文書§5.2）。
 */
function buildMarketGrowthEvidence(input: NewFactoryDecisionInput, bindingCapacityTons: number): MarketGrowthEvidence {
  const recentOwnContractGrowthRatio = input.commercialAmbition ? input.commercialAmbition.ambitionMultiplier - 1 : null;

  // 【Phase G・§3/§6修正】ここで observedMarketGrowthRatio を
  // 「持続的に稼働率が高い（persistentCapacityCausedUnserved）」に紐づけない。
  // その条件は reactive Gate H（EXISTING_CAPACITY_IN_USE、稼働率が既に
  // minimumUtilizationForNewFactory を超えている）と実質同一の「今すでに
  // 能力が逼迫している」条件であり、strategic routeの存在意義（＝まだ逼迫
  // していない段階で先を見る）と矛盾する。Phase Fの実測監査で、この結合が
  // strategic routeが一度もreactiveより先に発火しなかった直接原因だった。
  //
  // 代わりに、当期・生産能力が理由で取り切れなかった採算つき機会
  // （unservedOpportunity.blockedByProductionCapacityTons）をそのまま使う。
  // これは既存モジュール（unservedOpportunity.ts）が当期の観測だけから
  // 正式に切り分けた値であり、新しい計算式ではない。「持続しているか」は
  // ここでは要求しない（1四半期の値の急増だけで過剰反応しないための
  // 抑制は、Gate STRATEGIC_GROWTH_EVIDENCE 側でrecentOwnContractGrowthRatio
  // との**両立**を要求することで別途かける。設計文書§5.2）。
  const capacityCausedUnserved = input.unservedOpportunity?.blockedByProductionCapacityTons ?? 0;
  const observedMarketGrowthRatio = bindingCapacityTons > EPSILON && capacityCausedUnserved > EPSILON ? capacityCausedUnserved / bindingCapacityTons : null;

  return { recentOwnContractGrowthRatio, observedMarketGrowthRatio };
}

/**
 * 【Strategic Route】Forward Capacity Gapに基づく、先行能力投資型の新工場検討。
 * AGGRESSIVE_EARLY_CAPACITYの会社に対してのみ、reactive routeがREADY_TO_BUILDへ
 * 届かなかったときに呼ばれる（evaluateNewFactoryDecision参照）。
 */
function evaluateStrategicForwardCapacityRoute(
  input: NewFactoryDecisionInput,
  reactiveStatusAtDecision: NewFactoryConsiderationStatus,
  reactiveBlockerAtDecision: string | null
): NewFactoryDecisionResult {
  const { fixture, observation, pressures, vision, strategicGrowth } = input;
  if (!vision || !strategicGrowth) {
    throw new Error("evaluateStrategicForwardCapacityRoute: vision/strategicGrowth must be present（呼び出し側の契約違反）。");
  }
  const capexParams = input.capexParams ?? CAPEX_PARAMETERS_V1;
  const sp = input.strategyParams ?? NEW_FACTORY_STRATEGY_PARAMETERS_V1;
  const template = capexParams.templatesByType.newFactoryConstruction;
  const projectCostUsd = template.standardBudgetUsd;
  const firstPaymentUsd = projectCostUsd * (template.paymentRatios[0] ?? 1);

  const gates: NewFactoryGateResult[] = [];
  const reasonCodes: StandardAiReasonCode[] = [];
  const diagnostics: StandardAiDiagnosticEntry[] = [];

  const record = (
    code: StandardAiReasonCode,
    severity: StandardAiDiagnosticEntry["severity"],
    keyValues: Record<string, number>,
    decisionSummary: string,
    message: string
  ) => {
    reasonCodes.push(code);
    diagnostics.push({ code, domain: "capex", companyId: fixture.companyId, severity, keyValues, decisionSummary, message });
  };

  const bindingCapacityTons = computeBindingProductionCapacityTons(
    observation.totalEffectiveCapacityByProduct,
    observation.totalEffectiveCommonProcessingCapacity,
    observation.totalEffectiveFreezingPackagingCapacity,
    PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio
  );
  const marketGrowthEvidence = buildMarketGrowthEvidence(input, bindingCapacityTons);
  const forwardCapacityGap = computeForwardCapacityGap({
    turn: input.turn,
    vision,
    currentSustainableScaleTons: strategicGrowth.currentSustainableScaleTons,
    marketGrowthEvidence,
    capexParams,
  });

  let existingExpansionAlternativeSufficientTons: number | null = null;
  let postConstructionActivationFeasible: boolean | null = null;

  const finish = (status: NewFactoryConsiderationStatus, proposals: readonly CapexProjectProposalInput[] = []): NewFactoryDecisionResult => ({
    assessment: {
      status,
      reasonCodes,
      gates,
      projectCostUsd,
      firstPaymentUsd,
      growthPressure: strategicGrowth.growthPressure,
      strategicScaleGapTons: strategicGrowth.strategicScaleGapTons,
      strategicScaleGapRatio: strategicGrowth.strategicScaleGapRatio,
      commercialAmbitionTons: input.commercialAmbition?.ambitionTons ?? null,
      profitableOpportunityTons: input.commercialAmbition?.realisticOpportunityTons ?? null,
      unservedProfitableTons: input.unservedOpportunity?.unservedProfitableTons ?? null,
      capacityCausedUnservedTons: input.unservedOpportunity?.blockedByProductionCapacityTons ?? null,
      persistentCapacityCausedUnserved: input.persistentCapacityCausedUnserved ?? false,
      decisionRoute: status === "READY_TO_BUILD" ? "STRATEGIC_FORWARD_CAPACITY" : "NONE",
      strategicPosture: vision.strategicPosture ?? null,
      forwardCapacityGap,
      marketGrowthEvidence,
      existingExpansionAlternativeSufficientTons,
      postConstructionActivationFeasible,
      reactiveStatusAtStrategicDecision: reactiveStatusAtDecision,
      reactiveBlockerAtStrategicDecision: reactiveBlockerAtDecision,
    },
    proposals,
    diagnostics,
  });

  const gapKeyValues = {
    forwardCapacityGapTons: forwardCapacityGap.forwardCapacityGapTons,
    forwardCapacityGapRatio: forwardCapacityGap.forwardCapacityGapRatio,
    forecastCompletionTurn: forwardCapacityGap.forecastCompletionTurn,
    projectedCommercialScaleAtCompletion: forwardCapacityGap.projectedCommercialScaleAtCompletion,
    existingCapacityAtCompletion: forwardCapacityGap.existingCapacityAtCompletion,
    constructionLeadTimeQuarters: forwardCapacityGap.constructionLeadTimeQuarters,
  };

  // --- Gate: forward gap が意味のある大きさか -----------------------------
  const gapMeaningful = forwardCapacityGap.forwardCapacityGapTons > EPSILON;
  gates.push(
    gate(
      "STRATEGIC_FORWARD_GAP",
      gapMeaningful,
      gapKeyValues,
      `完成予定Q${forwardCapacityGap.forecastCompletionTurn}時点の想定規模 ${Math.round(
        forwardCapacityGap.projectedCommercialScaleAtCompletion
      ).toLocaleString()}t/期 に対し、現在能力 ${Math.round(forwardCapacityGap.existingCapacityAtCompletion).toLocaleString()}t/期。`
    )
  );
  if (!gapMeaningful) {
    record(
      "NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT",
      "info",
      gapKeyValues,
      "先行投資の根拠なし",
      `完成予定Q${forwardCapacityGap.forecastCompletionTurn}時点でも、Vision参考軌道と観測できる成長根拠のどちらか小さい方で見た想定規模が現在能力を上回らないため、先行着工の根拠が無い。`
    );
    return finish("NOT_CONSIDERED");
  }
  record(
    "NEW_FACTORY_STRATEGIC_FORWARD_GAP",
    "info",
    gapKeyValues,
    `完成時点で ${Math.round(forwardCapacityGap.forwardCapacityGapTons).toLocaleString()}t/期 不足見込み`,
    `Vision参考軌道（完成時点 ${Math.round(
      forwardCapacityGap.visionReferenceScaleAtCompletion
    ).toLocaleString()}t/期）と観測成長率で延伸した見込み（${Math.round(
      forwardCapacityGap.trendAdjustedScaleAtCompletion
    ).toLocaleString()}t/期）の小さい方に対し、現在能力が ${Math.round(forwardCapacityGap.forwardCapacityGapTons).toLocaleString()}t/期 不足する。`
  );

  // --- Gate: 観測できる成長根拠があるか（Vision単独の楽観だけで進めない） ---
  const growthEvidencePresent = forwardCapacityGap.observedGrowthRatioPerQuarter > EPSILON;
  const evidenceKeyValues = {
    recentOwnContractGrowthRatio: marketGrowthEvidence.recentOwnContractGrowthRatio ?? 0,
    observedMarketGrowthRatio: marketGrowthEvidence.observedMarketGrowthRatio ?? 0,
    observedGrowthRatioPerQuarter: forwardCapacityGap.observedGrowthRatioPerQuarter,
  };
  gates.push(
    gate(
      "STRATEGIC_GROWTH_EVIDENCE",
      growthEvidencePresent,
      evidenceKeyValues,
      growthEvidencePresent
        ? `自社成長根拠・観測市場成長根拠のいずれも正（四半期あたり ${(forwardCapacityGap.observedGrowthRatioPerQuarter * 100).toFixed(1)}%）。`
        : "自社成長・観測市場成長のいずれかが観測できないか0以下であり、Vision単独の楽観にとどまる。"
    )
  );
  if (!growthEvidencePresent) {
    record(
      "NEW_FACTORY_STRATEGIC_DEFERRED_GROWTH_EVIDENCE",
      "info",
      evidenceKeyValues,
      "観測できる成長根拠が乏しいため見送り",
      "Vision の参考軌道だけでは先行着工の根拠として不十分。自社の直近成長・観測できる市場成長のいずれかが確認できないため、今期は先行提案しない。"
    );
    return finish("NOT_CONSIDERED");
  }

  // --- Gate: 既存増設だけでは gap を解消できないか ------------------------
  // 【Phase G・§13/§14修正】ここでの「併走を正当化するほど差が大きいか」は
  // reactive routeと同じ currentの strategicScaleGapRatio ではなく、
  // strategic routeが実際に見ている forwardCapacityGapRatio（完成時点の
  // 不足）で判定する。current gapは「今」の話であり、strategic routeの
  // 判断基準（完成時点）と食い違うと、ここでも実質的にreactiveと同じ
  // タイミングでしか併走を許さなくなってしまう（§3と同型の問題）。
  const gapJustifiesOverlap = forwardCapacityGap.forwardCapacityGapRatio > sp.overlapGapRatio;
  const hasExistingSpace = observation.factorySpaceRemainingUnits > sp.existingSpaceSufficientUnits;
  const existingExpansionSufficient = hasExistingSpace && !gapJustifiesOverlap;
  const expansionKeyValues = {
    factorySpaceRemainingUnits: observation.factorySpaceRemainingUnits,
    existingSpaceSufficientUnits: sp.existingSpaceSufficientUnits,
    overlapGapRatio: sp.overlapGapRatio,
    forwardCapacityGapRatio: forwardCapacityGap.forwardCapacityGapRatio,
  };
  gates.push(
    gate(
      "STRATEGIC_EXISTING_EXPANSION_INSUFFICIENT",
      !existingExpansionSufficient,
      expansionKeyValues,
      existingExpansionSufficient
        ? "既存工場の増設余地・志との差の大きさから見て、既存増設だけで足りる可能性が高い。"
        : "既存増設だけではforward gapを解消できない、または志との差がすでに併走を正当化する規模。"
    )
  );
  if (existingExpansionSufficient) {
    existingExpansionAlternativeSufficientTons = forwardCapacityGap.forwardCapacityGapTons;
    record(
      "NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT",
      "info",
      expansionKeyValues,
      "既存増設で対応可能",
      `既存工場にまだ ${Math.round(observation.factorySpaceRemainingUnits).toLocaleString()} スペース単位の増設余地があり、志との差もまだ既存増設だけで対応できる範囲のため、先行して新工場は建てない。`
    );
    return finish("DEFERRED");
  }

  // --- Gate: 工場数上限・進行中案件（reactive routeと同じ条件の再確認） -----
  const factoryKeyValues = {
    factoryCount: observation.factoryCount,
    pendingNewFactoryProjectCount: observation.pendingNewFactoryProjectCount,
    prospectiveFactoryCount: observation.prospectiveFactoryCount,
    maxFactoriesPerCompany: observation.maxFactoriesPerCompany,
  };
  const factoryRoomOk = observation.pendingNewFactoryProjectCount === 0 && observation.prospectiveFactoryCount < observation.maxFactoriesPerCompany;
  gates.push(
    gate(
      "STRATEGIC_FACTORY_ROOM",
      factoryRoomOk,
      factoryKeyValues,
      factoryRoomOk ? "進行中の新工場案件は無く、工場数にも余地がある。" : "進行中の新工場案件があるか、工場数が上限に達している。"
    )
  );
  if (!factoryRoomOk) {
    return finish("DEFERRED");
  }

  // --- Gate: 財務（reactive routeのGate Lと同一の判定式。基準を緩めない） ---
  // 【Phase SAI-GROW-3B-1】reactive routeと同じくLiquidity SSoTを使う。
  const coverageRatio = sp.upfrontCoverageRatioByRiskTolerance[vision.financialRiskTolerance];
  const liquidity = input.liquidity;
  const paymentsWithinHorizonUsd = liquidity
    ? plannedInvestmentPaymentsWithinHorizonUsd(projectCostUsd, capexParams.templatesByType.newFactoryConstruction.paymentRatios, liquidity.horizonQuarters)
    : projectCostUsd;
  const paymentsThisQuarterUsd = liquidity
    ? plannedInvestmentPaymentsWithinHorizonUsd(projectCostUsd, capexParams.templatesByType.newFactoryConstruction.paymentRatios, 1)
    : projectCostUsd;
  const affordability = liquidity
    ? evaluateInvestmentAffordability(
        liquidity.assessment,
        paymentsWithinHorizonUsd,
        liquidity.alreadyApprovedThisTurnUsd(),
        coverageRatio,
        paymentsThisQuarterUsd,
        liquidity.alreadyApprovedThisQuarterUsd()
      )
    : null;
  const requiredCashUsd = liquidity
    ? liquidity.assessment.protectedFundingRequirementUsd + paymentsWithinHorizonUsd + (affordability?.safetyMarginUsd ?? 0)
    : pressures.targetMinimumCashUsd + projectCostUsd * coverageRatio;
  const cashSafe = affordability ? affordability.affordable : observation.cashUsd > requiredCashUsd;
  const borrowingSafe = pressures.borrowingPressure < 1;
  const financeKeyValues = {
    cashUsd: observation.cashUsd,
    projectCostUsd,
    firstPaymentUsd,
    upfrontCoverageRatio: coverageRatio,
    requiredCashUsd,
    borrowingPressure: pressures.borrowingPressure,
    ...(liquidity
      ? {
          liquidityHeadroomUsd: liquidity.assessment.liquidityHeadroomUsd,
          protectedFundingRequirementUsd: liquidity.assessment.protectedFundingRequirementUsd,
          postInvestmentLiquidityUsd: affordability?.postInvestmentLiquidityUsd ?? 0,
        }
      : {}),
  };
  gates.push(
    gate(
      "STRATEGIC_FINANCIAL_FEASIBILITY",
      cashSafe && borrowingSafe,
      financeKeyValues,
      `必要現金 ${Math.round(requiredCashUsd).toLocaleString()} USD（reactive routeと同一の財務ゲート）に対し手元現金 ${Math.round(
        observation.cashUsd
      ).toLocaleString()} USD。`
    )
  );
  if (!cashSafe || !borrowingSafe) {
    postConstructionActivationFeasible = false;
    record(
      "NEW_FACTORY_STRATEGIC_DEFERRED_FINANCE",
      "info",
      financeKeyValues,
      "財務条件を満たさないため先行着工を見送り",
      "積極戦略でも財務の安全性は緩めない。reactive routeと同じ財務ゲートを満たさないため、今期は先行着工しない。"
    );
    return finish("DEFERRED");
  }

  // --- Gate: 完成後の実際の稼働化可能性（空箱化リスク） -------------------
  // 【このフェーズでの簡略化】独立したキャッシュフロー予測は持たず、上のGateが
  // 使った cashSafe && borrowingSafe をそのまま再利用する（既に投資額＋最低
  // バッファの両方を満たした状態であることを、そのまま「その後の稼働化にも
  // 耐えうる」ことの根拠とする）。設計文書§8/§17参照。
  postConstructionActivationFeasible = cashSafe && borrowingSafe;
  gates.push(
    gate(
      "STRATEGIC_ACTIVATION_FEASIBILITY",
      postConstructionActivationFeasible,
      financeKeyValues,
      "完成後もWorker・設備を追加投入できる財務余力があると判断（reactive routeの財務ゲートと同一の根拠）。"
    )
  );
  if (!postConstructionActivationFeasible) {
    record(
      "NEW_FACTORY_STRATEGIC_DEFERRED_ACTIVATION",
      "info",
      financeKeyValues,
      "完成後の稼働化に見込みが立たないため見送り",
      "工場を先行着工しても、完成後にWorker・設備を実際に入れられる財務余力の見込みが立たないため、空箱化を避けて今期は見送る。"
    );
    return finish("DEFERRED");
  }

  // --- 全ゲート通過 --------------------------------------------------------
  record(
    "NEW_FACTORY_STRATEGIC_PROPOSED",
    "info",
    { ...gapKeyValues, ...evidenceKeyValues, ...financeKeyValues },
    `Forward Capacity Gapに基づき新工場建設を先行提案（${Math.round(projectCostUsd / 1e6)}百万USD、完成予定Q${forwardCapacityGap.forecastCompletionTurn}）`,
    `完成予定Q${forwardCapacityGap.forecastCompletionTurn}時点で ${Math.round(
      forwardCapacityGap.forwardCapacityGapTons
    ).toLocaleString()}t/期 の能力不足が見込まれ、観測できる自社・市場の成長根拠もあり、既存増設だけでは解消できず、財務・完成後の稼働化見込みも問題ない。現在の稼働率がまだ逼迫していなくても、建設リードタイム（${
      forwardCapacityGap.constructionLeadTimeQuarters
    }四半期）を踏まえて今着工する。`
  );
  liquidity?.commit(paymentsWithinHorizonUsd, paymentsThisQuarterUsd);
  return finish("READY_TO_BUILD", [{ projectType: "newFactoryConstruction" }]);
}

/**
 * 新工場建設を検討する（純粋関数）。提案するかどうかに関わらず、必ず
 * assessment と診断エントリを返す。
 *
 * 【2つの経路】
 *   Reactive Route      … 今の稼働率・受注残・需要に反応する経路（常に評価）。
 *   Strategic Route      … Forward Capacity Gapに基づく先行投資の経路。
 *     vision.strategicPosture === "AGGRESSIVE_EARLY_CAPACITY" のときだけ、
 *     reactive routeがREADY_TO_BUILDへ届かなかった場合に限り評価する
 *     （同一四半期に二重提案しない。DEMAND_CONFIRMED/VALUE_FIRSTは常にreactiveのみ＝STRAT-1）。
 */
export function evaluateNewFactoryDecision(input: NewFactoryDecisionInput): NewFactoryDecisionResult {
  const reactive = evaluateReactiveNewFactoryRoute(input);
  if (reactive.assessment.status === "READY_TO_BUILD") {
    return reactive;
  }

  const isAggressive = input.vision?.strategicPosture === "AGGRESSIVE_EARLY_CAPACITY";
  const factoryRoomForStrategic =
    input.observation.pendingNewFactoryProjectCount === 0 && input.observation.prospectiveFactoryCount < input.observation.maxFactoriesPerCompany;
  if (!isAggressive || !input.vision || !input.strategicGrowth || !factoryRoomForStrategic) {
    return reactive;
  }

  const strategic = evaluateStrategicForwardCapacityRoute(
    input,
    reactive.assessment.status,
    describeNewFactoryBlocker(reactive.assessment)
  );
  return {
    assessment: strategic.assessment,
    proposals: strategic.proposals,
    // 【両方の経路の判断根拠を残す】strategicが見送りに終わっても、reactiveが
    // 何を見ていたかの記録を捨てない（説明可能性。設計文書§9）。
    diagnostics: [...reactive.diagnostics, ...strategic.diagnostics],
  };
}
