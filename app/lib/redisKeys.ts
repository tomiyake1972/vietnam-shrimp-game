import { isStaging, STAGING_KEY_PREFIX } from "./env";
import { redis } from "./redis";
import { CompanyId } from "./gameData";
import { GameSession } from "./gameTypes";

// すべてのRedisキーはこのファイルの関数経由で生成する。直接テンプレートリテラルで
// キー文字列を組み立てるコードを他の場所に書かないこと。
//
// 本番Redisとテスト環境は同一データベースを共有し、staging:プレフィックスによる論理分離が
// 唯一の分離手段となる（別Upstashデータベースへの物理分離は行わない設計変更）。
// 本番（isStaging=false）の場合、キー形式は既存の本番データと完全に一致させ、変更しない。
// プレフィックス自体の値は app/lib/env.ts を唯一の定義元とし（app/lib/redis.ts の
// 書き込み前検証と共有するため）、ここでは再定義しない。
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

// ゲームが持つスナップショットIDの一覧（Redisリスト、新しい順にlpush）
export function snapshotsListKey(gameCode: string): string {
  return withEnvironmentPrefix(`game:${gameCode}:snapshots`);
}

// 個別のスナップショット本体
export function snapshotKey(gameCode: string, snapshotId: string): string {
  return withEnvironmentPrefix(`game:${gameCode}:snapshot:${snapshotId}`);
}

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

// 指定ゲームに属するRedisキーをすべて列挙する（削除・複製で使用）。
// 「games」一覧キー自体はここに含めない（他ゲームと共有するキーのため、
// 呼び出し元でLREMにより対象コードだけを取り除くこと）。
//
// 安全のため KEYS * は使用しない。まずGameSession.historyから既知のキーを
// 明示的に組み立て、そのうえで対象ゲームコードに厳密に限定したプレフィックスで
// SCANを行い、historyが欠けている旧データや想定外のキー（スナップショット等）も
// 漏れなく拾う。SCANのmatchパターンは常に `{prefix}game:{gameCode}` で始まる
// ため、他のゲームのキーには一致しない。
export async function listGameRelatedKeys(gameCode: string, session: GameSession | null): Promise<string[]> {
  const keys = new Set<string>();
  keys.add(gameKey(gameCode));
  for (const id of COMPANY_IDS) keys.add(companyStateKey(gameCode, id));

  if (session) {
    const periods = new Set<string>(session.history);
    periods.add(formatPeriod(session.currentYear, session.currentQuarter));
    for (const period of periods) {
      for (const id of COMPANY_IDS) keys.add(decisionsKey(gameCode, period, id));
      keys.add(resultsKey(gameCode, period));
    }
  }

  const scanPattern = `${gameKey(gameCode)}*`;
  let cursor = "0";
  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, { match: scanPattern, count: 100 });
    for (const k of foundKeys) keys.add(k);
    cursor = nextCursor;
  } while (cursor !== "0");

  return Array.from(keys);
}
