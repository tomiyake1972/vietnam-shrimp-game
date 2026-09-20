// ShrimpX V2 — #05 Standard AI費用Projection接続
//
// 【このファイルの責務】
// Standard AI が意思決定に使う「そのTurnの実効費用単価」と「そのTurnの必要工事費」を、
// Engineとまったく同じ窓口（companyLab/turnEconomicsProjection.ts の
// buildTurnEconomicsProjection）から受け取るための**運び手**である。
//
// 【新しい計算を一切持たない】
// ここには費用式・指数式・建設費式が1つも無い。TurnEconomicsProjection から
// 必要な2つのフィールドを取り出して渡すだけである。指数の解決は
// scenario/costIndex.ts、実効単価は finance/parameters.ts:financeParametersForTurn、
// 必要工事費は capex/projectLifecycle.ts:resolveProjectBudget が唯一のSSoTであり、
// Standard AI 側でそれらを再実装することはしない。
//
// 【中立値（NEUTRAL_STANDARD_AI_COST_PROJECTION）について】
// Scenario definition を持たない呼び出し元（CLI・診断script・既存テスト）のための
// 後方互換な既定値である。値は「指数未宣言シナリオ」でのProjectionと完全に同一に
// なるよう、同じSSoT関数を通して作る（捏造した定数は置かない）。
//   ・financeParameters … financeParametersForTurn は全指数1.00のとき base を
//     そのまま返すため、FINANCE_PARAMETERS_V1 と同一参照になる。
//   ・indexedRequiredProjectCostByType … legacy policy の resolveProjectBudget は
//     indexedRequiredProjectCostUsd = standardBudgetUsd を返す。
// この同一性は __tests__/costProjection.test.ts が buildTurnEconomicsProjection の
// 実結果と突き合わせて常時検証する（乖離したらテストが落ちる）。

import { CapexParameters, CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { LEGACY_CONSTRUCTION_COST_POLICY, resolveProjectBudget } from "../../capex/projectLifecycle";
import { CapitalProjectType, CAPITAL_PROJECT_TYPES } from "../../capex/types";
import { FINANCE_PARAMETERS_V1, FinanceParameters } from "../../finance/parameters";
import { TurnEconomicsProjection } from "../turnEconomicsProjection";

/**
 * Standard AI が読む費用前提。TurnEconomicsProjection の部分集合であり、
 * 独自のフィールドを一切追加しない（Engineと別の前提が生まれないようにするため）。
 */
export interface StandardAiCostProjection {
  /** 指数適用後の実効 FinanceParameters（Engineが実際に使う値と同一）。 */
  readonly financeParameters: FinanceParameters;
  /** 案件種別ごとの、その承認Turnの必要工事費（legacy policy では標準予算と同値）。 */
  readonly indexedRequiredProjectCostByType: Readonly<Record<CapitalProjectType, number>>;
}

/** TurnEconomicsProjection から Standard AI が使う2項目だけを取り出す。 */
export function toStandardAiCostProjection(projection: TurnEconomicsProjection): StandardAiCostProjection {
  return {
    financeParameters: projection.financeParameters,
    indexedRequiredProjectCostByType: projection.indexedRequiredProjectCostByType,
  };
}

function neutralIndexedRequiredProjectCostByType(capexParams: CapexParameters): Readonly<Record<CapitalProjectType, number>> {
  const result = {} as Record<CapitalProjectType, number>;
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const template = capexParams.templatesByType[projectType];
    // Engine・Projectionと同じ関数を通す（式を二重実装しない）。
    result[projectType] = resolveProjectBudget(template, undefined, LEGACY_CONSTRUCTION_COST_POLICY).indexedRequiredProjectCostUsd;
  }
  return result;
}

/**
 * 指数未宣言（＝現行）と完全に同一の費用前提。
 * Scenario definition を渡せない既存呼び出し元の既定値であり、
 * この値のとき Standard AI の判断・数値は本変更前とビット単位で同一になる。
 */
export const NEUTRAL_STANDARD_AI_COST_PROJECTION: StandardAiCostProjection = {
  financeParameters: FINANCE_PARAMETERS_V1,
  indexedRequiredProjectCostByType: neutralIndexedRequiredProjectCostByType(CAPEX_PARAMETERS_V1),
};
