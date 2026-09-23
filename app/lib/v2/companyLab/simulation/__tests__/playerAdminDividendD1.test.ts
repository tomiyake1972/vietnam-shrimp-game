// ShrimpX V2 — D1: 管理者指定配当をPLAYER含む全社へ共通強制精算する
//
// 【確定仕様】管理者がManagement Consoleのバランス調整で明示指定した配当性向は、
// STANDARD_AI / PLAYER の操作主体に関係なく同じ会社・同じ年度へ適用し、
// Q4決算直後に年間純利益ベースで自動精算する。Playerの追加操作は要らない。
//
// 【修正前の症状（実測で再現済み）】年度末精算は
// companyDecision.annualDividendSettlement が存在するときだけ走るが、この意思を
// 出していたのは Standard AI だけだった。PLAYERの提出値を組み立てる
// buildDecisionInputFromDraft は dividendDecision（金額指定）しか出さないため、
// PLAYER会社は利益があっても精算のコードパスに入らず、精算テーブルに行すら
// 出なかった（基準commit 728b3416 で BAL=PLAYER・管理者50%指定・年間NI 25.94M
// でも 実支払 0.00M・record無し を確認）。
//
// 【このテストが固定する契約】D1-01〜D1-26。
// 実Runを回して確定記録から検証する（設定値ではなく実績で確認する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import type { SimulationSession } from "../types";
import type { CompanyDecisionInput } from "../../types";
import { toYearQuarter } from "../../../core/period";
import { unwrapUsd } from "../../../finance/types";
import type { ManualBalanceSchedule } from "../../manualBalance/overrides";

const TS_AT = "2026-09-23T00:00:00.000Z";
const SCENARIO = "dynamic-scenario-2";
const SEED = "d1-admin-dividend";
const PLAYER = "BAL";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const EPS_USD = 0.01;

/** 管理者のバランス調整で、effectiveFromTurn 以降ずっと配当性向を指定する。 */
function adminRatio(payoutRatio: number, effectiveFromTurn = 1): ManualBalanceSchedule {
  return [
    {
      kind: "continuing",
      effectiveFromTurn,
      settings: { dividendPayout: { kind: "specified", payoutRatio }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined },
      source: "MANUAL_OVERRIDE",
      recordedAt: TS_AT,
    },
  ];
}

function newSession(runId: string, schedule: ManualBalanceSchedule | undefined, playerCompanies: readonly string[], turns = 8): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, playerCompanies.includes(c) ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: turns,
    startedAt: TS_AT,
    sourceCommit: "D1-TEST",
    companyControlModes: modes,
    ...(schedule ? { manualBalanceOverrides: schedule } : {}),
  });
}

/**
 * 既に確定したRunの同じTurnで実際に使われた意思決定を取り出し、PLAYERの提出物として再生する。
 *
 * 【なぜ意思決定を作り直さないか（実測）】
 * (1) 既定ドラフト経由（buildInitialDraft → buildDecisionInputFromDraft）はAIの判断と
 *     完全同一にはならない。実測した差分は salesPlans の並び順（集合としては一致）と、
 *     workerAssignments.regularHeadcount がドラフトでは「現員」になる点（T2: AI 4943 /
 *     draft 6000、T3: AI 4415 / draft 4943）。後者は生産量を変えるため年間純利益が動く
 *     （BAL T2で -845,600 USD）。これはfactory worker配置の既存挙動で、D1の変更禁止
 *     リストに該当するため触らない。
 * (2) テスト側でStandard AIを直接呼び直す方法も不可。engine.tsは会社別params・
 *     visionOverrides・costProjection・配当性向の出所まで渡して呼んでおり、
 *     素の呼び出しでは同じ判断にならない（BAL T4の純利益が -1,496,972 と -1,482,999 で
 *     約14,000 USD ずれることを実測）。
 * そこで「engineが実際に使った意思決定」をそのまま再生する。これなら財務履歴が
 * 完全に同一になり、違いは操作主体だけになる。
 *
 * ただし annualDividendSettlement（＝年度末に精算する意思）は取り除く。実際のPLAYER提出経路
 * （buildDecisionInputFromDraft）はこのfieldを出さないため、それを再現するためである。
 * つまり「PLAYERの提出物には精算意思が無い」状態で、管理者指定だけを頼りに
 * AIと同じ精算結果へ到達することを見る。
 */
function replayAsPlayerDecision(source: SimulationSession, turn: number, companyId: string): CompanyDecisionInput {
  const record = source.state.history.find((r) => r.turn === turn);
  assert.ok(record, `再生元のturn ${turn} が確定履歴に無い`);
  const used = record.decisions.find((d) => d.companyId === companyId);
  assert.ok(used, `再生元のturn ${turn} に会社 ${companyId} の意思決定が無い`);
  const withoutIntent = { ...used };
  delete (withoutIntent as { annualDividendSettlement?: unknown }).annualDividendSettlement;
  return withoutIntent;
}

/**
 * PLAYER会社の提出値を作る。
 * 【重要】既定ドラフト（＝Standard AIの当期判断のコピー）をそのまま提出する。
 * つまりプレイヤーは配当欄を一切触らない。それでも管理者指定が効くことを見る。
 */
function playerDecisionFor(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const ai = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    publicInfo,
    session.state.currentPeriod,
    session.state.scenarioState.currentTurn
  ).decision;
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
}

/** playerCompanies を PLAYER として turns ターン進める。 */
function runWithPlayers(
  session: SimulationSession,
  playerCompanies: readonly string[],
  turns: number,
  perTurnPlayerDecision?: (s: SimulationSession, companyId: string, turn: number) => CompanyDecisionInput
): SimulationSession {
  let s = session;
  for (let i = 0; i < turns; i++) {
    const turn = s.state.scenarioState.currentTurn;
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const c of playerCompanies) {
      decisions[c] = perTurnPlayerDecision ? perTurnPlayerDecision(s, c, turn) : playerDecisionFor(s, c);
    }
    const outcome = advanceSimulationTurn(s, TS_AT, playerCompanies.length > 0 ? decisions : undefined, "D1-TEST");
    assert.ok(outcome.advanced, `turn ${turn} で停止した: ${String(outcome.error)}`);
    s = outcome.session;
  }
  return s;
}

function q4Record(s: SimulationSession, turn: number) {
  const record = s.state.history.find((r) => r.turn === turn);
  assert.ok(record, `turn ${turn} の確定履歴が無い`);
  assert.equal(toYearQuarter(record.period).quarter, 4, `turn ${turn} はQ4ではない`);
  return record;
}

function settlementOf(s: SimulationSession, turn: number, companyId: string) {
  return q4Record(s, turn).dividendResults?.find((d) => d.companyId === companyId)?.annualSettlement;
}

function annualNetIncome(s: SimulationSession, year: number, companyId: string): number {
  return s.state.history
    .filter((r) => toYearQuarter(r.period).year === year)
    .reduce((sum, r) => sum + unwrapUsd(r.financialResults.find((f) => f.companyId === companyId)!.profitAndLoss.netIncome), 0);
}

// ---------------------------------------------------------------------
// D1-01 / D1-02: PLAYERもSTANDARD_AIも同じ結果になる
// ---------------------------------------------------------------------

test("D1-01: 同じ財務履歴・同じ管理者50%なら、PLAYERとSTANDARD_AIのQ4年間精算結果が一致する", () => {
  // 全社AIのRunと、BALだけPLAYERにしたRunを比べる。PLAYERはAIと同一の意思決定を提出し、
  // ただし提出物からは精算意思（annualDividendSettlement）を取り除く（実PLAYER経路の再現）。
  // したがって「操作主体」だけが違う2本になる。両者の年間精算結果は一致しなければならない。
  const asAi = advanceSimulationTurns({ session: newSession("d1-01", adminRatio(0.5), []), turns: 8, timestamp: TS_AT, sourceCommit: "D1-TEST" });
  const asPlayer = runWithPlayers(newSession("d1-01", adminRatio(0.5), [PLAYER]), [PLAYER], 8, (_s, c, turn) => replayAsPlayerDecision(asAi, turn, c));

  // まず前提（同じ財務履歴）が実際に成立していることを確認する。ここが崩れていると
  // 以降の一致検査は意味を持たない。
  for (const turn of [4, 8]) {
    for (const c of COMPANIES) {
      const p = q4Record(asPlayer, turn).financialResults.find((f) => f.companyId === c)!;
      const a = q4Record(asAi, turn).financialResults.find((f) => f.companyId === c)!;
      assert.equal(
        unwrapUsd(p.profitAndLoss.netIncome),
        unwrapUsd(a.profitAndLoss.netIncome),
        `T${turn} ${c}: 前提が崩れている（操作主体以外の条件が一致していない）`
      );
    }
  }

  for (const turn of [4, 8]) {
    for (const c of COMPANIES) {
      const p = settlementOf(asPlayer, turn, c);
      const a = settlementOf(asAi, turn, c);
      assert.ok(p, `T${turn} ${c}: PLAYER側に精算recordが無い`);
      assert.ok(a, `T${turn} ${c}: STANDARD_AI側に精算recordが無い`);
      assert.deepEqual(JSON.parse(JSON.stringify(p)), JSON.parse(JSON.stringify(a)), `T${turn} ${c}: 年間精算結果が操作主体で変わっている`);
      assert.equal(p.payoutRatioSource, "MANUAL_OVERRIDE");
    }
  }
  // PLAYER会社の配当実績そのものも一致する（記録だけ揃って支払が違う、を排除する）。
  assert.deepEqual(
    JSON.parse(JSON.stringify(q4Record(asPlayer, 8).dividendResults)),
    JSON.parse(JSON.stringify(q4Record(asAi, 8).dividendResults)),
    "T8: 配当結果が操作主体で変わっている"
  );
});

test("D1-02: PLAYERが配当欄を触らなくても、管理者50%指定だけで自動精算される", () => {
  const s = runWithPlayers(newSession("d1-02", adminRatio(0.5), [PLAYER]), [PLAYER], 8);

  // PLAYERは金額指定配当を一度も入力していない。
  for (const record of s.state.history) {
    const decision = record.decisions.find((d) => d.companyId === PLAYER)!;
    assert.equal(decision.dividendDecision?.dividendAmountUsd ?? 0, 0, `T${record.turn}: PLAYERが金額指定配当を入力している前提になっている`);
  }

  // それでもQ4に精算recordが出て、年間純利益×50%が目標になっている。
  const settled = settlementOf(s, 8, PLAYER);
  assert.ok(settled, "PLAYER会社に年度末精算recordが無い（修正前の症状）");
  assert.equal(settled.appliedPayoutRatio, 0.5);
  assert.equal(settled.payoutRatioSource, "MANUAL_OVERRIDE");
  const expected = annualNetIncome(s, settled.dividendTargetYear, PLAYER);
  assert.ok(Math.abs(settled.annualNetIncomeUsd - expected) < EPS_USD, "年間純利益が確定履歴の合計と一致しない");
  assert.ok(
    Math.abs(settled.annualDividendTargetUsd - Math.max(0, expected) * 0.5) < EPS_USD,
    "年間配当目標が max(0, 年間純利益) × 50% になっていない"
  );
  // 実際に支払われている（記録だけで終わっていない）。
  assert.ok(settled.appliedDividendUsd > 0, "PLAYER会社へ実際の配当が行われていない");
});

// ---------------------------------------------------------------------
// D1-03 / D1-04: 管理者指定はAIの任意見送りgateに負けない
// ---------------------------------------------------------------------

test("D1-03/D1-04: AIの任意policyが見送る条件でも、管理者指定があれば精算対象になる", () => {
  // 管理者未指定のRunでは、AIのgate（新規CAPEX提案・Crisis・財務健全性など）により
  // 精算を見送る会社が出る。同一条件で管理者50%を指定すると、その会社も精算される。
  const withoutAdmin = advanceSimulationTurns({ session: newSession("d1-03-none", undefined, []), turns: 8, timestamp: TS_AT, sourceCommit: "D1-TEST" });
  const withAdmin = advanceSimulationTurns({ session: newSession("d1-03-admin", adminRatio(0.5), []), turns: 8, timestamp: TS_AT, sourceCommit: "D1-TEST" });

  const skippedByAi: string[] = [];
  for (const turn of [4, 8]) {
    for (const c of COMPANIES) {
      if (!settlementOf(withoutAdmin, turn, c)) skippedByAi.push(`${turn}:${c}`);
    }
  }
  assert.ok(skippedByAi.length > 0, "AIが見送る会社が1社も無く、この検査が空振りしている");

  for (const key of skippedByAi) {
    const [turnText, company] = key.split(":");
    const settled = settlementOf(withAdmin, Number(turnText), company);
    assert.ok(settled, `T${turnText} ${company}: 管理者指定があるのに精算されていない`);
    assert.equal(settled.appliedPayoutRatio, 0.5);
    assert.equal(settled.payoutRatioSource, "MANUAL_OVERRIDE");
  }
});

// ---------------------------------------------------------------------
// D1-05 / D1-06 / D1-07: 明示0%と未指定の区別
// ---------------------------------------------------------------------

test("D1-05: 管理者明示0%は「精算した結果0」として記録される（無記録ではない）", () => {
  const s = runWithPlayers(newSession("d1-05", adminRatio(0), [PLAYER]), [PLAYER], 8);
  for (const turn of [4, 8]) {
    for (const c of COMPANIES) {
      const settled = settlementOf(s, turn, c);
      assert.ok(settled, `T${turn} ${c}: 明示0%なのに精算recordが無い`);
      assert.equal(settled.appliedPayoutRatio, 0, `T${turn} ${c}: 適用率が0でない`);
      assert.equal(settled.payoutRatioSource, "MANUAL_OVERRIDE");
      assert.equal(settled.annualDividendTargetUsd, 0, `T${turn} ${c}: 年間目標が0でない`);
      assert.equal(settled.appliedDividendUsd, 0, `T${turn} ${c}: 実支払が0でない`);
      // 年間純利益は記録されている（0%でも「いくらの利益に対して0%だったか」が残る）。
      assert.equal(typeof settled.annualNetIncomeUsd, "number");
    }
  }
});

test("D1-06: 管理者未指定のPLAYERには、AIの既定配当率を強制しない", () => {
  const s = runWithPlayers(newSession("d1-06", undefined, [PLAYER]), [PLAYER], 8);
  for (const turn of [4, 8]) {
    assert.equal(settlementOf(s, turn, PLAYER), undefined, `T${turn}: 管理者未指定なのにPLAYERへ精算が走っている`);
    const paid = q4Record(s, turn).dividendResults?.find((d) => d.companyId === PLAYER)?.appliedDividendUsd ?? 0;
    assert.equal(paid, 0, `T${turn}: 管理者未指定のPLAYERに配当が支払われている`);
  }
});

test("D1-07: 管理者未指定のSTANDARD_AIは、既存のAI任意policyとビット単位で一致する（回帰）", () => {
  // 管理者指定が無いRunでは、本変更の適用関数は同一オブジェクトを返して何もしない。
  // したがって全社Standard AIの結果は、この変更の前後で完全に一致していなければならない。
  // ここでは「未指定Run同士が決定論的に一致すること」と、
  // AI由来の設定元が STANDARD_AI のままであることを固定する。
  const a = advanceSimulationTurns({ session: newSession("d1-07", undefined, []), turns: 8, timestamp: TS_AT, sourceCommit: "D1-TEST" });
  const b = advanceSimulationTurns({ session: newSession("d1-07", undefined, []), turns: 8, timestamp: TS_AT, sourceCommit: "D1-TEST" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(b.state.history)),
    JSON.parse(JSON.stringify(a.state.history)),
    "管理者未指定Runが決定論的でない"
  );
  let aiSourced = 0;
  for (const turn of [4, 8]) {
    for (const c of COMPANIES) {
      const settled = settlementOf(a, turn, c);
      if (!settled) continue;
      aiSourced += 1;
      assert.equal(settled.payoutRatioSource, "STANDARD_AI", `T${turn} ${c}: 未指定なのに MANUAL_OVERRIDE になっている`);
    }
  }
  assert.ok(aiSourced > 0, "AI由来の精算が1件も無く、この検査が空振りしている");
});

// ---------------------------------------------------------------------
// D1-08: Q4時点の率だけを使う（年度内の率を平均しない）
// ---------------------------------------------------------------------

test("D1-08: 年度途中で20→30→40→50%と変えても、年間精算はQ4時点の50%を使う", () => {
  const schedule: ManualBalanceSchedule = [
    { kind: "perTurn", turn: 5, settings: { dividendPayout: { kind: "specified", payoutRatio: 0.2 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined }, source: "MANUAL_OVERRIDE", recordedAt: "2026-09-23T00:00:00.000Z" },
    { kind: "perTurn", turn: 6, settings: { dividendPayout: { kind: "specified", payoutRatio: 0.3 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined }, source: "MANUAL_OVERRIDE", recordedAt: "2026-09-23T00:00:01.000Z" },
    { kind: "perTurn", turn: 7, settings: { dividendPayout: { kind: "specified", payoutRatio: 0.4 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined }, source: "MANUAL_OVERRIDE", recordedAt: "2026-09-23T00:00:02.000Z" },
    { kind: "perTurn", turn: 8, settings: { dividendPayout: { kind: "specified", payoutRatio: 0.5 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined }, source: "MANUAL_OVERRIDE", recordedAt: "2026-09-23T00:00:03.000Z" },
  ];
  const s = runWithPlayers(newSession("d1-08", schedule, [PLAYER]), [PLAYER], 8);
  const settled = settlementOf(s, 8, PLAYER);
  assert.ok(settled, "Q4に精算recordが無い");
  assert.equal(settled.appliedPayoutRatio, 0.5, "Q4時点の率ではない値が使われている");
  // 平均（0.35）ではないこと。
  assert.notEqual(settled.appliedPayoutRatio, (0.2 + 0.3 + 0.4 + 0.5) / 4);
  const expected = annualNetIncome(s, settled.dividendTargetYear, PLAYER);
  assert.ok(Math.abs(settled.annualDividendTargetUsd - Math.max(0, expected) * 0.5) < EPS_USD);
  // Q1〜Q3（T5〜T7）には精算が走らない。
  for (const t of [5, 6, 7]) {
    const rec = s.state.history.find((r) => r.turn === t)!;
    for (const d of rec.dividendResults ?? []) assert.equal(d.annualSettlement, undefined, `T${t}: Q4以外で精算が走っている`);
  }
});

// ---------------------------------------------------------------------
// D1-09 / D1-10: 年間損益の扱い
// ---------------------------------------------------------------------

test("D1-09/D1-10: 赤字四半期があっても年間黒字なら配当、年間赤字なら目標0", () => {
  const s = runWithPlayers(newSession("d1-09", adminRatio(0.5), [PLAYER], 32), [PLAYER], 32);
  let sawNegativeQuarterWithPositiveYear = false;
  let sawNegativeYear = false;

  for (const record of s.state.history) {
    if (toYearQuarter(record.period).quarter !== 4) continue;
    for (const c of COMPANIES) {
      const settled = settlementOf(s, record.turn, c);
      assert.ok(settled, `T${record.turn} ${c}: 管理者指定があるのに精算recordが無い`);
      const year = settled.dividendTargetYear;
      const quarters = s.state.history.filter((r) => toYearQuarter(r.period).year === year);
      const hasNegativeQuarter = quarters.some((r) => unwrapUsd(r.financialResults.find((f) => f.companyId === c)!.profitAndLoss.netIncome) < 0);

      if (settled.annualNetIncomeUsd > 0 && hasNegativeQuarter) {
        sawNegativeQuarterWithPositiveYear = true;
        assert.ok(settled.annualDividendTargetUsd > 0, `${year} ${c}: 年間黒字なのに目標0`);
      }
      if (settled.annualNetIncomeUsd <= 0) {
        sawNegativeYear = true;
        assert.equal(settled.annualDividendTargetUsd, 0, `${year} ${c}: 年間赤字なのに目標が0でない`);
        assert.equal(settled.appliedDividendUsd, 0, `${year} ${c}: 年間赤字なのに配当している`);
      }
    }
  }
  assert.ok(sawNegativeQuarterWithPositiveYear, "「赤字四半期あり・年間黒字」のケースが出ず空振りしている");
  assert.ok(sawNegativeYear, "「年間赤字」のケースが出ず空振りしている");
});

// ---------------------------------------------------------------------
// D1-11: Player金額指定配当を既払として控除する
// ---------------------------------------------------------------------

test("D1-11: PLAYERが年度途中に金額指定で支払った配当は、年末追加目標から差し引かれる", () => {
  // 【支払Turnの選び方（実測に基づく）】年度途中の配当は
  // maxDividend = min(現金, 分配可能利益) までしか実行されない（全額拒否・部分執行なし）。
  // 同条件を20Turn流して実測したところ、BALの分配可能利益は2015〜2016Q3まで負で、
  // 年度途中に配当できる最初の年度はFY2017だった（T10 2017Q2で max=33,757,429 USD、
  // FY2017の年間目標=43,457,166 USD）。そのため支払はT10に置き、Q4はT12で見る。
  const PAID_MID_YEAR = 5_000_000;
  const PAY_TURN = 10;
  const Q4_TURN = 12;
  const s = runWithPlayers(newSession("d1-11", adminRatio(0.5), [PLAYER], Q4_TURN), [PLAYER], Q4_TURN, (session, companyId, turn) => {
    const base = playerDecisionFor(session, companyId);
    return turn === PAY_TURN ? { ...base, dividendDecision: { dividendAmountUsd: PAID_MID_YEAR } } : base;
  });

  const midRecord = s.state.history.find((r) => r.turn === PAY_TURN)!;
  const mid = midRecord.dividendResults?.find((d) => d.companyId === PLAYER);
  assert.ok(mid, "年度途中の配当recordが無い");
  assert.equal(mid.rejected, false, `年度途中の配当が拒否された: ${String(mid.rejectionReason)}`);
  assert.ok(Math.abs(mid.appliedDividendUsd - PAID_MID_YEAR) < EPS_USD, `年度途中の配当が実行されていない（実測 ${mid.appliedDividendUsd}）`);

  const settled = settlementOf(s, Q4_TURN, PLAYER);
  assert.ok(settled, "Q4に精算recordが無い");
  assert.equal(toYearQuarter(midRecord.period).year, settled.dividendTargetYear, "支払Turnと精算年度が同じ年になっていない");
  // 既払として計上されている（設定値ではなく、その年度の実支払額から）。
  assert.ok(
    Math.abs(settled.paidDividendEarlierInYearUsd - PAID_MID_YEAR) < EPS_USD,
    `既払が実支払額と一致しない（記録 ${settled.paidDividendEarlierInYearUsd} / 実支払 ${PAID_MID_YEAR}）`
  );
  // 年末追加目標 = max(0, 年間目標 − 既払)。二重払いにならない。
  assert.ok(
    Math.abs(settled.yearEndAdditionalTargetUsd - Math.max(0, settled.annualDividendTargetUsd - PAID_MID_YEAR)) < EPS_USD,
    "年末追加目標が「年間目標 − 既払」になっていない"
  );
  assert.ok(settled.annualDividendTargetUsd > PAID_MID_YEAR, "年間目標が既払以下で、控除の検査が空振りしている");
  // その年度の実支払合計が年間目標を超えない。
  const yearPaid = s.state.history
    .filter((r) => toYearQuarter(r.period).year === settled.dividendTargetYear)
    .reduce((sum, r) => sum + (r.dividendResults?.find((d) => d.companyId === PLAYER)?.appliedDividendUsd ?? 0), 0);
  assert.ok(yearPaid <= settled.annualDividendTargetUsd + EPS_USD, `年度内の実支払合計(${yearPaid})が年間目標(${settled.annualDividendTargetUsd})を超えている`);
});

// ---------------------------------------------------------------------
// D1-12 / D1-13: 資金制約
// ---------------------------------------------------------------------

test("D1-12/D1-13: 資金制約時は部分支払になり、未達額と理由（CASH_LIMIT / DISTRIBUTABLE_EARNINGS_LIMIT）が残る", () => {
  // 100%指定にすると年間目標＝年間純利益となり、上限に当たる会社が出る。
  const s = runWithPlayers(newSession("d1-12", adminRatio(1), [PLAYER], 12), [PLAYER], 12);
  const reasons = new Set<string>();
  for (const record of s.state.history) {
    if (toYearQuarter(record.period).quarter !== 4) continue;
    for (const c of COMPANIES) {
      const a = settlementOf(s, record.turn, c);
      assert.ok(a, `T${record.turn} ${c}: 精算recordが無い`);
      if (a.annualDividendShortfallUsd > EPS_USD) {
        reasons.add(a.shortfallReason ?? "(null)");
        // 部分支払であること（全額拒否ではない）。
        assert.ok(a.appliedDividendUsd >= 0, "実支払が負");
        assert.ok(a.appliedDividendUsd <= a.maxDividendUsd + EPS_USD, "上限を超えて支払っている");
        // 未達 = 年末追加目標 − 実支払
        assert.ok(
          Math.abs(a.annualDividendShortfallUsd - (a.yearEndAdditionalTargetUsd - a.appliedDividendUsd)) < EPS_USD,
          `T${record.turn} ${c}: 未達額が「年末追加目標 − 実支払」になっていない`
        );
        // 目標と実支払が別値として残っている。
        assert.ok(a.yearEndAdditionalTargetUsd > a.appliedDividendUsd, "未達なのに目標と実支払が同じ");
      } else {
        assert.equal(a.shortfallReason, null, `T${record.turn} ${c}: 未達0なのに理由が付いている`);
      }
    }
  }
  assert.ok(reasons.size > 0, "資金制約が1件も発生せず、この検査が空振りしている");
  for (const r of reasons) {
    assert.ok(r === "CASH_LIMIT" || r === "DISTRIBUTABLE_EARNINGS_LIMIT", `未知の未達理由: ${r}`);
  }
});

// ---------------------------------------------------------------------
// D1-15 / D1-16: 年度途中の主体切替
// ---------------------------------------------------------------------

test("D1-15/D1-16: 年度途中でAI→PLAYER / PLAYER→AI に切り替えても、年間会計結果は変わらない", () => {
  // PLAYERはAIと同一の意思決定を提出する（精算意思は除く）ため、
  // どのTurnで主体が入れ替わっても財務履歴は同じでなければならない。
  const allAi = advanceSimulationTurns({ session: newSession("d1-15", adminRatio(0.5), []), turns: 8, timestamp: TS_AT, sourceCommit: "D1-TEST" });

  // AI→PLAYER: T1〜T6はAI、T7〜T8はPLAYER（年度の途中で切り替わる）。
  let aiToPlayer = newSession("d1-15", adminRatio(0.5), []);
  aiToPlayer = advanceSimulationTurns({ session: aiToPlayer, turns: 6, timestamp: TS_AT, sourceCommit: "D1-TEST" });
  aiToPlayer = runWithPlayers(aiToPlayer, [PLAYER], 2, (_s, c, turn) => replayAsPlayerDecision(allAi, turn, c));

  // PLAYER→AI: T1〜T6はPLAYER、T7〜T8はAI。
  let playerToAi = newSession("d1-15", adminRatio(0.5), [PLAYER]);
  playerToAi = runWithPlayers(playerToAi, [PLAYER], 6, (_s, c, turn) => replayAsPlayerDecision(allAi, turn, c));
  playerToAi = advanceSimulationTurns({ session: playerToAi, turns: 2, timestamp: TS_AT, sourceCommit: "D1-TEST" });

  for (const [label, s] of [["AI→PLAYER", aiToPlayer], ["PLAYER→AI", playerToAi]] as const) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(q4Record(s, 8).dividendResults)),
      JSON.parse(JSON.stringify(q4Record(allAi, 8).dividendResults)),
      `${label}: 年度途中の主体切替でQ4配当結果が変わった`
    );
    const settled = settlementOf(s, 8, PLAYER)!;
    assert.equal(settled.payoutRatioSource, "MANUAL_OVERRIDE", `${label}: 管理者指定が適用されていない`);
    assert.equal(settled.appliedPayoutRatio, 0.5, `${label}: 適用率が管理者指定と違う`);
  }
});

// ---------------------------------------------------------------------
// D1-17 / D1-18: save/resume と retry
// ---------------------------------------------------------------------

test("D1-17: Q3でsave → resume → Q4 が、中断なし実行と完全に一致する", () => {
  const continuous = runWithPlayers(newSession("d1-17", adminRatio(0.5), [PLAYER]), [PLAYER], 8);

  const beforeQ4 = runWithPlayers(newSession("d1-17", adminRatio(0.5), [PLAYER]), [PLAYER], 7);
  const payload = buildResumePayload(beforeQ4, beforeQ4.run.companyControlModes ?? {}, {});
  const restored = restoreSessionFromResumePayload(beforeQ4.run, payload);
  const resumed = runWithPlayers(restored, [PLAYER], 1);

  assert.deepEqual(
    JSON.parse(JSON.stringify(q4Record(resumed, 8).dividendResults)),
    JSON.parse(JSON.stringify(q4Record(continuous, 8).dividendResults)),
    "resume後のQ4配当結果が中断なし実行と一致しない"
  );
});

test("D1-18: Q4を同じ前提から再実行しても、配当が二重にならない", () => {
  const beforeQ4 = runWithPlayers(newSession("d1-18", adminRatio(0.5), [PLAYER]), [PLAYER], 7);
  const first = runWithPlayers(beforeQ4, [PLAYER], 1);
  const second = runWithPlayers(beforeQ4, [PLAYER], 1);
  const pick = (s: SimulationSession) =>
    (q4Record(s, 8).dividendResults ?? []).map((d) => [d.companyId, d.appliedDividendUsd, d.cumulativeDividendUsd, d.annualSettlement?.appliedDividendUsd ?? null]);
  assert.deepEqual(pick(second), pick(first), "再実行で配当額・累積が変わっている（二重加算または取りこぼし）");
});

// ---------------------------------------------------------------------
// D1-19: T32まで完走して精算される
// ---------------------------------------------------------------------

test("D1-19: PLAYER会社でも32Turn完走し、最終Q4(T32)で精算され累積配当へ反映される", () => {
  const s = runWithPlayers(newSession("d1-19", adminRatio(0.5), [PLAYER], 32), [PLAYER], 32);
  assert.equal(s.run.completedTurns, 32);
  const settled = settlementOf(s, 32, PLAYER);
  assert.ok(settled, "T32で精算されていない");

  // 累積配当が、各Turnの実支払の合計と一致する（評価へ渡る値が整合している）。
  const last = q4Record(s, 32).dividendResults!.find((d) => d.companyId === PLAYER)!;
  const summed = s.state.history.reduce(
    (sum, r) => sum + (r.dividendResults?.find((d) => d.companyId === PLAYER)?.appliedDividendUsd ?? 0),
    0
  );
  assert.ok(Math.abs(last.cumulativeDividendUsd - summed) < EPS_USD, "累積配当が実支払の合計と一致しない");
  assert.ok(last.cumulativeDividendUsd > 0, "PLAYER会社の累積配当が0のまま（修正前の症状）");
});

// ---------------------------------------------------------------------
// D1-25: 会計不変条件
// ---------------------------------------------------------------------

test("D1-25: PLAYER会社への配当後も PL/BS/CF/累積配当 が整合する", () => {
  const s = runWithPlayers(newSession("d1-25", adminRatio(0.5), [PLAYER], 12), [PLAYER], 12);
  let checkedPaid = 0;
  for (const record of s.state.history) {
    for (const fin of record.financialResults) {
      const bs = fin.balanceSheet;
      const cf = fin.cashFlow;
      const at = `T${record.turn} ${fin.companyId}`;
      const sum =
        unwrapUsd(cf.openingCash) + unwrapUsd(cf.operatingCashFlow) + unwrapUsd(cf.investingCashFlow) + unwrapUsd(cf.financingCashFlow);
      assert.ok(Math.abs(sum - unwrapUsd(cf.closingCash)) < EPS_USD, `${at}: opening+CFO+CFI+CFF != closingCash`);
      assert.ok(Math.abs(unwrapUsd(bs.cash) - unwrapUsd(cf.closingCash)) < EPS_USD, `${at}: BS cash != CF closingCash`);
      assert.ok(Math.abs(unwrapUsd(bs.balanceDifference)) < EPS_USD, `${at}: balanceDifference != 0`);
      assert.ok(
        Math.abs(unwrapUsd(bs.totalEquity) - (unwrapUsd(bs.capitalStock) + unwrapUsd(bs.retainedEarnings))) < EPS_USD,
        `${at}: totalEquity != capitalStock + retainedEarnings`
      );
      const paid = record.dividendResults?.find((d) => d.companyId === fin.companyId)?.appliedDividendUsd ?? 0;
      if (paid > EPS_USD) {
        checkedPaid += 1;
        assert.ok(cf.dividendsPaid !== undefined, `${at}: dividendsPaidが記録されていない`);
        assert.ok(Math.abs(unwrapUsd(cf.dividendsPaid!) - paid) < EPS_USD, `${at}: dividendsPaidが実支払と一致しない`);
      }
    }
  }
  assert.ok(checkedPaid > 0, "配当が1件も発生せず、この検査が空振りしている");
});

test("D1-25b: 配当の有無でPLAYER会社のnetIncomeは変わらず、Debtも動かない", () => {
  const withDiv = runWithPlayers(newSession("d1-25b-d", adminRatio(0.5), [PLAYER]), [PLAYER], 4);
  const noDiv = runWithPlayers(newSession("d1-25b-n", adminRatio(0), [PLAYER]), [PLAYER], 4);
  const a = q4Record(withDiv, 4).financialResults.find((f) => f.companyId === PLAYER)!;
  const b = q4Record(noDiv, 4).financialResults.find((f) => f.companyId === PLAYER)!;
  assert.equal(unwrapUsd(a.profitAndLoss.netIncome), unwrapUsd(b.profitAndLoss.netIncome), "配当でnetIncomeが変わっている");
  assert.equal(unwrapUsd(a.balanceSheet.shortTermLoans), unwrapUsd(b.balanceSheet.shortTermLoans), "配当でDebtが動いている");
  assert.equal(unwrapUsd(a.balanceSheet.longTermLoans), unwrapUsd(b.balanceSheet.longTermLoans), "配当でDebtが動いている");
});

// ---------------------------------------------------------------------
// D1-20: 管理者未指定Runの回帰（既存の意思決定を書き換えない）
// ---------------------------------------------------------------------

test("D1-20: 管理者未指定なら、意思決定オブジェクトへ annualDividendSettlement を足さない", () => {
  const s = runWithPlayers(newSession("d1-20", undefined, [PLAYER]), [PLAYER], 4);
  for (const record of s.state.history) {
    const playerDecision = record.decisions.find((d) => d.companyId === PLAYER)!;
    assert.equal(
      playerDecision.annualDividendSettlement,
      undefined,
      `T${record.turn}: 管理者未指定なのにPLAYERの意思決定へ精算意思が足されている`
    );
  }
});
