// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run 専用Redisキー生成
//
// 会社ラボ本体（companyLabRedisKeys.ts）とは独立した名前空間を使う。
// Simulation Run は Game Owner のテスト実行結果であり、会社ラボの current/draft/
// history とは寿命も意味も違うため、同じキー空間へ混ぜない。
//
//   v2:simulationRun:index              （production。保存順ZSET）
//   staging:v2:simulationRun:index      （staging）
//   v2:simulationRun:{simulationRunId}
//
// 生成したキーは必ず assertAllowedSimulationRunKey を通してから書き込むこと。

import { AppEnvV2 } from "../core/version";

/** simulationRunId に許可する文字（キー注入・名前空間の逸脱を防ぐ）。 */
const SIMULATION_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function assertValidSimulationRunId(simulationRunId: string): void {
  if (typeof simulationRunId !== "string" || !SIMULATION_RUN_ID_PATTERN.test(simulationRunId)) {
    throw new Error(
      `simulationRunId は英数字・ドット・ハイフン・アンダースコア・コロンのみ、1〜200文字である必要があります。受け取った値: ${JSON.stringify(simulationRunId)}`
    );
  }
}

function prefixFor(appEnv: AppEnvV2): string {
  return appEnv === "production" ? "v2:simulationRun:" : "staging:v2:simulationRun:";
}

/** 保存済み Simulation Run の一覧キー（score=保存時刻のZSET）。 */
export function simulationRunIndexKeyV2(appEnv: AppEnvV2): string {
  return `${prefixFor(appEnv)}index`;
}

/** Simulation Run 本体キー。 */
export function simulationRunKeyV2(appEnv: AppEnvV2, simulationRunId: string): string {
  assertValidSimulationRunId(simulationRunId);
  return `${prefixFor(appEnv)}${simulationRunId}`;
}

/** 要約キャッシュキー（一覧のたびに dataset 本体を読まないため）。 */
export function simulationRunSummaryKeyV2(appEnv: AppEnvV2, simulationRunId: string): string {
  assertValidSimulationRunId(simulationRunId);
  return `${prefixFor(appEnv)}${simulationRunId}:summary`;
}

/**
 * 【Turn14以降Save/Resume停止BLOCKER修正】巨大な1つのJSON value・1回のHTTP requestとして
 * 保存する設計を廃止し、revisionでバージョニングした部分ごとのキーへ分割する。
 *
 * 実測でVercel Functionsのrequest body上限（既定約4.5MB）に、resumePayload＋dataset＋
 * packCaptureを1つのJSONへ束ねた場合Turn10〜15あたりで到達することを確認した
 * （measured: baseline scenario, Turn10=4.46MB, Turn12=5.03MB）。dataset/packCaptureは
 * 本来O(turns)で成長し続ける設計（Analysis用の正史であり、これ自体は間違っていない）
 * のため、1requestに束ねたままでは32Qまで到達し得ない。
 *
 * 各partをrevisionでバージョニングして別キーへ保存する（同じrunIdでも新しいrevisionは
 * 新しいキーへ書く）ことで、manifest（下記 simulationRunManifestKeyV2）がactiveRevisionを
 * 指し替えるまでは、進行中の書き込みが既存の読み込み可能な状態を上書きしない
 * （指示§21/§22 atomic save / manifest方式）。
 */
export function simulationRunResumeKeyV2(appEnv: AppEnvV2, simulationRunId: string, revision: number): string {
  assertValidSimulationRunId(simulationRunId);
  return `${prefixFor(appEnv)}${simulationRunId}:resume:${revision}`;
}

export function simulationRunDatasetKeyV2(appEnv: AppEnvV2, simulationRunId: string, revision: number): string {
  assertValidSimulationRunId(simulationRunId);
  return `${prefixFor(appEnv)}${simulationRunId}:dataset:${revision}`;
}

export function simulationRunPackKeyV2(appEnv: AppEnvV2, simulationRunId: string, revision: number): string {
  assertValidSimulationRunId(simulationRunId);
  return `${prefixFor(appEnv)}${simulationRunId}:pack:${revision}`;
}

/**
 * manifest本体キー。旧 simulationRunKeyV2 と同じ名前空間だが、内容は
 * RunManifest（小さい: run metadata + activeRevision + savedAt + hasXxxフラグ）のみ。
 * 巨大な本体を直接持たない。読み込みはmanifestを読んでからactiveRevisionを使って
 * resume/dataset/packの各キーを個別に取得する。
 */
export function simulationRunManifestKeyV2(appEnv: AppEnvV2, simulationRunId: string): string {
  return simulationRunKeyV2(appEnv, simulationRunId);
}

/**
 * 書き込み直前のキー許可検証。
 * 会社ラボ本体・本番ゲームのキー空間へ絶対に書き込まないことを構造的に保証する。
 */
export function assertAllowedSimulationRunKeys(keys: readonly string[], appEnv: AppEnvV2): void {
  const prefix = prefixFor(appEnv);
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      throw new Error(`Simulation Run 以外のキーへ書き込もうとしました（key=${key}, 期待するprefix=${prefix}）。`);
    }
  }
}
