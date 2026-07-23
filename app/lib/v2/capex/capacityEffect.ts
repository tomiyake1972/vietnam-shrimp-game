// ShrimpX V2 — 設備投資モジュール 操業効果（能力増加・新規資産減価償却・固定保守費）
// （Phase 8B-2B）
//
// 完成した設備投資案件を、実際の生産能力・PL（減価償却・固定保守費）へ接続する
// 純粋関数群。実装指示§8「累計能力増加・当期減価償却費・累計capex減価償却の
// 別台帳・当期保守費・操業中フラグは永続化しない」に従い、以下だけを唯一の
// 真実として毎期再導出する:
//   - CapitalProject.projectType（テンプレート参照キー）
//   - CapitalProject.status（"completed"のみ対象）
//   - CapitalProject.completedPeriod（稼働開始四半期の算出起点）
//   - CapitalProject.capitalizedAmountUsd（減価償却・保守費の算出基準額）
//   - CapitalProject.futureCapacityEffect（承認時スナップショット。targetProduct・
//     capacityIncreaseTonsPerQuarter・readinessQuartersAfterCompletion）
//   - capex/parameters.tsの案件種別別テンプレート（usefulLifeQuarters・
//     maintenanceRatePerQuarter。実装指示§4「耐用年数は案件固有の永続
//     フィールドにはせず、テンプレート値から導出」）
//   - 現在四半期（period引数）
// 能力増加・新規資産減価償却・固定保守費の開始四半期はすべて同一の
// operationalStartPeriodへ統一する（実装指示§3.2）。

import { nextPeriod, PeriodV2, toYearQuarter } from "../core/period";
import { hosoEqTons, unwrapUnit } from "../core/units";
import { CompanyId } from "../sales/types";
import { Factory } from "../production/types";
import { CapexParameters } from "./parameters";
import { CapexState, CapitalProject } from "./types";

// ---------------------------------------------------------------------
// 期間演算（financing/initialPortfolio.ts・financing/bankUnderwriting.tsの
// addQuarters、production/loadMetrics.tsのquartersBetweenと同じローカル実装
// パターンを踏襲。共通ユーティリティへ抽出しない既存の慣例に従う）。
// ---------------------------------------------------------------------

function addQuarters(p: PeriodV2, quarters: number): PeriodV2 {
  let result = p;
  for (let i = 0; i < quarters; i++) result = nextPeriod(result);
  return result;
}

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/**
 * 稼働開始四半期を算出する（実装指示§3.2、文字列比較せずPeriodV2演算のみで
 * 導出）。operationalStartPeriod = completedPeriodの翌四半期 + readiness。
 * 例: 2016Q2に完成・readiness=0 → 2016Q3から。readiness=1 → 2016Q4から。
 */
export function computeOperationalStartPeriod(completedPeriod: PeriodV2, readinessQuartersAfterCompletion: number): PeriodV2 {
  return addQuarters(nextPeriod(completedPeriod), readinessQuartersAfterCompletion);
}

/** period時点でこの案件がすでに稼働開始しているか（period >= operationalStartPeriod）。 */
function isOperationalAt(project: CapitalProject, period: PeriodV2): boolean {
  if (project.status !== "completed" || project.completedPeriod === undefined) return false;
  const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
  const opStart = computeOperationalStartPeriod(project.completedPeriod, readiness);
  return quartersBetween(opStart, period) >= 0;
}

// ---------------------------------------------------------------------
// 1. 能力増加（実装指示§3.1・§3.3・§3.4）
// ---------------------------------------------------------------------

/** 会社1社ぶんの、稼働開始済み案件による累計能力増加（Factoryの各能力プールへの加算量）。 */
export interface CapexCapacityEffect {
  readonly commonProcessing: number;
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly freezingPackaging: number;
}

/**
 * 1社の投資案件ポートフォリオから、period時点で稼働開始済みの案件ぶんだけを
 * 対象に、targetProduct別の累計能力増加を算出する（実装指示§3.3の要件を
 * すべて満たす）:
 *   - 建設中・停止・取消案件は加算しない（isOperationalAtがstatus==="completed"
 *     以外を除外）。
 *   - completedでも操業開始前なら加算しない（isOperationalAtの期間判定）。
 *   - 複数案件は累積する（reduce）。
 *   - HOSO/PD/VAPライン増設はcommonProcessingCapacityを増加させない
 *     （targetProductがそれぞれ独立しており、hosoLineExpansion等の
 *     futureCapacityEffect.targetProductは"hoso"等であって"commonProcessing"
 *     ではないため、テンプレート定義自体が混線しない構造になっている）。
 */
export function computeCapacityEffectForCompany(
  projects: readonly CapitalProject[],
  period: PeriodV2
): CapexCapacityEffect {
  let commonProcessing = 0;
  let hoso = 0;
  let pd = 0;
  let vap = 0;
  let freezingPackaging = 0;

  for (const project of projects) {
    if (!isOperationalAt(project, period)) continue;
    const effect = project.futureCapacityEffect;
    if (!effect || effect.targetProduct === undefined || effect.capacityIncreaseTonsPerQuarter === undefined) continue;
    const amount = effect.capacityIncreaseTonsPerQuarter;
    if (amount === 0) continue;
    switch (effect.targetProduct) {
      case "hoso":
        hoso += amount;
        break;
      case "pd":
        pd += amount;
        break;
      case "vap":
        vap += amount;
        break;
      case "commonProcessing":
        commonProcessing += amount;
        break;
      case "freezingPackaging":
        freezingPackaging += amount;
        break;
    }
  }

  return { commonProcessing, hoso, pd, vap, freezingPackaging };
}

/**
 * 基礎Factory fixture（元のcompanyLab/fixtures.tsの静的値、mutationしない）＋
 * 当該会社の稼働開始済み累計能力増加、から当期の実効Factory[]を再構成する
 * （実装指示§3.3）。
 *   - 元fixtureをmutationしない（新しいオブジェクトへスプレッドするのみ）。
 *   - 会社IDを厳密に区別する（companyIdでグルーピング）。
 *   - 他社設備へ効果を加えない（他社のfactoryはcapexState.companiesの
 *     該当エントリを参照しないため影響しない）。
 *   - 1社が複数工場を持つ場合、投資案件はfactoryId非依存（CapitalProjectに
 *     factoryId概念が無い）ため、その会社の最初の工場（factoryId昇順）へ
 *     累計効果をまとめて加算する（現状は全社1工場のみのため実質的な差は無い。
 *     複数工場への按分はfactoryId単位の投資対象化とあわせてPhase 8B-2B以降の
 *     課題として送る）。
 */
export function applyCapexCapacityToFactories(
  factories: readonly Factory[],
  capexState: CapexState,
  period: PeriodV2
): readonly Factory[] {
  const effectByCompany = new Map<CompanyId, CapexCapacityEffect>();
  for (const company of capexState.companies) {
    effectByCompany.set(company.companyId, computeCapacityEffectForCompany(company.portfolio.projects, period));
  }

  const primaryFactoryIdByCompany = new Map<CompanyId, string>();
  for (const f of factories) {
    if (!primaryFactoryIdByCompany.has(f.companyId)) primaryFactoryIdByCompany.set(f.companyId, f.factoryId);
  }

  return factories.map((f) => {
    const effect = effectByCompany.get(f.companyId);
    if (!effect) return f;
    const isPrimary = primaryFactoryIdByCompany.get(f.companyId) === f.factoryId;
    if (!isPrimary) return f;
    if (effect.commonProcessing === 0 && effect.hoso === 0 && effect.pd === 0 && effect.vap === 0 && effect.freezingPackaging === 0) {
      return f;
    }
    return {
      ...f,
      commonProcessingCapacity: hosoEqTons(unwrapUnit(f.commonProcessingCapacity) + effect.commonProcessing),
      hosoCapacity: hosoEqTons(unwrapUnit(f.hosoCapacity) + effect.hoso),
      pdCapacity: hosoEqTons(unwrapUnit(f.pdCapacity) + effect.pd),
      vapCapacity: hosoEqTons(unwrapUnit(f.vapCapacity) + effect.vap),
      freezingPackagingCapacity: hosoEqTons(unwrapUnit(f.freezingPackagingCapacity) + effect.freezingPackaging),
    };
  });
}

// ---------------------------------------------------------------------
// 2. 新規capex資産の定額法減価償却（実装指示§4）
// ---------------------------------------------------------------------

/**
 * 1社の投資案件ポートフォリオから、period当期の新規completed資産の定額法
 * 減価償却費合計を算出する（実装指示§4の要件をすべて満たす）:
 *   - 稼働前は0（isOperationalAtの期間判定）。
 *   - operationalStartPeriodから開始。
 *   - 耐用年数の四半期数だけ計上（elapsedOperationalQuarters > usefulLifeQuarters
 *     で打ち切り）。
 *   - 耐用年数終了後は0。
 *   - cancelled案件は0（status!=="completed"で除外）。
 *   - 複数案件は案件ごとに計算して合算。
 *   - 残存価額は0、累計減価償却が取得原価を超えない（capitalizedAmountUsd ÷
 *     usefulLifeQuartersをusefulLifeQuarters回だけ計上するため、合計は
 *     厳密にcapitalizedAmountUsdに一致する）。
 */
export function computeCapexAssetsDepreciationUsd(
  projects: readonly CapitalProject[],
  params: CapexParameters,
  period: PeriodV2
): number {
  let total = 0;
  for (const project of projects) {
    if (project.status !== "completed" || project.completedPeriod === undefined || project.capitalizedAmountUsd === undefined) continue;
    if (!isOperationalAt(project, period)) continue;
    const template = params.templatesByType[project.projectType];
    const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
    const opStart = computeOperationalStartPeriod(project.completedPeriod, readiness);
    const elapsedOperationalQuarters = quartersBetween(opStart, period) + 1;
    if (elapsedOperationalQuarters > template.usefulLifeQuarters) continue;
    total += project.capitalizedAmountUsd / template.usefulLifeQuarters;
  }
  return total;
}

// ---------------------------------------------------------------------
// 3. 固定保守費（実装指示§5）
// ---------------------------------------------------------------------

/**
 * 1社の投資案件ポートフォリオから、period当期の稼働中案件による固定保守費
 * 合計を算出する（実装指示§5の要件をすべて満たす）:
 *   - 稼働前は0。
 *   - 操業開始後は生産量ゼロでも発生（productionAcutalsに一切依存しない）。
 *   - 耐用年数を超えても継続（減価償却と異なり打ち切らない。保守は資産の
 *     簿価ではなく物理的な稼働状態に紐づく費用のため）。
 */
export function computeCapexMaintenanceCostUsd(
  projects: readonly CapitalProject[],
  params: CapexParameters,
  period: PeriodV2
): number {
  let total = 0;
  for (const project of projects) {
    if (project.status !== "completed" || project.completedPeriod === undefined || project.capitalizedAmountUsd === undefined) continue;
    if (!isOperationalAt(project, period)) continue;
    const template = params.templatesByType[project.projectType];
    total += project.capitalizedAmountUsd * template.maintenanceRatePerQuarter;
  }
  return total;
}
