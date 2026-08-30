// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ラボ作成Server Action
//
// 既存のhandleCreateLab（Phase 8C-3A・§6のplayerCompanyId必須検証込み）をそのまま
// 呼び出す（入力検証・エラー分類ロジックを重複実装しない。指示§7「重複しない」）。
// ブラウザからは一切admin tokenを使わず、requireStagingSession()のセッションCookieだけで
// 認可する。

"use server";

import { redirect } from "next/navigation";
import { requireStagingSession, assertSameOriginRequest } from "../../../../lib/companyLabUiSession";
import { resolveCompanyLabUiDependencies } from "../_lib/uiDependencies";
import { handleCreateLab } from "../../../../api/v2/company-labs/_lib/handlers";
import type { CompanyLabSummaryDto } from "../../../../api/v2/company-labs/_lib/responseDto";
import { resolveSalesModelIdForSubmission } from "../_lib/newLabFormModel";

const NEW_LAB_PATH = "/v2/company-lab/play/new";

function readOptionalTrimmedString(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function createLabAction(formData: FormData): Promise<void> {
  await requireStagingSession();
  const origin = await assertSameOriginRequest();
  if (!origin.ok) {
    redirect(`${NEW_LAB_PATH}?error=${encodeURIComponent("不正なリクエスト元です。ページを再読み込みしてやり直してください。")}`);
  }

  const labId = readOptionalTrimmedString(formData, "labId");
  const scenarioId = readOptionalTrimmedString(formData, "scenarioId");
  const mode = readOptionalTrimmedString(formData, "mode");
  const seed = readOptionalTrimmedString(formData, "seed");
  const turnsRaw = readOptionalTrimmedString(formData, "turns");
  const turns = turnsRaw !== undefined ? Number(turnsRaw) : undefined;
  const playerCompanyId = readOptionalTrimmedString(formData, "playerCompanyId");
  // 【UI-SALES-MODEL-SELECT-1・指示§5推奨】既定選択（legacy、DEFAULT_SALES_MODEL_ID）の
  // ままであれば salesModelId 自体を送らない。既存Runと完全に同一のpayload・挙動を
  // 維持するため（validation.ts側のallowlistは既存のまま。ここでは値を作らない）。
  const salesModelId = resolveSalesModelIdForSubmission(readOptionalTrimmedString(formData, "salesModelId"));

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleCreateLab(
    deps,
    { ...(labId !== undefined ? { labId } : {}), scenarioId, mode, seed, turns, playerCompanyId, ...(salesModelId !== undefined ? { salesModelId } : {}) },
    new Date().toISOString()
  );

  if (result.status !== 201) {
    const message = (result.body as { error?: { message?: string } })?.error?.message ?? "ラボの作成に失敗しました。";
    redirect(`${NEW_LAB_PATH}?error=${encodeURIComponent(message)}`);
  }

  const created = (result.body as { lab: CompanyLabSummaryDto }).lab;
  redirect(`/v2/company-lab/play/${encodeURIComponent(created.labId)}`);
}
