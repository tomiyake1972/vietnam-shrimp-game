import { NextRequest, NextResponse } from "next/server";
import { createPlayerRepository, parseJsonBody, withSimulationRunApiContext } from "./_lib/context";
import { handleListSimulationRuns, handleSaveSimulationRun, handleSaveSimulationRunPart } from "./_lib/handlers";
import { createPlayerSeatSubmissionGate } from "../../../lib/v2/player/turnAdvanceGate";
import { SIMULATION_RUN_REQUEST_BODY_TOO_LARGE } from "../../../lib/v2/companyLab/simulation/persistence/partBodyEncoding";

/**
 * POST /api/v2/simulation-runs — Simulation Run の保存。
 *
 * 【Turn14以降Save/Resume停止BLOCKER修正】1回のrequest bodyへdataset/resumePayload/
 * packCaptureを丸ごと束ねる旧方式は、実測でVercel Functionsのrequest body上限
 * （既定約4.5MB）にTurn10〜15あたりで到達し、それ以降の保存がプラットフォーム側で
 * 拒否されていた（アプリケーションコードに到達する前の失敗）。
 * このため、bodyに `part` フィールドがあればパート単体の保存として扱い
 * （dataset/resume/pack、いずれも束ねた場合よりずっと小さいrequest body）、
 * 無ければ従来どおりの単発保存（manifestOnly指定時はmanifestのcommitのみ、
 * 小さいpayload・テスト・後方互換用）として扱う。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  /**
   * 【COMP-2】本文の読み取りが上限超過・破損で失敗したら、ここで理由つきで返す。
   * repository へ触れる前なので、拒否された保存で既存の正本が変わることはない。
   * 成功したことにしない（呼び出し側は serverSaveSucceeded=false を受け取る）。
   */
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    const status = parsed.code === SIMULATION_RUN_REQUEST_BODY_TOO_LARGE ? 413 : 400;
    return NextResponse.json({ error: { code: parsed.code, message: parsed.message } }, { status });
  }
  const body = parsed.value;
  const hasPart = typeof body === "object" && body !== null && "part" in body;
  return withSimulationRunApiContext(req, async (repository) => {
    if (hasPart) return handleSaveSimulationRunPart(repository, body);
    // 【Independent Player Flow】Turn進行（completedTurns増加）を伴う保存だけ、
    // 参加link発行済みPLAYER会社の提出状況をserver側でも検査する。
    const playerRepository = await createPlayerRepository();
    return handleSaveSimulationRun(repository, body, createPlayerSeatSubmissionGate(playerRepository));
  });
}

// GET /api/v2/simulation-runs — 保存済み Simulation Run の一覧（要約のみ）。
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withSimulationRunApiContext(req, (repository) => handleListSimulationRuns(repository));
}
