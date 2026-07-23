// ShrimpX V2 — 設備投資モジュール 新規capex資産の減価償却（Phase 8B-2C）
//
// 新規completed資産（Phase 8B-2A以降にcapex経由で完成した固定資産）の減価償却を、
// 案件種別ごとの単一usefulLifeQuarters（Phase 8B-2Bの旧方式）から、固定資産2区分
// （建物・構築物／機械・設備）ごとのコンポーネント別定額法へ置き換える。
//
//   建物部分の四半期償却費 = capitalizedAmountUsd × buildingRatio ÷ 建物耐用年数
//   機械部分の四半期償却費 = capitalizedAmountUsd × machineryRatio ÷ 機械耐用年数
//   案件の四半期償却費 = 建物部分 + 機械部分
//
// buildingRatio・machineryRatio・耐用年数はいずれもcapex/parameters.tsのテンプレート
// から都度ライブ参照するだけで、CapitalProjectへ新規の永続フィールドは一切追加
// しない（実装指示§9「原則として永続化しない」）。稼働開始判定
// （operationalStartPeriod・isCapexProjectOperationalAt）はcapex/capacityEffect.ts
// のものをそのまま再利用し、能力増加・固定保守費と完全に同じタイミングで
// 減価償却が始まることを保証する（実装指示§4「Phase 8B-2Bで実装した
// operationalStartPeriodの考え方を変更しない」）。

import { PeriodV2, toYearQuarter } from "../core/period";
import { computeOperationalStartPeriod, isCapexProjectOperationalAt } from "./capacityEffect";
import { CapexParameters } from "./parameters";
import { CapitalProject } from "./types";

// ---------------------------------------------------------------------
// 期間演算（capacityEffect.ts・financing/初期ポートフォリオ等と同じローカル実装
// パターンを踏襲。共通ユーティリティへ抽出しない既存の慣例に従う）。
// ---------------------------------------------------------------------

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/** 新規capex資産1社ぶんの、建物・機械コンポーネント別の当期減価償却費。 */
export interface CapexComponentDepreciation {
  readonly buildingUsd: number;
  readonly machineryUsd: number;
  readonly totalUsd: number;
}

/**
 * 1社の投資案件ポートフォリオから、period当期の新規completed資産の建物・機械
 * コンポーネント別定額法減価償却費を算出する（実装指示§4・§11の要件をすべて
 * 満たす）:
 *   - 建設中・完成四半期そのものは0（isCapexProjectOperationalAtの判定）。
 *   - operationalStartPeriodから両コンポーネントとも開始。
 *   - 建物はcomponentUsefulLifeQuarters.building（100四半期）だけ計上し、
 *     その後は0。機械はcomponentUsefulLifeQuarters.machinery（40四半期）だけ
 *     計上し、その後は0（機械の償却終了後も建物の償却は独立して継続する）。
 *   - cancelled案件は0（status!=="completed"で除外）。
 *   - 複数案件は案件ごとに計算して合算。
 *   - 残存価額は0。各コンポーネントの累計減価償却は、そのコンポーネントの
 *     取得原価（capitalizedAmountUsd×該当ratio）を厳密に超えない
 *     （耐用年数ぶんちょうど計上して打ち切るため、合計は必ずその配分額に一致する）。
 */
export function computeCapexComponentDepreciationUsd(
  projects: readonly CapitalProject[],
  params: CapexParameters,
  period: PeriodV2
): CapexComponentDepreciation {
  let buildingUsd = 0;
  let machineryUsd = 0;

  for (const project of projects) {
    if (project.status !== "completed" || project.completedPeriod === undefined || project.capitalizedAmountUsd === undefined) continue;
    if (!isCapexProjectOperationalAt(project, period)) continue;

    const template = params.templatesByType[project.projectType];
    const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
    const opStart = computeOperationalStartPeriod(project.completedPeriod, readiness);
    const elapsedOperationalQuarters = quartersBetween(opStart, period) + 1;

    const buildingAmountUsd = project.capitalizedAmountUsd * template.buildingRatio;
    const machineryAmountUsd = project.capitalizedAmountUsd * template.machineryRatio;

    if (elapsedOperationalQuarters <= params.componentUsefulLifeQuarters.building) {
      buildingUsd += buildingAmountUsd / params.componentUsefulLifeQuarters.building;
    }
    if (elapsedOperationalQuarters <= params.componentUsefulLifeQuarters.machinery) {
      machineryUsd += machineryAmountUsd / params.componentUsefulLifeQuarters.machinery;
    }
  }

  return { buildingUsd, machineryUsd, totalUsd: buildingUsd + machineryUsd };
}
