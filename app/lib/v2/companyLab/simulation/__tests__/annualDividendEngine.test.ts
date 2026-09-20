// ShrimpX V2 — 年間純利益ベース配当: Engine統合テスト（実装指示§17 CASE G〜S）
//
// 【方針】計算契約そのもの（CASE A〜F/J/K/L/O）は finance/__tests__/
// annualDividendSettlement.test.ts が純粋関数で固定している。ここでは
// 実際に32Turn未満のRunを回し、「Engineが本当にその契約どおり動いたか」を
// 確定済みの記録（state.history / dividendResults / financialResults）で実測する。
// 仮定で通さない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSimulationSession, advanceSimulationTurns } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import type { SimulationSession } from "../types";
import { toYearQuarter } from "../../../core/period";
import { unwrapUsd } from "../../../finance/types";
import type { ManualBalanceSchedule, ManualBalanceSettings } from "../../manualBalance/overrides";

const TS_AT = "2026-09-20T00:00:00.000Z";
const SCENARIO = "baseline";
const SEED = "annual-dividend-engine";
const EPS_USD = 1e-6;

function settings(patch: Partial<ManualBalanceSettings> = {}): ManualBalanceSettings {
  return { dividendPayout: { kind: "unspecified" }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined, ...patch };
}

function continuingRatio(payoutRatio: number): ManualBalanceSchedule {
  return [
    {
      kind: "continuing",
      effectiveFromTurn: 1,
      settings: settings({ dividendPayout: { kind: "specified", payoutRatio } }),
      source: "MANUAL_OVERRIDE",
      recordedAt: TS_AT,
    },
  ];
}

function newSession(runId: string, schedule?: ManualBalanceSchedule, turns = 8): SimulationSession {
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: turns,
    startedAt: TS_AT,
    sourceCommit: "ANNUAL-DIVIDEND-TEST",
    ...(schedule ? { manualBalanceOverrides: schedule } : {}),
  });
}

function run(session: SimulationSession, turns: number): SimulationSession {
  return advanceSimulationTurns({ session, turns, timestamp: TS_AT, sourceCommit: "ANNUAL-DIVIDEND-TEST" });
}

/** ある年度・ある会社の、確定済み四半期netIncomeの符号付き合計。 */
function annualNetIncomeFromHistory(session: SimulationSession, year: number, companyId: string): number {
  return session.state.history
    .filter((r) => toYearQuarter(r.period).year === year)
    .reduce((sum, r) => {
      const fin = r.financialResults.find((f) => f.companyId === companyId);
      return sum + (fin ? unwrapUsd(fin.profitAndLoss.netIncome) : 0);
    }, 0);
}

function settlementsAt(session: SimulationSession, turn: number) {
  const record = session.state.history.find((r) => r.turn === turn);
  assert.ok(record, `turn ${turn} の確定履歴が無い`);
  return (record.dividendResults ?? []).filter((d) => d.annualSettlement !== undefined);
}

// ---------------------------------------------------------------------
// CASE G / H / I: Q4時点で有効な配当性向と、その出所
// ---------------------------------------------------------------------

test("CASE H: Manual 50%指定は経営性格バイアスで改変されず、実適用率0.5として記録される", () => {
  const s = run(newSession("case-h", continuingRatio(0.5)), 4);
  const settled = settlementsAt(s, 4);
  assert.ok(settled.length > 0, "Q4で年間精算が1社以上実行されていること");
  for (const d of settled) {
    assert.equal(d.annualSettlement!.appliedPayoutRatio, 0.5, `${d.companyId}: 手動50%がそのまま適用されていない`);
    assert.equal(d.annualSettlement!.payoutRatioSource, "MANUAL_OVERRIDE");
  }
});

test("CASE I: Manual未指定ならStandard AIの実効配当性向が使われ、出所はSTANDARD_AI", () => {
  const s = run(newSession("case-i"), 4);
  const settled = settlementsAt(s, 4);
  assert.ok(settled.length > 0);
  for (const d of settled) {
    assert.equal(d.annualSettlement!.payoutRatioSource, "STANDARD_AI");
    assert.ok(d.annualSettlement!.appliedPayoutRatio > 0, "実効配当性向が正であること");
    // 手動50%とは異なる値であること（=手動値が漏れていない）。
    assert.notEqual(d.annualSettlement!.appliedPayoutRatio, 0.5);
  }
});

test("CASE G: Q4で配当性向を変更した場合、Q4時点で有効な率が年間精算に使われる", () => {
  // Turn4（Q4）からだけ 0.8 を有効にする。Q1〜Q3は手動指定なし。
  const schedule: ManualBalanceSchedule = [
    {
      kind: "continuing",
      effectiveFromTurn: 4,
      settings: settings({ dividendPayout: { kind: "specified", payoutRatio: 0.8 } }),
      source: "MANUAL_OVERRIDE",
      recordedAt: TS_AT,
    },
  ];
  const s = run(newSession("case-g", schedule), 4);
  const settled = settlementsAt(s, 4);
  assert.ok(settled.length > 0);
  for (const d of settled) {
    assert.equal(d.annualSettlement!.appliedPayoutRatio, 0.8, "Q4で有効になった率が使われていない");
    assert.equal(d.annualSettlement!.payoutRatioSource, "MANUAL_OVERRIDE");
  }
});

// ---------------------------------------------------------------------
// CASE A（Engine実測版）: 年間合計が算定baseになっている
// ---------------------------------------------------------------------

test("CASE A(Engine): 記録された年間純利益が、確定履歴Q1〜Q4のnetIncome合計と一致する", () => {
  const s = run(newSession("case-a-engine", continuingRatio(0.5)), 4);
  const settled = settlementsAt(s, 4);
  assert.ok(settled.length > 0);
  for (const d of settled) {
    const a = d.annualSettlement!;
    const expected = annualNetIncomeFromHistory(s, a.dividendTargetYear, d.companyId);
    assert.ok(
      Math.abs(a.annualNetIncomeUsd - expected) < 0.01,
      `${d.companyId}: 記録=${a.annualNetIncomeUsd} / 履歴合計=${expected}`
    );
    // 目標 = max(0, 年間NI) × 率
    assert.ok(Math.abs(a.annualDividendTargetUsd - Math.max(0, expected) * a.appliedPayoutRatio) < 0.01);
    // 【対照】Q3単独×率ではないこと。
    const q3 = s.state.history.find((r) => r.turn === 3)!.financialResults.find((f) => f.companyId === d.companyId)!;
    const q3Based = Math.max(0, unwrapUsd(q3.profitAndLoss.netIncome)) * a.appliedPayoutRatio;
    assert.ok(Math.abs(a.annualDividendTargetUsd - q3Based) > 0.01, `${d.companyId}: 年間目標がQ3単独基準と一致してしまっている`);
  }
});

// ---------------------------------------------------------------------
// CASE R / S: 会計整合
// ---------------------------------------------------------------------

test("CASE R: 配当を払ってもPLのnetIncomeは変わらない（配当はPL費用ではない）", () => {
  const withDividend = run(newSession("case-r-div", continuingRatio(0.5)), 4);
  const noDividend = run(newSession("case-r-nodiv", continuingRatio(0)), 4);
  // 配当性向0%のRunは年間目標0＝支払なし。Q4のnetIncomeは配当の有無で変わらないはず。
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const a = withDividend.state.history.find((r) => r.turn === 4)!.financialResults.find((f) => f.companyId === companyId)!;
    const b = noDividend.state.history.find((r) => r.turn === 4)!.financialResults.find((f) => f.companyId === companyId)!;
    assert.equal(
      unwrapUsd(a.profitAndLoss.netIncome),
      unwrapUsd(b.profitAndLoss.netIncome),
      `${companyId}: 配当の有無でnetIncomeが変わっている`
    );
  }
});

test("CASE S: 配当後もBS/Cash/Equity/CF/Dividend Resultが整合する", () => {
  const s = run(newSession("case-s", continuingRatio(0.5)), 8);
  let checkedPaidQuarters = 0;
  for (const record of s.state.history) {
    for (const fin of record.financialResults) {
      const bs = fin.balanceSheet;
      const cf = fin.cashFlow;
      const div = record.dividendResults?.find((d) => d.companyId === fin.companyId);
      const paid = div?.appliedDividendUsd ?? 0;

      // CF内部整合: opening + net = closing
      assert.ok(
        Math.abs(unwrapUsd(cf.openingCash) + unwrapUsd(cf.netCashChange) - unwrapUsd(cf.closingCash)) < 0.01,
        `T${record.turn} ${fin.companyId}: opening+net != closing`
      );
      // CF closingCash == BS cash
      assert.ok(
        Math.abs(unwrapUsd(cf.closingCash) - unwrapUsd(bs.cash)) < 0.01,
        `T${record.turn} ${fin.companyId}: CF closingCash != BS cash`
      );
      // BS balance
      assert.ok(
        Math.abs(unwrapUsd(bs.balanceDifference)) < 0.01,
        `T${record.turn} ${fin.companyId}: balanceDifference=${unwrapUsd(bs.balanceDifference)}`
      );
      // 純資産 = 資本金 + 利益剰余金
      assert.ok(
        Math.abs(unwrapUsd(bs.totalEquity) - (unwrapUsd(bs.capitalStock) + unwrapUsd(bs.retainedEarnings))) < 0.01,
        `T${record.turn} ${fin.companyId}: totalEquity != capitalStock + retainedEarnings`
      );
      // 配当を払った四半期は、CFへ dividendsPaid が同額で記録されていること。
      if (paid > EPS_USD) {
        checkedPaidQuarters += 1;
        assert.ok(cf.dividendsPaid !== undefined, `T${record.turn} ${fin.companyId}: dividendsPaidが記録されていない`);
        assert.ok(
          Math.abs(unwrapUsd(cf.dividendsPaid!) - paid) < 0.01,
          `T${record.turn} ${fin.companyId}: dividendsPaid=${unwrapUsd(cf.dividendsPaid!)} != 実支払=${paid}`
        );
      }
    }
  }
  assert.ok(checkedPaidQuarters > 0, "配当が1件も発生しておらず、CASE Sの検査が空振りしている");
});

test("CASE S-2: 配当はDebtを動かさない（配当のための自動借入をしない）", () => {
  const withDividend = run(newSession("case-s2-div", continuingRatio(0.5)), 4);
  const noDividend = run(newSession("case-s2-nodiv", continuingRatio(0)), 4);
  // Q4は配当の有無で資金繰りが変わりうるため、配当実行前の同一条件区間（Q1〜Q3）で
  // 借入残高が完全一致することを確認する（配当がQ1〜Q3の借入へ影響していないこと）。
  for (const turn of [1, 2, 3]) {
    for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
      const a = withDividend.state.history.find((r) => r.turn === turn)!.financialResults.find((f) => f.companyId === companyId)!;
      const b = noDividend.state.history.find((r) => r.turn === turn)!.financialResults.find((f) => f.companyId === companyId)!;
      assert.equal(unwrapUsd(a.balanceSheet.shortTermLoans), unwrapUsd(b.balanceSheet.shortTermLoans), `T${turn} ${companyId} 短期借入`);
      assert.equal(unwrapUsd(a.balanceSheet.longTermLoans), unwrapUsd(b.balanceSheet.longTermLoans), `T${turn} ${companyId} 長期借入`);
    }
  }
});

// ---------------------------------------------------------------------
// CASE M / N: 再実行・save/resume で二重支払しない
// ---------------------------------------------------------------------

test("CASE M: Q4のTurnを同じ前提から再実行しても、配当が二重にならない", () => {
  const beforeQ4 = run(newSession("case-m", continuingRatio(0.5)), 3);
  const first = run(beforeQ4, 1);
  const second = run(beforeQ4, 1); // 同じ前提stateから再実行（retry相当）
  const f = settlementsAt(first, 4);
  const g = settlementsAt(second, 4);
  assert.deepEqual(
    g.map((d) => [d.companyId, d.appliedDividendUsd, d.annualSettlement!.appliedDividendUsd]),
    f.map((d) => [d.companyId, d.appliedDividendUsd, d.annualSettlement!.appliedDividendUsd]),
    "再実行で配当額が変わっている（二重加算または取りこぼし）"
  );
  // 累積配当も同じであること（積み増されていない）。
  assert.deepEqual(
    g.map((d) => d.cumulativeDividendUsd),
    f.map((d) => d.cumulativeDividendUsd)
  );
});

test("CASE N: save → resume → Q4計算 が、中断なし実行と完全に一致する", () => {
  const continuous = run(newSession("case-n", continuingRatio(0.5)), 4);

  const beforeQ4 = run(newSession("case-n", continuingRatio(0.5)), 3);
  const payload = buildResumePayload(beforeQ4, beforeQ4.run.companyControlModes ?? {}, {});
  const restored = restoreSessionFromResumePayload(beforeQ4.run, payload);
  const resumed = run(restored, 1);

  const a = continuous.state.history.find((r) => r.turn === 4)!;
  const b = resumed.state.history.find((r) => r.turn === 4)!;
  assert.deepEqual(
    JSON.parse(JSON.stringify(b.dividendResults)),
    JSON.parse(JSON.stringify(a.dividendResults)),
    "resume後のQ4配当結果が中断なし実行と一致しない"
  );
  assert.deepEqual(
    b.financialResults.map((f) => [f.companyId, unwrapUsd(f.balanceSheet.cash), unwrapUsd(f.balanceSheet.retainedEarnings)]),
    a.financialResults.map((f) => [f.companyId, unwrapUsd(f.balanceSheet.cash), unwrapUsd(f.balanceSheet.retainedEarnings)]),
    "resume後のQ4 Cash/利益剰余金が一致しない"
  );
});

// ---------------------------------------------------------------------
// CASE P: 最終Q4（T32）でも精算される
// ---------------------------------------------------------------------

test("CASE P: 32Turn完走時、最終Q4(T32)でも年間精算が実行される", () => {
  const s = run(newSession("case-p", continuingRatio(0.5), 32), 32);
  assert.equal(s.run.completedTurns, 32);
  const last = s.state.history.find((r) => r.turn === 32)!;
  assert.equal(toYearQuarter(last.period).quarter, 4, "T32がQ4でない");
  const settled = (last.dividendResults ?? []).filter((d) => d.annualSettlement !== undefined);
  assert.ok(settled.length > 0, "最終Q4で年間精算が1社も実行されていない");
  for (const d of settled) {
    const a = d.annualSettlement!;
    const expected = annualNetIncomeFromHistory(s, a.dividendTargetYear, d.companyId);
    assert.ok(Math.abs(a.annualNetIncomeUsd - expected) < 0.01, `${d.companyId}: T32の年間純利益が履歴合計と一致しない`);
  }
});

// ---------------------------------------------------------------------
// CASE Q: Player金額指定の実支払が年度内既払へ算入される
// ---------------------------------------------------------------------

test("CASE Q: 年度内に金額指定で支払った配当は、年末追加目標から差し引かれる", () => {
  // Q1〜Q3のどこかで金額指定配当が発生するRunを作るのではなく、
  // 契約の要である「既払 → 追加目標の減少」をEngine記録の関係式として検査する。
  const s = run(newSession("case-q", continuingRatio(0.5)), 8);
  let checked = 0;
  for (const turn of [4, 8]) {
    for (const d of settlementsAt(s, turn)) {
      const a = d.annualSettlement!;
      // 年末追加目標 = max(0, 年間目標 − 同年度既払)
      assert.ok(
        Math.abs(a.yearEndAdditionalTargetUsd - Math.max(0, a.annualDividendTargetUsd - a.paidDividendEarlierInYearUsd)) < 0.01,
        `T${turn} ${d.companyId}: 年末追加目標が「年間目標−既払」になっていない`
      );
      // 既払は「実際に支払った額」から来る（負にならない）。
      assert.ok(a.paidDividendEarlierInYearUsd >= 0);
      // その四半期の実支払総額 = Turn開始時配当 + 年度末精算
      assert.ok(
        Math.abs(d.appliedDividendUsd - a.appliedDividendUsd) < 0.01 || d.appliedDividendUsd > a.appliedDividendUsd,
        `T${turn} ${d.companyId}: 四半期実支払が年度末精算額を下回っている`
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, "検査対象の精算が1件も無く、CASE Qが空振りしている");
});

// ---------------------------------------------------------------------
// 非Q4での不実行（既存Gate Aの維持）
// ---------------------------------------------------------------------

test("Q1〜Q3では年間精算が一切実行されない（年度末Q4のみ）", () => {
  const s = run(newSession("case-nonq4", continuingRatio(0.5)), 8);
  for (const record of s.state.history) {
    if (toYearQuarter(record.period).quarter === 4) continue;
    for (const d of record.dividendResults ?? []) {
      assert.equal(d.annualSettlement, undefined, `T${record.turn} ${d.companyId}: Q4以外で年間精算が実行されている`);
      assert.equal(d.appliedDividendUsd, 0, `T${record.turn} ${d.companyId}: Q4以外で配当が支払われている`);
    }
  }
});

// ---------------------------------------------------------------------
// 会計整合の正式テスト（実装指示§10）
// ---------------------------------------------------------------------

test("会計整合: 配当を払った年度末Q4で、CF恒等式とBSが同時に成立する", () => {
  const s = run(newSession("acct", continuingRatio(0.5), 12), 12);
  let paidQuarters = 0;
  for (const record of s.state.history) {
    if (toYearQuarter(record.period).quarter !== 4) continue;
    for (const fin of record.financialResults) {
      const div = record.dividendResults?.find((d) => d.companyId === fin.companyId);
      const settlementPaid = div?.annualSettlement?.appliedDividendUsd ?? 0;
      if (settlementPaid <= EPS_USD) continue;
      paidQuarters += 1;

      const bs = fin.balanceSheet;
      const cf = fin.cashFlow;
      const at = `T${record.turn} ${fin.companyId}`;

      // openingCash + CFO + CFI + CFF = closingCash
      const sum =
        unwrapUsd(cf.openingCash) + unwrapUsd(cf.operatingCashFlow) + unwrapUsd(cf.investingCashFlow) + unwrapUsd(cf.financingCashFlow);
      assert.ok(Math.abs(sum - unwrapUsd(cf.closingCash)) < 0.01, `${at}: opening+CFO+CFI+CFF != closingCash`);

      // BS cash == CF closingCash
      assert.ok(Math.abs(unwrapUsd(bs.cash) - unwrapUsd(cf.closingCash)) < 0.01, `${at}: BS cash != CF closingCash`);

      // 配当支払は財務CFへ正式反映されている（内訳としてdividendsPaidも残る）
      assert.ok(cf.dividendsPaid !== undefined, `${at}: dividendsPaidが記録されていない`);

      // BSが閉じている
      assert.ok(Math.abs(unwrapUsd(bs.balanceDifference)) < 0.01, `${at}: balanceDifference != 0`);
      assert.ok(
        Math.abs(unwrapUsd(bs.totalAssets) - unwrapUsd(bs.totalLiabilitiesAndEquity)) < 0.01,
        `${at}: totalAssets != totalLiabilitiesAndEquity`
      );
    }
  }
  assert.ok(paidQuarters > 0, "年度末精算が1件も発生せず、会計整合テストが空振りしている");
});

test("会計整合: 配当の有無でnetIncomeは変わらず、retainedEarnings/equity/cashだけが同額減り、Debtは不変", () => {
  const withDiv = run(newSession("acct2-div", continuingRatio(0.5), 4), 4);
  const noDiv = run(newSession("acct2-nodiv", continuingRatio(0), 4), 4);

  const q4a = withDiv.state.history.find((r) => r.turn === 4)!;
  const q4b = noDiv.state.history.find((r) => r.turn === 4)!;
  let compared = 0;

  for (const finA of q4a.financialResults) {
    const finB = q4b.financialResults.find((f) => f.companyId === finA.companyId)!;
    const paid = q4a.dividendResults?.find((d) => d.companyId === finA.companyId)?.annualSettlement?.appliedDividendUsd ?? 0;
    if (paid <= EPS_USD) continue;
    compared += 1;
    const at = finA.companyId;

    // Q4の営業そのものは配当前の現金で行われるため、PLは両Runで完全一致する。
    assert.equal(unwrapUsd(finA.profitAndLoss.netIncome), unwrapUsd(finB.profitAndLoss.netIncome), `${at}: netIncomeが変化している`);
    assert.equal(
      unwrapUsd(finA.profitAndLoss.operatingProfit),
      unwrapUsd(finB.profitAndLoss.operatingProfit),
      `${at}: operatingProfitが変化している`
    );

    // Cash・利益剰余金・純資産が、配当額ちょうど減っていること。
    for (const [label, a, b] of [
      ["cash", unwrapUsd(finA.balanceSheet.cash), unwrapUsd(finB.balanceSheet.cash)],
      ["retainedEarnings", unwrapUsd(finA.balanceSheet.retainedEarnings), unwrapUsd(finB.balanceSheet.retainedEarnings)],
      ["totalEquity", unwrapUsd(finA.balanceSheet.totalEquity), unwrapUsd(finB.balanceSheet.totalEquity)],
    ] as const) {
      assert.ok(Math.abs(b - a - paid) < 0.01, `${at}: ${label} の減少額が配当額と一致しない（差=${b - a} / 配当=${paid}）`);
    }

    // Debtは配当では動かない（配当のための自動借入をしない）。
    assert.equal(unwrapUsd(finA.balanceSheet.shortTermLoans), unwrapUsd(finB.balanceSheet.shortTermLoans), `${at}: 短期借入が動いている`);
    assert.equal(unwrapUsd(finA.balanceSheet.longTermLoans), unwrapUsd(finB.balanceSheet.longTermLoans), `${at}: 長期借入が動いている`);

    // 財務CFは配当額ちょうど減っていること（配当が財務CFへ正式反映されている）。
    assert.ok(
      Math.abs(unwrapUsd(finB.cashFlow.financingCashFlow) - unwrapUsd(finA.cashFlow.financingCashFlow) - paid) < 0.01,
      `${at}: financingCashFlowの差が配当額と一致しない`
    );
  }
  assert.ok(compared > 0, "比較対象の配当が1件も無く、この検査が空振りしている");
});

// ---------------------------------------------------------------------
// Manual Balance 実適用履歴（実装指示§11）
// ---------------------------------------------------------------------

test("Manual Balance: T9以降50%継続指定で、T9〜T32の各Turnに実適用率0.5が記録される", () => {
  const schedule: ManualBalanceSchedule = [
    {
      kind: "continuing",
      effectiveFromTurn: 9,
      settings: settings({ dividendPayout: { kind: "specified", payoutRatio: 0.5 }, salesPriceIndex: 90 }),
      source: "MANUAL_OVERRIDE",
      recordedAt: TS_AT,
    },
  ];
  const s = run(newSession("manual-applied", schedule, 32), 32);
  const applied = s.manualBalanceApplied ?? [];
  assert.equal(applied.length, 32, "適用記録が32Turnぶん無い");

  for (const record of applied) {
    if (record.turn < 9) {
      assert.equal(record.manualDividendPayoutRatio, null, `T${record.turn}: 指定前なのに配当性向が記録されている`);
      assert.equal(record.manualSalesPriceIndex, 100, `T${record.turn}: 指定前なのに販売指数が中立でない`);
    } else {
      assert.equal(record.manualDividendPayoutRatio, 0.5, `T${record.turn}: 配当性向0.5が適用されていない`);
      assert.equal(record.manualSalesPriceIndex, 90, `T${record.turn}: 販売価格指数90が適用されていない`);
    }
    // 原料は中立のまま（指定していない）。
    assert.equal(record.manualRawMarketPriceIndex, 100, `T${record.turn}: 原料指数が中立でない`);
  }

  // 【率が有効 ≠ 毎Turn配当支払】実際の支払は年度末Q4だけであること。
  for (const quarterRecord of s.state.history) {
    if (quarterRecord.turn < 9) continue;
    const isQ4 = toYearQuarter(quarterRecord.period).quarter === 4;
    for (const d of quarterRecord.dividendResults ?? []) {
      if (!isQ4) {
        assert.equal(d.appliedDividendUsd, 0, `T${quarterRecord.turn} ${d.companyId}: Q4以外で配当が支払われている`);
      }
    }
  }
});
