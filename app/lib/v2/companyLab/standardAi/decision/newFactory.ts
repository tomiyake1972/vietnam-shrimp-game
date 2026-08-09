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
import { CompanyVision } from "../../vision/types";
import { GrowthPressure, StrategicGrowthState, growthPressureAtLeast } from "../../vision/strategicGrowth";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, sumProductAmount } from "../types";
import { StandardAiDiagnosticEntry, StandardAiReasonCode } from "../reasonCodes";

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
}

export interface NewFactoryDecisionResult {
  readonly assessment: NewFactoryAssessment;
  /** 提案する場合の1件（提案しない場合は空）。 */
  readonly proposals: readonly CapexProjectProposalInput[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export interface NewFactoryStrategyParameters {
  /**
   * 工場を建てることへの前向きさ別の、検討開始・提案に必要な growth pressure。
   * LOW の会社でも「絶対に建てない」ではなく「よほどのことがない限り建てない」。
   */
  readonly monitoringPressureByWillingness: Readonly<Record<CompanyVision["willingnessToBuildFactories"], GrowthPressure>>;
  readonly proposalPressureByWillingness: Readonly<Record<CompanyVision["willingnessToBuildFactories"], GrowthPressure>>;
  /**
   * 既存工場のスペース残がこの単位数を上回る間は、原則として既存増設を先に使う。
   * ただし下の overlapGapRatio を超える大きな gap では併走を許す
   * （志が桁違いに大きいとき、既存増設だけを待つのは合理的でない）。
   */
  readonly existingSpaceSufficientUnits: number;
  /** この gap 比率を超えたら、既存増設余地があっても新工場の検討を併走させる。 */
  readonly overlapGapRatio: number;
  /** 既存能力がこの稼働率に達していないうちは、能力を増やしても意味がない。 */
  readonly minimumUtilizationForNewFactory: number;
  /** 当期の生産必要量が既存実効能力のこの比率を超えていること（需要の裏づけ）。 */
  readonly minimumDemandPullRatio: number;
  /** 労働稼働率がこれを超えていると、新工場を回す人員の確保に無理があると見る。 */
  readonly laborStrainCeiling: number;
  /** 財務リスク許容度別の、総投資額に対して手元で用意しておきたい比率。 */
  readonly upfrontCoverageRatioByRiskTolerance: Readonly<Record<CompanyVision["financialRiskTolerance"], number>>;
}

export const NEW_FACTORY_STRATEGY_PARAMETERS_V1: NewFactoryStrategyParameters = {
  monitoringPressureByWillingness: { HIGH: "MODERATE", MEDIUM: "MODERATE", LOW: "HIGH" },
  proposalPressureByWillingness: { HIGH: "HIGH", MEDIUM: "HIGH", LOW: "URGENT" },
  existingSpaceSufficientUnits: 3_000,
  overlapGapRatio: 0.3,
  minimumUtilizationForNewFactory: 0.75,
  minimumDemandPullRatio: 0.95,
  laborStrainCeiling: 1.15,
  upfrontCoverageRatioByRiskTolerance: { HIGH: 0.6, MEDIUM: 0.85, LOW: 1.1 },
};

export interface NewFactoryDecisionInput {
  readonly fixture: CompanyFixture;
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly vision: CompanyVision | null;
  readonly strategicGrowth: StrategicGrowthState | null;
  /** 制約適用前の当期生産必要量（需要の裏づけ判定に使う。capex.ts と同じ値）。 */
  readonly productionNeededByProductBeforeCap: ProductAmount;
  /** 当期、既存設備の増設案件を提案したか（既存増設を先に使う原則の判定材料）。 */
  readonly existingExpansionProposedThisQuarter: boolean;
  readonly capexParams?: CapexParameters;
  readonly strategyParams?: NewFactoryStrategyParameters;
}

function gate(gateName: string, passed: boolean, keyValues: Record<string, number>, note: string): NewFactoryGateResult {
  return { gate: gateName, passed, keyValues, note };
}

/**
 * 新工場建設を検討する（純粋関数）。
 * 提案するかどうかに関わらず、必ず assessment と診断エントリを返す。
 */
export function evaluateNewFactoryDecision(input: NewFactoryDecisionInput): NewFactoryDecisionResult {
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
  const bindingCapacityTons = Math.min(
    sumProductAmount({ ...observation.totalEffectiveCapacityByProduct }),
    observation.totalEffectiveCommonProcessingCapacity
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
  const demandKeyValues = {
    productionNeededTons: neededTotal,
    bindingEffectiveCapacityTons: bindingCapacityTons,
    demandPullRatio,
    minimumDemandPullRatio: sp.minimumDemandPullRatio,
  };
  const demandOk = demandPullRatio >= sp.minimumDemandPullRatio;
  gates.push(gate("DEMAND_PULL", demandOk, demandKeyValues, `当期の生産必要量 ÷ 実効能力 = ${(demandPullRatio * 100).toFixed(1)}%。`));
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
  const requiredCashUsd = pressures.targetMinimumCashUsd + projectCostUsd * coverageRatio;
  const cashSafe = observation.cashUsd > requiredCashUsd;
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
  return finish("READY_TO_BUILD", [{ projectType: "newFactoryConstruction" }]);
}
