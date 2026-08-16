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
import { computeLinearRampProgress } from "../capex/pdMechanization";
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
 *
 * 【QI-I1最終化】通常の新規プレイでは、projectLifecycle.tsの承認ゲート
 * （hasActiveQualityControlEquipmentProjectForFactory）により、同一Factoryへの
 * 重複投資は承認段階で拒否される。ここでの「複数案件が同じFactoryを対象とする
 * 場合は最も効果の大きい（乗数が最小の）ものを採用する」処理は、旧保存データ・
 * 異常stateに対する防御的フォールバックとして意図的に残している
 * （#04指示：QI-I1最終化§3）。
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

// ---------------------------------------------------------------------
// 【Standard AI Capability Expansion・Phase CE-3新設】診断用のFactory別設備状態
// ---------------------------------------------------------------------
//
// 【指示§3・§4・§5】Standard AIがqualityControlEquipmentの投資可否・重複回避を
// 判断するための観測（hasQualityEquipment・equipmentRampProgress・
// qualityEquipmentStatus）を、既存のcapexState（唯一の案件ポートフォリオSSoT）と
// 既存の品質管理設備効果算出関数（computeQualityEquipmentRiskMultiplier・
// computeLinearRampProgress、上のbuildQualityEquipmentRiskMultiplierByFactoryが
// 実際に使うのと同じ関数）だけから導出する。新しい独立した状態・新しい永続化用
// SSoTは一切作らない（この関数はcapexStateから毎期再計算するだけの純粋関数）。

/** Factory単位の品質管理設備状態（導出型。既存project lifecycleの状態遷移と矛盾しない）。 */
export type QualityEquipmentStatus =
  | "NONE" // 案件が存在しない
  | "IN_PROGRESS" // 承認済み〜建設中〜中断中（まだ完成していない）
  | "RAMPING" // 完成・稼働開始済みだが、まだフル効果に達していない
  | "FULL_EFFECT"; // 完成・稼働開始済みで、ランプが完了しフル効果

export interface QualityEquipmentFactoryStatus {
  /** 【指示§3許可済みdiagnostic】案件が存在する（取消以外のいずれかの状態）か。 */
  readonly hasQualityEquipment: boolean;
  /** 【指示§3許可済みdiagnostic】NONE/IN_PROGRESS/RAMPING/FULL_EFFECT。 */
  readonly qualityEquipmentStatus: QualityEquipmentStatus;
  /** 【指示§3許可済みdiagnostic】ランプ進捗（0〜1）。NONE/IN_PROGRESSは常に0。 */
  readonly equipmentRampProgress: number;
  /** buildQualityEquipmentRiskMultiplierByFactoryと同じ値（NONE/IN_PROGRESSは1.0）。 */
  readonly qualityEquipmentRiskMultiplier: number;
}

const NO_EQUIPMENT_STATUS: QualityEquipmentFactoryStatus = {
  hasQualityEquipment: false,
  qualityEquipmentStatus: "NONE",
  equipmentRampProgress: 0,
  qualityEquipmentRiskMultiplier: 1,
};

/**
 * 【重要・タイミング】buildQualityEquipmentRiskMultiplierByFactoryと同じく、
 * 必ず「前四半期末までのcapex状態」を渡すこと（先読み禁止）。
 *
 * 同一Factoryを対象とする案件が複数存在する場合（QI-I1最終化により通常の新規
 * プレイでは発生しないが、旧保存データ・異常stateへの防御として）、最も進んだ
 * 状態（FULL_EFFECT > RAMPING > IN_PROGRESS）のものを採用する。取消(cancelled)
 * 案件は無視する。
 */
export function resolveQualityEquipmentStatusByFactory(
  capexState: CapexState,
  factories: readonly Factory[],
  period: PeriodV2,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): ReadonlyMap<string, QualityEquipmentFactoryStatus> {
  const primaryFactoryIdByCompany = new Map<CompanyId, string>();
  for (const f of factories) {
    if (!primaryFactoryIdByCompany.has(f.companyId)) primaryFactoryIdByCompany.set(f.companyId, f.factoryId);
  }

  const allProjects: CapitalProject[] = capexState.companies.flatMap((c) => c.portfolio.projects);
  const equipmentProjects = allProjects
    .filter((p) => p.projectType === "qualityControlEquipment" && p.status !== "cancelled")
    .slice()
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));

  const statusRank: Readonly<Record<QualityEquipmentStatus, number>> = { NONE: 0, IN_PROGRESS: 1, RAMPING: 2, FULL_EFFECT: 3 };
  const result = new Map<string, QualityEquipmentFactoryStatus>();
  for (const project of equipmentProjects) {
    const factoryId = project.targetFactoryId ?? primaryFactoryIdByCompany.get(project.companyId);
    if (factoryId === undefined) continue;

    const entry: QualityEquipmentFactoryStatus = isCapexProjectOperationalAt(project, period)
      ? (() => {
          const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
          const operationalStart = computeOperationalStartPeriod(project.completedPeriod!, readiness);
          const quartersSinceActivation = quartersBetweenLocal(operationalStart, period);
          const rampProgress = computeLinearRampProgress(quartersSinceActivation, params.qualityControlEquipment.rampQuarters);
          return {
            hasQualityEquipment: true,
            qualityEquipmentStatus: rampProgress >= 1 ? "FULL_EFFECT" : "RAMPING",
            equipmentRampProgress: rampProgress,
            qualityEquipmentRiskMultiplier: computeQualityEquipmentRiskMultiplier(quartersSinceActivation, params),
          };
        })()
      : { hasQualityEquipment: true, qualityEquipmentStatus: "IN_PROGRESS", equipmentRampProgress: 0, qualityEquipmentRiskMultiplier: 1 };

    const existing = result.get(factoryId);
    if (existing === undefined || statusRank[entry.qualityEquipmentStatus] > statusRank[existing.qualityEquipmentStatus]) {
      result.set(factoryId, entry);
    }
  }
  return result;
}

/** factories一覧のうち、result（resolveQualityEquipmentStatusByFactoryの戻り値）に無いFactoryはNONE扱い。 */
export function qualityEquipmentStatusFor(
  statusByFactory: ReadonlyMap<string, QualityEquipmentFactoryStatus>,
  factoryId: string
): QualityEquipmentFactoryStatus {
  return statusByFactory.get(factoryId) ?? NO_EQUIPMENT_STATUS;
}
