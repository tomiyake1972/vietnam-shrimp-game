import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { CompanyDecision, GameSession, CompanySubmissionStatus, SubmissionStatusResponse } from "../../../../lib/gameTypes";
import { COMPANIES, CompanyId } from "../../../../lib/gameData";
import { decisionsKey, formatPeriod, gameKey } from "../../../../lib/redisKeys";
import { normalizeGameSession } from "../../../../lib/gameSession";
import { normalizeDecision } from "../../../../lib/decision";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);
  const period = formatPeriod(session.currentYear, session.currentQuarter);

  const companies: CompanySubmissionStatus[] = await Promise.all(
    COMPANY_IDS.map(async (id): Promise<CompanySubmissionStatus> => {
      const raw = await redis.get(decisionsKey(gameCode, period, id));
      const storedDecision = parseStored<CompanyDecision>(raw);
      const decision = storedDecision ? normalizeDecision(storedDecision) : null;
      return {
        companyId: id,
        companyName: COMPANIES[id].name,
        playerType: session.players[id],
        submitted: decision !== null,
        submissionCount: decision?.submissionCount ?? 0,
        firstSubmittedAt: decision?.firstSubmittedAt ?? null,
        lastSubmittedAt: decision?.lastSubmittedAt ?? null,
        submittedBy: decision?.submittedBy ?? "unknown",
        isResubmission: (decision?.submissionCount ?? 0) > 1,
      };
    })
  );

  const submittedCount = companies.filter((c) => c.submitted).length;

  const response: SubmissionStatusResponse = {
    gameCode,
    year: session.currentYear,
    quarter: session.currentQuarter,
    phase: session.currentPhase,
    submittedCount,
    totalCompanies: COMPANY_IDS.length,
    allSubmitted: submittedCount === COMPANY_IDS.length,
    updatedAt: new Date().toISOString(),
    companies,
  };
  return NextResponse.json(response);
}
