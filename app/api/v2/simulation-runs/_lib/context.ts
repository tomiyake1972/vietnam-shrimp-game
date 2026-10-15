// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run API の共通コンテキスト
//
// 【認証方針】会社ラボ API（company-labs/_lib/withApiContext.ts）と同じく、
// 本番環境では一切提供しない。認証は次のいずれかを受け付ける。
//   (a) Authorization: Bearer {STAGING_ADMIN_TOKEN}（既存の管理API方式）
//   (b) Company Lab UI のセッションCookie（ブラウザからの利用。トークン自体は
//       ブラウザへ渡らない既存の仕組みをそのまま再利用する）
// どちらも無い場合は 403 を返す。Management Console 側は 403 を受け取ったら
// ブラウザ内保存へフォールバックし、保存先を画面に明示する（黙って失敗しない）。
//
// 【Independent Player Flow・実Redis認証情報が無い検証環境向けE2E in-memory fallback】
// app/v2/company-lab/play/_lib/uiDependencies.tsが既に確立している「非本番環境かつ
// 明示的な環境変数フラグが立っているときだけ、プロセス内in-memory実装へ委譲する」
// パターンをそのままここへも適用する（新しいE2E戦略を発明しない）。デフォルトでは
// 絶対にin-memoryへ落ちない。Simulation Run RepositoryとPlayer Repositoryを同じ
// server processで共有することで、複数のPlaywright browser contextから同じ
// dev serverへ繋いだときに「別contextでも同じRunへ復帰できる」ことを実credentials
// 無しで検証できるようにする（実Redisの代わりであり、実環境の検証を置き換えるものではない）。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingAdmin } from "../../../../lib/stagingAdmin";
import { hasValidStagingSession } from "../../../../lib/companyLabUiSession";
import { isProduction } from "../../../../lib/env";
import { readAppEnvV2FromEnv } from "../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabClient";
import { createRedisSimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/redisRepository";
import { createInMemorySimulationRunRepository, SimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/repository";
import { createRedisPlayerRepository } from "../../../../lib/v2/player/redisRepository";
import { createInMemoryPlayerRepository, PlayerRepository } from "../../../../lib/v2/player/repository";

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（保存先の初期化に失敗しました）。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

export interface SimulationRunApiResult {
  readonly status: number;
  readonly body: unknown;
}

const E2E_IN_MEMORY_ENV_FLAG = "V2_API_E2E_IN_MEMORY";

function isE2eInMemoryModeEnabled(): boolean {
  return !isProduction && process.env[E2E_IN_MEMORY_ENV_FLAG] === "1";
}

// プロセス内で使い回すシングルトン（in-memory時のみ）。モジュールトップレベルでは
// 生成しない（isProduction判定を実際に呼ばれるまで遅延させる、既存パターンと同じ）。
let inMemorySimulationRunRepositorySingleton: SimulationRunRepository | null = null;
let inMemoryPlayerRepositorySingleton: PlayerRepository | null = null;

/** 実Redisに接続したRepositoryを組み立てる（リクエストごとに呼ぶ）。 */
export async function createSimulationRunRepository(): Promise<SimulationRunRepository> {
  if (isE2eInMemoryModeEnabled()) {
    if (!inMemorySimulationRunRepositorySingleton) inMemorySimulationRunRepositorySingleton = createInMemorySimulationRunRepository();
    return inMemorySimulationRunRepositorySingleton;
  }
  const appEnv = readAppEnvV2FromEnv();
  const client = await createDefaultCompanyLabRedisClient(appEnv);
  return createRedisSimulationRunRepository({ client, appEnv });
}

/** Independent Player Flow用のRepository（join credential・Seat・Session）。 */
export async function createPlayerRepository(): Promise<PlayerRepository> {
  if (isE2eInMemoryModeEnabled()) {
    if (!inMemoryPlayerRepositorySingleton) inMemoryPlayerRepositorySingleton = createInMemoryPlayerRepository();
    return inMemoryPlayerRepositorySingleton;
  }
  const appEnv = readAppEnvV2FromEnv();
  const client = await createDefaultCompanyLabRedisClient(appEnv);
  return createRedisPlayerRepository({ client, appEnv });
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
