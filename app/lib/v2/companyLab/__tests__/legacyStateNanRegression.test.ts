// ShrimpX V2 — INT-NA: 「Turn 8でUsd金額が有限の数値ではありません: NaN」回帰テスト
//
// 【再現した不具合】DIV-1より前に保存されたSimulation Runのstateには
// financeState.companies[].distributableEarnings が存在しない。resume経路
// （restoreSessionFromResumePayload）は保存payloadのstateをそのまま返しており、
// companyLab/persistence/schema.ts が行っている「旧フィールドの既定値補完」を
// 通らないため、undefinedのままエンジンへ渡っていた。
//
// その状態でDIV-4がQ4（Turn 8）に初めて配当判定へ入ると、
//   computeMaxDividendUsd = max(0, min(cash, undefined)) = NaN
// となる。JavaScriptでは NaN <= EPS も undefined <= EPS も常にfalseなので、
// 「配れる原資が無ければ配らない」ためのGate F/Gが素通りし、NaNの配当額が
// usd()へ渡ってFinanceValidationErrorでRun全体が停止していた。
//
// 修正は2層。
//   (1) resume時にstate semanticsを正す（DIV-1の規約どおり未定義は0）
//   (2) 配当判定・配当解決の両方で「有限でない値は0扱いにせず、明示的に見送る／弾く」
// 本テストは(1)(2)の両方が生きていることを、旧stateの再現から確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../simulation/engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../simulation/persistence/resume";
import { buildStandardAiDividendDecision } from "../standardAi/decision/dividend";
import { STANDARD_AI_PARAMETERS_V1 } from "../standardAi/parameters";
import { CompanyFinanceState, usd } from "../../finance/types";
import { DividendValidationError, resolveDividendDecision } from "../../finance/dividend";
import { period } from "../../core/period";

const AT = "2026-01-01T00:00:00.000Z";

function legacyFinanceState(): CompanyFinanceState {
  const base: CompanyFinanceState = {
    companyId: "TEST",
    cash: usd(42_025_019),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(0),
    longTermLoans: usd(0),
    otherLiabilities: usd(0),
    capitalStock: usd(30_000_000),
    retainedEarnings: usd(500_000_000),
    distributableEarnings: usd(0),
    finishedGoodsCostLedger: [],
  };
  // DIV-1導入前の保存stateを再現する（フィールドそのものが存在しない）。
  const legacy = { ...base } as Record<string, unknown>;
  delete legacy.distributableEarnings;
  return legacy as unknown as CompanyFinanceState;
}

/**
 * INT-NA-1: baseline / management-console-32q を旧保存state（distributableEarnings欠落）
 * から復元してTurn 8（Q4・DIV-4が初めて配当判定へ入るTurn）を越えられること。
 * Turn 9まで進めて、Turn 8だけが通る一時しのぎでないことも確認する。
 */
test("INT-NA-1: 旧保存stateから復元してもTurn 8/9でNaN停止しない", () => {
  let session = createSimulationSession({
    simulationRunId: "run-baseline-management-console-32q-init",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  for (let i = 0; i < 7; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced, `Turn ${i + 1} で停止した: ${outcome.error}`);
    session = outcome.session;
  }

  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as {
    state: { financeState: { companies: Record<string, unknown>[] } };
  };
  for (const company of payload.state.financeState.companies) delete company.distributableEarnings;

  session = restoreSessionFromResumePayload(session.run, payload as never);
  // resume時点でDIV-1の規約どおり0へ補完されている（NaNのまま持ち回らない）。
  for (const company of session.state.financeState.companies) {
    assert.equal(Number.isFinite(company.distributableEarnings as unknown as number), true);
  }

  for (const expectedTurn of [8, 9]) {
    assert.equal(session.state.scenarioState.currentTurn, expectedTurn);
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced, `Turn ${expectedTurn} で停止した: ${outcome.error}`);
    session = outcome.session;
  }
});

/**
 * INT-NA-2: Q4であっても、配当判定の入力（distributableEarnings等）が有限でなければ
 * 配当は「見送り」になり、NaNの配当額を生成しない。0とみなして配当を続行もしない。
 */
test("INT-NA-2: Q4でも財務入力が有限でなければ配当skip（NaNを生成しない）", () => {
  const result = buildStandardAiDividendDecision({
    companyId: "TEST",
    period: period(2020, 4),
    financeState: legacyFinanceState(),
    currentQuarterNetIncomeUsd: 11_569_241,
    netIncomeSourcePeriod: period(2020, 3),
    lastQuarterFinancialHealthTier: "healthy",
    crisisState: "NORMAL",
    newCapexProposalCount: 0,
    params: STANDARD_AI_PARAMETERS_V1,
  });

  assert.equal(result.dividendDecision, undefined, "壊れた入力で配当を提案してはいけない");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["DIVIDEND_SKIPPED_INVALID_FINANCIAL_INPUT"]
  );
  assert.equal(result.baseDividendUsd, 0);
});

/**
 * INT-NA-2b: 確定済み四半期損益が無い（null）場合は、従来どおり
 * DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS で見送る。INT-NA-2の新Gateが
 * 「Net Income未確定」という正常系まで奪っていないことの確認。
 */
test("INT-NA-2b: Net Income未確定(null)はNaN扱いではなく従来どおりの見送り", () => {
  const result = buildStandardAiDividendDecision({
    companyId: "TEST",
    period: period(2020, 4),
    financeState: { ...legacyFinanceState(), distributableEarnings: usd(200_000_000) },
    currentQuarterNetIncomeUsd: null,
    netIncomeSourcePeriod: null,
    lastQuarterFinancialHealthTier: "healthy",
    crisisState: "NORMAL",
    newCapexProposalCount: 0,
    params: STANDARD_AI_PARAMETERS_V1,
  });
  assert.equal(result.dividendDecision, undefined);
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS"]
  );
});

/**
 * INT-NA-3: Net Incomeが有限の正値で、stateも健全なら、DIV-4の仕様どおり
 * 有限の配当額（当期純利益×payoutRatio）が算出される。
 * また、有限でない配当要求は「0扱い」ではなく構造的な誤用として弾かれる。
 */
test("INT-NA-3: 正常な入力では有限の配当額。有限でない要求額・上限は明示的に弾く", () => {
  const healthy: CompanyFinanceState = { ...legacyFinanceState(), distributableEarnings: usd(200_000_000) };
  const result = buildStandardAiDividendDecision({
    companyId: "TEST",
    period: period(2020, 4),
    financeState: healthy,
    currentQuarterNetIncomeUsd: 20_000_000,
    netIncomeSourcePeriod: period(2020, 3),
    lastQuarterFinancialHealthTier: "healthy",
    crisisState: "NORMAL",
    newCapexProposalCount: 0,
    params: { ...STANDARD_AI_PARAMETERS_V1, dividendBasePayoutRatio: 0.15 },
  });
  const applied = result.dividendDecision?.dividendAmountUsd;
  assert.equal(Number.isFinite(applied), true);
  assert.equal(applied, 20_000_000 * 0.15);

  // 有限でない要求額を黙って0にせず、原因の分かる例外で止める。
  assert.throws(() => resolveDividendDecision({ dividendAmountUsd: Number.NaN }, healthy), DividendValidationError);
  // 上限側（state）が壊れている場合も同様に、配ってしまう前に弾く。
  assert.throws(() => resolveDividendDecision({ dividendAmountUsd: 1_000_000 }, legacyFinanceState()), DividendValidationError);
});

/**
 * INT-NA-4: 旧保存stateから復元して32Turn完走したとき、履歴と財務stateに含まれる
 * すべての数値が有限であること（NaNがどこにも残らない）。
 */
test("INT-NA-4: 旧保存stateから32Turn完走し、全数値が有限", () => {
  let session = createSimulationSession({
    simulationRunId: "run-baseline-management-console-32q-init",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  for (let i = 0; i < 7; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as {
    state: { financeState: { companies: Record<string, unknown>[] } };
  };
  for (const company of payload.state.financeState.companies) delete company.distributableEarnings;
  session = restoreSessionFromResumePayload(session.run, payload as never);

  while (session.state.scenarioState.currentTurn <= 32) {
    const turn = session.state.scenarioState.currentTurn;
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      assert.equal(outcome.error, null, `Turn ${turn} でエラー停止した: ${outcome.error}`);
      break;
    }
    session = outcome.session;
  }
  assert.equal(session.state.scenarioState.currentTurn, 32, "32Turn完走していない");

  let nonFinite = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) nonFinite++;
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) walk(child);
    }
  };
  walk(session.state.history);
  walk(session.state.financeState);
  assert.equal(nonFinite, 0, "履歴・財務stateに有限でない数値が残っている");
});
