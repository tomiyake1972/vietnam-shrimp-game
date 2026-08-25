// ShrimpX V2 — Player Factory Operations: draft (factoryLifecycleDecisions) の追記・削除ヘルパー
//
// 他のドラフト変換ヘルパー（capexDraftActions.ts等）と同じ方針：計算ロジックは
// 一切持たない、単純な配列の置き換えだけを行う。1工場につき同時に選択できる
// Lifecycle Decisionは常に0件または1件（既存validateFactoryLifecycleDecisionが
// 「同一Turn同一工場への複数決定」を拒否するのと矛盾しないよう、UI側もその工場の
// 既存選択を必ず置き換える）。

import { FactoryLifecycleDecisionInput, FactoryLifecycleDecisionType } from "../../lib/v2/capex/factoryLifecycle";
import { CompanyDecisionDraft } from "./decisionDraft";

/**
 * 指定工場のLifecycle Decisionを設定する。typeにnullを渡すと「何もしない」
 * （未選択に戻す）。他の工場の選択には一切触れない。
 */
export function setFactoryLifecycleDecisionInDraft(
  draft: CompanyDecisionDraft,
  factoryId: string,
  type: FactoryLifecycleDecisionType | null
): CompanyDecisionDraft {
  const rest = (draft.factoryLifecycleDecisions ?? []).filter((d) => d.factoryId !== factoryId);
  const next: readonly FactoryLifecycleDecisionInput[] = type === null ? rest : [...rest, { factoryId, type }];
  return { ...draft, factoryLifecycleDecisions: next };
}

/** 指定工場に現在draft上で選択されているLifecycle Decision（未選択ならundefined）。 */
export function findFactoryLifecycleDecisionInDraft(draft: CompanyDecisionDraft, factoryId: string): FactoryLifecycleDecisionInput | undefined {
  return (draft.factoryLifecycleDecisions ?? []).find((d) => d.factoryId === factoryId);
}
