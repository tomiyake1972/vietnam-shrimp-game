// ShrimpX V2 — Balance Profile の保存先（BALANCE-PROFILE-1）
//
// 【保存先の選定理由】Balance Profile は「そのブラウザで試した条件の控え」であり、
// ゲーム状態（Run）の正本ではない。共有Redisのschemaを変えたり migration を
// 走らせたりすることは本Phaseの Stop Condition であるため、Redisへは保存しない。
// 既存の Management Console が Run一覧のキャッシュに使っているのと同じ localStorage
// のキー空間へ、Profile専用の名前空間を1つ追加する方式にした。
//
// 【scope】ユーザー共通ではなく**このブラウザ内で共通**（Run固有ではない）。
// 別の端末・別のブラウザへ持っていくときは、Profileのexport/import（JSON）を使う。
// 端末間の共有が必要になった時点で、サーバー保存を別Phaseとして検討する。
//
// 【壊れた保存物で画面を落とさない】localStorage は private window・容量超過・
// 手で書き換えられた値など、いつでも読めない/壊れている可能性がある。
// 読み取りは必ず try/catch で包み、壊れているエントリは黙って捨てて
// 「保存されていない」として扱う（推測で復元しない）。

import {
  BALANCE_PROFILE_SPEC_VERSION,
  BalanceProfile,
  NEUTRAL_BALANCE_PROFILE_ID,
  neutralBalanceProfile,
} from "../../../lib/v2/companyLab/manualBalance/profile";
import { parseManualBalanceScheduleEntry } from "../../../lib/v2/companyLab/manualBalance/portable";
import type { ManualBalanceScheduleEntry } from "../../../lib/v2/companyLab/manualBalance/overrides";

/** localStorage のキー空間（既存の simulationRun 名前空間と衝突させない）。 */
const PROFILE_INDEX_KEY = "shrimpx:v2:balanceProfile:index";

/** 保存できるProfile数の上限（古いものから捨てる）。 */
export const BALANCE_PROFILE_RETENTION_LIMIT = 50;

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** 1件ぶんの検証。壊れていれば null（捏造して復元しない）。 */
function parseStoredProfile(raw: unknown): BalanceProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.profileId !== "string" || r.profileId.trim() === "") return null;
  if (typeof r.profileName !== "string" || r.profileName.trim() === "") return null;
  if (typeof r.specVersion !== "string") return null;
  if (!Array.isArray(r.schedule)) return null;

  const schedule: ManualBalanceScheduleEntry[] = [];
  for (const rawEntry of r.schedule) {
    // 【共有パーサー】画面入力・Profile import と同じ検証を通す。
    const entry = parseManualBalanceScheduleEntry(rawEntry);
    if (!entry) return null;
    schedule.push(entry);
  }

  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return {
    profileId: r.profileId,
    profileName: r.profileName,
    description: typeof r.description === "string" ? r.description : "",
    specVersion: r.specVersion,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    ...(str(r.createdFromRunId) !== undefined ? { createdFromRunId: str(r.createdFromRunId)! } : {}),
    ...(str(r.sourceCommit) !== undefined ? { sourceCommit: str(r.sourceCommit)! } : {}),
    ...(str(r.sourceScenarioId) !== undefined ? { sourceScenarioId: str(r.sourceScenarioId)! } : {}),
    ...(str(r.sourceSeed) !== undefined ? { sourceSeed: str(r.sourceSeed)! } : {}),
    ...(str(r.sourceSalesModelId) !== undefined ? { sourceSalesModelId: str(r.sourceSalesModelId)! } : {}),
    schedule,
  };
}

/**
 * 保存済みProfileを読み出す。
 *
 * 先頭には必ず Neutral（手動補正なし）を置く。Neutralは保存物ではなく
 * コード側の定数であり、localStorageが空でも壊れていても必ず選べる。
 */
export function listBalanceProfiles(now: string): readonly BalanceProfile[] {
  const neutral = neutralBalanceProfile(now);
  if (!hasWindow()) return [neutral];
  try {
    const raw = window.localStorage.getItem(PROFILE_INDEX_KEY);
    if (!raw) return [neutral];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [neutral];
    const profiles = parsed
      .map(parseStoredProfile)
      .filter((p): p is BalanceProfile => p !== null)
      // Neutralは定数側を正とし、保存物側の同IDは無視する（書き換えを許さない）。
      .filter((p) => p.profileId !== NEUTRAL_BALANCE_PROFILE_ID);
    return [neutral, ...profiles];
  } catch {
    return [neutral];
  }
}

export function findBalanceProfile(profileId: string, now: string): BalanceProfile | null {
  return listBalanceProfiles(now).find((p) => p.profileId === profileId) ?? null;
}

/** 保存に失敗した理由（成功時は null）。画面は失敗を黙殺しない。 */
export function saveBalanceProfile(profile: BalanceProfile): string | null {
  if (profile.profileId === NEUTRAL_BALANCE_PROFILE_ID) {
    return "Neutralは既定Profileのため上書きできません。別の名前で保存してください。";
  }
  if (!hasWindow()) return "このブラウザではProfileを保存できません。";
  try {
    const existing = listBalanceProfiles(profile.updatedAt).filter((p) => p.profileId !== NEUTRAL_BALANCE_PROFILE_ID);
    const withoutSame = existing.filter((p) => p.profileId !== profile.profileId);
    const next = [profile, ...withoutSame].slice(0, BALANCE_PROFILE_RETENTION_LIMIT);
    window.localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify(next));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Profileの保存に失敗しました。";
  }
}

export function deleteBalanceProfile(profileId: string, now: string): string | null {
  if (profileId === NEUTRAL_BALANCE_PROFILE_ID) return "Neutralは削除できません。";
  if (!hasWindow()) return "このブラウザではProfileを削除できません。";
  try {
    const remaining = listBalanceProfiles(now)
      .filter((p) => p.profileId !== NEUTRAL_BALANCE_PROFILE_ID)
      .filter((p) => p.profileId !== profileId);
    window.localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify(remaining));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Profileの削除に失敗しました。";
  }
}

/** 新しいProfile IDを作る（表示名とは独立した安定IDにする）。 */
export function newBalanceProfileId(now: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `bp-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${random}`;
}

export { BALANCE_PROFILE_SPEC_VERSION };
