// ShrimpX V2 — 2026-08-04 Conservative / Base / Growth Scenario 生成（診断専用・型と生成ルール案）
//
// 【位置づけ】三宅さんの指示§10「型と生成ルール案まで設計する。本番決定には接続しない」を
// 満たすための最小実装。ここで定義するGrowth Scenarioの具体的な増分（+X%等）は
// 「診断結果を人間が比較できる形で示すための、説明可能な1つのイラストレーション」であり、
// Mission/Vision由来のModerate Growth Target設計（将来モジュール）が確定するまでの
// **暫定値**である。この暫定値をそのまま最終仕様として採用しない。
//
// 【単一値へ潰さない】各Scenarioも、Business Scale Profileの5軸をmin()で1つの数字へ
// 潰すのではなく、5軸それぞれの値・bindingになる軸・リスクを保持したまま提示する。
//
// 【Growth Scenario ≠ 最大成長】三宅さんの指示どおり、Growthは「Expandable制約の一部を
// 適度に緩めた場合」の候補であり、物理的な最大値（名目能力・無制限採用等）ではない。

import { ProductAmount, StandardAiObservation } from "../types";
import { PressureScores, computePressureScores } from "../pressures";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { CompanyFixture } from "../../../companyLab/types";
import { buildStandardAiUnitEconomics, StandardAiUnitEconomicsResult } from "./forwardUnitEconomics";
import { buildBusinessScaleProfile, BusinessScaleAxis, BusinessScaleProfile } from "./businessScaleProfile";

export type BusinessScaleScenarioId = "conservative" | "base" | "growth";

export interface BusinessScaleScenarioAssumption {
  readonly label: string;
  /** この前提が暫定的なイラストレーションであるか（Growthシナリオの増分等）。 */
  readonly isProvisionalIllustration: boolean;
}

export interface BusinessScaleScenarioResult {
  readonly scenarioId: BusinessScaleScenarioId;
  readonly label: string;
  readonly description: string;
  readonly assumptions: readonly BusinessScaleScenarioAssumption[];
  /** このScenarioの下でのBusiness Scale Profile（5軸、単一値へ潰していない）。 */
  readonly profile: BusinessScaleProfile;
  /** 5軸のうち、このScenarioで最も厳しい制約（複数同時にbindingの可能性を排除しないため配列）。 */
  readonly bindingAxes: readonly BusinessScaleAxis[];
  /** 最も厳しい制約の値（tons）。5軸すべてがnullでない前提が崩れる場合はnull。 */
  readonly bindingScaleTons: number | null;
  readonly mainRisks: readonly string[];
}

function bindingAxesOf(profile: BusinessScaleProfile): { axes: BusinessScaleAxis[]; scaleTons: number | null } {
  const known = profile.axes.filter((a) => a.supportedScaleTons !== null) as (typeof profile.axes)[number][];
  if (known.length === 0) return { axes: [], scaleTons: null };
  const minScale = Math.min(...known.map((a) => a.supportedScaleTons!));
  const axes = known.filter((a) => Math.abs(a.supportedScaleTons! - minScale) < 1e-6).map((a) => a.axis);
  return { axes, scaleTons: minScale };
}

/**
 * Conservative Scenario: 現在のHard/Adjustable制約を一切動かさない（採用・capex・
 * 新規借入を行わない）前提での事業規模。営業人員の最適再配分（Shadow reallocation）
 * すら行わない、最も控えめな基準線。
 */
function buildConservativeScenario(
  observation: StandardAiObservation,
  pressures: PressureScores,
  unitEconomics: StandardAiUnitEconomicsResult,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  desiredByProduct: ProductAmount
): BusinessScaleScenarioResult {
  const profile = buildBusinessScaleProfile({
    observation,
    pressures,
    unitEconomics,
    currentSalesPlans,
    desiredByProduct,
  });
  const { axes, scaleTons } = bindingAxesOf(profile);
  return {
    scenarioId: "conservative",
    label: "Conservative Scale",
    description:
      "採用・capex・新規借入を一切行わず、現在のHard Constraint内で無理なく回せる規模。" +
      "Business Scale Profileの5軸をそのまま用いる（追加の前提を一切加えない基準線）。",
    assumptions: [{ label: "採用・capex・新規借入なし", isProvisionalIllustration: false }],
    profile,
    bindingAxes: axes,
    bindingScaleTons: scaleTons,
    mainRisks: axes.map((a) => `${a}軸が現状のまま制約として残る`),
  };
}

/**
 * Base Scenario: 追加投資・新規借入なしで、既に使える「次期調整可能」なレバー
 * （営業人員の最適再配分＝shadowSalesAllocation.tsのvolume-oriented）だけを反映した規模。
 * Business Scale ProfileのSales軸（salesForceSupportedScaleTons）が既にこれを表しているため、
 * Conservativeとの違いは「Sales軸の値をcurrentRealisticではなくsupportedとして使う」ことに限定する。
 */
function buildBaseScenario(
  observation: StandardAiObservation,
  pressures: PressureScores,
  unitEconomics: StandardAiUnitEconomicsResult,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  desiredByProduct: ProductAmount
): BusinessScaleScenarioResult {
  // ConservativeとBaseの差は、Business Scale Profile自体の設計（Sales軸が既に
  // salesForceSupportedScaleTons=「現有人員を最適再配分した場合の上限」を返す）に
  // 既に反映されているため、Profile自体は共通で構わない。Base Scenarioの意味は
  // 「この上限まで実際に踏み込む」という前提を明示する点にある。
  const profile = buildBusinessScaleProfile({
    observation,
    pressures,
    unitEconomics,
    currentSalesPlans,
    desiredByProduct,
  });
  const { axes, scaleTons } = bindingAxesOf(profile);
  return {
    scenarioId: "base",
    label: "Base Scale",
    description:
      "追加投資・新規借入なしで、既存の営業人員を最適に再配分した場合（Volume-oriented Shadow" +
      "Allocation相当）に無理なく回せる規模。Cash bufferを大きく損なわない範囲内。",
    assumptions: [{ label: "既存人員の最適再配分のみ（新規採用・capex・新規借入なし）", isProvisionalIllustration: false }],
    profile,
    bindingAxes: axes,
    bindingScaleTons: scaleTons,
    mainRisks: axes.map((a) => `${a}軸がBase規模でも制約として残る`),
  };
}

/**
 * Growth Scenario: Expandable制約（採用・capex・借入）の一部を、暫定的な
 * 「1段階分の適度な増分」で緩めた場合の規模。三宅さんの指示どおり、最大成長ではない。
 * 増分の大きさ（+20%営業人員・+10%労務人員）はイラストレーションであり、Mission/Vision
 * 由来のModerate Growth Target設計が確定するまでの暫定値である。
 */
const GROWTH_SALES_HEADCOUNT_STEP_RATIO = 0.2;
const GROWTH_LABOR_HEADCOUNT_STEP_RATIO = 0.1;

function buildGrowthScenario(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  desiredByProduct: ProductAmount
): BusinessScaleScenarioResult {
  const grownSalesHeadcount = Math.round(observation.salesForceHeadcountTotal * (1 + GROWTH_SALES_HEADCOUNT_STEP_RATIO));
  const grownRegularHeadcount = Math.round(observation.regularHeadcountTotal * (1 + GROWTH_LABOR_HEADCOUNT_STEP_RATIO));
  const grownObservation: StandardAiObservation = {
    ...observation,
    salesForceHeadcountTotal: grownSalesHeadcount,
    regularHeadcountTotal: grownRegularHeadcount,
  };
  const grownPressures = computePressureScores(grownObservation, fixture);
  const unitEconomics = buildStandardAiUnitEconomics(grownObservation);

  const profile = buildBusinessScaleProfile({
    observation: grownObservation,
    pressures: grownPressures,
    unitEconomics,
    currentSalesPlans,
    desiredByProduct,
  });
  const { axes, scaleTons } = bindingAxesOf(profile);

  return {
    scenarioId: "growth",
    label: "Growth Scale（Moderate、最大成長ではない）",
    description:
      `営業人員+${Math.round(GROWTH_SALES_HEADCOUNT_STEP_RATIO * 100)}%・正社員+${Math.round(
        GROWTH_LABOR_HEADCOUNT_STEP_RATIO * 100
      )}%（いずれも暫定的なイラストレーション、Mission/Vision確定後に再設計）を仮定した場合の規模。` +
      "生産・原料・財務の実効能力は今回拡張していない（capex・追加調達余地は現状値のまま）ため、" +
      "採用だけでは解消しない制約が新たにbindingになる可能性がある。",
    assumptions: [
      { label: `営業人員 +${Math.round(GROWTH_SALES_HEADCOUNT_STEP_RATIO * 100)}%（暫定）`, isProvisionalIllustration: true },
      { label: `正社員 +${Math.round(GROWTH_LABOR_HEADCOUNT_STEP_RATIO * 100)}%（暫定）`, isProvisionalIllustration: true },
      { label: "生産設備・原料調達余地・借入可能額は今回拡張していない（現状値のまま）", isProvisionalIllustration: false },
    ],
    profile,
    bindingAxes: axes,
    bindingScaleTons: scaleTons,
    mainRisks: axes.map((a) => `${a}軸が採用増だけでは解消せず、Growth Scaleのbinding制約になる`),
  };
}

export interface BusinessScaleScenarioComparison {
  readonly companyId: string;
  readonly conservative: BusinessScaleScenarioResult;
  readonly base: BusinessScaleScenarioResult;
  readonly growth: BusinessScaleScenarioResult;
}

export function buildBusinessScaleScenarioComparison(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  desiredByProduct: ProductAmount
): BusinessScaleScenarioComparison {
  const unitEconomics = buildStandardAiUnitEconomics(observation);
  return {
    companyId: observation.companyId,
    conservative: buildConservativeScenario(observation, pressures, unitEconomics, currentSalesPlans, desiredByProduct),
    base: buildBaseScenario(observation, pressures, unitEconomics, currentSalesPlans, desiredByProduct),
    growth: buildGrowthScenario(fixture, observation, currentSalesPlans, desiredByProduct),
  };
}
