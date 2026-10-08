// ShrimpX V2 — Independent Player Flow: Player Submit（server authoritative）
//
// クライアントはCompanyDecisionDraft（画面の入力値そのまま）とclaimedTurnだけを
// 送る。CompanyDecisionInputへの変換は既存のbuildDecisionInputFromDraft
// （decisionDraft.ts、GM Console・従来のPlayer Workspaceと同じ関数）をサーバー側で
// 呼ぶだけで、新しい変換ロジックは作らない。

import { NextRequest, NextResponse } from "next/server";
import { withPlayerApiContext, parseJsonBody } from "../_lib/context";
import { buildDecisionInputFromDraft, CompanyDecisionDraft, validateDecisionDraftNumbers } from "../../../../v2/company-lab/decisionDraft";
import { submitPlayerDecision } from "../../../../lib/v2/player/submit";
import { PlayerSubmitError } from "../../../../lib/v2/player/types";

const SUBMIT_ERROR_STATUS: Readonly<Record<PlayerSubmitError["code"], number>> = {
  RUN_NOT_FOUND: 404,
  RUN_FINISHED: 409,
  NOT_PLAYER_CONTROLLED: 403,
  STALE_TURN: 409,
  DUPLICATE_SUBMIT: 409,
  INVALID_DECISION: 400,
  // 【O1】保存競合。クライアントは最新Turnを読み直してから出し直す。
  SAVE_CONFLICT: 409,
};

// POST /api/v2/play/submit — このTurnの意思決定を提出する（1Turn1回、以後は同Turn編集不可）。
export async function POST(req: NextRequest): Promise<NextResponse> {
  return withPlayerApiContext(async ({ session, simulationRunRepository, playerRepository }) => {
    const body = await parseJsonBody(req);
    if (typeof body !== "object" || body === null) {
      return { status: 400, body: { error: { code: "BAD_REQUEST", message: "リクエストボディが JSON オブジェクトではありません。" } } };
    }
    const candidate = body as { turn?: unknown; draft?: unknown };
    if (typeof candidate.turn !== "number" || !Number.isFinite(candidate.turn)) {
      return { status: 400, body: { error: { code: "BAD_REQUEST", message: "turn が数値ではありません。" } } };
    }
    if (typeof candidate.draft !== "object" || candidate.draft === null) {
      return { status: 400, body: { error: { code: "BAD_REQUEST", message: "draft がありません。" } } };
    }

    // 【BW-1】この入力検証で見るのは run.gameEndedAt と resumePayload（fixtures と
    // currentPeriod）だけ。dataset と packCapture は読まない。
    // 実際の保存は submitPlayerDecision の CAS ループが最新を読み直して行うため、
    // 保存競合対策（CAS）の経路には手を入れていない。
    const stored = await simulationRunRepository.loadRun(session.runId, { include: { dataset: false, pack: false } });
    if (!stored) {
      return { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: "この Simulation Run は見つかりません。" } } };
    }
    // 【FINISHED後の変更拒否】draft変換（buildDecisionInputFromDraft）を試みる前に確認する。
    // 既にGame Endしたrunでは、クライアントが送るdraftの形が最新のDecision Studioと
    // 食い違っていても（旧UI・不正なリクエスト等）意味のあるエラーにならないため、
    // 変換より前に弾く（submitPlayerDecision内の同チェックより早い、入力検証としての防御）。
    if (stored.run.gameEndedAt) {
      return { status: 409, body: { error: { code: "RUN_FINISHED", message: "このゲームは既に終了しています。意思決定は変更できません。" } } };
    }
    if (!stored.resumePayload) {
      return { status: 409, body: { error: { code: "NOT_RESUMABLE", message: "この Simulation Run は続きからプレイできる保存形式ではありません。" } } };
    }
    const fixture = stored.resumePayload.fixtures.find((f) => f.companyId === session.companyId);
    if (!fixture) {
      return { status: 404, body: { error: { code: "COMPANY_NOT_FOUND", message: `会社 ${session.companyId} はこのRunに存在しません。` } } };
    }

    const draft = { ...(candidate.draft as CompanyDecisionDraft), companyId: session.companyId };
    /**
     * 【INT-1 §6】無効な数値を保存しない。
     * buildDecisionInputFromDraft は安全側に倒して無効値を黙って0へ置換し、
     * 数量0以下の行を黙って落とす（実測済み）。そのままでは
     * 「提出したはずの販売計画が消える」「人員が0になる」が無警告で保存される。
     * サニタイズ自体は変えず、無効入力はここで 400 として拒否する。
     */
    const draftErrors = validateDecisionDraftNumbers(draft);
    if (draftErrors.length > 0) {
      return {
        status: 400,
        body: {
          error: {
            code: "INVALID_DECISION",
            message: `入力に無効な値があるため提出できません（値は保存していません）。${draftErrors.slice(0, 5).join(" / ")}`,
          },
        },
      };
    }
    const decision = buildDecisionInputFromDraft(draft, fixture, stored.resumePayload.state.currentPeriod);

    try {
      const result = await submitPlayerDecision(simulationRunRepository, playerRepository, {
        runId: session.runId,
        companyId: session.companyId,
        claimedTurn: candidate.turn,
        decision,
      });
      return { status: 200, body: result };
    } catch (e) {
      if (e instanceof PlayerSubmitError) {
        return { status: SUBMIT_ERROR_STATUS[e.code], body: { error: { code: e.code, message: e.message } } };
      }
      throw e;
    }
  });
}
