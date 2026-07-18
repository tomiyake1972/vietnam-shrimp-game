import { TurnResult } from "./gameTypes";

// TurnResult に後から追加されたフィールド（schemaVersion/engineVersion）を
// 旧データから読み込んだ際に補うための正規化関数。
// Redisから読み込んだ TurnResult は、画面やAPIで使う前に必ずこの関数を通すこと。
type LegacyTurnResult = Omit<TurnResult, "schemaVersion" | "engineVersion"> &
  Partial<Pick<TurnResult, "schemaVersion" | "engineVersion">>;

export function normalizeTurnResult(stored: LegacyTurnResult): TurnResult {
  return {
    ...stored,
    schemaVersion: stored.schemaVersion ?? 1,
    engineVersion: stored.engineVersion ?? "1.0.0-legacy",
  };
}
