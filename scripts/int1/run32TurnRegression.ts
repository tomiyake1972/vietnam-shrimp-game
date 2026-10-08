/**
 * 【INT-1 §5 / §7】32Turn 技術回帰（2本）と、Turn28〜32のTSV分解。
 *
 * これは技術回帰であり、研修設定の正式採用・ゲームバランスの合格判定ではない。
 * Scenario指数・費用曲線・AI判断ロジック・P1係数は一切変更していない。
 *
 *   Run A: Dynamic Scenario 2 / tiered-v200-crowding-v1 / 全社Standard AI / 32Turn
 *          管理者による配当率・販売指数の追加指定なし
 *   Run B: Run Aと同一seed・同一モデルで、BALをPLAYER（提出経路）＋管理者配当50%
 *
 * seed は現行の決定論的テストが使っている値を固定して使う（新しい値を決めない）。
 */
import { advanceSimulationTurn, advanceSimulationTurns, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft, validateDecisionDraftNumbers } from "../../app/v2/company-lab/decisionDraft";
import { computeFinalEvaluationSnapshot } from "../../app/v2/management/lib/gameEnd";
import { crowdingPolicyForModelId } from "../../app/lib/v2/sales/salesModels";
import { toYearQuarter } from "../../app/lib/v2/core/period";
import { unwrapUsd } from "../../app/lib/v2/finance/types";
import { unwrapUnit } from "../../app/lib/v2/core/units";
import type { SimulationSession } from "../../app/lib/v2/companyLab/simulation/types";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";
import type { ManualBalanceSchedule } from "../../app/lib/v2/companyLab/manualBalance/overrides";

const TS_AT = "2026-10-07T00:00:00.000Z";
const SCENARIO = "dynamic-scenario-2";
/**
 * 【seedの根拠】Management Console の DEFAULT_SEED（app/v2/management/setup/SetupScreen.tsx）
 * であり、32Turnの決定論テスト（newFactoryWorker.test.ts 等）が使っている既存の有効値。
 * ここで新しい研修推奨seedを決めてはいないため、既存値をそのまま採用する。
 */
const SEED = "management-console-32q";
const MODEL = "tiered-v200-crowding-v1" as const;
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const PLAYER = "BAL";
const M = (n: number | null | undefined) => (n === null || n === undefined ? "未取得" : (n / 1e6).toFixed(2));
const T = (n: number | null | undefined) => (n === null || n === undefined ? "未取得" : Math.round(n).toLocaleString());

const adminPayout50: ManualBalanceSchedule = [
  {
    kind: "continuing",
    effectiveFromTurn: 1,
    settings: { dividendPayout: { kind: "specified", payoutRatio: 0.5 }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined },
    source: "MANUAL_OVERRIDE",
    recordedAt: TS_AT,
  },
];

function newSession(runId: string, players: readonly string[], schedule?: ManualBalanceSchedule): SimulationSession {
  const modes = Object.fromEntries(COMPANIES.map((c) => [c, players.includes(c) ? "PLAYER" : "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">;
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO,
    seed: SEED,
    requestedTurns: 32,
    startedAt: TS_AT,
    sourceCommit: "INT1-REG",
    companyControlModes: modes,
    salesModelId: MODEL,
    ...(schedule ? { manualBalanceOverrides: schedule } : {}),
  });
}

/**
 * 【PLAYER意思決定の生成方法（人による戦略テストではない）】
 * 画面のPLAYERが「既定ドラフトをそのまま提出する」操作を再現する。
 *   buildInitialDraft（= その期のStandard AI判断を初期値にした下書き）
 *   → validateDecisionDraftNumbers（INT-1で追加した提出前検証を必ず通す）
 *   → buildDecisionInputFromDraft（実際の提出経路と同じ変換）
 * 配当欄は一切触らない（管理者指定だけで精算されることの確認を兼ねる）。
 * これは技術回帰用の機械的な提出であり、人間の戦略判断の代替ではない。
 */
function playerDecision(session: SimulationSession, companyId: string): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const ai = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    buildPublicMarketInfo(session.state),
    session.state.currentPeriod,
    session.state.scenarioState.currentTurn
  ).decision;
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const errors = validateDecisionDraftNumbers(draft);
  if (errors.length > 0) throw new Error(`既定ドラフトが提出前検証で落ちた（バグ）: ${errors.join(" / ")}`);
  return buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
}

function runAllAi(runId: string): SimulationSession {
  return advanceSimulationTurns({ session: newSession(runId, []), turns: 32, timestamp: TS_AT, sourceCommit: "INT1-REG" });
}

function runWithPlayer(runId: string): SimulationSession {
  let s = newSession(runId, [PLAYER], adminPayout50);
  for (let i = 0; i < 32; i += 1) {
    const turn = s.state.scenarioState.currentTurn;
    const out = advanceSimulationTurn(s, TS_AT, { [PLAYER]: playerDecision(s, PLAYER) }, "INT1-REG");
    if (!out.advanced) throw new Error(`Turn ${turn} で停止: ${String(out.error)}`);
    s = out.session;
  }
  return s;
}

interface TurnRow {
  readonly turn: number;
  readonly period: string;
  readonly cash: number;
  readonly debt: number;
  readonly netIncome: number;
  readonly dividend: number;
  readonly capexPaid: number;
  readonly capexCip: number;
  readonly backlog: number;
  readonly overdue: number;
  readonly fgInventory: number;
  readonly rawInventory: number;
  readonly shortfallCompanies: number;
  readonly accountingBreaches: number;
  readonly worstBalanceDiff: number;
}

function turnRows(s: SimulationSession): readonly TurnRow[] {
  return s.state.history.map((r) => {
    let cash = 0;
    let debt = 0;
    let ni = 0;
    let breaches = 0;
    let worst = 0;
    for (const f of r.financialResults) {
      cash += unwrapUsd(f.balanceSheet.cash);
      debt += unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans);
      ni += unwrapUsd(f.profitAndLoss.netIncome);
      const d = Math.abs(unwrapUsd(f.balanceSheet.balanceDifference));
      if (d > worst) worst = d;
      if (d > 1) breaches += 1;
      if (Math.abs(unwrapUsd(f.balanceSheet.totalAssets) - unwrapUsd(f.balanceSheet.totalLiabilitiesAndEquity)) > 1) breaches += 1;
    }
    const dividend = (r.dividendResults ?? []).reduce((sum, d) => sum + d.appliedDividendUsd, 0);
    // 【投資支払】CapexQuarterResult.totalPaidThisQuarterUsd（当四半期に実際に支払えた額）。
    // events[].paymentSucceededUsd の合計と同じ意味だが、既存の集計済みフィールドを使う。
    const capexPaid = (r.capexResults ?? []).reduce((sum, c) => sum + c.totalPaidThisQuarterUsd, 0);
    const capexCip = (r.capexResults ?? []).reduce((sum, c) => sum + c.endingConstructionInProgressUsd, 0);
    let backlog = 0;
    let overdue = 0;
    let fg = 0;
    let raw = 0;
    for (const c of r.companySummaries) {
      backlog += unwrapUnit(c.outstandingQuantity) as number;
      overdue += unwrapUnit(c.overdueQuantity) as number;
      fg += unwrapUnit(c.finishedGoodsInventory) as number;
      raw += unwrapUnit(c.rawMaterialInventory) as number;
    }
    const shortfallCompanies = (r.financingResults ?? []).filter(
      (fr) => fr.financialHealth.insolvent || fr.financialHealth.paymentArrears || fr.financialHealth.paymentDefault || fr.financialHealth.usedEmergencyLoanThisPeriod
    ).length;
    const yq = toYearQuarter(r.period);
    return {
      turn: r.turn,
      period: `${yq.year}Q${yq.quarter}`,
      cash,
      debt,
      netIncome: ni,
      dividend,
      capexPaid,
      capexCip,
      backlog,
      overdue,
      fgInventory: fg,
      rawInventory: raw,
      shortfallCompanies,
      accountingBreaches: breaches,
      worstBalanceDiff: worst,
    };
  });
}

function printTurnTable(label: string, rows: readonly TurnRow[]): void {
  console.log(`\n### ${label}（5社合計・百万USD / トン）`);
  console.log("T   期     Cash     Debt    純利益   配当   投資支払 建設中   受注残   納期超過  完成品在庫 原料在庫 資金不足社数 会計不整合");
  for (const r of rows) {
    console.log(
      `${String(r.turn).padStart(2)}  ${r.period}  ${M(r.cash).padStart(8)} ${M(r.debt).padStart(8)} ${M(r.netIncome).padStart(8)} ${M(r.dividend).padStart(6)} ${M(r.capexPaid).padStart(8)} ${M(r.capexCip).padStart(7)} ` +
        `${T(r.backlog).padStart(8)} ${T(r.overdue).padStart(8)} ${T(r.fgInventory).padStart(9)} ${T(r.rawInventory).padStart(8)} ${String(r.shortfallCompanies).padStart(10)} ${String(r.accountingBreaches).padStart(10)}`
    );
  }
  const breaches = rows.reduce((s, r) => s + r.accountingBreaches, 0);
  const worst = rows.reduce((m, r) => Math.max(m, r.worstBalanceDiff), 0);
  console.log(`合計: 会計不整合 ${breaches} 件 / 最大貸借差額 ${worst.toFixed(6)} USD / 資金不足のあったTurn ${rows.filter((r) => r.shortfallCompanies > 0).length} / ${rows.length}`);
}

/** 【§7】Turn28〜32のTSV分解（取得できない内訳は「未取得」と明示する）。 */
function printTsvDecomposition(label: string, s: SimulationSession): void {
  console.log(`\n### ${label} — Turn28〜32 のTSV分解（会社別・百万USD）`);
  console.log("※ TSVは現時点では暫定的な参考指標であり、単独の勝敗判定には使わない。");
  console.log("会社   T  TSV      配当価値  会社価値  EV      現金    借入    参照CF(四半期正規化) 年換算CF 運転資金変動");
  const snapshots = computeFinalEvaluationSnapshot(s);
  for (const companyId of COMPANIES) {
    const snap = snapshots.find((x) => x.companyId === companyId);
    if (!snap) {
      console.log(`${companyId.padEnd(6)} 32 未取得（Final Results にこの会社が無い）`);
      continue;
    }
    const cv = snap.currentCompanyValue;
    /**
     * 【運転資金変動】正式な workingCapital フィールドは存在しない（grepで確認）。
     * 既存の実績から「売掛金＋在庫−買掛金」の前Turn差分として導出する
     * （新しい評価式を作らず、BSの実績値だけを使う）。
     */
    const wc = (turn: number): number | null => {
      const rec = s.state.history.find((r) => r.turn === turn);
      const f = rec?.financialResults.find((x) => x.companyId === companyId);
      if (!f) return null;
      return (
        unwrapUsd(f.balanceSheet.accountsReceivable) +
        unwrapUsd(f.balanceSheet.rawMaterialInventory) +
        unwrapUsd(f.balanceSheet.finishedGoodsInventory) -
        unwrapUsd(f.balanceSheet.accountsPayable)
      );
    };
    for (const turn of [28, 29, 30, 31, 32]) {
      const rec = s.state.history.find((r) => r.turn === turn);
      const f = rec?.financialResults.find((x) => x.companyId === companyId);
      const cur = wc(turn);
      const prev = wc(turn - 1);
      const delta = cur !== null && prev !== null ? cur - prev : null;
      const isFinal = turn === 32;
      console.log(
        `${companyId.padEnd(6)} ${turn} ` +
          `${(isFinal ? M(snap.totalShareholderValueUsd) : "（T32のみ）").padStart(8)} ` +
          `${(isFinal ? M(snap.currentDividendValueUsd) : "（T32のみ）").padStart(9)} ` +
          `${(isFinal ? M(cv.currentCompanyValueUsd) : "（T32のみ）").padStart(9)} ` +
          `${(isFinal ? M(cv.enterpriseValueUsd) : "（T32のみ）").padStart(7)} ` +
          `${M(f ? unwrapUsd(f.balanceSheet.cash) : null).padStart(7)} ` +
          `${M(f ? unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans) : null).padStart(7)} ` +
          `${(isFinal ? M(cv.normalizedQuarterlyCashFlowUsd) : "（T32のみ）").padStart(19)} ` +
          `${(isFinal ? M(cv.annualizedCashFlowUsd) : "（T32のみ）").padStart(8)} ` +
          `${M(delta).padStart(12)}`
      );
    }
  }
  console.log("※ TSV・配当価値・会社価値・EV・参照CFは asOfTurn=32 の1点のみ算出される指標（Turn別の内訳は未取得）。");
  console.log("※ 運転資金変動 = (売掛金＋原料在庫＋完成品在庫−買掛金) の前Turn差分。BS実績からの導出であり、評価式は変更していない。");
}

function main(): void {
  console.log(`# INT-1 §5 32Turn 技術回帰（研修設定の正式採用・バランス合格判定ではない）`);
  console.log(`# scenario=${SCENARIO} / seed=${SEED}（既存の決定論テストが使う有効値） / salesModelId=${MODEL}`);
  const policy = crowdingPolicyForModelId(MODEL);
  console.log(`# crowding: enabled=${policy?.enabled} version=${policy?.policyVersion} threshold=${policy?.byProduct.hoso.threshold} lambda=${policy?.byProduct.hoso.lambda} gamma=${policy?.byProduct.hoso.gamma} floor=${policy?.byProduct.hoso.floor} protectedExternalShare=${policy?.protectedExternalShare.hoso}`);

  console.log(`\n## Run A: 全社Standard AI / 管理者の追加指定なし`);
  const a = runAllAi("int1-reg-a");
  console.log(`completedTurns=${a.run.completedTurns} / stopReason=${a.run.stopReason} / history=${a.state.history.length}Turn / crowding診断=${a.state.history.filter((r) => r.crowdingDiagnostics !== undefined).length}Turn`);
  const rowsA = turnRows(a);
  printTurnTable("Run A", rowsA);
  printTsvDecomposition("Run A", a);

  console.log(`\n## Run B: BAL=PLAYER（提出経路）＋ 管理者配当50% / 同一seed・同一モデル`);
  const b = runWithPlayer("int1-reg-b");
  console.log(`completedTurns=${b.run.completedTurns} / stopReason=${b.run.stopReason} / history=${b.state.history.length}Turn / crowding診断=${b.state.history.filter((r) => r.crowdingDiagnostics !== undefined).length}Turn`);
  const rowsB = turnRows(b);
  printTurnTable("Run B", rowsB);
  printTsvDecomposition("Run B", b);

  console.log(`\n## D1 年間配当精算（Run B・Q4のみ）`);
  console.log("T   期     会社   年間NI    適用率  年間目標  既払    追加目標  実支払  未達     理由              出所");
  for (const r of b.state.history) {
    if (toYearQuarter(r.period).quarter !== 4) continue;
    const yq = toYearQuarter(r.period);
    for (const c of COMPANIES) {
      const st = r.dividendResults?.find((d) => d.companyId === c)?.annualSettlement;
      if (!st) {
        console.log(`${String(r.turn).padStart(2)}  ${yq.year}Q4  ${c.padEnd(6)} 精算recordなし`);
        continue;
      }
      console.log(
        `${String(r.turn).padStart(2)}  ${yq.year}Q4  ${c.padEnd(6)} ${M(st.annualNetIncomeUsd).padStart(8)} ${String(st.appliedPayoutRatio).padStart(6)} ${M(st.annualDividendTargetUsd).padStart(8)} ${M(st.paidDividendEarlierInYearUsd).padStart(6)} ${M(st.yearEndAdditionalTargetUsd).padStart(8)} ${M(st.appliedDividendUsd).padStart(6)} ${M(st.annualDividendShortfallUsd).padStart(7)} ${(st.shortfallReason ?? "-").padEnd(28)} ${st.payoutRatioSource}`
      );
    }
  }

  const breachesA = rowsA.reduce((s, r) => s + r.accountingBreaches, 0);
  const breachesB = rowsB.reduce((s, r) => s + r.accountingBreaches, 0);
  console.log(`\n# 会計不整合: Run A ${breachesA} 件 / Run B ${breachesB} 件`);
  process.exit(breachesA === 0 && breachesB === 0 ? 0 : 1);
}

main();
