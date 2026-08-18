// ShrimpX V2 — 配当（Dividend）モジュール（Phase DIV-1）
//
// 【目的】単純な累計利益ランキングから一段進め、「利益を生む→再投資する→財務を
// 守る→株主へ還元する→会社価値を残す」という資本配分までを含めた経営ゲームに
// するための第一歩。各会社は各Turnで任意額の配当を決定できる。
//
// 【会計監査結果（実装指示§5・§6）】finance/quarterClose.ts・finance/initialState.ts
// を監査した結果、既存のBalanceSheet.retainedEarningsは「game-start時点の残差
// （総資産-総負債-資本金。会社ごとに数千万USD規模の非ゼロ値）＋その後の累計
// 当期純利益」であり、ゲーム開始後に生み出した利益だけを区別するフィールドでは
// ない。既存retainedEarnings全額を配当可能とすると、Turn1開始直後に初期設定由来の
// 利益剰余金まで即時大量配当できてしまう（実装指示§6が明示的に禁止する挙動）。
//
// そのため、新しい独立したフィールド`CompanyFinanceState.distributableEarnings`を
// 追加した（本ファイルでは定義しない。finance/types.tsに追加）。これはgame-start時点
// で0にシードし（実装指示§6「game-start distributable base = 0」を採用）、以後は
// 既存retainedEarningsとまったく同じロールフォワード式（前期値+当期純利益）で
// 増加し、配当実行時にだけ減少する。既存retainedEarnings自体はBS整合項目として
// 一切変更しない計算方法を維持する（実装指示§6「既存Retained EarningsはBS整合
// 項目として残してよい」）。
//
// 【配当可能額（実装指示§5）】maxDividend = min(availableCash, distributableEarnings)。
// どちらもTurn N decision時点で「前Turnまでに確定した」値（=state.financeState.
// companiesのTurn N-1確定値）を使う。当Turnの営業結果はまだ確定していないため、
// 当Turn利益の先取り配当はできない（実装指示§4）。
//
// 【会計処理（実装指示§7）】配当実行時: Cash↓・Retained Earnings↓。営業利益・
// P&L expenseには一切影響しない。Debtも自動増加させない（配当のための自動借入は
// 禁止）。配当前Cash不足ならvalidationで止める（部分執行しない。全額拒否）。
//
// 【資金制約（実装指示§9）】配当したCashはそのTurnの経営に使えなくなる必要がある。
// runner.ts側で、この配当計算をfinancing pre-check・procurement constraint計算より
// 前に実行し、その結果（cash/retainedEarnings/distributableEarnings控除後の
// CompanyFinanceState）を以後のTurn処理全体で唯一のprevFinanceとして使うことで、
// 「Turn終了後に帳尻だけCashを減らす」方式（実装指示§9が禁止）を避ける。

import { CompanyFinanceState, unwrapUsd, usd } from "./types";
import { CompanyId } from "../sales/types";
import { PeriodV2 } from "../core/period";

export class DividendValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DividendValidationError";
  }
}

/** 実装指示§3。Finance decisionへ追加する配当入力。0も可、自由入力。 */
export interface DividendDecisionInput {
  readonly dividendAmountUsd: number;
}

/** 実装指示§5。maxDividend = min(availableCash, distributableEarnings)（0未満にはならない）。 */
export function computeMaxDividendUsd(prevFinance: CompanyFinanceState): number {
  return Math.max(0, Math.min(unwrapUsd(prevFinance.cash), unwrapUsd(prevFinance.distributableEarnings)));
}

/** 実装指示§7・§28。配当決定のserver-side解決結果。requestedと実際に適用された額を分離する。 */
export interface DividendResolution {
  readonly requestedUsd: number;
  readonly appliedUsd: number;
  readonly rejected: boolean;
  /** rejected=trueの場合のみ設定（UI/AIへ理由を返すため）。 */
  readonly rejectionReason: string | null;
  readonly maxDividendUsd: number;
}

const EPS_USD = 1e-6;

/**
 * 配当決定を、前Turnまでに確定したCompanyFinanceStateへ照らして解決する。
 * requestedが未指定・0の場合は配当なし（rejected=false, appliedUsd=0）。
 * requestedが負数の場合は構造的な誤用としてDividendValidationErrorを投げる
 * （UIが負数を送ること自体が想定外の入力のため）。
 * requestedがmaxDividendを超える場合は、部分執行せず全額拒否する
 * （実装指示§7「配当実行前にCash不足ならvalidationで止める」）。
 */
export function resolveDividendDecision(requested: DividendDecisionInput | undefined, prevFinance: CompanyFinanceState): DividendResolution {
  const maxDividendUsd = computeMaxDividendUsd(prevFinance);
  const requestedUsd = requested?.dividendAmountUsd ?? 0;

  // 【INT-NA】有限でない配当要求額は「0扱い」にしてはならない。
  // requestedUsdがNaN/Infinityの場合、以下の比較（< -EPS / <= EPS / > cash / > distributable）は
  // すべてfalseになり、素通りしてappliedUsd=NaNが返る。その値はapplyDividendToFinanceStateで
  // usd()へ渡され、「Usd金額が有限の数値ではありません: NaN」という原因の分からない例外で
  // シミュレーションが停止する。ここで負数と同じ「構造的な誤用」として明示的に弾き、
  // どの入力が壊れているかをメッセージに残す。
  if (!Number.isFinite(requestedUsd)) {
    throw new DividendValidationError(`配当額が有限の数値ではありません: ${String(requested?.dividendAmountUsd)}`);
  }
  if (requestedUsd < -EPS_USD) {
    throw new DividendValidationError(`配当額はマイナスにできません: ${requestedUsd}`);
  }
  if (requestedUsd <= EPS_USD) {
    return { requestedUsd: Math.max(0, requestedUsd), appliedUsd: 0, rejected: false, rejectionReason: null, maxDividendUsd };
  }

  const availableCashUsd = unwrapUsd(prevFinance.cash);
  const distributableEarningsUsd = unwrapUsd(prevFinance.distributableEarnings);

  // 【INT-NA】上限側が有限でない場合も同様に素通りする（NaNとの比較は常にfalse）。
  // 「上限が不明なのだから配ってよい」ではなく「上限を確認できないので配れない」が
  // 正しい会計上の意味なので、0扱いにも無制限扱いにもせず、状態異常として明示的に弾く。
  if (!Number.isFinite(availableCashUsd) || !Number.isFinite(distributableEarningsUsd)) {
    throw new DividendValidationError(
      `配当可能額を判定できません（現金または分配可能利益が有限の数値ではありません）: cash=${String(availableCashUsd)} distributableEarnings=${String(distributableEarningsUsd)}`
    );
  }

  if (requestedUsd > availableCashUsd + EPS_USD) {
    return {
      requestedUsd,
      appliedUsd: 0,
      rejected: true,
      rejectionReason: `配当額(${requestedUsd.toFixed(2)})が利用可能な現金(${availableCashUsd.toFixed(2)})を超えています。`,
      maxDividendUsd,
    };
  }
  if (requestedUsd > distributableEarningsUsd + EPS_USD) {
    return {
      requestedUsd,
      appliedUsd: 0,
      rejected: true,
      rejectionReason: `配当額(${requestedUsd.toFixed(2)})が分配可能利益(${distributableEarningsUsd.toFixed(2)})を超えています。`,
      maxDividendUsd,
    };
  }

  return { requestedUsd, appliedUsd: requestedUsd, rejected: false, rejectionReason: null, maxDividendUsd };
}

/**
 * 配当実行後のCompanyFinanceStateを返す（純粋関数、副作用なし）。
 * Cash・Retained Earnings・distributableEarningsを同額だけ減らす。
 * 営業利益・P&L・Debtには一切触れない（実装指示§7）。
 */
export function applyDividendToFinanceState(prevFinance: CompanyFinanceState, appliedUsd: number): CompanyFinanceState {
  if (appliedUsd <= EPS_USD) return prevFinance;
  return {
    ...prevFinance,
    cash: usd(unwrapUsd(prevFinance.cash) - appliedUsd),
    retainedEarnings: usd(unwrapUsd(prevFinance.retainedEarnings) - appliedUsd),
    distributableEarnings: usd(unwrapUsd(prevFinance.distributableEarnings) - appliedUsd),
  };
}

// ---------------------------------------------------------------------
// Time-weighted Dividend Score（実装指示§11・§12・§27）
// ---------------------------------------------------------------------

const DEFAULT_SCENARIO_LENGTH_TURNS = 32;

/**
 * 実装指示§12の第一候補（32Turnの段階方式）を、任意のscenarioLengthへ比例
 * スケールする関数として実装する（32固定にしない。実装指示§27「scenario
 * lengthへ対応可能な設計」）。境界は32Turn基準の8/16/24/32を、turn/scenarioLength
 * の割合（0.25/0.5/0.75/1.0）として一般化した。
 *
 * 将来、連続discount factorへ差し替え可能なようシグネチャを固定する
 * （実装指示§12「getDividendTimeWeight(turn, scenarioLength?)」）。
 */
export function getDividendTimeWeight(turn: number, scenarioLength: number = DEFAULT_SCENARIO_LENGTH_TURNS): number {
  const length = scenarioLength > 0 ? scenarioLength : DEFAULT_SCENARIO_LENGTH_TURNS;
  const fraction = turn / length;
  if (fraction <= 0.25) return 1.5;
  if (fraction <= 0.5) return 1.3;
  if (fraction <= 0.75) return 1.15;
  return 1.0;
}

/** weightedDividendValue = dividendAmount × timeWeight(turn)（実装指示§11）。 */
export function computeWeightedDividendValueUsd(dividendUsd: number, turn: number, scenarioLength?: number): number {
  return dividendUsd * getDividendTimeWeight(turn, scenarioLength);
}

// ---------------------------------------------------------------------
// 配当履歴（実装指示§10）
// ---------------------------------------------------------------------

/** Turn別に保存する配当履歴の1件（実装指示§10）。CompanyQuarterRecordへoptionalとして追加する。 */
export interface CompanyDividendQuarterResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly turn: number;
  readonly requestedDividendUsd: number;
  readonly appliedDividendUsd: number;
  readonly rejected: boolean;
  readonly rejectionReason: string | null;
  readonly maxDividendUsd: number;
  /** このTurnまでの累積配当額（このTurnの配当を含む）。 */
  readonly cumulativeDividendUsd: number;
  readonly timeWeight: number;
  readonly weightedDividendValueUsd: number;
  /** このTurnまでの時間加重配当価値累計（このTurnぶんを含む）。 */
  readonly cumulativeWeightedDividendValueUsd: number;
  /** 配当実行後の分配可能利益（次Turnのmax dividend計算の基準になる値）。 */
  readonly distributableEarningsAfterUsd: number;
  /** 配当実行後の現金（このTurnの調達・投資等の基準になる値）。 */
  readonly cashAfterUsd: number;
}

/** 実装指示§10。過去の配当履歴からこのTurnまでの累積配当・累積weighted valueを計算する純粋関数。 */
export function buildDividendQuarterResult(params: {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly turn: number;
  readonly resolution: DividendResolution;
  readonly priorCumulativeDividendUsd: number;
  readonly priorCumulativeWeightedDividendValueUsd: number;
  readonly distributableEarningsAfterUsd: number;
  readonly cashAfterUsd: number;
  readonly scenarioLength?: number;
}): CompanyDividendQuarterResult {
  const { companyId, period, turn, resolution, priorCumulativeDividendUsd, priorCumulativeWeightedDividendValueUsd, distributableEarningsAfterUsd, cashAfterUsd, scenarioLength } = params;
  const timeWeight = getDividendTimeWeight(turn, scenarioLength);
  const weightedDividendValueUsd = resolution.appliedUsd * timeWeight;
  return {
    companyId,
    period,
    turn,
    requestedDividendUsd: resolution.requestedUsd,
    appliedDividendUsd: resolution.appliedUsd,
    rejected: resolution.rejected,
    rejectionReason: resolution.rejectionReason,
    maxDividendUsd: resolution.maxDividendUsd,
    cumulativeDividendUsd: priorCumulativeDividendUsd + resolution.appliedUsd,
    timeWeight,
    weightedDividendValueUsd,
    cumulativeWeightedDividendValueUsd: priorCumulativeWeightedDividendValueUsd + weightedDividendValueUsd,
    distributableEarningsAfterUsd,
    cashAfterUsd,
  };
}
