import { isStaging } from "./env";

// すべてのRedisキーはこのファイルの関数経由で生成する。直接テンプレートリテラルで
// キー文字列を組み立てるコードを他の場所に書かないこと。
//
// 環境分離の一次防御は「別Upstash Redisデータベースへの接続」（app/lib/redis.ts）であり、
// このプレフィックスは同一Redis内に万一データが混在した場合の二次防御（多層防御）として付与する。
// 本番（isStaging=false）の場合、キー形式は既存の本番データと完全に一致させ、変更しない。
const STAGING_KEY_PREFIX = "staging:";

function withEnvironmentPrefix(key: string): string {
  return isStaging ? `${STAGING_KEY_PREFIX}${key}` : key;
}

// 四半期の一意表現（例: "2015Q1"）。Redisキーの一部にも、GameSession.historyの要素にも使う。
export function formatPeriod(year: number, quarter: number): string {
  return `${year}Q${quarter}`;
}

// 作成済みゲームコードの一覧（Redisリスト）
export function gamesListKey(): string {
  return withEnvironmentPrefix("games");
}

// ゲームセッション本体
export function gameKey(gameCode: string): string {
  return withEnvironmentPrefix(`game:${gameCode}`);
}

// 会社ごとの財務状態（A〜E）
export function companyStateKey(gameCode: string, companyId: string): string {
  return withEnvironmentPrefix(`game:${gameCode}:company:${companyId}`);
}

// 四半期・会社ごとの意思決定
export function decisionsKey(gameCode: string, period: string, companyId: string): string {
  return withEnvironmentPrefix(`game:${gameCode}:decisions:${period}:${companyId}`);
}

// 四半期ごとのターン処理結果
export function resultsKey(gameCode: string, period: string): string {
  return withEnvironmentPrefix(`game:${gameCode}:results:${period}`);
}
