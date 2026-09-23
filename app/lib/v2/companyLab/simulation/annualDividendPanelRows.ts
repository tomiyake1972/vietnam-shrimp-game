// ShrimpX V2 — 年度末の配当精算 表示行の組み立て（D1 §9）
//
// 【なぜ専用moduleにするか】Management Consoleのパネル・Player側表示・
// Audit Workbookが「同じEngine確定record」を正本として同じ判定を使うため。
// 画面ごとに if を書き分けると、同じRunなのに画面によって状態表示が変わる。
//
// 【捏造しない】この機能より前に確定したRunには年度末精算の記録そのものが無い。
// その行を「0支払」や「CASH_LIMIT」として描かない。読めない事実は UNKNOWN と書く。
//
// 【新しい保存fieldを作らない】判定に使うのは既存の確定記録だけ:
//   - record.dividendResults[].annualSettlement / annualSettlementUnavailableReason
//   - record.decisions[].annualDividendSettlement（年度末精算の意思）
//   - session.manualBalanceApplied[].manualDividendPayoutRatio（null=未指定, 0=明示0%）
//   - session.packCompanyTurns[].decisionOwner（PLAYER / STANDARD_AI）

import { PeriodV2, toYearQuarter } from "../../core/period";
import type { DividendAnnualSettlementRecord } from "../../finance/dividend";
import type { DecisionOwner, SimulationSession } from "./types";

/**
 * 1行の処理状態。「支払った/支払わなかった」ではなく「なぜその額になったか」を区別する。
 * 区別できない事実は UNKNOWN_NO_RECORD に落とし、推測で別の状態へ寄せない。
 */
export type AnnualDividendRowStatus =
  /** 年間目標を全額支払った。 */
  | "PAID_IN_FULL"
  /** 現金上限で部分支払。 */
  | "SHORTFALL_CASH_LIMIT"
  /** 分配可能利益の上限で部分支払。 */
  | "SHORTFALL_DISTRIBUTABLE_EARNINGS_LIMIT"
  /** Standard AIの安全gateで見送られた（精算recordはある）。 */
  | "SHORTFALL_POLICY_GATE"
  /** 年間赤字・利益ゼロのため目標0。 */
  | "NO_ANNUAL_PROFIT"
  /** 管理者が0%と明示指定したため目標0（未指定ではない）。 */
  | "ADMIN_ZERO_PERCENT"
  /** 管理者指定が無く、PLAYER操作のため年度末の自動精算対象外。 */
  | "NO_ADMIN_SETTING_PLAYER"
  /** 管理者指定が無く、Standard AIが任意policyで見送った。 */
  | "NO_ADMIN_SETTING_AI_SKIPPED"
  /** 対象年度のQ1〜Q4が揃わず精算できなかった（0補完していない）。 */
  | "INCOMPLETE_FISCAL_YEAR"
  /** 年間純利益・既払配当に有限でない数値が混ざっていた。 */
  | "INVALID_FINANCIAL_INPUT"
  /** 管理者指定があるのに精算recordが無い（想定外。捏造せず要確認として出す）。 */
  | "ADMIN_SET_BUT_NO_SETTLEMENT"
  /** 年度末精算の記録そのものが無い（この機能より前のRun等）。 */
  | "UNKNOWN_NO_RECORD";

export interface AnnualDividendPanelRow {
  readonly turn: number;
  readonly period: PeriodV2;
  readonly companyId: string;
  readonly status: AnnualDividendRowStatus;
  /** Engineが確定させた精算record。無い場合はundefined（0で埋めない）。 */
  readonly settlement: DividendAnnualSettlementRecord | undefined;
  readonly unavailableReason: string | undefined;
  /**
   * そのTurnに適用されていた管理者指定配当性向。
   *   number    … 明示指定（0を含む）
   *   null      … 管理者指定なし
   *   undefined … 適用記録そのものが無い（旧Run等。推測で埋めない）
   */
  readonly adminPayoutRatio: number | null | undefined;
  /** その四半期・その会社の意思決定が誰由来だったか。記録が無ければundefined。 */
  readonly decisionOwner: DecisionOwner | undefined;
}

const EPS_RATIO = 1e-12;

function resolveStatus(params: {
  readonly settlement: DividendAnnualSettlementRecord | undefined;
  readonly unavailableReason: string | undefined;
  readonly hasDividendRecord: boolean;
  readonly adminPayoutRatio: number | null | undefined;
  readonly decisionOwner: DecisionOwner | undefined;
}): AnnualDividendRowStatus {
  const { settlement, unavailableReason, hasDividendRecord, adminPayoutRatio, decisionOwner } = params;

  if (unavailableReason !== undefined) {
    return unavailableReason === "INCOMPLETE_FISCAL_YEAR" ? "INCOMPLETE_FISCAL_YEAR" : "INVALID_FINANCIAL_INPUT";
  }

  if (settlement !== undefined) {
    // 【0%が先】管理者が0%と明示指定した年度は、年間利益が黒字でも目標0になる。
    // 「年間赤字」と混同すると、設定の結果なのか業績の結果なのかが読めなくなる。
    if (settlement.payoutRatioSource === "MANUAL_OVERRIDE" && Math.abs(settlement.appliedPayoutRatio) <= EPS_RATIO) {
      return "ADMIN_ZERO_PERCENT";
    }
    if (settlement.annualNetIncomeUsd <= 0) return "NO_ANNUAL_PROFIT";
    if (settlement.annualDividendShortfallUsd > 0) {
      switch (settlement.shortfallReason) {
        case "CASH_LIMIT":
          return "SHORTFALL_CASH_LIMIT";
        case "DISTRIBUTABLE_EARNINGS_LIMIT":
          return "SHORTFALL_DISTRIBUTABLE_EARNINGS_LIMIT";
        case "POLICY_GATE":
          return "SHORTFALL_POLICY_GATE";
        default:
          // 未達なのに理由が無い記録は、理由を作らずそのまま「要確認」にはせず、
          // 既存の未達理由集合に無い値として扱う（UI側で「－」表示になる）。
          return "SHORTFALL_POLICY_GATE";
      }
    }
    return "PAID_IN_FULL";
  }

  // ここから先は精算recordが無い行。読めた事実だけで状態を決める。
  if (adminPayoutRatio === undefined) {
    // 手動バランスの適用記録が無い＝この機能より前のRun。0支払と書かない。
    return "UNKNOWN_NO_RECORD";
  }
  if (adminPayoutRatio !== null) {
    // 管理者指定があるのに精算recordが無いのは本修正後は起きない想定。
    // 起きた場合に黙って0支払へ落とすと原因が消えるため、要確認として残す。
    return "ADMIN_SET_BUT_NO_SETTLEMENT";
  }
  if (!hasDividendRecord) return "UNKNOWN_NO_RECORD";
  return decisionOwner === "PLAYER" ? "NO_ADMIN_SETTING_PLAYER" : "NO_ADMIN_SETTING_AI_SKIPPED";
}

/**
 * 年度末（Q4）の確定四半期について、その四半期に存在した全会社の行を作る。
 *
 * 【行を落とさない】以前のパネルは annualSettlement も unavailableReason も無い行を
 * filterで捨てていたため、「管理者設定が無くAIが見送った会社」と
 * 「そもそも記録が無い旧Run」が画面から消えて区別できなかった。Q4に存在した会社は
 * 必ず1行出し、状態で区別する。
 */
export function buildAnnualDividendPanelRows(session: SimulationSession): readonly AnnualDividendPanelRow[] {
  const manualByTurn = new Map<number, number | null>();
  for (const applied of session.manualBalanceApplied ?? []) {
    manualByTurn.set(applied.turn, applied.manualDividendPayoutRatio);
  }
  const ownerByTurnCompany = new Map<string, DecisionOwner>();
  for (const capture of session.packCompanyTurns) {
    ownerByTurnCompany.set(`${capture.turn}:${capture.companyId}`, capture.decisionOwner);
  }

  const rows: AnnualDividendPanelRow[] = [];
  for (const record of session.state.history) {
    if (toYearQuarter(record.period).quarter !== 4) continue;
    for (const financial of record.financialResults) {
      const companyId = financial.companyId;
      const dividend = record.dividendResults?.find((d) => d.companyId === companyId);
      const settlement = dividend?.annualSettlement;
      const unavailableReason = dividend?.annualSettlementUnavailableReason;
      const adminPayoutRatio = manualByTurn.has(record.turn) ? manualByTurn.get(record.turn) : undefined;
      const decisionOwner = ownerByTurnCompany.get(`${record.turn}:${companyId}`);
      rows.push({
        turn: record.turn,
        period: record.period,
        companyId,
        status: resolveStatus({
          settlement,
          unavailableReason,
          hasDividendRecord: dividend !== undefined,
          adminPayoutRatio,
          decisionOwner,
        }),
        settlement,
        unavailableReason,
        adminPayoutRatio,
        decisionOwner,
      });
    }
  }
  // 新しい年度が上に来る順（同一Turn内は会社ID順）。
  return rows.sort((a, b) => (b.turn === a.turn ? a.companyId.localeCompare(b.companyId) : b.turn - a.turn));
}

/** 画面・Workbookで共通に使う日本語ラベル（表示文言の正本を1本にする）。 */
export const ANNUAL_DIVIDEND_ROW_STATUS_LABELS: Readonly<Record<AnnualDividendRowStatus, string>> = {
  PAID_IN_FULL: "全額支払",
  SHORTFALL_CASH_LIMIT: "部分支払（現金上限）",
  SHORTFALL_DISTRIBUTABLE_EARNINGS_LIMIT: "部分支払（分配可能利益の上限）",
  SHORTFALL_POLICY_GATE: "見送り（配当ポリシーの条件）",
  NO_ANNUAL_PROFIT: "年間赤字・利益ゼロ（目標0）",
  ADMIN_ZERO_PERCENT: "管理者が0%と明示指定（目標0）",
  NO_ADMIN_SETTING_PLAYER: "管理者設定なし（PLAYER操作・自動精算の対象外）",
  NO_ADMIN_SETTING_AI_SKIPPED: "管理者設定なし（Standard AIの任意判断で見送り）",
  INCOMPLETE_FISCAL_YEAR: "年間資料不足（Q1〜Q4が揃わず精算せず）",
  INVALID_FINANCIAL_INPUT: "年間資料不足（数値が不正）",
  ADMIN_SET_BUT_NO_SETTLEMENT: "要確認（管理者指定があるのに精算記録なし）",
  UNKNOWN_NO_RECORD: "記録なし（UNKNOWN・この機能より前のRun）",
};
