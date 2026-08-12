import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody, withSimulationRunApiContext } from "./_lib/context";
import { handleListSimulationRuns, handleSaveSimulationRun, handleSaveSimulationRunPart } from "./_lib/handlers";

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
  const body = await parseJsonBody(req);
  const hasPart = typeof body === "object" && body !== null && "part" in body;
  return withSimulationRunApiContext(req, (repository) =>
    hasPart ? handleSaveSimulationRunPart(repository, body) : handleSaveSimulationRun(repository, body)
  );
}

// GET /api/v2/simulation-runs — 保存済み Simulation Run の一覧（要約のみ）。
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withSimulationRunApiContext(req, (repository) => handleListSimulationRuns(repository));
}
