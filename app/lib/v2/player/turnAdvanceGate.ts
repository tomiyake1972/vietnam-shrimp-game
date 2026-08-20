// ShrimpX V2 — Independent Player Flow: Turn Advance Gate（server-side実装）
//
// app/api/v2/simulation-runs/_lib/handlers.tsのPlayerSeatSubmissionGate契約の
// 実装。GMが参加linkを発行した（＝Independent Player Flowへ組み入れた）PLAYER会社
// だけを対象に、そのTurnの提出（Seat.lastSubmittedTurn）が揃っているか検査する。
//
// 【GM代理操作は対象外】参加linkを一度も発行していない会社（joinIssuedAtがnull）は
// このgateの対象にしない。既存のGM Console client側判定（missingPlayerCompanies）に
// そのまま委ねる。

import { PlayerSeatSubmissionGate } from "../../../api/v2/simulation-runs/_lib/handlers";
import { CompanyControlMode } from "../companyLab/simulation/types";
import { PlayerRepository } from "./repository";

export function createPlayerSeatSubmissionGate(playerRepository: PlayerRepository): PlayerSeatSubmissionGate {
  return {
    async checkTurnAdvanceAllowed(runId, completedTurn, companyControlModes) {
      const playerCompanyIds = Object.entries(companyControlModes ?? {})
        .filter(([, mode]) => (mode as CompanyControlMode) === "PLAYER")
        .map(([companyId]) => companyId);
      if (playerCompanyIds.length === 0) return { allowed: true, missingCompanyIds: [] };

      const seats = await playerRepository.listSeatsForRun(runId, playerCompanyIds);
      const seatByCompanyId = new Map(seats.map((s) => [s.companyId, s]));

      const missingCompanyIds = playerCompanyIds.filter((companyId) => {
        const seat = seatByCompanyId.get(companyId);
        // 参加linkを一度も発行していない会社（Seatが無い）はgate対象外（GM代理操作を信頼する）。
        if (!seat || seat.joinIssuedAt === null) return false;
        return seat.lastSubmittedTurn !== completedTurn;
      });

      return { allowed: missingCompanyIds.length === 0, missingCompanyIds };
    },
  };
}
