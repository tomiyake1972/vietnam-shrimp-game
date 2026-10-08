// ShrimpX V2 — Independent Player Flow: GM Console用 Player Seat一覧
//
// 会社ごとに assigned/unassigned（companyControlModes）・joined/unjoined
// （seat.claimedSessionId）・submitted/unsubmitted（resumePayload.confirmedPlayerDecisions、
// GM Advance Turn gatingと同じ信号）・submittedAt（Seatの副次情報）を返す。
// join URLの平文は絶対に含めない（発行/再発行APIが1回だけ返す）。
//
// 【BW-1・転送量削減】この一覧は dataset と packCapture を一切使わないのに、
// 以前は loadRun が常に全パートを読んでいた（manifest + dataset + resume + pack の4回）。
// GM Console は5秒ごとにこれを叩くため、研修1回ぶんでも相当の転送量になる。
//   1. 大きい dataset / packCapture は読まない（include で除外）。
//   2. クライアントが持っている revision と Seat の指紋を受け取り、
//      どちらも変わっていなければ resumePayload も読まずに「変化なし」を返す。
// Seat（参加・再発行・失効・代理提出の記録）は Run の revision とは独立に変わるため、
// revision が同じでも Seat 指紋が変わっていれば必ず完全な一覧を返し直す。
// 認証・権限確認は従来どおり毎回行う（withPlayerSeatManagementApiContext）。

import { NextRequest, NextResponse } from "next/server";
import { withPlayerSeatManagementApiContext } from "../_lib/context";
import type { PlayerSeatRecord } from "../../../../../lib/v2/player/types";
import type { CompanyId } from "../../../../../lib/v2/sales/types";
import { COMPANY_LAB_COMPANY_IDS } from "../../../../../lib/v2/companyLab/fixtures";

/**
 * Seat の変化を表す短い指紋。参加・再発行・失効・代理提出の記録がここに効く。
 * 値そのものではなく「変わったかどうか」だけを判定するために使う。
 */
export function playerSeatsFingerprint(companyIds: readonly string[], seats: readonly PlayerSeatRecord[]): string {
  const byCompanyId = new Map(seats.map((s) => [s.companyId, s]));
  return companyIds
    .slice()
    .sort()
    .map((companyId) => {
      const s = byCompanyId.get(companyId);
      if (!s) return `${companyId}:-`;
      return [
        companyId,
        s.joinIssuedAt ?? "",
        s.joinRevokedAt ?? "",
        s.claimedSessionId ? "1" : "0",
        s.lastSubmittedTurn ?? "",
        s.lastSubmittedAt ?? "",
      ].join("|");
    })
    .join(";");
}

/**
 * クライアントから来た会社IDは信頼せず、既知の会社IDだけを通す。
 * （この一覧は「変化が無いこと」の確認にしか使わないが、入力は検証する。）
 */
function parseKnownCompanyIds(raw: string | null): readonly CompanyId[] {
  if (!raw) return [];
  const known = new Set<string>(COMPANY_LAB_COMPANY_IDS);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => known.has(s)) as readonly CompanyId[];
}

export async function GET(_req: NextRequest, context: { readonly params: Promise<{ readonly runId: string }> }): Promise<NextResponse> {
  const { runId } = await context.params;
  const url = new URL(_req.url);
  const knownRevisionRaw = url.searchParams.get("knownRevision");
  const knownRevision = knownRevisionRaw !== null && /^\d+$/.test(knownRevisionRaw) ? Number(knownRevisionRaw) : null;
  const knownSeatsVersion = url.searchParams.get("knownSeatsVersion");
  const knownCompanyIds = parseKnownCompanyIds(url.searchParams.get("knownCompanyIds"));

  return withPlayerSeatManagementApiContext(_req, async ({ playerRepository, simulationRunRepository }) => {
    // manifestだけを読む軽い問い合わせ。ここで revision が変わっていなければ、
    // fixtures・confirmedPlayerDecisions・currentTurn も変わっていない。
    const persistenceRevision = await simulationRunRepository.currentPublishedRevision(runId);

    if (knownRevision !== null && knownRevision === persistenceRevision && persistenceRevision > 0 && knownCompanyIds.length > 0) {
      const seats = await playerRepository.listSeatsForRun(runId, knownCompanyIds);
      const seatsVersion = playerSeatsFingerprint(knownCompanyIds, seats);
      if (knownSeatsVersion !== null && knownSeatsVersion === seatsVersion) {
        // Run も Seat も変わっていない。大きいパートは一切読まない。
        return { status: 200, body: { runId, unchanged: true, persistenceRevision, seatsVersion } };
      }
      // Seat だけが変わった場合はここを抜けて完全な一覧を返し直す（取りこぼさない）。
    }

    // dataset と packCapture はこの一覧では使わないので読まない。
    const stored = await simulationRunRepository.loadRun(runId, { include: { dataset: false, pack: false } });
    if (!stored) {
      return { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: `Simulation Run が見つかりません（runId=${runId}）。` } } };
    }
    const fixtures = stored.resumePayload?.fixtures ?? [];
    const companyIds = fixtures.map((f) => f.companyId);
    const seats = await playerRepository.listSeatsForRun(runId, companyIds);
    const seatByCompanyId = new Map(seats.map((s) => [s.companyId, s]));
    const controlModes = stored.run.companyControlModes ?? {};
    const confirmedPlayerDecisions = stored.resumePayload?.confirmedPlayerDecisions ?? {};
    const currentTurn = stored.resumePayload?.state.scenarioState.currentTurn ?? null;

    const companies = fixtures.map((fixture) => {
      const seat = seatByCompanyId.get(fixture.companyId) ?? null;
      return {
        companyId: fixture.companyId,
        displayName: fixture.displayName,
        controlMode: controlModes[fixture.companyId] ?? "STANDARD_AI",
        hasSeat: seat !== null,
        joinIssued: Boolean(seat?.joinIssuedAt) && !seat?.joinRevokedAt,
        joined: Boolean(seat?.claimedSessionId),
        hasSubmittedThisTurn: confirmedPlayerDecisions[fixture.companyId] !== undefined,
        lastSubmittedTurn: seat?.lastSubmittedTurn ?? null,
        lastSubmittedAt: seat?.lastSubmittedAt ?? null,
      };
    });

    return {
      status: 200,
      body: {
        runId,
        unchanged: false,
        persistenceRevision: stored.persistenceRevision ?? persistenceRevision,
        seatsVersion: playerSeatsFingerprint(companyIds, seats),
        currentTurn,
        gameEndedAt: stored.run.gameEndedAt ?? null,
        companies,
      },
    };
  });
}
