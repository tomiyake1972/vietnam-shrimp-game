// ShrimpX V2 — 会社経営統合テスト環境 設備投資ドラフト操作（Phase 8B-3）
//
// decisionDraft.tsが定義するCapexDecisionDraft（Phase 8B-2Aで既に往復可能に
// なっている型）に対する、UI操作（候補追加・削除・取消要求追加・削除）だけを
// 行う。CapexDecisionDraft自体の型・buildInitialDraft/buildDecisionInputFromDraftは
// 一切変更しない（既存の網羅ドラフト往復層に手を加えず、その上に薄い操作関数を
// 追加するだけ）。

import { CapitalProjectType } from "../../lib/v2/capex/types";
import { CapexDecisionDraft, CapexProjectProposalDraftRow, CompanyDecisionDraft } from "./decisionDraft";

/** 新規案件候補を、このターンの意思決定ドラフトへ追加する（テンプレート標準額のまま。実装指示§5「サイズは自由入力にしない」）。 */
export function addCapexProposalToDraft(draft: CompanyDecisionDraft, projectType: CapitalProjectType): CompanyDecisionDraft {
  const row: CapexProjectProposalDraftRow = { projectType };
  const capexDecision: CapexDecisionDraft = {
    ...draft.capexDecision,
    newProjectProposals: [...draft.capexDecision.newProjectProposals, row],
  };
  return { ...draft, capexDecision };
}

/** ドラフト内の新規案件候補を1件削除する（提出前のみ呼び出される想定。提出済みは呼び出し側でdisabledにする）。 */
export function removeCapexProposalFromDraft(draft: CompanyDecisionDraft, index: number): CompanyDecisionDraft {
  const newProjectProposals = draft.capexDecision.newProjectProposals.filter((_, i) => i !== index);
  return { ...draft, capexDecision: { ...draft.capexDecision, newProjectProposals } };
}

/** 同一projectTypeがすでにドラフト内にあるか（エンジン側に重複禁止ルールは無いため、UI側の警告表示専用）。 */
export function isDuplicateProjectTypeInDraft(draft: CompanyDecisionDraft, projectType: CapitalProjectType): boolean {
  return draft.capexDecision.newProjectProposals.some((p) => p.projectType === projectType);
}

/** 取消要求をドラフトへ追加する（既にある場合は追加しない＝重複防止）。 */
export function addCapexCancelRequestToDraft(draft: CompanyDecisionDraft, projectId: string): CompanyDecisionDraft {
  if (draft.capexDecision.cancelRequests.some((c) => c.projectId === projectId)) return draft;
  return {
    ...draft,
    capexDecision: {
      ...draft.capexDecision,
      cancelRequests: [...draft.capexDecision.cancelRequests, { projectId }],
    },
  };
}

/** 取消要求をドラフトから取り下げる（「取消を予約」の取り消し。エンジンへは何も送信していない状態なので自由に取り下げられる）。 */
export function removeCapexCancelRequestFromDraft(draft: CompanyDecisionDraft, projectId: string): CompanyDecisionDraft {
  return {
    ...draft,
    capexDecision: {
      ...draft.capexDecision,
      cancelRequests: draft.capexDecision.cancelRequests.filter((c) => c.projectId !== projectId),
    },
  };
}

export function isCancelRequestedInDraft(draft: CompanyDecisionDraft, projectId: string): boolean {
  return draft.capexDecision.cancelRequests.some((c) => c.projectId === projectId);
}
