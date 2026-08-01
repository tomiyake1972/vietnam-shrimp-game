// ShrimpX V2 — 会社経営統合テスト環境 設備投資ドラフト操作（Phase 8B-3）
//
// decisionDraft.tsが定義するCapexDecisionDraft（Phase 8B-2Aで既に往復可能に
// なっている型）に対する、UI操作（候補追加・削除・取消要求追加・削除）だけを
// 行う。CapexDecisionDraft自体の型・buildInitialDraft/buildDecisionInputFromDraftは
// 一切変更しない（既存の網羅ドラフト往復層に手を加えず、その上に薄い操作関数を
// 追加するだけ）。

import { CapitalProject, CapitalProjectType } from "../../lib/v2/capex/types";
import { CapexDecisionDraft, CapexProjectProposalDraftRow, CompanyDecisionDraft } from "./decisionDraft";
import { countProspectiveFactories, MAX_FACTORIES_PER_COMPANY } from "../../lib/v2/capex/factoryConstruction";
import { hasActivePdMechanizationProjectForFactory } from "../../lib/v2/capex/projectLifecycle";

/**
 * 新規案件候補を、このターンの意思決定ドラフトへ追加する（テンプレート標準額のまま。実装指示§5「サイズは自由入力にしない」）。
 * 【Test15新設】targetFactoryIdは pdMechanization 提案（工場単位の投資）にのみ渡す。
 */
export function addCapexProposalToDraft(draft: CompanyDecisionDraft, projectType: CapitalProjectType, targetFactoryId?: string): CompanyDecisionDraft {
  const row: CapexProjectProposalDraftRow = { projectType, ...(targetFactoryId !== undefined ? { targetFactoryId } : {}) };
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

/**
 * 【Test15新設】pdMechanization案件は「対象Factoryごとに1件」までしか提案できない
 * （承認時ゲートと同じ制約をUI側でも先読みし、当ターンのドラフト内の重複だけを見る。
 * 既に稼働中の案件との重複判定はcapexViewModel.ts側の責務）。
 */
export function isPdMechanizationAlreadyProposedForFactoryInDraft(draft: CompanyDecisionDraft, factoryId: string): boolean {
  return draft.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization" && p.targetFactoryId === factoryId);
}

/** 【Test15新設】今四半期のVAP商品開発費（4段階のいずれか）をドラフトへ設定する。 */
export function setVapProductDevelopmentSpendInDraft(draft: CompanyDecisionDraft, amountUsd: number): CompanyDecisionDraft {
  return { ...draft, vapProductDevelopmentSpendUsd: amountUsd };
}

/**
 * 【Test15新設】新工場建設(newFactoryConstruction)の追加提案1件を、今このドラフトへ
 * 積んだ場合に4工場上限を超えるか。承認時の実際のゲート（factoryConstruction.ts
 * wouldExceedMaxFactories）と同じ数え方を使い、既存の実在プロジェクト数に、
 * 今期ドラフト内ですでに積んだnewFactoryConstruction提案の件数を加えて先読みする
 * （実在プロジェクトへ反映されるのは提出・承認後のため、ドラフト内の重複だけは
 * こちらで追加カウントする必要がある）。
 */
export function isNewFactoryConstructionBlockedByCap(
  draft: CompanyDecisionDraft,
  existingFactoryCount: number,
  existingProjects: readonly CapitalProject[]
): boolean {
  const draftPendingCount = draft.capexDecision.newProjectProposals.filter((p) => p.projectType === "newFactoryConstruction").length;
  return countProspectiveFactories(existingFactoryCount, existingProjects) + draftPendingCount + 1 > MAX_FACTORIES_PER_COMPANY;
}

/** 4工場上限に達している/達する理由を文章で返す（ブロック時のみ）。 */
export function newFactoryConstructionCapBlockedReason(existingFactoryCount: number, existingProjects: readonly CapitalProject[], draftPendingCount: number): string {
  const prospective = countProspectiveFactories(existingFactoryCount, existingProjects) + draftPendingCount;
  return `工場数が上限（${MAX_FACTORIES_PER_COMPANY}工場）に達しています（現在・進行中・今期の提案を合わせて${prospective}工場）。これ以上の新工場建設は提案できません。`;
}

/**
 * 【Test15新設】pdMechanizationは対象Factoryごとに高々1件までしか進行できない
 * （承認時ゲートと同じ制約。projectLifecycle.ts hasActivePdMechanizationProjectForFactory
 * を再実装せずそのまま使う）。既に稼働中・承認済みの案件と、今期ドラフト内の重複の
 * 両方を見る。
 */
export function isPdMechanizationBlockedForFactory(draft: CompanyDecisionDraft, existingProjects: readonly CapitalProject[], factoryId: string): boolean {
  return hasActivePdMechanizationProjectForFactory(existingProjects, factoryId) || isPdMechanizationAlreadyProposedForFactoryInDraft(draft, factoryId);
}
