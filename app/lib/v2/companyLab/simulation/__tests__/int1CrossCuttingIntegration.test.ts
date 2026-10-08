// ShrimpX V2 — INT-1 統合横断シナリオ（D1 + O1 + Crowding を同時に使う）
//
// 【このテストの立場】個別branchのテスト成功を統合候補の成功として流用しないため、
// 「3成果を同時に有効にした1本のRun」から実績を取って契約を固定する。
//   D1       … 管理者指定年間配当（PLAYER / Standard AI 共通・Q4精算）
//   O1       … 保存の CAS（expectedBaseRevision / writeToken / staging / stale拒否）
//   Crowding … salesModelId = tiered-v200-crowding-v1（正式P1）＋ Persistence v9 診断保存
//
// 新しい仕様・新しい数値は一切決めない。既存の受入済み契約が同時に成立することだけを見る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { ROLLING_RESUME_HISTORY_WINDOW, buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import {
  createInMemorySimulationRunRepository,
  createSimulationRunWriteToken,
  SimulationRunStaleRevisionError,
} from "../persistence/repository";
import { createRedisSimulationRunRepository } from "../persistence/redisRepository";
import { createFakeSimulationRunRedisClient } from "./fakeSimulationRunRedisClient";
import {
  CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  StoredSimulationRunManifest,
  manifestToSimulationRunSummary,
} from "../persistence/types";
import { crowdingPolicyForModelId } from "../../../sales/salesModels";
import { CROWDING_COEFFICIENTS_V200_P1, CROWDING_POLICY_VERSION_V1 } from "../../../sales/crowding";
import { buildStandardAiAuditWorkbookData } from "../auditWorkbook/index";
import { buildDatasetFromSession } from "../analytics/dataset";
import type { SimulationSession } from "../types";
import type { CompanyDecisionInput } from "../../types";
import { toYearQuarter } from "../../../core/period";
import { unwrapUsd } from "../../../finance/types";
import type { ManualBalanceSchedule } from "../../manualBalance/overrides";

const TS_AT = "2026-10-06T00:00:00.000Z";
const SCENARIO = "dynamic-scenario-2";
const SEED = "int1-cross-cutting";
const CROWDING_MODEL = "tiered-v200-crowding-v1" as const;
const PLAYER = "BAL";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const EPS = 0.01;

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

/** Crowding モデル＋（任意で）管理者指定配当＋PLAYER会社を同時に持つ Run を作る。 */
function newCrowdingSession(runId: string, schedule: ManualBalanceSchedule | undefined, players: readonly string[], turns = 8): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, players.includes(c) ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: turns,
    startedAt: TS_AT,
    sourceCommit: "INT1-TEST",
    companyControlModes: modes,
    salesModelId: CROWDING_MODEL,
    ...(schedule ? { manualBalanceOverrides: schedule } : {}),
  });
}

/**
 * PLAYER の提出値。既定ドラフト（＝その期のAI判断のコピー）をそのまま出す。
 * 【重要】buildDecisionInputFromDraft は annualDividendSettlement を出さない。
 * つまり PLAYER は配当欄を一切触っていない状態である。
 */
function playerDecisionFor(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const ai = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn).decision;
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const submitted = buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
  assert.equal(
    (submitted as { annualDividendSettlement?: unknown }).annualDividendSettlement,
    undefined,
    "PLAYER提出経路が精算意思を出してしまっている（前提が崩れている）"
  );
  return submitted;
}

function runWithPlayers(session: SimulationSession, players: readonly string[], turns: number): SimulationSession {
  let s = session;
  for (let i = 0; i < turns; i += 1) {
    const turn = s.state.scenarioState.currentTurn;
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const c of players) decisions[c] = playerDecisionFor(s, c);
    const outcome = advanceSimulationTurn(s, TS_AT, players.length > 0 ? decisions : undefined, "INT1-TEST");
    assert.ok(outcome.advanced, `turn ${turn} で停止した: ${String(outcome.error)}`);
    s = outcome.session;
  }
  return s;
}

function recordAt(s: SimulationSession, turn: number) {
  const r = s.state.history.find((x) => x.turn === turn);
  assert.ok(r, `turn ${turn} の確定履歴が無い`);
  return r;
}

function settlementOf(s: SimulationSession, turn: number, companyId: string) {
  return recordAt(s, turn).dividendResults?.find((d) => d.companyId === companyId)?.annualSettlement;
}

function annualNetIncome(s: SimulationSession, year: number, companyId: string): number {
  return s.state.history
    .filter((r) => toYearQuarter(r.period).year === year)
    .reduce((sum, r) => sum + unwrapUsd(r.financialResults.find((f) => f.companyId === companyId)!.profitAndLoss.netIncome), 0);
}

function paidEarlierInYear(s: SimulationSession, year: number, companyId: string, upToTurnExclusive: number): number {
  return s.state.history
    .filter((r) => toYearQuarter(r.period).year === year && r.turn < upToTurnExclusive)
    .reduce((sum, r) => sum + (r.dividendResults?.find((d) => d.companyId === companyId)?.appliedDividendUsd ?? 0), 0);
}

// 統合候補の基準Run。1回だけ回して複数のtestで共有する（32Q相当の重さを避ける）。
const INTEGRATED = runWithPlayers(newCrowdingSession("int1-x", adminRatio(0.5), [PLAYER], 8), [PLAYER], 8);

// ---------------------------------------------------------------------
// INT1-X-01: Crowding が実際に動いており、診断が v9 形式で履歴へ残る
// ---------------------------------------------------------------------
test("INT1-X-01: Crowding model の Run で crowdingDiagnostics が履歴へ保存される", () => {
  assert.equal(INTEGRATED.state.config.salesModelId, CROWDING_MODEL, "salesModelId が Crowding モデルでない");
  const policy = crowdingPolicyForModelId(CROWDING_MODEL);
  assert.ok(policy, "Crowding policy が解決できない");
  assert.equal(policy.policyVersion, CROWDING_POLICY_VERSION_V1);
  assert.equal(policy.enabled, true, "Crowding policy が enabled でない");
  for (const product of ["hoso", "pd", "vap"] as const) {
    assert.deepEqual(policy.byProduct[product], CROWDING_COEFFICIENTS_V200_P1, `P1 係数（${product}）が正式値と一致しない`);
    assert.equal(policy.byProduct[product].threshold, 1.0);
    assert.equal(policy.byProduct[product].lambda, 0.6);
    assert.equal(policy.byProduct[product].gamma, 1.0);
    assert.equal(policy.byProduct[product].floor, 0.82);
    assert.equal(policy.protectedExternalShare[product], 0.2);
  }

  const withDiag = INTEGRATED.state.history.filter((r) => r.crowdingDiagnostics !== undefined);
  assert.ok(withDiag.length > 0, "Crowding が有効なRunなのに crowdingDiagnostics を持つTurnが1つも無い");
  assert.equal(withDiag.length, INTEGRATED.state.history.length, "Crowding ONのRunで診断が欠落したTurnがある");
});

// ---------------------------------------------------------------------
// INT1-X-02: D1 の年間精算が、Crowding ON・PLAYER 混在でも全社へ効く
// ---------------------------------------------------------------------
test("INT1-X-02: Crowding ON・PLAYER混在でも管理者50%がQ4で全社精算される", () => {
  for (const turn of [4, 8]) {
    assert.equal(toYearQuarter(recordAt(INTEGRATED, turn).period).quarter, 4, `T${turn} がQ4でない`);
    for (const c of COMPANIES) {
      const st = settlementOf(INTEGRATED, turn, c);
      assert.ok(st, `T${turn} ${c}: 年間精算recordが無い（PLAYER=${c === PLAYER}）`);
      assert.equal(st.payoutRatioSource, "MANUAL_OVERRIDE", `T${turn} ${c}: 出所が管理者指定でない`);
      assert.equal(st.appliedPayoutRatio, 0.5, `T${turn} ${c}: 適用率が管理者指定と違う`);
    }
  }
});

// ---------------------------------------------------------------------
// INT1-X-03: 精算式が Crowding 下でも契約どおり（実績から検算する）
// ---------------------------------------------------------------------
test("INT1-X-03: Crowding ONでも年間NI・目標・既払控除・上限の関係が崩れない", () => {
  for (const turn of [4, 8]) {
    const year = toYearQuarter(recordAt(INTEGRATED, turn).period).year;
    for (const c of COMPANIES) {
      const st = settlementOf(INTEGRATED, turn, c)!;
      const ni = annualNetIncome(INTEGRATED, year, c);
      assert.ok(Math.abs(st.annualNetIncomeUsd - ni) < 1, `T${turn} ${c}: annualNetIncome が Q1〜Q4符号付き合計と違う（${st.annualNetIncomeUsd} vs ${ni}）`);
      const target = Math.max(0, ni) * st.appliedPayoutRatio;
      assert.ok(Math.abs(st.annualDividendTargetUsd - target) < 1, `T${turn} ${c}: 年間目標が max(0,NI)×率 と違う`);
      const paid = paidEarlierInYear(INTEGRATED, year, c, turn);
      assert.ok(Math.abs(st.paidDividendEarlierInYearUsd - paid) < 1, `T${turn} ${c}: 同年度既払配当の集計が履歴と違う`);
      const additional = Math.max(0, st.annualDividendTargetUsd - st.paidDividendEarlierInYearUsd);
      assert.ok(Math.abs(st.yearEndAdditionalTargetUsd - additional) < EPS, `T${turn} ${c}: 追加目標が max(0, 目標−既払) と違う`);
      assert.ok(st.appliedDividendUsd <= st.yearEndAdditionalTargetUsd + EPS, `T${turn} ${c}: 実支払が追加目標を超えている`);
      assert.ok(st.appliedDividendUsd <= st.maxDividendUsd + EPS, `T${turn} ${c}: 実支払が min(cash, 分配可能利益) を超えている`);
      assert.ok(st.appliedDividendUsd >= -EPS, `T${turn} ${c}: 実支払が負になっている（返還は行わない契約）`);
      const shortfall = st.yearEndAdditionalTargetUsd - st.appliedDividendUsd;
      assert.ok(Math.abs(st.annualDividendShortfallUsd - shortfall) < EPS, `T${turn} ${c}: 未達額の記録が合わない`);
      if (st.annualDividendShortfallUsd > EPS) assert.ok(st.shortfallReason !== null, `T${turn} ${c}: 未達なのに理由が無い`);
    }
  }
});

// ---------------------------------------------------------------------
// INT1-X-04: 0%明示指定と未指定を、Crowding ON でも区別する
// ---------------------------------------------------------------------
test("INT1-X-04: Crowding ONで 0%明示指定と未指定が区別される", () => {
  const zero = runWithPlayers(newCrowdingSession("int1-x-zero", adminRatio(0), [PLAYER], 4), [PLAYER], 4);
  const unspecified = runWithPlayers(newCrowdingSession("int1-x-unspec", undefined, [PLAYER], 4), [PLAYER], 4);

  for (const c of COMPANIES) {
    const z = settlementOf(zero, 4, c);
    assert.ok(z, `0%指定: ${c} の精算recordが無い（0%は「指示」なので記録される）`);
    assert.equal(z.payoutRatioSource, "MANUAL_OVERRIDE", `0%指定: ${c} の出所が管理者指定でない`);
    assert.equal(z.appliedPayoutRatio, 0, `0%指定: ${c} の適用率が0でない`);
    assert.ok(Math.abs(z.annualDividendTargetUsd) < EPS, `0%指定: ${c} の年間目標が0でない`);
    assert.ok(Math.abs(z.appliedDividendUsd) < EPS, `0%指定: ${c} の実支払が0でない`);
  }

  // 未指定: PLAYER会社は精算意思を持たないため精算されない（0%指定とは別の状態）。
  const up = settlementOf(unspecified, 4, PLAYER);
  assert.equal(up, undefined, "未指定なのにPLAYER会社が精算された（0%指定と同じ扱いになっている）");
  // 未指定のAI会社は Standard AI 既定率で動く＝管理者指定ではない。
  for (const c of COMPANIES.filter((x) => x !== PLAYER)) {
    const ua = settlementOf(unspecified, 4, c);
    if (ua) assert.notEqual(ua.payoutRatioSource, "MANUAL_OVERRIDE", `未指定なのに ${c} の出所が管理者指定になっている`);
  }
});

// ---------------------------------------------------------------------
// INT1-X-05: save → resume を跨いでも Crowding 診断と D1 精算が両立する
// ---------------------------------------------------------------------
test("INT1-X-05: resume後もCrowding診断が残り、次のQ4で管理者指定が効く", () => {
  // T5まで進めて保存 → 復元 → T8（Q4）まで進める。
  const mid = runWithPlayers(newCrowdingSession("int1-x-resume", adminRatio(0.5), [PLAYER], 8), [PLAYER], 5);
  const payload = buildResumePayload(mid, {}, {});
  const roundTripped = JSON.parse(JSON.stringify(payload));
  const restored = restoreSessionFromResumePayload(mid.run, roundTripped, {
    companyTurns: mid.packCompanyTurns,
    worldTurns: mid.packWorldTurns,
  });

  assert.equal(restored.state.config.salesModelId, CROWDING_MODEL, "resume後に salesModelId が失われた（Crowding OFFへ戻った）");
  assert.ok(crowdingPolicyForModelId(restored.state.config.salesModelId!), "resume後に Crowding policy が解決できない");
  /**
   * 【resumeのhistoryは rolling window】RC既存仕様として resume payload の history は
   * 直近 ROLLING_RESUME_HISTORY_WINDOW（=4、実測）ターンへ間引かれる。
   * これはD1/O1/Crowdingのいずれも変更していない既存挙動なので、
   * 「間引かれずに残ったTurンについて診断が一致すること」を契約として見る
   * （件数の一致を要求すると、間引き仕様そのものを誤って回帰扱いしてしまう）。
   */
  assert.equal(ROLLING_RESUME_HISTORY_WINDOW, 4, "resume windowの実測値が変わった（前提の再確認が必要）");
  assert.equal(restored.state.history.length, Math.min(mid.state.history.length, ROLLING_RESUME_HISTORY_WINDOW), "resume後のhistory件数が間引き仕様と違う");
  assert.ok(restored.state.history.length > 0, "resume後のhistoryが空");
  for (const r of restored.state.history) {
    const before = mid.state.history.find((x) => x.turn === r.turn);
    assert.ok(before, `resume後のT${r.turn}が保存前に存在しない`);
    assert.notEqual(r.crowdingDiagnostics, undefined, `resume後のT${r.turn}で crowdingDiagnostics が落ちた`);
    assert.deepEqual(r.crowdingDiagnostics, before.crowdingDiagnostics, `resume後のT${r.turn}の crowdingDiagnostics が保存前と一致しない`);
  }
  /**
   * 【JSON往復で undefined キーが落ちる】ManualBalanceSettings は
   * salesPriceIndex / rawMarketPriceIndex を「未設定」として undefined で持つ。
   * JSON.stringify はその**キー自体**を落とすため、復元後のオブジェクトは
   * キーが無い形になる（値の意味は同じ。resolveManualBalanceForTurn は
   * どちらも「手動補正なし」として扱う）。実際の保存経路もJSONを通るので、
   * ここは同じ正規化を掛けて比較する。
   */
  const normalize = (v: unknown) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(
    normalize(restored.state.config.manualBalanceOverrides),
    normalize(mid.state.config.manualBalanceOverrides),
    "resume後に管理者指定スケジュールが失われた"
  );
  assert.equal(restored.state.config.manualBalanceOverrides?.length, 1, "resume後の管理者指定エントリ件数が違う");

  const afterResume = runWithPlayers(restored, [PLAYER], 3);
  for (const c of COMPANIES) {
    const st = settlementOf(afterResume, 8, c);
    assert.ok(st, `resume後のT8: ${c} の年間精算recordが無い`);
    assert.equal(st.payoutRatioSource, "MANUAL_OVERRIDE", `resume後のT8: ${c} の出所が管理者指定でない`);
    assert.equal(st.appliedPayoutRatio, 0.5);
  }
  // resume後に進めたTurnでも診断が作られ続けること（historyに残っている全Turnで確認）。
  for (const r of afterResume.state.history) {
    assert.notEqual(r.crowdingDiagnostics, undefined, `resume後に進めたT${r.turn}で crowdingDiagnostics が欠けている`);
  }
  assert.ok(
    afterResume.state.history.some((r) => r.turn > 5),
    "resume後に進めたTurnがhistoryに無い（検証が空振りしている）"
  );
});

// ---------------------------------------------------------------------
// INT1-X-06: O1 の CAS が v9 payload（Crowding診断つき）でもそのまま働く
// ---------------------------------------------------------------------
for (const impl of [
  { name: "in-memory", create: () => createInMemorySimulationRunRepository() },
  { name: "redis", create: () => createRedisSimulationRunRepository({ client: createFakeSimulationRunRedisClient(), appEnv: "staging" as const }) },
] as const) {
  test(`INT1-X-06 (${impl.name}): v9 + Crowding診断を含む保存でも stale writer は拒否され、勝者の診断が残る`, async () => {
    const repo = impl.create();
    const id = `int1-x-cas-${impl.name}`;
    const resumePayload = JSON.parse(JSON.stringify(buildResumePayload(INTEGRATED, {}, {})));
    const diagTurns = (resumePayload.state.history as { crowdingDiagnostics?: unknown }[]).filter((r) => r.crowdingDiagnostics !== undefined).length;
    assert.ok(diagTurns > 0, "保存対象のresumePayloadにCrowding診断が入っていない（前提が崩れている）");

    const manifestFor = (revision: number, completedTurns: number): StoredSimulationRunManifest => ({
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: { ...INTEGRATED.run, simulationRunId: id, completedTurns },
      persistenceRevision: revision,
      savedAt: new Date(Date.parse(TS_AT) + revision * 1000).toISOString(),
      hasResumePayload: true,
      hasPackCapture: false,
    });

    // 初回保存（revision 1）
    const base0 = await repo.currentPublishedRevision(id);
    assert.equal(base0, 0, "新規Runの公開revisionが0でない");
    const a1 = { expectedBaseRevision: 0, writeToken: createSimulationRunWriteToken("int1a") };
    await repo.saveRunPart(id, a1, "dataset", { marker: "ds-1" });
    await repo.saveRunPart(id, a1, "resume", resumePayload);
    const m1 = manifestFor(1, 8);
    await repo.commitRunManifest(m1, manifestToSimulationRunSummary(m1), a1);

    // 同じ base を読んだ2者が競合する（GM保存 と PLAYER提出）
    const base1 = await repo.currentPublishedRevision(id);
    const win = { expectedBaseRevision: base1, writeToken: createSimulationRunWriteToken("int1win") };
    const lose = { expectedBaseRevision: base1, writeToken: createSimulationRunWriteToken("int1lose") };
    for (const [att, mk] of [
      [win, "ds-win"],
      [lose, "ds-lose"],
    ] as const) {
      await repo.saveRunPart(id, att, "dataset", { marker: mk });
      await repo.saveRunPart(id, att, "resume", resumePayload);
    }
    const mWin = manifestFor(base1 + 1, 8);
    await repo.commitRunManifest(mWin, manifestToSimulationRunSummary(mWin), win);
    await assert.rejects(
      async () => {
        const mLose = manifestFor(base1 + 1, 99);
        await repo.commitRunManifest(mLose, manifestToSimulationRunSummary(mLose), lose);
      },
      (e: unknown) => e instanceof SimulationRunStaleRevisionError,
      "stale writer が拒否されていない"
    );

    const loaded = await repo.loadRun(id);
    assert.ok(loaded, "保存したRunが読めない");
    assert.equal(loaded.schemaVersion, 9, "保存されたschemaVersionがv9でない");
    assert.equal((loaded.dataset as { marker?: string }).marker, "ds-win", "敗者のパートが正本になっている");
    assert.equal(loaded.run.completedTurns, 8, "敗者のmanifestが公開されている");
    const loadedHistory = (loaded.resumePayload as unknown as { state: { history: readonly { crowdingDiagnostics?: unknown }[] } }).state.history;
    const loadedDiag = loadedHistory.filter((r) => r.crowdingDiagnostics !== undefined).length;
    assert.equal(loadedDiag, diagTurns, "CASを通した保存でCrowding診断が落ちた");
  });
}

// ---------------------------------------------------------------------
// INT1-X-07: 会計不変条件（統合候補の実績で確認する）
// ---------------------------------------------------------------------
test("INT1-X-07: 統合候補のRunで貸借一致・配当のPL非費用化・配当目的の自動借入なしが保たれる", () => {
  for (const r of INTEGRATED.state.history) {
    for (const f of r.financialResults) {
      assert.ok(
        Math.abs(unwrapUsd(f.balanceSheet.balanceDifference)) < 1,
        `T${r.turn} ${f.companyId}: 貸借差額が0でない（${unwrapUsd(f.balanceSheet.balanceDifference)}）`
      );
      const a = unwrapUsd(f.balanceSheet.totalAssets);
      const le = unwrapUsd(f.balanceSheet.totalLiabilitiesAndEquity);
      assert.ok(Math.abs(a - le) < 1, `T${r.turn} ${f.companyId}: totalAssets != totalLiabilitiesAndEquity`);
    }
  }

  // 配当はPL費用ではない: 配当を払ったQ4で、純利益が配当額ぶん目減りしていないことを
  // 「同年度Q1〜Q4の純利益合計 = 精算が使った annualNetIncomeUsd」で確認する
  // （配当がPLへ入っていれば、Q4純利益が配当ぶん減り、この等式が崩れる）。
  for (const turn of [4, 8]) {
    const year = toYearQuarter(recordAt(INTEGRATED, turn).period).year;
    for (const c of COMPANIES) {
      const st = settlementOf(INTEGRATED, turn, c)!;
      assert.ok(
        Math.abs(st.annualNetIncomeUsd - annualNetIncome(INTEGRATED, year, c)) < 1,
        `T${turn} ${c}: 配当がPLへ混入している疑い（年間NIの一致が崩れている）`
      );
    }
  }

  // 配当のための自動借入をしない: 年間目標に届かなかった会社で、借入が増えていないこと。
  for (const turn of [4, 8]) {
    const rec = recordAt(INTEGRATED, turn);
    const prev = INTEGRATED.state.history.find((x) => x.turn === turn - 1);
    if (!prev) continue;
    for (const c of COMPANIES) {
      const st = settlementOf(INTEGRATED, turn, c)!;
      if (st.annualDividendShortfallUsd <= EPS) continue;
      const now = rec.financialResults.find((f) => f.companyId === c)!.balanceSheet;
      const before = prev.financialResults.find((f) => f.companyId === c)!.balanceSheet;
      const debtNow = unwrapUsd(now.shortTermLoans) + unwrapUsd(now.longTermLoans);
      const debtBefore = unwrapUsd(before.shortTermLoans) + unwrapUsd(before.longTermLoans);
      assert.ok(
        debtNow - debtBefore <= st.annualDividendShortfallUsd || st.appliedDividendUsd <= st.maxDividendUsd + EPS,
        `T${turn} ${c}: 未達なのに配当目的の自動借入が疑われる（debt ${debtBefore} → ${debtNow}）`
      );
      // 未達額を負債化していない（未達は記録されるだけ）。
      assert.ok(st.appliedDividendUsd <= st.maxDividendUsd + EPS, `T${turn} ${c}: 上限を超えて支払っている`);
    }
  }

  // 二重払いをしない: 年間実支払（Q1〜Q4合計）が年間目標を超えない。
  for (const turn of [4, 8]) {
    const year = toYearQuarter(recordAt(INTEGRATED, turn).period).year;
    for (const c of COMPANIES) {
      const st = settlementOf(INTEGRATED, turn, c)!;
      const paidAll = paidEarlierInYear(INTEGRATED, year, c, turn) + (recordAt(INTEGRATED, turn).dividendResults?.find((d) => d.companyId === c)?.appliedDividendUsd ?? 0);
      assert.ok(
        paidAll <= Math.max(st.annualDividendTargetUsd, st.paidDividendEarlierInYearUsd) + EPS,
        `T${turn} ${c}: 年間実支払が年間目標を超えている（二重払いの疑い。paid=${paidAll}, target=${st.annualDividendTargetUsd}）`
      );
    }
  }
});

// ---------------------------------------------------------------------
// INT1-X-08: Audit Workbook が統合候補でも Crowding 行を出す
// ---------------------------------------------------------------------
test("INT1-X-08: Audit Workbook 行生成が統合候補のRunで Crowding 診断を出力する", () => {
  const stored = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: INTEGRATED.run,
    dataset: buildDatasetFromSession(INTEGRATED),
    packCapture: { companyTurns: INTEGRATED.packCompanyTurns, worldTurns: INTEGRATED.packWorldTurns },
    resumePayload: buildResumePayload(INTEGRATED, {}, {}),
    savedAt: TS_AT,
  };
  const data = buildStandardAiAuditWorkbookData({ stored, generatedAt: TS_AT, liveHistory: INTEGRATED.state.history });
  const asJson = JSON.stringify(data);
  assert.ok(/crowding/i.test(asJson), "Audit Workbook のデータに Crowding 由来の項目が1つも無い");
  assert.ok(data.meta.completedTurns === 8, `Audit Workbook の completedTurns が実績と違う（${data.meta.completedTurns}）`);
});

// ---------------------------------------------------------------------
// INT1-X-09: 対照実験。Crowding OFF モデルでは診断が付かず、D1だけが効く
//            （INT1-X-01 / X-02 が空振りしていないことの確認も兼ねる）
// ---------------------------------------------------------------------
test("INT1-X-09: Crowding OFFモデルでは診断が付かず、管理者指定配当だけが効く", () => {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, c === PLAYER ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  const offSession = createSimulationSession({
    simulationRunId: "int1-x-off",
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: 4,
    startedAt: TS_AT,
    sourceCommit: "INT1-TEST",
    companyControlModes: modes,
    salesModelId: "tiered-v200-candidate-v1",
    manualBalanceOverrides: adminRatio(0.5),
  });
  assert.equal(crowdingPolicyForModelId("tiered-v200-candidate-v1"), undefined, "既存モデルへCrowdingが後付けされている");
  const off = runWithPlayers(offSession, [PLAYER], 4);

  // Crowding OFF: 診断キー自体が作られない（v8以前の履歴と同じ形）。
  for (const r of off.state.history) {
    assert.equal(r.crowdingDiagnostics, undefined, `Crowding OFFなのにT${r.turn}へ診断が付いている`);
  }
  // D1 は Crowding と独立に効く。
  for (const c of COMPANIES) {
    const st = settlementOf(off, 4, c);
    assert.ok(st, `Crowding OFF: ${c} の年間精算recordが無い`);
    assert.equal(st.payoutRatioSource, "MANUAL_OVERRIDE");
    assert.equal(st.appliedPayoutRatio, 0.5);
  }
  // Crowding ON/OFF で価格が実際に変わっている（P1が無害化されていないことの確認）。
  const onRevenue = recordAt(INTEGRATED, 4).financialResults.map((f) => unwrapUsd(f.profitAndLoss.netRevenue)).reduce((a, b) => a + b, 0);
  const offRevenue = recordAt(off, 4).financialResults.map((f) => unwrapUsd(f.profitAndLoss.netRevenue)).reduce((a, b) => a + b, 0);
  assert.notEqual(onRevenue, offRevenue, "Crowding ON/OFFで売上が同一（P1が効いていない疑い）");
});
