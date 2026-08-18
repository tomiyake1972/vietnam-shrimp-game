// ShrimpX V2 — Run Advisory Memory Management API ハンドラー本体（AMM-M2.6・実装指示§23）
//
// 【役割】UIから将来確認可能なように用意するbackend API contract（MVPでUI実装は不要、
// ただしAPI contractは用意する、という実装指示§23の要求への対応）。
// GET: run/company単位のactive memory一覧。DELETE: 個別memoryの無効化（実装指示§25
// 「完全削除よりinactive推奨」）。いずれもGame State SSoTへは一切触れない
// 読み取り・conversation artifact更新のみの経路。

import { CompanyId } from "../../../../../../../../../lib/v2/sales/types";
import { RunAdvisoryMemoryRecord } from "../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/types";
import { loadRunMemories, saveRunMemories } from "../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/runAdvisoryMemory";
import { RunAdvisoryMemoryApiDependencies } from "./dependencies";

export type RunAdvisoryMemoryApiResult = { readonly status: number; readonly body: unknown };

function notFound(message: string): RunAdvisoryMemoryApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
}

/**
 * GET: labId(run)×companyIdのactive memory一覧を返す（実装指示§23「GET run/company
 * active memories」）。読み取り専用、副作用なし。
 */
export async function handleGetRunAdvisoryMemories(deps: RunAdvisoryMemoryApiDependencies, labId: string, companyId: string): Promise<RunAdvisoryMemoryApiResult> {
  let records: readonly RunAdvisoryMemoryRecord[];
  try {
    records = await loadRunMemories(deps.redisClient, labId, companyId);
  } catch (e) {
    console.error(`[run-advisory-memory api] 読み込みに失敗しました lab=${labId} company=${companyId}:`, e instanceof Error ? e.message : String(e));
    // 実装指示§38「memory unavailable → memoryなしで会話継続」と同じ耐障害方針。空一覧を返す。
    records = [];
  }
  return { status: 200, body: { runId: labId, companyId, memories: records } };
}

/**
 * DELETE: 個別memoryをinactive化する（実装指示§25「完全削除よりinactive推奨」）。
 * 対象idが見つからない場合は404。既にinactiveな場合もそのまま200を返す（冪等）。
 */
export async function handleDeactivateRunAdvisoryMemory(
  deps: RunAdvisoryMemoryApiDependencies,
  labId: string,
  companyId: string,
  memoryId: string
): Promise<RunAdvisoryMemoryApiResult> {
  const records = await loadRunMemories(deps.redisClient, labId, companyId);
  const target = records.find((r) => r.id === memoryId);
  if (!target) {
    return notFound(`memory "${memoryId}" は見つかりません。`);
  }
  const now = new Date().toISOString();
  const updated = records.map((r) => (r.id === memoryId ? { ...r, isActive: false, updatedAt: now } : r));
  await saveRunMemories(deps.redisClient, labId, companyId, updated);
  return { status: 200, body: { runId: labId, companyId: companyId as CompanyId, deactivatedId: memoryId } };
}
