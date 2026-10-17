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

import { gunzipSync } from "zlib";
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
import {
  SIMULATION_RUN_BODY_ENCODING_HEADER,
  SIMULATION_RUN_INVALID_REQUEST_BODY,
  SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES,
  SIMULATION_RUN_REQUEST_BODY_TOO_LARGE,
  isGzipBodyEncoding,
} from "../../../../lib/v2/companyLab/simulation/persistence/partBodyEncoding";

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

/**
 * 本文の読み取り結果。失敗を undefined で表すと「本文が無い」「壊れている」
 * 「大きすぎる」の区別が呼び出し側へ伝わらず、理由を出せないため、
 * 成否と理由を持つ値で返す。
 */
export type ParsedRequestBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

function tooLarge(message: string): ParsedRequestBody {
  return { ok: false, code: SIMULATION_RUN_REQUEST_BODY_TOO_LARGE, message };
}

function invalidBody(message: string): ParsedRequestBody {
  return { ok: false, code: SIMULATION_RUN_INVALID_REQUEST_BODY, message };
}

/** zlib が「出力が上限に達した」として投げたエラーかどうか。 */
function isOutputLimitError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE";
}

const LIMIT_MIB = (SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES / 1024 / 1024).toFixed(0);

/**
 * 【COMP-1・送信量削減】`x-shrimpx-body-encoding: gzip` が付いている場合は、ボディを
 * gzip として展開してから JSON にする。保存のたびに dataset / resume / pack を
 * 丸ごと送る経路があり、そこが送信量の大半を占めるため、送る前に縮める。
 *
 * ヘッダが無ければ従来どおり素の JSON として読む。旧クライアント（圧縮を知らない
 * ブラウザ・CompressionStream が無い環境）からの保存を壊さないための後方互換である。
 *
 * 【COMP-2・展開後サイズの上限】圧縮本文は小さくても、展開すると何十倍にもなり得る
 * （実測で、101,941 B の gzip が 104,857,600 B へ＝1029:1）。そのため
 *   1. 展開しきってから大きさを検査するのではなく、展開処理自体を上限で止める
 *      （zlib の maxOutputLength。上限に達した時点で ERR_BUFFER_TOO_LARGE を投げ、
 *        残りを展開しない。上の1029:1の本文は 8.2 ms・heap 増加 0.2 MB で拒否される）
 *   2. 未圧縮の経路にも同じ上限を、JSON として解釈する前に適用する
 * とする。上限を超えた場合は理由つきで失敗を返し、保存は一切行わない
 * （この関数は repository へ触れる前に呼ばれるため、既存の正本は変化しない）。
 */
export async function parseJsonBody(req: NextRequest): Promise<ParsedRequestBody> {
  if (isGzipBodyEncoding(req.headers.get(SIMULATION_RUN_BODY_ENCODING_HEADER))) {
    let json: string;
    try {
      const compressed = Buffer.from(await req.arrayBuffer());
      json = gunzipSync(compressed, { maxOutputLength: SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES }).toString("utf8");
    } catch (e) {
      if (isOutputLimitError(e)) {
        return tooLarge(
          `展開後の本文が上限（${LIMIT_MIB}MiB）を超えたため、展開を中止しました。保存は行っていません。`
        );
      }
      console.error("[simulation-runs api] gzip ボディの展開に失敗しました:", e);
      return invalidBody("gzip ボディを展開できませんでした。保存は行っていません。");
    }
    try {
      return { ok: true, value: JSON.parse(json) };
    } catch {
      return invalidBody("展開したボディを JSON として読めませんでした。保存は行っていません。");
    }
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(await req.arrayBuffer());
  } catch {
    return invalidBody("ボディを読み取れませんでした。保存は行っていません。");
  }
  if (raw.byteLength > SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES) {
    return tooLarge(
      `本文が上限（${LIMIT_MIB}MiB）を超えています（${raw.byteLength} B）。保存は行っていません。`
    );
  }
  try {
    return { ok: true, value: JSON.parse(raw.toString("utf8")) };
  } catch {
    return invalidBody("ボディを JSON として読めませんでした。保存は行っていません。");
  }
}
