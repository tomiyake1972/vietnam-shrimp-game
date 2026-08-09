// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run API の共通コンテキスト
//
// 【認証方針】会社ラボ API（company-labs/_lib/withApiContext.ts）と同じく、
// 本番環境では一切提供しない。認証は次のいずれかを受け付ける。
//   (a) Authorization: Bearer {STAGING_ADMIN_TOKEN}（既存の管理API方式）
//   (b) Company Lab UI のセッションCookie（ブラウザからの利用。トークン自体は
//       ブラウザへ渡らない既存の仕組みをそのまま再利用する）
// どちらも無い場合は 403 を返す。Management Console 側は 403 を受け取ったら
// ブラウザ内保存へフォールバックし、保存先を画面に明示する（黙って失敗しない）。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingAdmin } from "../../../../lib/stagingAdmin";
import { hasValidStagingSession } from "../../../../lib/companyLabUiSession";
import { readAppEnvV2FromEnv } from "../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabClient";
import { createRedisSimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/redisRepository";
import { SimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/repository";

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（保存先の初期化に失敗しました）。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

export interface SimulationRunApiResult {
  readonly status: number;
  readonly body: unknown;
}

/** 実Redisに接続したRepositoryを組み立てる（リクエストごとに呼ぶ）。 */
export async function createSimulationRunRepository(): Promise<SimulationRunRepository> {
  const appEnv = readAppEnvV2FromEnv();
  const client = await createDefaultCompanyLabRedisClient(appEnv);
  return createRedisSimulationRunRepository({ client, appEnv });
}

export async function withSimulationRunApiContext(
  req: NextRequest,
  handlerFn: (repository: SimulationRunRepository) => Promise<SimulationRunApiResult>
): Promise<NextResponse> {
  const bearer = assertStagingAdmin(req);
  if (!bearer.ok) {
    const session = await hasValidStagingSession();
    if (!session) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: bearer.error } }, { status: bearer.status });
    }
  }

  let repository: SimulationRunRepository;
  try {
    repository = await createSimulationRunRepository();
  } catch (e) {
    console.error("[simulation-runs api] 保存先の初期化に失敗しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } }, { status: 500 });
  }

  try {
    const result = await handlerFn(repository);
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error("[simulation-runs api] ハンドラーで予期しないエラーが発生しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_UNEXPECTED_ERROR } }, { status: 500 });
  }
}

export async function parseJsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
