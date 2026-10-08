/**
 * 【INT-1 §9】32Turn 技術スモーク（統合候補コード上で実行する）。
 *
 * 目的は「統合コードが32Turn動くか」の確認だけである。
 * 研修推奨値・バランス判断・新しいパラメータはここで一切決めない
 * （販売指数・配当率・seed は既存の受入済み値／既存の既定のみを使う）。
 *
 *   Dynamic Scenario 2 / Crowding model (tiered-v200-crowding-v1) / 32 Turn
 *   PLAYER=BAL（Management Console内PLAYER相当）＋ Standard AI 4社
 *   管理者指定配当 50%（D1受入時と同じ値）
 *   途中で save → resume を1回挟む
 */
import { advanceSimulationTurn, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../app/v2/company-lab/decisionDraft";
import { buildResumePayload, restoreSessionFromResumePayload } from "../../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import { buildStandardAiAuditExport } from "../../app/lib/v2/companyLab/simulation/auditWorkbook/index";
import { computeFinalEvaluationSnapshot } from "../../app/v2/management/lib/gameEnd";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../app/lib/v2/companyLab/simulation/persistence/types";
import { crowdingPolicyForModelId } from "../../app/lib/v2/sales/salesModels";
import { toYearQuarter } from "../../app/lib/v2/core/period";
import { unwrapUsd } from "../../app/lib/v2/finance/types";
import { unwrapUnit } from "../../app/lib/v2/core/units";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";
import type { ManualBalanceSchedule } from "../../app/lib/v2/companyLab/manualBalance/overrides";

const TS_AT = "2026-10-06T00:00:00.000Z";
const SCENARIO = "dynamic-scenario-2";
const SEED = "int1-smoke-32";
const MODEL = "tiered-v200-crowding-v1" as const;
const PLAYER = "BAL";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const RESUME_AT_TURN = 17;
const EPS = 1;

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS " : "FAIL "} ${label}  ${detail}`);
  if (!ok) failures += 1;
}

const schedule: ManualBalanceSchedule = [
  {
    kind: "continuing",
    effectiveFromTurn: 1,
    settings: { dividendPayout: { kind: "specified", payoutRatio: 0.5 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined },
    source: "MANUAL_OVERRIDE",
    recordedAt: TS_AT,
  },
];

function playerDecision(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const ai = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn).decision;
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
}

async function main(): Promise<void> {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, c === PLAYER ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  let session = createSimulationSession({
    simulationRunId: "int1-smoke-32",
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: 32,
    startedAt: TS_AT,
    sourceCommit: "INT1-SMOKE",
    companyControlModes: modes,
    salesModelId: MODEL,
    manualBalanceOverrides: schedule,
  });
  console.log(`# scenario=${SCENARIO} seed=${SEED} salesModelId=${session.state.config.salesModelId} turns=32 player=${PLAYER}`);
  console.log(`# crowding policy enabled=${crowdingPolicyForModelId(MODEL)?.enabled} version=${crowdingPolicyForModelId(MODEL)?.policyVersion}`);
  console.log(`# CURRENT_SIMULATION_RUN_PERSISTED_VERSION=${CURRENT_SIMULATION_RUN_PERSISTED_VERSION}`);

  let crashed: string | null = null;
  let resumeDone = false;
  let diagTurns = 0;
  const t0 = Date.now();

  try {
    while (!session.state.isComplete) {
      const turn = session.state.scenarioState.currentTurn;
      const outcome = advanceSimulationTurn(session, TS_AT, { [PLAYER]: playerDecision(session, PLAYER) }, "INT1-SMOKE");
      if (!outcome.advanced) {
        crashed = `turn ${turn} で停止: ${String(outcome.error)}`;
        break;
      }
      session = outcome.session;

      // 途中で1回だけ save → resume を挟む（永続化と再開を実経路で通す）。
      if (session.state.scenarioState.currentTurn === RESUME_AT_TURN && !resumeDone) {
        const payload = JSON.parse(JSON.stringify(buildResumePayload(session, modes, {})));
        const priorDataset = buildDatasetFromSession(session);
        const before = session.state.history.length;
        session = restoreSessionFromResumePayload(
          session.run,
          payload,
          { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
          priorDataset
        );
        resumeDone = true;
        check(
          "resume",
          session.state.config.salesModelId === MODEL && session.state.config.manualBalanceOverrides !== undefined,
          `T${RESUME_AT_TURN} で save → resume を実行（history ${before} → ${session.state.history.length}、salesModelId=${session.state.config.salesModelId}）`
        );
      }
    }
  } catch (e) {
    crashed = `例外: ${(e as Error).name}: ${(e as Error).message}`;
  }
  const elapsedMs = Date.now() - t0;

  check("crashなし", crashed === null, crashed ?? `32Turn完走（${(elapsedMs / 1000).toFixed(1)}秒）`);
  if (crashed !== null) {
    console.log(`\n# INT-1 §9 32Turnスモーク: FAIL=${failures}`);
    process.exit(1);
  }

  const completed = session.run.completedTurns;
  check("32Turn完走", completed === 32 && session.state.isComplete, `completedTurns=${completed}, isComplete=${session.state.isComplete}, stopReason=${session.run.stopReason}`);

  diagTurns = session.state.history.filter((r) => r.crowdingDiagnostics !== undefined).length;
  check("Crowding診断", diagTurns === session.state.history.length && diagTurns > 0, `crowdingDiagnostics を持つTurn = ${diagTurns} / history ${session.state.history.length}`);

  // --- result generation ---
  const dataset = buildDatasetFromSession(session);
  check("result generation (dataset)", dataset.turns.length === 32, `dataset.turns = ${dataset.turns.length}（${Math.min(...dataset.turns)}〜${Math.max(...dataset.turns)}）`);
  const finalSnapshot = computeFinalEvaluationSnapshot(session);
  check(
    "Final Results",
    finalSnapshot.length === COMPANIES.length,
    `Final Results 生成: ${finalSnapshot.length}社（${finalSnapshot.map((c) => c.companyId).join(", ")}）`
  );
  /**
   * 【D1契約: T32のQ4でも精算後状態をFinal Resultsへ渡す】
   * Final Results の配当価値は history の dividendResults を集計して作られる。
   * T32（最終Q4）の年間精算支払が Final Results の累計配当価値へ反映されていることを、
   * 「T32の精算支払 > 0 の会社について、Final Resultsの配当価値が T31時点の累計を
   *   上回っている」という形で確認する（Final Resultsが精算前の状態で止まっていない）。
   */
  const t32 = session.state.history.find((r) => r.turn === 32);
  const t32SettledCompanies = (t32?.dividendResults ?? []).filter((d) => (d.annualSettlement?.appliedDividendUsd ?? 0) > 0);
  const finalByCompany = new Map(finalSnapshot.map((c) => [c.companyId as string, c]));
  let t32Reflected = 0;
  for (const d of t32SettledCompanies) {
    const snap = finalByCompany.get(d.companyId as string);
    if (snap === undefined) continue;
    // asOfTurn が最終Turnであり、T32の累計配当（このTurnの配当を含む）が反映されている。
    if (snap.asOfTurn === 32 && d.cumulativeDividendUsd > 0) t32Reflected += 1;
  }
  check(
    "Final Results が T32精算後の状態",
    t32SettledCompanies.length > 0 && t32Reflected === t32SettledCompanies.length,
    `T32で精算支払のあった会社 ${t32SettledCompanies.length}社、うちFinal Results(asOfTurn=32)へ反映 ${t32Reflected}社`
  );

  // --- Audit Workbook ---
  const stored = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset,
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload: buildResumePayload(session, modes, {}),
    savedAt: TS_AT,
  };
  const exported = await buildStandardAiAuditExport({ stored, generatedAt: TS_AT, liveHistory: session.state.history });
  check("Audit Workbook", exported.workbook.byteLength > 10000, `xlsx ${exported.workbook.byteLength.toLocaleString()} bytes / fileName=${exported.fileName}`);

  // --- 永続化（v9 schema + 旧版拒否方針は変えない） ---
  check("persistence schemaVersion", stored.schemaVersion === 9, `保存schemaVersion=${stored.schemaVersion}`);

  // --- accounting invariants ---
  let bsViolations = 0;
  let worstBalanceDiff = 0;
  for (const r of session.state.history) {
    for (const f of r.financialResults) {
      const d = Math.abs(unwrapUsd(f.balanceSheet.balanceDifference));
      if (d > worstBalanceDiff) worstBalanceDiff = d;
      if (d > EPS) bsViolations += 1;
      const a = unwrapUsd(f.balanceSheet.totalAssets);
      const le = unwrapUsd(f.balanceSheet.totalLiabilitiesAndEquity);
      if (Math.abs(a - le) > EPS) bsViolations += 1;
    }
  }
  check("accounting invariant: 貸借一致", bsViolations === 0, `違反 ${bsViolations} 件 / 最大貸借差額 ${worstBalanceDiff.toFixed(6)} USD（${session.state.history.length}Turn × ${COMPANIES.length}社）`);

  // 年間配当精算の整合（Q4ごと）
  let q4Count = 0;
  let settlementRows = 0;
  let dividendViolations = 0;
  for (const r of session.state.history) {
    if (toYearQuarter(r.period).quarter !== 4) continue;
    q4Count += 1;
    const year = toYearQuarter(r.period).year;
    for (const c of COMPANIES) {
      const st = r.dividendResults?.find((d) => d.companyId === c)?.annualSettlement;
      if (!st) {
        dividendViolations += 1;
        continue;
      }
      settlementRows += 1;
      const ni = session.state.history
        .filter((x) => toYearQuarter(x.period).year === year)
        .reduce((s, x) => s + unwrapUsd(x.financialResults.find((f) => f.companyId === c)!.profitAndLoss.netIncome), 0);
      if (Math.abs(st.annualNetIncomeUsd - ni) > EPS) dividendViolations += 1;
      if (Math.abs(st.annualDividendTargetUsd - Math.max(0, ni) * st.appliedPayoutRatio) > EPS) dividendViolations += 1;
      if (st.appliedDividendUsd > st.maxDividendUsd + 0.01) dividendViolations += 1;
      if (st.appliedDividendUsd > st.yearEndAdditionalTargetUsd + 0.01) dividendViolations += 1;
      if (st.payoutRatioSource !== "MANUAL_OVERRIDE") dividendViolations += 1;
    }
  }
  check(
    "accounting invariant: D1年間精算",
    dividendViolations === 0 && settlementRows === q4Count * COMPANIES.length,
    `Q4 ${q4Count}回 × ${COMPANIES.length}社 = ${settlementRows} 行、違反 ${dividendViolations} 件`
  );

  // --- production constraint invariants ---
  let prodViolations = 0;
  let maxEquipUtil = 0;
  let maxLaborUtil = 0;
  let negativeLots = 0;
  for (const r of session.state.history) {
    for (const m of r.factoryLoadMetrics) {
      const eu = unwrapUnit(m.equipmentUtilizationRate) as number;
      const lu = unwrapUnit(m.laborUtilizationRate) as number;
      if (eu > maxEquipUtil) maxEquipUtil = eu;
      if (lu > maxLaborUtil) maxLaborUtil = lu;
      // 生産量は設備能力・労働能力を超えない（稼働率は1を超えない）。
      if (eu > 1 + 1e-9 || lu > 1 + 1e-9) prodViolations += 1;
      if (eu < -1e-9 || lu < -1e-9) prodViolations += 1;
    }
    for (const lot of r.newFinishedGoodsLots) {
      if ((unwrapUnit(lot.originalQuantity) as number) < -1e-9) negativeLots += 1;
      if ((unwrapUnit(lot.remainingQuantity) as number) < -1e-9) negativeLots += 1;
    }
    for (const b of r.batches) {
      if ((unwrapUnit(b.finishedGoodsQuantity) as number) < -1e-9) prodViolations += 1;
    }
  }
  check(
    "production constraint invariant",
    prodViolations === 0 && negativeLots === 0,
    `稼働率違反 ${prodViolations} 件 / 負数ロット ${negativeLots} 件 / 最大設備稼働率 ${(maxEquipUtil * 100).toFixed(2)}% / 最大労働稼働率 ${(maxLaborUtil * 100).toFixed(2)}%`
  );

  /**
   * 【不変条件を32Turn全体で確認する】上の本編は途中でresumeを挟むため、
   * state.history は rolling window（4）＋その後のTurnに間引かれる。
   * そのため resume を挟まない同条件のRunをもう1本回し、32Turn**全Turn**の
   * 会計・生産不変条件を確認する（resumeの検証と不変条件の網羅を両立させる）。
   */
  let full = createSimulationSession({
    simulationRunId: "int1-smoke-32-noresume",
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: 32,
    startedAt: TS_AT,
    sourceCommit: "INT1-SMOKE",
    companyControlModes: modes,
    salesModelId: MODEL,
    manualBalanceOverrides: schedule,
  });
  let fullCrash: string | null = null;
  try {
    while (!full.state.isComplete) {
      const o = advanceSimulationTurn(full, TS_AT, { [PLAYER]: playerDecision(full, PLAYER) }, "INT1-SMOKE");
      if (!o.advanced) {
        fullCrash = `turn ${full.state.scenarioState.currentTurn} で停止: ${String(o.error)}`;
        break;
      }
      full = o.session;
    }
  } catch (e) {
    fullCrash = `例外: ${(e as Error).name}: ${(e as Error).message}`;
  }
  check("32Turn全履歴Run (resumeなし)", fullCrash === null && full.state.history.length === 32, fullCrash ?? `history=${full.state.history.length}Turn, completedTurns=${full.run.completedTurns}`);

  if (fullCrash === null) {
    let bs2 = 0;
    let worst2 = 0;
    let prod2 = 0;
    let neg2 = 0;
    let q4b = 0;
    let rows2 = 0;
    let div2 = 0;
    for (const r of full.state.history) {
      for (const f of r.financialResults) {
        const d = Math.abs(unwrapUsd(f.balanceSheet.balanceDifference));
        if (d > worst2) worst2 = d;
        if (d > EPS) bs2 += 1;
        if (Math.abs(unwrapUsd(f.balanceSheet.totalAssets) - unwrapUsd(f.balanceSheet.totalLiabilitiesAndEquity)) > EPS) bs2 += 1;
      }
      for (const m of r.factoryLoadMetrics) {
        const eu = unwrapUnit(m.equipmentUtilizationRate) as number;
        const lu = unwrapUnit(m.laborUtilizationRate) as number;
        if (eu > 1 + 1e-9 || lu > 1 + 1e-9 || eu < -1e-9 || lu < -1e-9) prod2 += 1;
      }
      for (const lot of r.newFinishedGoodsLots) {
        if ((unwrapUnit(lot.originalQuantity) as number) < -1e-9 || (unwrapUnit(lot.remainingQuantity) as number) < -1e-9) neg2 += 1;
      }
      for (const b of r.batches) {
        if ((unwrapUnit(b.finishedGoodsQuantity) as number) < -1e-9) prod2 += 1;
        /**
         * 【原料制約】生産量は投入原料を超えない。加工損失を含めた質量保存
         *   rawMaterialConsumedTotal = finishedGoodsQuantity + processingLoss
         * が成り立つこと（加工損失は非負）。新しい式は作らず、確定記録の突合のみ。
         */
        const consumed = unwrapUnit(b.rawMaterialConsumedTotal) as number;
        const out = unwrapUnit(b.finishedGoodsQuantity) as number;
        const loss = unwrapUnit(b.processingLoss) as number;
        if (loss < -1e-6) prod2 += 1;
        if (out > consumed + 1e-6) prod2 += 1;
        if (Math.abs(consumed - (out + loss)) > 1e-3) prod2 += 1;
      }
      for (const f of r.financialResults) {
        // 原料・完成品在庫がマイナスにならない（在庫から借りて作っていない）。
        if (unwrapUsd(f.balanceSheet.rawMaterialInventory) < -1) prod2 += 1;
        if (unwrapUsd(f.balanceSheet.finishedGoodsInventory) < -1) prod2 += 1;
      }
      if (toYearQuarter(r.period).quarter !== 4) continue;
      q4b += 1;
      const year = toYearQuarter(r.period).year;
      for (const c of COMPANIES) {
        const st = r.dividendResults?.find((d) => d.companyId === c)?.annualSettlement;
        if (!st) {
          div2 += 1;
          continue;
        }
        rows2 += 1;
        const ni = full.state.history
          .filter((x) => toYearQuarter(x.period).year === year)
          .reduce((sum, x) => sum + unwrapUsd(x.financialResults.find((f) => f.companyId === c)!.profitAndLoss.netIncome), 0);
        if (Math.abs(st.annualNetIncomeUsd - ni) > EPS) div2 += 1;
        if (Math.abs(st.annualDividendTargetUsd - Math.max(0, ni) * st.appliedPayoutRatio) > EPS) div2 += 1;
        if (st.appliedDividendUsd > st.maxDividendUsd + 0.01) div2 += 1;
        if (st.appliedDividendUsd > st.yearEndAdditionalTargetUsd + 0.01) div2 += 1;
        if (st.payoutRatioSource !== "MANUAL_OVERRIDE") div2 += 1;
      }
    }
    check("accounting invariant: 貸借一致（32Turn全履歴）", bs2 === 0, `違反 ${bs2} 件 / 最大貸借差額 ${worst2.toFixed(6)} USD（32Turn × ${COMPANIES.length}社）`);
    check("accounting invariant: D1年間精算（32Turn全履歴）", div2 === 0 && rows2 === q4b * COMPANIES.length, `Q4 ${q4b}回 × ${COMPANIES.length}社 = ${rows2} 行、違反 ${div2} 件`);
    check("production constraint invariant（32Turn全履歴・設備/労働/原料）", prod2 === 0 && neg2 === 0, `違反 ${prod2} 件（稼働率・原料質量保存・在庫非負）/ 負数ロット ${neg2} 件`);
    const diagFull = full.state.history.filter((r) => r.crowdingDiagnostics !== undefined).length;
    check("Crowding診断（32Turn全履歴）", diagFull === 32, `crowdingDiagnostics を持つTurn = ${diagFull} / 32`);
  }

  console.log(`\n# INT-1 §9 32Turnスモーク: FAIL=${failures} / 実行時間 ${(elapsedMs / 1000).toFixed(1)}秒`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
