import { randomBytes } from "crypto";
import { GameSession } from "./gameTypes";

// Math.random() だけに依存せず、Node.jsのcryptoモジュールでシードを生成する。
// 暗号学的な強度は不要（同一条件でのゲーム再現用の識別子）だが、素朴なMath.random()より
// 衝突・予測可能性の面で安全な方式を優先している。
export function generateRandomSeed(): string {
  return randomBytes(8).toString("hex"); // 16文字の16進数文字列（URL・JSONに安全）
}

const RANDOM_SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ユーザーが手動入力したシードを受け取る場合の検証。
// 不正な形式（記号・空文字・長すぎる等）の場合はnullを返し、呼び出し元で自動生成にフォールバックする。
export function sanitizeRandomSeed(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!RANDOM_SEED_PATTERN.test(trimmed)) return null;
  return trimmed;
}

// Step 3でGameSessionに追加したフィールド（isTestGame/environment/randomSeed/updatedAt）と、
// Step 2で追加したhistoryは、それ以前に作成された既存データには存在しない。
// Redisから読み込んだセッションは、画面やAPIで使う前に必ずこの関数を通して既定値を補うこと。
// 本番の既存データそのものを書き換える必要はない（読み込み時にその場で補うだけ）。
type LegacyGameSession = Omit<
  GameSession,
  "isTestGame" | "environment" | "randomSeed" | "updatedAt" | "history" | "schemaVersion" | "engineVersion"
> &
  Partial<Pick<GameSession, "isTestGame" | "environment" | "randomSeed" | "updatedAt" | "history" | "schemaVersion" | "engineVersion">>;

export function normalizeGameSession(stored: LegacyGameSession): GameSession {
  return {
    ...stored,
    schemaVersion: stored.schemaVersion ?? 1,
    engineVersion: stored.engineVersion ?? "1.0.0-legacy",
    isTestGame: stored.isTestGame ?? false,
    environment: stored.environment ?? "production",
    randomSeed: stored.randomSeed ?? "",
    updatedAt: stored.updatedAt ?? stored.createdAt ?? "",
    history: stored.history ?? [],
  };
}

// Step 5の破壊的な管理操作（初期化・削除・複製・スナップショット）は、
// isProduction===false であることに加えて、対象ゲーム自身がテストゲームである
// ことも必ず確認すること。isTestGameだけでなくenvironmentも念のため二重に確認する
// （通常は両者は一致するはずだが、防御的に両方見る）。
export function isValidTestGameSession(session: GameSession): boolean {
  return session.isTestGame === true && session.environment !== "production";
}
