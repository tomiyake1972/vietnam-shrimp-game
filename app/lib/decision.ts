import { CompanyDecision } from "./gameTypes";

// Step 4で追加したフィールド（submissionCount/firstSubmittedAt/lastSubmittedAt/submittedBy）は
// それ以前に保存された意思決定データには存在しない。Redisから読み込んだ意思決定は、
// 画面やAPIで使う前に必ずこの関数を通して既定値を補うこと。既存データそのものを
// 書き換える必要はない（読み込み時にその場で補うだけ）。
type LegacyDecision = Omit<CompanyDecision, "submissionCount" | "firstSubmittedAt" | "lastSubmittedAt" | "submittedBy"> &
  Partial<Pick<CompanyDecision, "submissionCount" | "firstSubmittedAt" | "lastSubmittedAt" | "submittedBy">>;

export function normalizeDecision(stored: LegacyDecision): CompanyDecision {
  return {
    ...stored,
    submissionCount: stored.submissionCount ?? 1,
    firstSubmittedAt: stored.firstSubmittedAt ?? stored.submittedAt ?? "",
    lastSubmittedAt: stored.lastSubmittedAt ?? stored.submittedAt ?? "",
    submittedBy: stored.submittedBy ?? "unknown",
  };
}
