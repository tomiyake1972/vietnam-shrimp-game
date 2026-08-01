// ShrimpX V2 — feature/v2-persist-standard-ai-proposal（Phase A）
// Standard AIの原案（CompanyDecisionInput）と、実際にプレイヤーが提出した
// CompanyDecisionInputとの差分要約を計算する、副作用のない純粋関数。
//
// 【背景】CompanyLabQuarterHistoryEntry.diffFromAiProposal / DecisionDiffSummary
// (persistence/types.ts) は「将来のAI提案比較機能のための型のみ先行定義」として
// 以前から存在していたが、実際にこの値を計算するロジックはこれまで存在しなかった
// （companyLabQuarterFlowService.processQuarterのentryDraftはこの2フィールドを
// 一切代入していない）。本モジュールが、その未実装だった差分計算ロジック本体。
//
// 【比較方針】CompanyDecisionInputの各フィールドを構造的に（キー順序に依存しない
// 形で）比較する。companyIdは「どの会社の意思決定か」という識別子であり、
// 意思決定の内容そのものではないため比較対象から除外する。salesForceHireCount/
// salesForceLayoffCountはoptionalフィールド（既存の後方互換規約: 省略時は0人）
// のため、比較前にundefined→0へ正規化する。

import { CompanyDecisionInput } from "./types";
import { DecisionDiffSummary } from "./persistence/types";

export type { DecisionDiffSummary };

/** JSON化可能な値を、オブジェクトキーをソートした形へ正規化する（キー順序による誤検知を防ぐ）。 */
function canonicalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForComparison);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeForComparison(obj[key]);
    }
    return result;
  }
  return value;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalizeForComparison(a)) === JSON.stringify(canonicalizeForComparison(b));
}

/**
 * companyId以外の全フィールドを比較対象とする（新フィールド追加時に比較漏れが
 * 起きないよう、Omit<CompanyDecisionInput, "companyId">のキー一覧をここで
 * 明示的に列挙する。CompanyDecisionInputへフィールドを追加した場合はここも
 * 更新する必要がある——テスト側でも網羅性を確認する）。
 */
const COMPARABLE_DECISION_FIELDS: readonly (keyof Omit<CompanyDecisionInput, "companyId">)[] = [
  "salesPlans",
  "domesticPurchasePlan",
  "importOrders",
  "aquacultureStockingPlans",
  "productionPlans",
  "workerAssignments",
  "financingRequest",
  "capexDecision",
  "salesForceHireCount",
  "salesForceLayoffCount",
];

/** salesForceHireCount/salesForceLayoffCountの省略時0人という既存の後方互換規約を比較にも適用する。 */
function normalizeOptionalCount(value: number | undefined): number {
  return value ?? 0;
}

/**
 * Standard AIの原案（aiProposal）と、実際の提出（submitted）を比較し、
 * 差分要約を返す。同一会社の意思決定同士を比較する前提（呼び出し側で
 * companyIdの一致を確認すること）。
 */
export function computeDecisionDiffSummary(aiProposal: CompanyDecisionInput, submitted: CompanyDecisionInput): DecisionDiffSummary {
  const changedFieldPaths: string[] = [];
  for (const field of COMPARABLE_DECISION_FIELDS) {
    if (field === "salesForceHireCount" || field === "salesForceLayoffCount") {
      if (normalizeOptionalCount(aiProposal[field]) !== normalizeOptionalCount(submitted[field])) {
        changedFieldPaths.push(field);
      }
      continue;
    }
    if (!structurallyEqual(aiProposal[field], submitted[field])) {
      changedFieldPaths.push(field);
    }
  }
  return { hasDifferences: changedFieldPaths.length > 0, changedFieldPaths };
}
