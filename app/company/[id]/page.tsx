import { COMPANIES, PHASES, CompanyId } from "../../lib/gameData";
import CompanyDashboard from "../../components/CompanyDashboard";
import { notFound } from "next/navigation";
import { isProduction } from "../../lib/env";
import { redis, parseStored } from "../../lib/redis";
import { gameKey } from "../../lib/redisKeys";
import { normalizeGameSession } from "../../lib/gameSession";
import { GameSession } from "../../lib/gameTypes";

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ game?: string; mode?: string }> }) {
  const { id } = await params;
  const { game: gameCode, mode } = await searchParams;
  const companyId = id.toUpperCase() as CompanyId;
  const profile = COMPANIES[companyId];
  if (!profile) return notFound();

  // GMテスト操作モード（mode=gm-test）は、クライアントのクエリパラメータだけで有効化しない。
  // サーバー側で「本番環境ではない」かつ「対象ゲームがテストゲームである」ことを
  // Redis上のGameSessionから直接確認できた場合のみ有効化する。
  // 本番環境ではこのブロック自体を実行せず、常に通常の会社画面として扱う
  // （エラー画面等で明示的に拒否すると、この機能の存在自体を外部に示唆してしまうため、
  //  何も特別なことが起きていないかのように通常表示へフォールバックさせる方を選んだ）。
  let isGmTestMode = false;
  if (mode === "gm-test" && gameCode && !isProduction) {
    const data = await redis.get(gameKey(gameCode));
    const stored = parseStored<GameSession>(data);
    if (stored) {
      const session = normalizeGameSession(stored);
      isGmTestMode = session.isTestGame;
    }
  }

  return <CompanyDashboard profile={profile} phases={PHASES} gameCode={gameCode} isGmTestMode={isGmTestMode} />;
}
export function generateStaticParams() { return ["A","B","C","D","E"].map((id) => ({ id })); }
