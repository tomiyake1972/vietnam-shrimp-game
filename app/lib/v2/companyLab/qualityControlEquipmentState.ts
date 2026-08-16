// ShrimpX V2 — 品質管理設備（qualityControlEquipment）のFactory別リスク低減乗数（Phase QI-I1新設）
//
// 【このモジュールが存在する理由】PD省人化投資（companyLab/pdMechanizationState.ts）と
// 同じ「capexStateから当四半期の効果を毎期再導出する」パターンを踏襲する。ただし
// qualityControlEquipmentの効果はPD稼働率のような「前四半期実績」を必要としない
// （ランプ進捗だけで決まる）ため、pdMechanizationStateのようなターンをまたいだ
// 状態を新設する必要はない（capexState＋periodだけから毎期決定論的に導出できる）。
//
// 【targetFactoryId省略時の扱い】qualityControlEquipmentはtargetFactoryIdが任意
// （capex/types.ts:244「省略時は主工場へ適用」）。capex/capacityEffect.tsの
// applyCapexCapacityToFactoriesと同一の「主工場＝factories配列でその会社が最初に
// 現れるFactory」規則をそのまま再利用する（新しい主工場の定義を作らない）。

import { PeriodV2, toYearQuarter } from "../core/period";
import { CompanyId } from "../sales/types";
import { Factory } from "../production/types";
import { CapexState, CapitalProject } from "../capex/types";
import { computeOperationalStartPeriod, isCapexProjectOperationalAt } from "../capex/capacityEffect";
import { computeQualityEquipmentRiskMultiplier } from "../capex/qualityControlEquipmentEffect";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "../quality/parameters";

// 期間演算（capex/pdMechanizationState.ts等と同じローカル実装パターンを踏襲。共通ユーティリティへ抽出しない既存の慣例に従う）。
function quartersBetweenLocal(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/**
 * 【重要・タイミング】この関数へ渡すcapexStateは、必ず「前四半期末までのcapex状態」
 * （当期のcloseQuarterWithCapex呼び出しより前、runner.tsのfactoriesWithCapex算出と
 * 同じ基準）でなければならない（先読み禁止。PD省人化投資と同じ規約）。
 *
 * 稼働開始済み（isCapexProjectOperationalAt）のqualityControlEquipment案件だけを
 * 対象に、targetFactoryId（省略時は主工場）ごとのoperationalRisk乗数を算出する。
 * 同じFactoryを対象とする案件が複数存在する場合は、承認時の重複ガードが
 * qualityControlEquipmentには存在しない（設計doc§6で明記済みのギャップ）ため、
 * 最も効果の大きい（乗数が最小の）ものを採用する（決定論的・保守的な既定）。
 */
export function buildQualityEquipmentRiskMultiplierByFactory(
  capexState: CapexState,
  factories: readonly Factory[],
  period: PeriodV2,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): ReadonlyMap<string, number> {
  const primaryFactoryIdByCompany = new Map<CompanyId, string>();
  for (const f of factories) {
    if (!primaryFactoryIdByCompany.has(f.companyId)) primaryFactoryIdByCompany.set(f.companyId, f.factoryId);
  }

  const allProjects: CapitalProject[] = capexState.companies.flatMap((c) => c.portfolio.projects);
  const equipmentProjects = allProjects
    .filter((p) => p.projectType === "qualityControlEquipment")
    .slice()
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));

  const result = new Map<string, number>();
  for (const project of equipmentProjects) {
    if (!isCapexProjectOperationalAt(project, period)) continue;
    const factoryId = project.targetFactoryId ?? primaryFactoryIdByCompany.get(project.companyId);
    if (factoryId === undefined) continue;

    const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
    const operationalStart = computeOperationalStartPeriod(project.completedPeriod!, readiness);
    const quartersSinceActivation = quartersBetweenLocal(operationalStart, period);
    const multiplier = computeQualityEquipmentRiskMultiplier(quartersSinceActivation, params);

    const existing = result.get(factoryId);
    if (existing === undefined || multiplier < existing) {
      result.set(factoryId, multiplier);
    }
  }
  return result;
}
