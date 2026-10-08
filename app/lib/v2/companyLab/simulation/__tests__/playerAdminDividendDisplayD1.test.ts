// ShrimpX V2 — D1 表示契約のテスト（§8 年度中表示 / §9 年度末表示 / §10 Audit Workbook）
//
// 【何を固定するか】
//   - 年度末表示（AnnualDividendPanel）が、Q4に存在した会社の行を落とさず、
//     「なぜその額になったか」を9通りに区別すること（D1-23）
//   - Audit Workbook 14_DIVIDEND_DETAIL が、その画面行とまったく同じEngine確定値を
//     出すこと（D1-24）
//   - 年間実績が揃わない年度を0で補完せず unavailable として残すこと（D1-14）
//   - 記録の無い旧Runを0支払やCASH_LIMITへ捏造しないこと（D1-26）
//   - 年度中の参考表示が、確定実績と現在残高だけから作られること（§8）
//
// 実Runを回して確定記録から検証する（fixtureで作った偽データではなく実データ）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { buildAnnualDividendPanelRows, ANNUAL_DIVIDEND_ROW_STATUS_LABELS } from "../annualDividendPanelRows";
import { buildAnnualDividendGuidanceView } from "../../annualDividendGuidanceView";
import { buildAnnualDividendGuidance } from "../../../finance/annualDividendGuidance";
import { computeMaxDividendUsd } from "../../../finance/dividend";
import { buildDatasetFromSession } from "../analytics/dataset";
import { buildResumePayload } from "../persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../persistence/types";
import { buildStandardAiAuditWorkbookData } from "../auditWorkbook/index";
import { period, toYearQuarter } from "../../../core/period";
import { unwrapUsd } from "../../../finance/types";
import type { SimulationSession } from "../types";
import type { CompanyDecisionInput } from "../../types";
import type { ManualBalanceSchedule } from "../../manualBalance/overrides";

const TS_AT = "2026-09-23T00:00:00.000Z";
const PLAYER = "BAL";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const EPS_USD = 0.01;

function adminRatio(payoutRatio: number): ManualBalanceSchedule {
  return [
    {
      kind: "continuing",
      effectiveFromTurn: 1,
      settings: { dividendPayout: { kind: "specified", payoutRatio }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined },
      source: "MANUAL_OVERRIDE",
      recordedAt: TS_AT,
    },
  ];
}

function newSession(runId: string, schedule: ManualBalanceSchedule | undefined, players: readonly string[], turns = 8): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, players.includes(c) ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: "dynamic-scenario-2",
    seed: "d1-admin-dividend",
    requestedTurns: turns,
    startedAt: TS_AT,
    sourceCommit: "D1-TEST",
    companyControlModes: modes,
    ...(schedule ? { manualBalanceOverrides: schedule } : {}),
  });
}

function playerDecisionFor(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const ai = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    buildPublicMarketInfo(session.state),
    session.state.currentPeriod,
    session.state.scenarioState.currentTurn
  ).decision;
  return buildDecisionInputFromDraft(buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories), fixture, session.state.currentPeriod);
}

function runWithPlayer(session: SimulationSession, turns: number): SimulationSession {
  let s = session;
  for (let i = 0; i < turns; i++) {
    const outcome = advanceSimulationTurn(s, TS_AT, { [PLAYER]: playerDecisionFor(s, PLAYER) }, "D1-TEST");
    assert.ok(outcome.advanced, `turn ${s.state.scenarioState.currentTurn} で停止した`);
    s = outcome.session;
  }
  return s;
}

function storedOf(session: SimulationSession): StoredSimulationRun {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload: buildResumePayload(session, session.run.companyControlModes ?? {}, {}),
    savedAt: TS_AT,
  };
}

// ---------------------------------------------------------------------
// §9 / D1-23: 年度末表示が行を落とさず、状態を区別する
// ---------------------------------------------------------------------

test("D1-23a: 管理者50%指定のRunでは、Q4に存在した全社の行が出て、精算recordと一致する", () => {
  const s = runWithPlayer(newSession("d1-23a", adminRatio(0.5), [PLAYER]), 8);
  const rows = buildAnnualDividendPanelRows(s);

  // Q4は2回（T4・T8）あり、会社は5社。行を落としていないこと。
  assert.equal(rows.length, 2 * COMPANIES.length, `Q4の行数が会社数×年度数と一致しない（実測 ${rows.length}）`);

  for (const row of rows) {
    // 表示値はEngine確定recordそのもの（画面側で再計算していない）。
    const record = s.state.history.find((r) => r.turn === row.turn)!;
    const engine = record.dividendResults?.find((d) => d.companyId === row.companyId)?.annualSettlement;
    assert.deepEqual(
      JSON.parse(JSON.stringify(row.settlement ?? null)),
      JSON.parse(JSON.stringify(engine ?? null)),
      `T${row.turn} ${row.companyId}: 表示行がEngine確定recordと一致しない`
    );
    assert.equal(row.adminPayoutRatio, 0.5, `T${row.turn} ${row.companyId}: 管理者指定列が実際の適用記録と違う`);
    assert.ok(ANNUAL_DIVIDEND_ROW_STATUS_LABELS[row.status], "状態ラベルが無い");
  }
  // PLAYER会社の操作主体が正しく出る（AIと混同しない）。
  for (const row of rows.filter((r) => r.companyId === PLAYER)) {
    assert.equal(row.decisionOwner, "PLAYER", `T${row.turn}: PLAYER会社の操作主体がPLAYERになっていない`);
  }
});

test("D1-23b: 管理者0%明示は「管理者が0%と明示指定」、管理者未指定・AI見送りは「管理者設定なし」と区別される", () => {
  const zero = runWithPlayer(newSession("d1-23b-0", adminRatio(0), [PLAYER]), 8);
  for (const row of buildAnnualDividendPanelRows(zero)) {
    assert.equal(row.status, "ADMIN_ZERO_PERCENT", `T${row.turn} ${row.companyId}: 明示0%が別の状態になっている`);
    assert.equal(row.adminPayoutRatio, 0, "管理者指定列が0になっていない");
    assert.ok(row.settlement, "明示0%なのに精算recordが無い");
    assert.equal(row.settlement.appliedDividendUsd, 0);
  }

  const none = runWithPlayer(newSession("d1-23b-n", undefined, [PLAYER]), 8);
  const noneRows = buildAnnualDividendPanelRows(none);
  assert.equal(noneRows.length, 2 * COMPANIES.length, "管理者未指定でも行は落とさない");
  const playerRows = noneRows.filter((r) => r.companyId === PLAYER);
  for (const row of playerRows) {
    assert.equal(row.adminPayoutRatio, null, "管理者指定なしはnull（undefinedでも0でもない）");
    assert.equal(row.status, "NO_ADMIN_SETTING_PLAYER", `T${row.turn}: PLAYER会社の未指定状態が区別されていない`);
    assert.equal(row.settlement, undefined, "未指定なのに精算recordがある");
  }
  const skipped = noneRows.filter((r) => r.companyId !== PLAYER && r.settlement === undefined);
  assert.ok(skipped.length > 0, "AIが見送った会社が無く、この検査が空振りしている");
  for (const row of skipped) {
    assert.equal(row.status, "NO_ADMIN_SETTING_AI_SKIPPED", `T${row.turn} ${row.companyId}: AI見送りが区別されていない`);
  }
});

test("D1-23c: 資金制約による部分支払と、年間赤字による目標0が別の状態になる", () => {
  const s = runWithPlayer(newSession("d1-23c", adminRatio(1), [PLAYER], 12), 12);
  const rows = buildAnnualDividendPanelRows(s);
  const statuses = new Set(rows.map((r) => r.status));
  assert.ok(
    statuses.has("SHORTFALL_CASH_LIMIT") || statuses.has("SHORTFALL_DISTRIBUTABLE_EARNINGS_LIMIT"),
    `資金制約の行が1件も出ていない（出た状態: ${[...statuses].join(",")}）`
  );
  assert.ok(statuses.has("NO_ANNUAL_PROFIT"), `年間赤字の行が1件も出ていない（出た状態: ${[...statuses].join(",")}）`);

  for (const row of rows) {
    if (row.status === "NO_ANNUAL_PROFIT") {
      assert.ok(row.settlement!.annualNetIncomeUsd <= 0, "年間赤字状態なのに年間純利益が正");
      assert.equal(row.settlement!.annualDividendTargetUsd, 0, "年間赤字なのに目標が0でない");
    }
    if (row.status === "SHORTFALL_CASH_LIMIT") assert.equal(row.settlement!.shortfallReason, "CASH_LIMIT");
    if (row.status === "SHORTFALL_DISTRIBUTABLE_EARNINGS_LIMIT") assert.equal(row.settlement!.shortfallReason, "DISTRIBUTABLE_EARNINGS_LIMIT");
  }
});

// ---------------------------------------------------------------------
// D1-26 / D1-14: 記録が無いものを捏造しない
// ---------------------------------------------------------------------

test("D1-26: 手動バランスの適用記録が無い旧Runの行は、0支払でもCASH_LIMITでもなくUNKNOWNになる", () => {
  const s = runWithPlayer(newSession("d1-26", undefined, [PLAYER]), 8);
  // この機能より前のRun＝manualBalanceApplied自体が存在しない保存形式を再現する。
  const legacy: SimulationSession = { ...s, manualBalanceApplied: undefined };
  const rows = buildAnnualDividendPanelRows(legacy);
  assert.equal(rows.length, 2 * COMPANIES.length, "旧Runでも行を落とさない");
  for (const row of rows.filter((r) => r.settlement === undefined)) {
    assert.equal(row.status, "UNKNOWN_NO_RECORD", `T${row.turn} ${row.companyId}: 記録なしがUNKNOWNになっていない`);
    assert.equal(row.adminPayoutRatio, undefined, "記録が無いのに管理者指定値が埋まっている");
    assert.equal(row.settlement, undefined, "記録が無いのに精算recordが埋まっている");
  }
  // 「0支払」「CASH_LIMIT」へ寄せていないこと。
  const fabricated = rows.filter((r) => r.settlement === undefined && (r.status === "PAID_IN_FULL" || r.status === "SHORTFALL_CASH_LIMIT"));
  assert.equal(fabricated.length, 0, "記録の無い行が支払実績として描かれている");
});

test("D1-14: 対象年度のQ1〜Q4が揃わない年度は、0補完せずunavailableとして残る", () => {
  // Q4だけを切り出した履歴（Q1〜Q3が無い）を作り、精算判定の入力として与える。
  const s = runWithPlayer(newSession("d1-14", adminRatio(0.5), [PLAYER]), 8);
  const q4Only = s.state.history.filter((r) => toYearQuarter(r.period).quarter === 4);
  assert.ok(q4Only.length >= 1, "Q4の履歴が無い");

  // 実Runでは4四半期揃っているので、揃っている側が available であることを先に確認する。
  const settled = q4Only[q4Only.length - 1].dividendResults?.find((d) => d.companyId === PLAYER)?.annualSettlement;
  assert.ok(settled, "揃っている年度で精算されていない（前提が崩れている）");

  // 揃っていない年度の扱いは finance/annualDividend.ts の契約（INCOMPLETE_FISCAL_YEAR）で
  // 既に固定されている。ここでは表示側が「0支払」へ落とさないことを見る。
  const truncated: SimulationSession = {
    ...s,
    state: {
      ...s.state,
      history: s.state.history.map((r) =>
        toYearQuarter(r.period).quarter === 4
          ? {
              ...r,
              dividendResults: (r.dividendResults ?? []).map((d) => ({
                ...d,
                annualSettlement: undefined,
                annualSettlementUnavailableReason: "INCOMPLETE_FISCAL_YEAR",
              })),
            }
          : r
      ),
    },
  };
  const rows = buildAnnualDividendPanelRows(truncated);
  assert.ok(rows.length > 0, "行が無い");
  for (const row of rows) {
    assert.equal(row.status, "INCOMPLETE_FISCAL_YEAR", `T${row.turn} ${row.companyId}: 資料不足が別の状態になっている`);
    assert.equal(row.settlement, undefined, "資料不足なのに精算recordが埋まっている");
  }
});

// ---------------------------------------------------------------------
// §10 / D1-24: Audit Workbook = 画面 = Engine確定値
// ---------------------------------------------------------------------

test("D1-24: 管理者指定PLAYERの14_DIVIDEND_DETAILが、画面行とEngine確定値に一致する", () => {
  const s = runWithPlayer(newSession("d1-24", adminRatio(0.5), [PLAYER]), 8);
  const workbook = buildStandardAiAuditWorkbookData({ stored: storedOf(s), generatedAt: TS_AT, liveHistory: s.state.history });
  const rows = buildAnnualDividendPanelRows(s);

  let checked = 0;
  for (const row of rows.filter((r) => r.companyId === PLAYER)) {
    const detail = workbook.dividend.find((d) => d.companyId === PLAYER && d.turn === row.turn);
    assert.ok(detail, `T${row.turn}: 14_DIVIDEND_DETAILに行が無い`);
    const s9 = row.settlement;
    assert.ok(s9, `T${row.turn}: 画面行に精算recordが無い`);
    checked += 1;
    assert.equal(detail.appliedPayoutRatio, s9.appliedPayoutRatio, "appliedPayoutRatioが一致しない");
    assert.equal(detail.payoutRatioSource, s9.payoutRatioSource, "payoutRatioSourceが一致しない");
    assert.equal(detail.payoutRatioSource, "MANUAL_OVERRIDE", "管理者指定PLAYERの設定元がMANUAL_OVERRIDEになっていない");
    assert.equal(detail.annualNetIncomeUsd, s9.annualNetIncomeUsd, "annualNetIncomeUsdが一致しない");
    assert.equal(detail.annualDividendTargetUsd, s9.annualDividendTargetUsd, "annualDividendTargetUsdが一致しない");
    assert.equal(detail.paidDividendEarlierInYearUsd, s9.paidDividendEarlierInYearUsd, "paidDividendEarlierInYearUsdが一致しない");
    assert.equal(detail.yearEndAdditionalTargetUsd, s9.yearEndAdditionalTargetUsd, "yearEndAdditionalTargetUsdが一致しない");
    assert.equal(detail.annualSettlementAppliedDividendUsd, s9.appliedDividendUsd, "annualSettlementAppliedDividendUsdが一致しない");
    assert.equal(detail.annualDividendShortfallUsd, s9.annualDividendShortfallUsd, "annualDividendShortfallUsdが一致しない");
    assert.equal(detail.shortfallReason, s9.shortfallReason ?? "", "shortfallReasonが一致しない");
    // 現在parameterからの逆算値を実効率として使っていないこと。
    assert.notEqual(detail.referencePayoutRatioFromCurrentParams, detail.appliedPayoutRatio, "実効率が現在parameterからの逆算値と同じになっている");
  }
  assert.ok(checked >= 2, `検証した年度が少なすぎる（${checked}件）`);

  // Q1〜Q3の行は年度末精算の列が空（推測で埋めない）。
  for (const detail of workbook.dividend.filter((d) => d.companyId === PLAYER && d.isAnnualEvaluationPeriod === "FALSE")) {
    assert.equal(detail.dividendTargetYear, null, `T${detail.turn}: Q4以外に精算年度が入っている`);
    assert.equal(detail.annualNetIncomeUsd, null, `T${detail.turn}: Q4以外に年間純利益が入っている`);
    assert.equal(detail.payoutRatioSource, "", `T${detail.turn}: Q4以外に設定元が入っている`);
  }
});

// ---------------------------------------------------------------------
// §8: 年度中の参考表示
// ---------------------------------------------------------------------

test("§8-1: 管理者指定があるとき、年初来の確定実績と現在残高だけで参考額が出る", () => {
  // 2016Q3（T7）まで進め、T8（2016Q4）を意思決定する直前の画面を作る。
  const s = runWithPlayer(newSession("d1-g1", adminRatio(0.5), [PLAYER]), 7);
  const fixture = s.fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(s.state, fixture);
  const guidance = buildAnnualDividendGuidanceView({
    history: s.state.history,
    currentPeriod: s.state.currentPeriod,
    turn: s.state.scenarioState.currentTurn,
    companyId: PLAYER,
    manualBalanceOverrides: s.state.config.manualBalanceOverrides,
    currentCashUsd: ownState.financeState.cash as number,
    dividendCapacityUsd: computeMaxDividendUsd(ownState.financeState),
  });

  assert.equal(guidance.kind, "ADMIN_SPECIFIED");
  if (guidance.kind !== "ADMIN_SPECIFIED") return;
  const f = guidance.figures;
  assert.equal(f.adminPayoutRatio, 0.5);
  assert.equal(f.currentQuarter, 4, "T8は2016Q4のはず");
  assert.equal(f.targetYear, 2016);
  // 年初来＝この年度の確定済み四半期だけ（Q4はまだ確定していないので3四半期）。
  assert.equal(f.confirmedQuarterCount, 3, "確定していないQ4を数えている");
  const expectedYtd = s.state.history
    .filter((r) => toYearQuarter(r.period).year === 2016)
    .reduce((sum, r) => sum + unwrapUsd(r.financialResults.find((x) => x.companyId === PLAYER)!.profitAndLoss.netIncome), 0);
  assert.ok(Math.abs(f.ytdNetIncomeUsd - expectedYtd) < EPS_USD, "年初来確定純利益が確定履歴の合計と一致しない");
  assert.ok(Math.abs(f.ytdReferenceDividendUsd - Math.max(0, expectedYtd) * 0.5) < EPS_USD, "参考配当額が max(0, 年初来) × 率 になっていない");
  // 現在残高ベースの参考値。
  assert.ok(f.referencePayableUsd <= computeMaxDividendUsd(ownState.financeState) + EPS_USD, "参考支払可能額が配当可能額を超えている");
  assert.ok(
    Math.abs(f.referenceCashAfterUsd - ((ownState.financeState.cash as number) - f.referencePayableUsd)) < EPS_USD,
    "参考配当後Cashが 現在現金 − 参考支払可能額 になっていない"
  );

  // 【予測していないこと】この参考値はQ4決算後の確定額とは別物でよいが、
  // 年初来実績（3四半期）だけで作られているため、4四半期ぶんの確定目標とは一致しない。
  const settled = runWithPlayer(s, 1).state.history.find((r) => r.turn === 8)!.dividendResults!.find((d) => d.companyId === PLAYER)!.annualSettlement!;
  assert.notEqual(f.ytdReferenceDividendUsd, settled.annualDividendTargetUsd, "参考額がQ4確定額と同一で、将来利益を先取りしている疑いがある");
});

test("§8-2: 管理者未指定なら「管理者指定なし」になり、AIの既定率を出さない", () => {
  const s = runWithPlayer(newSession("d1-g2", undefined, [PLAYER]), 5);
  const fixture = s.fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(s.state, fixture);
  const guidance = buildAnnualDividendGuidanceView({
    history: s.state.history,
    currentPeriod: s.state.currentPeriod,
    turn: s.state.scenarioState.currentTurn,
    companyId: PLAYER,
    manualBalanceOverrides: s.state.config.manualBalanceOverrides,
    currentCashUsd: ownState.financeState.cash as number,
    dividendCapacityUsd: computeMaxDividendUsd(ownState.financeState),
  });
  assert.equal(guidance.kind, "NO_ADMIN_SETTING", "管理者未指定なのに率が表示されている");
});

test("§8-3: 設定を読めない場合はUNKNOWNで、0%や100%を埋めない", () => {
  const guidance = buildAnnualDividendGuidance({
    period: period(2016, 2),
    adminPayoutRatio: undefined,
    confirmedQuarters: [],
    currentCashUsd: 1_000_000,
    dividendCapacityUsd: 500_000,
  });
  assert.equal(guidance.kind, "UNKNOWN");
});

test("§8-4: 年度途中の実支払があると、参考の追加必要額から差し引かれる", () => {
  const guidance = buildAnnualDividendGuidance({
    period: period(2017, 3),
    adminPayoutRatio: 0.5,
    confirmedQuarters: [
      { quarter: 1, netIncomeUsd: 10_000_000, appliedDividendUsd: 0 },
      { quarter: 2, netIncomeUsd: -2_000_000, appliedDividendUsd: 1_000_000 },
    ],
    currentCashUsd: 20_000_000,
    dividendCapacityUsd: 20_000_000,
  });
  assert.equal(guidance.kind, "ADMIN_SPECIFIED");
  if (guidance.kind !== "ADMIN_SPECIFIED") return;
  // 年初来純利益 = 10,000,000 + (-2,000,000) = 8,000,000（赤字四半期も符号付きで合算）
  assert.equal(guidance.figures.ytdNetIncomeUsd, 8_000_000);
  assert.equal(guidance.figures.ytdReferenceDividendUsd, 4_000_000);
  assert.equal(guidance.figures.ytdPaidDividendUsd, 1_000_000);
  assert.equal(guidance.figures.referenceAdditionalUsd, 3_000_000);
  assert.equal(guidance.figures.referencePayableUsd, 3_000_000);
  assert.equal(guidance.figures.referenceCashAfterUsd, 17_000_000);
});

test("§8-5: 年間赤字でも参考額はマイナスにならず0になる", () => {
  const guidance = buildAnnualDividendGuidance({
    period: period(2015, 4),
    adminPayoutRatio: 0.5,
    confirmedQuarters: [
      { quarter: 1, netIncomeUsd: -5_000_000, appliedDividendUsd: 0 },
      { quarter: 2, netIncomeUsd: -1_000_000, appliedDividendUsd: 0 },
    ],
    currentCashUsd: 9_000_000,
    dividendCapacityUsd: 9_000_000,
  });
  assert.equal(guidance.kind, "ADMIN_SPECIFIED");
  if (guidance.kind !== "ADMIN_SPECIFIED") return;
  assert.equal(guidance.figures.ytdNetIncomeUsd, -6_000_000);
  assert.equal(guidance.figures.ytdReferenceDividendUsd, 0);
  assert.equal(guidance.figures.referencePayableUsd, 0);
  assert.equal(guidance.figures.referenceCashAfterUsd, 9_000_000);
});
