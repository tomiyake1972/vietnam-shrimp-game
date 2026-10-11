// ShrimpX V2 — UI-CLARITY-1 A-6: Runの保存上限を、作る前に知らせる
//
// 【直す問題】保存上限は20本で、21本目を保存すると保存日が最も古い1本が
// 自動的に削除される（persistence/repository.ts SIMULATION_RUN_RETENTION_LIMIT と、
// redisRepository.ts のmanifest保存Luaが ZCARD→超過分をZREM→TS側が実体をDEL）。
// しかし保存APIは成功（200）を返すだけで、何が消えたかを呼び出し側へ知らせない。
// 画面にも警告が無いため、研修でRunを作るたびに過去の記録が黙って消えていく。
//
// 【ここは判定だけ】削除そのものはサーバー側の既存ロジックが行う。
// このファイルは「いま何本あるか」から画面に出す文言を組み立てるだけで、
// 保存・削除の挙動は一切変えない。

/** サーバー側の保持上限（persistence/repository.ts の SIMULATION_RUN_RETENTION_LIMIT と同じ値）。 */
export const SERVER_RUN_RETENTION_LIMIT = 20;

export type RunRetentionLevel = "ok" | "nearLimit" | "atLimit";

export interface RunRetentionNotice {
  readonly level: RunRetentionLevel;
  readonly savedRunCount: number;
  readonly limit: number;
  /** 次の1本を作ったときに消える Run の名前（分かる場合のみ）。 */
  readonly runIdToBeEvicted?: string;
  readonly runNameToBeEvicted?: string;
  readonly message: string;
}

export interface RunRetentionInput {
  readonly simulationRunId: string;
  readonly savedAt?: string;
  readonly runName?: string;
}

/** 残りが何本を切ったら注意を出すか。 */
const NEAR_LIMIT_REMAINING = 3;

/**
 * 保存済みRun一覧から、Runを作る前に出す注意書きを組み立てる。
 * 一覧を取得できていない間（null）は何も出さない（推測で警告しない）。
 */
export function buildRunRetentionNotice(savedRuns: readonly RunRetentionInput[] | null | undefined): RunRetentionNotice | null {
  if (!savedRuns) return null;
  const savedRunCount = savedRuns.length;
  const remaining = SERVER_RUN_RETENTION_LIMIT - savedRunCount;

  if (remaining > NEAR_LIMIT_REMAINING) {
    return {
      level: "ok",
      savedRunCount,
      limit: SERVER_RUN_RETENTION_LIMIT,
      message: `保存済み ${savedRunCount} / ${SERVER_RUN_RETENTION_LIMIT} 本。上限に達すると、新しいRunを作るたびに最も古いRunが自動的に削除されます。`,
    };
  }

  // savedAt が最も古いものが退避対象（サーバー側も savedAt を score にしている）。
  const oldest = [...savedRuns].sort((a, b) => (a.savedAt ?? "").localeCompare(b.savedAt ?? ""))[0];

  if (remaining > 0) {
    return {
      level: "nearLimit",
      savedRunCount,
      limit: SERVER_RUN_RETENTION_LIMIT,
      runIdToBeEvicted: oldest?.simulationRunId,
      runNameToBeEvicted: oldest?.runName,
      message:
        `保存済み ${savedRunCount} / ${SERVER_RUN_RETENTION_LIMIT} 本。あと ${remaining} 本で上限です。` +
        `上限を超えると、新しいRunを作るたびに最も古いRunが自動的に削除されます（元に戻せません）。`,
    };
  }

  return {
    level: "atLimit",
    savedRunCount,
    limit: SERVER_RUN_RETENTION_LIMIT,
    runIdToBeEvicted: oldest?.simulationRunId,
    runNameToBeEvicted: oldest?.runName,
    message:
      `保存済みが上限の ${SERVER_RUN_RETENTION_LIMIT} 本に達しています。` +
      `このままゲームを開始すると、最も古いRunが自動的に削除されます（元に戻せません）。` +
      `残しておきたいRunがある場合は、先に書き出しておいてください。`,
  };
}
