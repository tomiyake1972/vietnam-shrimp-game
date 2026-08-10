// ShrimpX V2 — Phase 6D: New Factory Gate Audit（#05 §0〜§40）
//
// 【READ / AUDIT FIRST】このスクリプトは threshold・gate・Vision・工場・Worker の
// いずれも変更しない。正式モデル（Phase 6C 既定）で 32Q を回し、
// Standard AI が実際に行った新工場判断を、記録された gate keyValues と
// 純粋関数の再呼び出し（counterfactual）だけで完全再構成する。
//
// 【counterfactual の正当性】evaluateNewFactoryDecision は純粋関数である。
// 実行時に観測・圧力を（同一入力からの再計算で）捕捉しておき、監査時に
// 入力を1つだけ差し替えて再評価する。世界 state には一切触れない。

import { CompanyLabConfig, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import {
  generateStandardAiDecisionWithDiagnostics,
  StandardAiQuarterDiagnostics,
} from "../app/lib/v2/companyLab/standardAi/policy";
import { buildStandardAiObservation } from "../app/lib/v2/companyLab/standardAi/observation";
import { computePressureScores, PressureScores } from "../app/lib/v2/companyLab/standardAi/pressures";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";
import { StandardAiObservation, sumProductAmount, ProductAmount, zeroProductAmount } from "../app/lib/v2/companyLab/standardAi/types";
import { evaluateNewFactoryDecision, NEW_FACTORY_STRATEGY_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/decision/newFactory";
import {
  computeEligibleCurrentPeriodDemand,
  computeNormalInventoryTargetByProduct,
  computeBasicCurrentPeriodProductionRequirement,
  computeFinalProductionRequirement,
} from "../app/lib/v2/companyLab/standardAi/diagnosis/productionRequirement";
import { CAPEX_PARAMETERS_V1 } from "../app/lib/v2/capex/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { unwrapUsd } from "../app/lib/v2/finance/types";
import { PeriodV2 } from "../app/lib/v2/core/period";

const TURNS = 32;
const COMPANIES = ["BAL", "JPQ", "CONSV", "MASS", "VAP"];
const DETAIL_TURNS = [16, 20, 24, 28, 32];
const n = (v: number | null | undefined, w = 8) =>
  v === null || v === undefined ? "－".padStart(w) : Math.round(v).toLocaleString().padStart(w);
const f2 = (v: number | null | undefined, w = 6) => (v === null || v === undefined ? "－".padStart(w) : v.toFixed(3).padStart(w));

// ---------------------------------------------------------------------
// 実行＋観測・圧力の捕捉（純粋関数の再呼び出し。決定そのものは通常経路と同一）
// ---------------------------------------------------------------------

interface Captured {
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
}

const captured = new Map<string, Captured>();
const diagnostics: StandardAiQuarterDiagnostics[] = [];

const provider = (fixture: CompanyFixture, ownState: CompanyOwnState, publicInfo: PublicMarketInfo, period: PeriodV2, turn: number) => {
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, STANDARD_AI_PARAMETERS_V1);
  captured.set(`${turn}:${fixture.companyId}`, { observation, pressures });
  const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  diagnostics.push(result.diagnostics);
  return result.decision;
};

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: TURNS };
const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);

const diag = (turn: number, companyId: string) => diagnostics.find((d) => d.turn === turn && d.companyId === companyId);
const cap = (turn: number, companyId: string) => captured.get(`${turn}:${companyId}`);

// 捕捉値の自己検証: gate keyValues に残された値と、再計算した観測が一致すること。
{
  let checked = 0;
  for (const d of diagnostics) {
    const a = d.newFactoryAssessment;
    const c = cap(d.turn, d.companyId);
    if (!a || !c) continue;
    const spaceGate = a.gates.find((g) => g.gate === "EXISTING_SPACE_FIRST");
    if (spaceGate) {
      const recorded = spaceGate.keyValues.factorySpaceRemainingUnits;
      const recomputed = c.observation.factorySpaceRemainingUnits;
      if (Math.abs(recorded - recomputed) > 1e-6) throw new Error(`捕捉値の不一致: ${d.companyId} turn${d.turn} space ${recorded} vs ${recomputed}`);
      checked += 1;
    }
  }
  console.log(`【自己検証】gate keyValues と再計算観測の一致確認: ${checked} 件一致（不一致0）\n`);
}

// ---------------------------------------------------------------------
// §7/§8 Vision gap の実数値（全社×主要ターン）
// ---------------------------------------------------------------------

console.log("=== Phase 6D New Factory Gate Audit（baseline / seed=management-console-32q / 32Q / 正式モデル）===\n");

console.log("【§7-§8 Vision gap の実数値】");
console.log("  currentSustainableScale = 前期実績×(1−w) + 実効商品ライン能力合計×w、w=targetScaleCapacityWeightInBaseline");
console.log(`  実際の w = ${STANDARD_AI_PARAMETERS_V1.targetScaleCapacityWeightInBaseline}（→ 実績の重みは ${1 - STANDARD_AI_PARAMETERS_V1.targetScaleCapacityWeightInBaseline}）\n`);
console.log("   Q 会社   Vision参考 sustainable  =ライン能力計 共通前処理  binding  前期実績生産  gapRatio 調整後  圧力    onTrack status");
for (const turn of DETAIL_TURNS) {
  for (const companyId of COMPANIES) {
    const d = diag(turn, companyId);
    const c = cap(turn, companyId);
    if (!d?.strategicGrowth || !c) continue;
    const g = d.strategicGrowth;
    const lineSum = sumProductAmount({ ...c.observation.totalEffectiveCapacityByProduct });
    const common = c.observation.totalEffectiveCommonProcessingCapacity;
    const lastActual =
      (c.observation.lastQuarterActualProductionByProduct.hoso ?? 0) +
      (c.observation.lastQuarterActualProductionByProduct.pd ?? 0) +
      (c.observation.lastQuarterActualProductionByProduct.vap ?? 0);
    console.log(
      `  ${String(turn).padStart(2)} ${companyId.padEnd(6)}${n(g.visionTargetScaleAtCurrentTurn, 10)} ${n(g.currentSustainableScaleTons, 11)} ${n(
        lineSum,
        13
      )} ${n(common, 10)} ${n(Math.min(lineSum, common), 8)} ${n(lastActual, 13)} ${f2(g.strategicScaleGapRatio, 9)} ${f2(
        g.ambitionAdjustedGapRatio
      )} ${g.growthPressure.padEnd(9)}${g.onTrack ? "YES" : "no "}    ${d.newFactoryAssessment?.status ?? "-"}`
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------
// §4/§34 Gate heatmap（32Q × 会社 × ゲート）
// ---------------------------------------------------------------------

const GATE_ORDER = [
  "VISION_PRESENT",
  "VISION_GROWTH_GAP",
  "GROWTH_PRESSURE",
  "NO_PENDING_NEW_FACTORY",
  "FACTORY_LIMIT",
  "EXISTING_SPACE_FIRST",
  "EXISTING_EXPANSION_FIRST",
  "EXISTING_CAPACITY_IN_USE",
  "DEMAND_PULL",
  "RAW_MATERIAL_SUPPORT",
  "LABOR_SUPPORT",
  "FINANCIAL_FEASIBILITY",
];

console.log("【§34 Gate heatmap（o=通過 / X=不通過 / ·=未到達（手前で評価終了））】");
for (const companyId of COMPANIES) {
  console.log(`  --- ${companyId} ---`);
  console.log("  gate                        " + Array.from({ length: TURNS }, (_, i) => ((i + 1) % 4 === 0 ? String(i + 1).padStart(2) : " ·")).join(""));
  for (const gateName of GATE_ORDER) {
    let row = "";
    for (let turn = 1; turn <= TURNS; turn++) {
      const a = diag(turn, companyId)?.newFactoryAssessment;
      const g = a?.gates.find((x) => x.gate === gateName);
      row += g === undefined ? " ·" : g.passed ? " o" : " X";
    }
    console.log(`  ${gateName.padEnd(28)}${row}`);
  }
  let statusRow = "";
  for (let turn = 1; turn <= TURNS; turn++) {
    const s = diag(turn, companyId)?.newFactoryAssessment?.status ?? "?";
    const letters: Record<string, string> = { NOT_CONSIDERED: "N", MONITORING: "M", CONSIDERING: "C", READY_TO_BUILD: "R", DEFERRED: "D", APPROVED: "A" };
    statusRow += " " + (letters[s] ?? "?");
  }
  console.log(`  ${"STATUS (N/M/C/R/D/A)".padEnd(28)}${statusRow}\n`);
}

// ---------------------------------------------------------------------
// §12-§15 Q32 exact audit（会社別1枚）
// ---------------------------------------------------------------------

function fullAudit(companyId: string, turn: number): void {
  const d = diag(turn, companyId);
  const c = cap(turn, companyId);
  const record = result.history.find((h) => h.turn === turn);
  const s = record?.companySummaries.find((x) => x.companyId === companyId);
  const fin = record?.financialResults.find((x) => x.companyId === companyId);
  if (!d || !c || !s || !fin) return;
  const a = d.newFactoryAssessment!;
  const g = d.strategicGrowth!;
  const o = c.observation;
  const lineByProduct = o.totalEffectiveCapacityByProduct;
  const prodByProduct: ProductAmount = {
    hoso: unwrapUnit(s.hosoProduced),
    pd: unwrapUnit(s.pdProduced),
    vap: unwrapUnit(s.vapProduced),
  };
  const lineSum = sumProductAmount({ ...lineByProduct });
  const binding = Math.min(lineSum, o.totalEffectiveCommonProcessingCapacity);
  const production = sumProductAmount(prodByProduct);
  const vision = d.vision!;
  const coverage = NEW_FACTORY_STRATEGY_PARAMETERS_V1.upfrontCoverageRatioByRiskTolerance[vision.financialRiskTolerance];
  const requiredCash = c.pressures.targetMinimumCashUsd + a.projectCostUsd * coverage;
  const debt = unwrapUsd(fin.balanceSheet.shortTermLoans) + unwrapUsd(fin.balanceSheet.longTermLoans);

  console.log(`  === ${companyId} Q${turn} full audit ===`);
  console.log(`  Vision参考規模         ${n(g.visionTargetScaleAtCurrentTurn)} t/Q（Q32目標 ${n(g.visionTargetScaleAtQ32)}）`);
  console.log(`  sustainable scale      ${n(g.currentSustainableScaleTons)} t/Q ＝ 実効商品ライン能力計（w=1.0のため実績は不算入）`);
  console.log(`  gap                    ${n(g.strategicScaleGapTons)} t（ratio ${f2(g.strategicScaleGapRatio)} / 調整後 ${f2(g.ambitionAdjustedGapRatio)} / 圧力 ${g.growthPressure} / onTrack ${g.onTrack}）`);
  console.log(`  工場数                 ${o.factoryCount}（見込み ${o.prospectiveFactoryCount} / 上限 ${o.maxFactoriesPerCompany} / 建設中新工場 ${o.pendingNewFactoryProjectCount}）`);
  console.log(`  工場スペース           total ${n(o.factorySpaceTotalUnits, 6)} / used ${n(o.factorySpaceUsedUnits, 6)} / 残 ${n(o.factorySpaceRemainingUnits, 6)} units（既存増設優先の閾値 ${NEW_FACTORY_STRATEGY_PARAMETERS_V1.existingSpaceSufficientUnits}）`);
  console.log(
    `  実効能力（商品ライン） HOSO ${n(lineByProduct.hoso, 7)} / PD ${n(lineByProduct.pd, 7)} / VAP ${n(lineByProduct.vap, 7)} ＝ 計 ${n(lineSum, 7)}`
  );
  console.log(`  共通前処理能力         ${n(o.totalEffectiveCommonProcessingCapacity)}（binding = min(ライン計, 共通) = ${n(binding)}）`);
  console.log(
    `  当期実績生産           HOSO ${n(prodByProduct.hoso, 7)} / PD ${n(prodByProduct.pd, 7)} / VAP ${n(prodByProduct.vap, 7)} ＝ 計 ${n(production, 7)}`
  );
  console.log(
    `  ライン別 生産/能力     HOSO ${f2(lineByProduct.hoso > 0 ? prodByProduct.hoso / lineByProduct.hoso : null)} / PD ${f2(
      lineByProduct.pd > 0 ? prodByProduct.pd / lineByProduct.pd : null
    )} / VAP ${f2(lineByProduct.vap > 0 ? prodByProduct.vap / lineByProduct.vap : null)} / 共通 ${f2(production / o.totalEffectiveCommonProcessingCapacity)}`
  );
  console.log(`  設備稼働率（engine）   ${(unwrapUnit(s.equipmentUtilizationRate) * 100).toFixed(1)}% ／ 労働稼働率（前期, gateが見る値） ${(c.pressures.laborUtilizationLastQuarter * 100).toFixed(1)}%（上限 ${NEW_FACTORY_STRATEGY_PARAMETERS_V1.laborStrainCeiling}）`);
  console.log(`  Ambition/成約/未充足   ambition ${n(a.commercialAmbitionTons)} / 成約 ${n(unwrapUnit(s.newContractedQuantity))} / 未充足 ${n(a.unservedProfitableTons)} / うち能力起因 ${n(a.capacityCausedUnservedTons)} / persistent ${a.persistentCapacityCausedUnserved}`);
  console.log(`  原料                   在庫+パイプライン ${n(o.rawMaterialAvailable + o.rawMaterialPipeline)} t / 前期国内売れ残り ${n(o.vietnamDomesticPriorMarket?.unsoldSupply ?? null)} t`);
  console.log(`  財務                   現金 ${(o.cashUsd / 1e6).toFixed(1)}M / 借入 ${(debt / 1e6).toFixed(1)}M / 新工場 ${(a.projectCostUsd / 1e6).toFixed(0)}M / 必要現金(gate) ${(requiredCash / 1e6).toFixed(1)}M → 余裕 ${((o.cashUsd - requiredCash) / 1e6).toFixed(1)}M`);
  console.log(`  status                 ${a.status} ／ reason ${a.reasonCodes.join(", ")}`);
  for (const gt of a.gates) {
    const kv = Object.entries(gt.keyValues)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(v.toFixed(3))}`)
      .join(" ");
    console.log(`    ${gt.passed ? "o" : "X"} ${gt.gate.padEnd(26)}${kv}`);
  }
  console.log("");
}

console.log("【§12-§14 Q32 exact audit】");
for (const companyId of COMPANIES) fullAudit(companyId, 32);

// ---------------------------------------------------------------------
// §15 MASS Q20〜Q32 の追跡（工場2化をまたぐ変化）
// ---------------------------------------------------------------------

console.log("【§15 MASS Q20〜Q32 追跡（新工場ではなく既存承認capexの完成をまたぐ）】");
console.log("   Q 工場数 ライン能力計 共通前処理 sustainable Vision参考 gapRatio 調整後 圧力    onTrack 成約   生産   営業HC status");
for (let turn = 20; turn <= 32; turn++) {
  const d = diag(turn, "MASS");
  const c = cap(turn, "MASS");
  const s = result.history.find((h) => h.turn === turn)?.companySummaries.find((x) => x.companyId === "MASS");
  if (!d?.strategicGrowth || !c || !s) continue;
  const g = d.strategicGrowth;
  const lineSum = sumProductAmount({ ...c.observation.totalEffectiveCapacityByProduct });
  const hc = [...new Map(d.decision.salesPlans.map((p) => [p.market, p.salesForceHeadcount])).values()].reduce((x, y) => x + y, 0);
  console.log(
    `  ${String(turn).padStart(2)} ${String(c.observation.factoryCount).padStart(5)} ${n(lineSum, 11)} ${n(
      c.observation.totalEffectiveCommonProcessingCapacity,
      9
    )} ${n(g.currentSustainableScaleTons, 11)} ${n(g.visionTargetScaleAtCurrentTurn, 9)} ${f2(g.strategicScaleGapRatio, 9)} ${f2(
      g.ambitionAdjustedGapRatio
    )} ${g.growthPressure.padEnd(9)}${g.onTrack ? "YES" : "no "}  ${n(unwrapUnit(s.newContractedQuantity), 6)} ${n(
      unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced),
      6
    )} ${String(hc).padStart(6)} ${d.newFactoryAssessment?.status}`
  );
}

// ---------------------------------------------------------------------
// §20 Unserved waterfall（BAL/JPQ Q32: 成約>生産 なのに unserved が小さい理由）
// ---------------------------------------------------------------------

console.log("\n【§20 Unserved Opportunity waterfall（Q32）】");
console.log("  会社   Ambition 工数前希望  提出   binding能力 未充足計 在庫起因 能力起因 営業起因 労働 原料 その他 主因");
for (const companyId of COMPANIES) {
  const d = diag(32, companyId);
  const u = d?.unservedOpportunity;
  const c = cap(32, companyId);
  if (!d || !u || !c) continue;
  const desiredBefore = d.salesWishByMarketProduct.reduce((s2, w) => s2 + w.desiredQuantityBeforeEffortConstraint, 0);
  const submitted = d.decision.salesPlans.reduce((s2, p) => s2 + unwrapUnit(p.desiredQuantity), 0);
  const binding = Math.min(sumProductAmount({ ...c.observation.totalEffectiveCapacityByProduct }), c.observation.totalEffectiveCommonProcessingCapacity);
  console.log(
    `  ${companyId.padEnd(6)}${n(d.commercialAmbition?.ambitionTons)} ${n(desiredBefore, 9)} ${n(submitted, 6)} ${n(binding, 10)} ${n(
      u.unservedProfitableTons,
      7
    )} ${n(u.blockedByInventoryPolicyTons, 7)} ${n(u.blockedByProductionCapacityTons, 7)} ${n(u.blockedBySalesCapacityTons, 7)} ${n(
      u.blockedByLaborTons,
      5
    )} ${n(u.blockedByRawMaterialTons, 5)} ${n(u.otherTons, 5)} ${u.primaryConstraint}`
  );
}

// ---------------------------------------------------------------------
// §32/§33 Counterfactual（Q32・純粋関数の再評価。世界 state は不変）
// ---------------------------------------------------------------------

function reconstructNeeded(companyId: string, turn: number): ProductAmount {
  const d = diag(turn, companyId)!;
  const c = cap(turn, companyId)!;
  const eligible = computeEligibleCurrentPeriodDemand(d.currentPeriodDeliveryDemand!);
  const target = computeNormalInventoryTargetByProduct(c.observation, STANDARD_AI_PARAMETERS_V1);
  const opening: ProductAmount = { ...zeroProductAmount(), ...c.observation.finishedGoodsByProduct };
  return computeFinalProductionRequirement(computeBasicCurrentPeriodProductionRequirement(eligible, target, opening));
}

function baseInput(companyId: string, turn: number) {
  const d = diag(turn, companyId)!;
  const c = cap(turn, companyId)!;
  const fixture = result.companies.find((f) => f.companyId === companyId)!;
  const existingExpansion = d.decision.capexDecision.newProjectProposals.some((p) => p.projectType !== "newFactoryConstruction");
  return {
    fixture,
    observation: c.observation,
    pressures: c.pressures,
    vision: d.vision ?? null,
    strategicGrowth: d.strategicGrowth ?? null,
    productionNeededByProductBeforeCap: reconstructNeeded(companyId, turn),
    existingExpansionProposedThisQuarter: existingExpansion,
    commercialAmbition: d.commercialAmbition,
    unservedOpportunity: d.unservedOpportunity,
    persistentCapacityCausedUnserved: d.newFactoryAssessment?.persistentCapacityCausedUnserved ?? false,
  };
}

console.log("\n【§32 Counterfactual（Q32・入力を1つだけ差し替えて純粋関数を再評価）】");
console.log("  再現性確認: まず捕捉入力そのままで再評価し、実際の status と一致することを確認する。\n");
for (const companyId of COMPANIES) {
  const actual = diag(32, companyId)?.newFactoryAssessment;
  if (!actual) continue;
  const base = baseInput(companyId, 32);
  const replay = evaluateNewFactoryDecision(base);
  const match = replay.assessment.status === actual.status;
  console.log(`  ${companyId.padEnd(6)} 実際 ${actual.status.padEnd(15)} 再評価 ${replay.assessment.status.padEnd(15)} ${match ? "一致" : "★不一致（監査手法の誤り）"}`);
  if (!match) continue;

  const scenarios: { label: string; mutate: (b: ReturnType<typeof baseInput>) => ReturnType<typeof baseInput> }[] = [
    {
      label: "既存増設を当期提案していなかったら",
      mutate: (b) => ({ ...b, existingExpansionProposedThisQuarter: false }),
    },
    {
      label: "persistent capacity evidence を満たしていたら",
      mutate: (b) => ({ ...b, persistentCapacityCausedUnserved: true }),
    },
    {
      label: "Vision gap gate を強制通過（pressure=HIGH, onTrack=false）したら",
      mutate: (b) => ({
        ...b,
        strategicGrowth: b.strategicGrowth ? { ...b.strategicGrowth, onTrack: false, growthPressure: "HIGH" as const } : null,
      }),
    },
    {
      label: "sustainable scale を前期実績生産（w=0相当）で測ったら",
      mutate: (b) => {
        if (!b.strategicGrowth) return b;
        const c = cap(32, companyId)!;
        const lastActual =
          (c.observation.lastQuarterActualProductionByProduct.hoso ?? 0) +
          (c.observation.lastQuarterActualProductionByProduct.pd ?? 0) +
          (c.observation.lastQuarterActualProductionByProduct.vap ?? 0);
        const reference = b.strategicGrowth.visionTargetScaleAtCurrentTurn;
        const gapTons = reference - lastActual;
        const gapRatio = reference > 0 ? gapTons / reference : 0;
        const sensitivity = { HIGH: 1.2, MEDIUM: 1.0, LOW: 0.7 }[b.vision!.growthAmbition];
        const adjusted = gapRatio * sensitivity;
        const pressure = adjusted > 0.35 ? "URGENT" : adjusted > 0.18 ? "HIGH" : adjusted > 0.05 ? "MODERATE" : "LOW";
        return {
          ...b,
          strategicGrowth: {
            ...b.strategicGrowth,
            currentSustainableScaleTons: lastActual,
            strategicScaleGapTons: gapTons,
            strategicScaleGapRatio: gapRatio,
            ambitionAdjustedGapRatio: adjusted,
            growthPressure: pressure as never,
            onTrack: pressure === "LOW",
          },
        };
      },
    },
    {
      label: "労働 gate だけ解除（laborUtilization=1.0）したら",
      mutate: (b) => ({ ...b, pressures: { ...b.pressures, laborUtilizationLastQuarter: 1.0 } }),
    },
  ];
  for (const sc of scenarios) {
    const out = evaluateNewFactoryDecision(sc.mutate(base));
    const changed = out.assessment.status !== actual.status;
    const failedGate = out.assessment.gates.find((x) => !x.passed);
    console.log(
      `         → ${sc.label.padEnd(42)} ${out.assessment.status.padEnd(15)}${changed ? " ★変化" : ""}  ${
        failedGate ? `止まるゲート: ${failedGate.gate}` : out.assessment.status === "READY_TO_BUILD" ? "全ゲート通過（提案）" : ""
      }`
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------
// §23 Factory space（Q32・全社）
// ---------------------------------------------------------------------

console.log("【§23 Factory space（Q32）】");
console.log("  会社   total  used   残り   既存増設優先の閾値(3,000)を上回るか");
for (const companyId of COMPANIES) {
  const o = cap(32, companyId)?.observation;
  if (!o) continue;
  console.log(
    `  ${companyId.padEnd(6)}${n(o.factorySpaceTotalUnits, 6)} ${n(o.factorySpaceUsedUnits, 6)} ${n(o.factorySpaceRemainingUnits, 6)}  ${
      o.factorySpaceRemainingUnits > 3000 ? "上回る（既存増設を優先）" : "下回る（スペースでは止まらない）"
    }`
  );
}

// ---------------------------------------------------------------------
// §24 New Factory economics（現行ルールの値。独自数値は無い）
// ---------------------------------------------------------------------

const t = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction;
console.log("\n【§24 New Factory economics（capex/parameters.ts の実値）】");
console.log(`  投資額 ${(t.standardBudgetUsd / 1e6).toFixed(0)}M USD / 支払 ${t.paymentRatios.map((r) => `${r * 100}%`).join("・")}（建設 ${t.standardConstructionQuarters}Q）+ 操業準備 ${t.postCompletionReadinessQuarters}Q`);
console.log(`  フルランプ能力: 共通 ${t.newFactoryEffect?.fullCapacities.commonProcessing.toLocaleString()} / HOSO ${t.newFactoryEffect?.fullCapacities.hoso.toLocaleString()} / PD ${t.newFactoryEffect?.fullCapacities.pd.toLocaleString()} / VAP ${t.newFactoryEffect?.fullCapacities.vap.toLocaleString()}（ライン計 ${(
  (t.newFactoryEffect?.fullCapacities.hoso ?? 0) + (t.newFactoryEffect?.fullCapacities.pd ?? 0) + (t.newFactoryEffect?.fullCapacities.vap ?? 0)
).toLocaleString()}）`);
console.log(`  ランプ: ${t.newFactoryEffect?.rampMultipliers.map((r) => `${r * 100}%`).join(" → ")} / 保守費 ${t.maintenanceRatePerQuarter * 100}%/Q / 建物${t.buildingRatio * 100}%・機械${t.machineryRatio * 100}%`);

// ---------------------------------------------------------------------
// 補助: BAL の既存増設提案の履歴（EXISTING_EXPANSION_FIRST の中身）
// ---------------------------------------------------------------------

console.log("\n【§10 既存増設の提案履歴（会社×Q: capexDecision.newProjectProposals の種類）】");
for (const companyId of COMPANIES) {
  const rows: string[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const d = diag(turn, companyId);
    const proposals = d?.decision.capexDecision.newProjectProposals ?? [];
    for (const p of proposals) rows.push(`Q${turn}:${p.projectType}`);
  }
  console.log(`  ${companyId.padEnd(6)}${rows.length === 0 ? "（提案なし）" : rows.join("  ")}`);
}

void STANDARD_AI_PARAMETERS_V1.capexSustainedUtilizationThreshold;
