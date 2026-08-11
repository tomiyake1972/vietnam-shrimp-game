// ShrimpX V2 — Standard AI Strategic Posture Phase H: 定量ベンチマーク。
//
// 【位置づけ】本番コードは一切変更しない。DEFAULT_COMPANY_VISION_DOCUMENTS
// （実体はMap。ReadonlyMapはTS型だけの制約でランタイムはmutable）を、この
// スクリプトの中だけで対象会社の strategicPosture を書き換えた「別の
// Visionドキュメント」に一時的に差し替え、シミュレーションを実行してから
// 必ず元に戻す。createSimulationSession/advanceSimulationTurns/
// buildDatasetFromSessionは既存のセッションAPIをそのまま呼ぶだけであり、
// ベンチマーク専用の計算式はapp/lib/v2/companyLab/simulation/benchmarkKpis.ts
// の純粋関数（テスト済み）だけに閉じている。
//
// 実行: npx tsx scripts/strategicPostureQuantBenchmark.ts
// 出力: docs/standard_ai/benchmarks/strategic_posture_phase_h_results.csv
//       docs/standard_ai/benchmarks/strategic_posture_phase_h_summary.md

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationSession } from "../app/lib/v2/companyLab/simulation/types";
import { buildDatasetFromSession } from "../app/lib/v2/companyLab/simulation/analytics/dataset";
import { DEFAULT_COMPANY_VISION_DOCUMENTS } from "../app/lib/v2/companyLab/vision/defaults";
import { CompanyVisionDocument } from "../app/lib/v2/companyLab/vision/types";

/** このベンチマークで比較する2つのpostureだけに限定した型（VALUE_FIRSTはPhase Hの対象外）。 */
type BenchmarkProfile = "AGGRESSIVE_EARLY_CAPACITY" | "DEMAND_CONFIRMED";
import {
  averageOf,
  classifyOutcome,
  maximumOf,
  minimumOf,
  pairRuns,
  postFactoryUtilization,
  RunRow,
  sumSeries,
  TurnValue,
} from "../app/lib/v2/companyLab/simulation/benchmarkKpis";

const AT = "2026-01-01T00:00:00.000Z";

const SCENARIOS = ["baseline", "ecuador-early-expansion", "ecuador-delayed-expansion", "global-disease-crisis", "global-demand-boom"];
const SEEDS = [
  "management-console-32q",
  "management-console-32q-seed2",
  "management-console-32q-seed3",
  "management-console-32q-seed4",
  "management-console-32q-seed5",
];
const COMPANIES = ["BAL", "MASS"];
const PROFILES: readonly BenchmarkProfile[] = ["AGGRESSIVE_EARLY_CAPACITY", "DEMAND_CONFIRMED"];

/** DEFAULT_COMPANY_VISION_DOCUMENTSはReadonlyMap型だが実体はMap（ランタイムはmutable）。 */
const mutableVisionDocuments = DEFAULT_COMPANY_VISION_DOCUMENTS as Map<string, CompanyVisionDocument>;

function withCompanyPosture<T>(companyId: string, posture: BenchmarkProfile, fn: () => T): T {
  const original = mutableVisionDocuments.get(companyId);
  if (!original) throw new Error(`Vision未設定の会社: ${companyId}`);
  const patched: CompanyVisionDocument = {
    ...original,
    visions: original.visions.map((v) => ({ ...v, strategicPosture: posture })),
  };
  mutableVisionDocuments.set(companyId, patched);
  try {
    return fn();
  } finally {
    mutableVisionDocuments.set(companyId, original);
  }
}

function metricSeries(dataset: ReturnType<typeof buildDatasetFromSession>, companyId: string, metric: string): TurnValue[] {
  return dataset.companyMetrics.filter((f) => f.companyId === companyId && f.metric === metric && f.value !== null).map((f) => ({ turn: f.turn, value: f.value as number }));
}

function valueAtOrNull(series: readonly TurnValue[], turn: number): number | null {
  return series.find((tv) => tv.turn === turn)?.value ?? null;
}

/** その会社が新工場建設案件（newFactoryConstruction）を最初に提案したturnと、完成したturn。 */
function findFactoryTimeline(session: SimulationSession, companyId: string): { proposalTurn: number | null; completionTurn: number | null } {
  const turns = session.packCompanyTurns.filter((t) => t.companyId === companyId).sort((a, b) => a.turn - b.turn);
  let proposalTurn: number | null = null;
  let completionTurn: number | null = null;
  const seenProjectIds = new Set<string>();
  for (const t of turns) {
    for (const project of t.capitalProjects) {
      if (project.projectType !== "newFactoryConstruction") continue;
      if (!seenProjectIds.has(project.projectId)) {
        seenProjectIds.add(project.projectId);
        if (proposalTurn === null) proposalTurn = t.turn;
      }
      if (project.status === "completed" && completionTurn === null) completionTurn = t.turn;
    }
  }
  return { proposalTurn, completionTurn };
}

function decisionRouteAtProposal(session: SimulationSession, companyId: string, proposalTurn: number | null): string | null {
  if (proposalTurn === null) return null;
  const entry = session.packCompanyTurns.find((t) => t.companyId === companyId && t.turn === proposalTurn);
  return entry?.strategy.newFactory?.status === "READY_TO_BUILD" ? entry.strategy.newFactory.decisionRoute : null;
}

function reactiveStatusAssertionHolds(session: SimulationSession, companyId: string, proposalTurn: number | null): boolean | null {
  if (proposalTurn === null) return null;
  const entry = session.packCompanyTurns.find((t) => t.companyId === companyId && t.turn === proposalTurn);
  const nf = entry?.strategy.newFactory;
  if (!nf || nf.decisionRoute !== "STRATEGIC_FORWARD_CAPACITY") return null;
  return nf.reactiveStatusAtStrategicDecision !== "READY_TO_BUILD";
}

function runOne(scenario: string, seed: string, targetCompany: string, profile: BenchmarkProfile): { row: RunRow; assertionHolds: boolean | null } {
  const session = withCompanyPosture(targetCompany, profile, () => {
    let s = createSimulationSession({
      simulationRunId: `qbench-${scenario}-${seed}-${targetCompany}-${profile}`,
      scenarioId: scenario,
      seed,
      requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
      startedAt: AT,
    });
    s = advanceSimulationTurns({ session: s, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });
    return s;
  });

  const dataset = buildDatasetFromSession(session);
  const op = metricSeries(dataset, targetCompany, "operatingProfit");
  const cash = metricSeries(dataset, targetCompany, "cash");
  const debt = metricSeries(dataset, targetCompany, "debt");
  const common = metricSeries(dataset, targetCompany, "commonCapacity");
  const hoso = metricSeries(dataset, targetCompany, "hosoProduced");
  const pd = metricSeries(dataset, targetCompany, "pdProduced");
  const vap = metricSeries(dataset, targetCompany, "vapProduced");
  const contracted = metricSeries(dataset, targetCompany, "newContractedQuantity");
  const finishedGoods = metricSeries(dataset, targetCompany, "finishedGoodsInventory");
  const backlog = metricSeries(dataset, targetCompany, "outstandingQuantity");

  const productionTotal: TurnValue[] = hoso.map((h) => {
    const t = h.turn;
    return { turn: t, value: h.value + (valueAtOrNull(pd, t) ?? 0) + (valueAtOrNull(vap, t) ?? 0) };
  });
  // 稼働率 = 実際の生産 ÷ 共通前処理実効能力（Standard AIのGate Hと同じ分母。SSoTを再利用）。
  const utilization: TurnValue[] = productionTotal
    .map((p) => {
      const cap = valueAtOrNull(common, p.turn);
      return cap !== null && cap > 0 ? { turn: p.turn, value: p.value / cap } : null;
    })
    .filter((v): v is TurnValue => v !== null);

  const { proposalTurn, completionTurn } = findFactoryTimeline(session, targetCompany);
  const decisionRoute = decisionRouteAtProposal(session, targetCompany, proposalTurn);
  const assertionHolds = reactiveStatusAssertionHolds(session, targetCompany, proposalTurn);

  const minCash = minimumOf(cash);
  const maxDebt = maximumOf(debt);
  const distressQuarters = cash.filter((c) => c.value < 0).length;

  // 【§9】投資前後だけを切り出した窓（proposal-4Q 〜 completion+4Q、無ければ
  // proposal-4Q〜run末）でのCash底値・Debt山値。BALは32Q通しての最小Cash・最大Debtが
  // 投資よりずっと前の無関係なイベント（turn5の一時的な落ち込み等）で決まってしまい、
  // 新工場投資の効果がrun全体の最小・最大に埋もれて見えなくなることが実測で判明した
  // （両profileで完全に同じturn5の値が最小Cashになる）。そのため、投資固有の効果を
  // 見るための窓付き指標を別途持つ（run全体の最小・最大は「経営全体のリスク床」として
  // そのまま残す）。
  let investmentWindowMinCashUsd: number | null = null;
  let investmentWindowMaxDebtUsd: number | null = null;
  if (proposalTurn !== null) {
    const windowStart = Math.max(1, proposalTurn - 4);
    const windowEnd = (completionTurn ?? proposalTurn) + 4;
    const cashWindow = cash.filter((c) => c.turn >= windowStart && c.turn <= windowEnd);
    const debtWindow = debt.filter((d) => d.turn >= windowStart && d.turn <= windowEnd);
    investmentWindowMinCashUsd = minimumOf(cashWindow)?.value ?? null;
    investmentWindowMaxDebtUsd = maximumOf(debtWindow)?.value ?? null;
  }

  const row: RunRow = {
    scenario,
    seed,
    company: targetCompany,
    profile,
    firstFactoryProposalTurn: proposalTurn,
    decisionRoute,
    factoryCompletionTurn: completionTurn,
    cumulativeOperatingProfitUsd: sumSeries(op),
    minimumCashUsd: minCash?.value ?? null,
    peakDebtUsd: maxDebt?.value ?? null,
    averageUtilization: averageOf(utilization),
    contractsQ32: valueAtOrNull(contracted, 32),
    productionQ32: valueAtOrNull(productionTotal, 32),
    maxFinishedGoodsTons: maximumOf(finishedGoods)?.value ?? null,
    maxBacklogTons: maximumOf(backlog)?.value ?? null,
    distressQuarters,
  };

  // 完成後utilization・投資窓Cash/Debtは、CSVの補助列として別途保持する
  // （RunRowは既存型のためここでは計算のみ。pairRuns/classifyOutcomeはこれらを使わない
  // ＝run全体のminCash/peakDebtによる分類基準は変えない）。
  (row as unknown as { _postFactoryUtil?: unknown })._postFactoryUtil = postFactoryUtilization(utilization, completionTurn);
  (row as unknown as { _investmentWindow?: unknown })._investmentWindow = { investmentWindowMinCashUsd, investmentWindowMaxDebtUsd };

  return { row, assertionHolds };
}

function main() {
  const rows: RunRow[] = [];
  const postFactoryUtilByKey = new Map<string, { q1: number | null; q2: number | null; q4: number | null }>();
  const investmentWindowByKey = new Map<string, { investmentWindowMinCashUsd: number | null; investmentWindowMaxDebtUsd: number | null }>();
  const assertionFailures: string[] = [];
  const demandConfirmedUsedStrategic: string[] = [];

  let runCount = 0;
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      for (const company of COMPANIES) {
        for (const profile of PROFILES) {
          runCount += 1;
          const { row, assertionHolds } = runOne(scenario, seed, company, profile);
          rows.push(row);
          const key = `${scenario}::${seed}::${company}::${profile}`;
          postFactoryUtilByKey.set(key, (row as unknown as { _postFactoryUtil: { q1: number | null; q2: number | null; q4: number | null } })._postFactoryUtil);
          investmentWindowByKey.set(
            key,
            (row as unknown as { _investmentWindow: { investmentWindowMinCashUsd: number | null; investmentWindowMaxDebtUsd: number | null } })._investmentWindow
          );
          if (profile === "AGGRESSIVE_EARLY_CAPACITY" && assertionHolds === false) {
            assertionFailures.push(`${scenario}/${seed}/${company}: strategic提案時にreactiveがREADY_TO_BUILDだった（§34違反）`);
          }
          if (profile === "DEMAND_CONFIRMED" && row.decisionRoute === "STRATEGIC_FORWARD_CAPACITY") {
            demandConfirmedUsedStrategic.push(`${scenario}/${seed}/${company}`);
          }
          process.stderr.write(
            `[${runCount}/${SCENARIOS.length * SEEDS.length * COMPANIES.length * PROFILES.length}] ${scenario} ${seed} ${company} ${profile}: proposal=${row.firstFactoryProposalTurn} route=${row.decisionRoute}\n`
          );
        }
      }
    }
  }

  const pairs = pairRuns(rows);
  const classified = pairs.map((p) => ({ pair: p, classification: classifyOutcome(p) }));

  const commitSha = (() => {
    try {
      return execSync("git rev-parse HEAD", { cwd: __dirname + "/.." }).toString().trim();
    } catch {
      return "unknown";
    }
  })();

  mkdirSync("docs/standard_ai/benchmarks", { recursive: true });

  // --- CSV: run-level rows ---
  const csvHeader = [
    "scenario", "seed", "company", "profile", "firstFactoryProposalTurn", "decisionRoute", "factoryCompletionTurn",
    "cumulativeOperatingProfitUsd", "minimumCashUsd", "peakDebtUsd", "averageUtilization",
    "contractsQ32", "productionQ32", "maxFinishedGoodsTons", "maxBacklogTons", "distressQuarters",
    "postFactoryUtilQ1", "postFactoryUtilQ2", "postFactoryUtilQ4",
    "investmentWindowMinCashUsd", "investmentWindowMaxDebtUsd",
  ];
  const csvLines = [csvHeader.join(",")];
  for (const row of rows) {
    const key = `${row.scenario}::${row.seed}::${row.company}::${row.profile}`;
    const u = postFactoryUtilByKey.get(key);
    const w = investmentWindowByKey.get(key);
    csvLines.push(
      [
        row.scenario, row.seed, row.company, row.profile, row.firstFactoryProposalTurn ?? "", row.decisionRoute ?? "", row.factoryCompletionTurn ?? "",
        row.cumulativeOperatingProfitUsd.toFixed(0), row.minimumCashUsd?.toFixed(0) ?? "", row.peakDebtUsd?.toFixed(0) ?? "", row.averageUtilization?.toFixed(4) ?? "",
        row.contractsQ32 ?? "", row.productionQ32?.toFixed(0) ?? "", row.maxFinishedGoodsTons?.toFixed(0) ?? "", row.maxBacklogTons?.toFixed(0) ?? "", row.distressQuarters,
        u?.q1?.toFixed(4) ?? "", u?.q2?.toFixed(4) ?? "", u?.q4?.toFixed(4) ?? "",
        w?.investmentWindowMinCashUsd?.toFixed(0) ?? "", w?.investmentWindowMaxDebtUsd?.toFixed(0) ?? "",
      ].join(",")
    );
  }
  writeFileSync("docs/standard_ai/benchmarks/strategic_posture_phase_h_results.csv", csvLines.join("\n") + "\n");

  // --- Pair CSV ---
  const pairCsvHeader = [
    "scenario", "seed", "company", "strategicLeadTurns", "classification",
    "aggProposalTurn", "dcProposalTurn", "aggCompletionTurn", "dcCompletionTurn",
    "deltaCumulativeOP", "deltaContractsQ32", "deltaProductionQ32", "deltaMinCash", "deltaPeakDebt",
    "deltaInvestmentWindowMinCash", "deltaInvestmentWindowMaxDebt",
  ];
  const pairCsvLines = [pairCsvHeader.join(",")];
  for (const { pair, classification } of classified) {
    const aw = investmentWindowByKey.get(`${pair.scenario}::${pair.seed}::${pair.company}::AGGRESSIVE_EARLY_CAPACITY`);
    const dw = investmentWindowByKey.get(`${pair.scenario}::${pair.seed}::${pair.company}::DEMAND_CONFIRMED`);
    const deltaWindowMinCash =
      aw?.investmentWindowMinCashUsd !== undefined && aw?.investmentWindowMinCashUsd !== null && dw?.investmentWindowMinCashUsd !== undefined && dw?.investmentWindowMinCashUsd !== null
        ? aw.investmentWindowMinCashUsd - dw.investmentWindowMinCashUsd
        : null;
    const deltaWindowMaxDebt =
      aw?.investmentWindowMaxDebtUsd !== undefined && aw?.investmentWindowMaxDebtUsd !== null && dw?.investmentWindowMaxDebtUsd !== undefined && dw?.investmentWindowMaxDebtUsd !== null
        ? aw.investmentWindowMaxDebtUsd - dw.investmentWindowMaxDebtUsd
        : null;
    pairCsvLines.push(
      [
        pair.scenario, pair.seed, pair.company, pair.strategicLeadTurns ?? "", classification,
        pair.aggressive.firstFactoryProposalTurn ?? "", pair.demandConfirmed.firstFactoryProposalTurn ?? "",
        pair.aggressive.factoryCompletionTurn ?? "", pair.demandConfirmed.factoryCompletionTurn ?? "",
        pair.deltaCumulativeOperatingProfitUsd.toFixed(0), pair.deltaContractsQ32 ?? "", pair.deltaProductionQ32?.toFixed(0) ?? "",
        pair.deltaMinimumCashUsd?.toFixed(0) ?? "", pair.deltaPeakDebtUsd?.toFixed(0) ?? "",
        deltaWindowMinCash?.toFixed(0) ?? "", deltaWindowMaxDebt?.toFixed(0) ?? "",
      ].join(",")
    );
  }
  writeFileSync("docs/standard_ai/benchmarks/strategic_posture_phase_h_pairs.csv", pairCsvLines.join("\n") + "\n");

  // --- Markdown summary ---
  const advantageCount = classified.filter((c) => c.classification === "AGGRESSIVE_ADVANTAGE").length;
  const mixedCount = classified.filter((c) => c.classification === "MIXED").length;
  const disadvantageCount = classified.filter((c) => c.classification === "AGGRESSIVE_DISADVANTAGE").length;
  const noDiffCount = classified.filter((c) => c.classification === "NO_MEANINGFUL_DIFFERENCE").length;

  const byCompany = (companyId: string) => classified.filter((c) => c.pair.company === companyId);
  const leadTurnsOf = (list: typeof classified) => list.map((c) => c.pair.strategicLeadTurns).filter((v): v is number => v !== null);

  const md: string[] = [];
  md.push("# Standard AI Strategic Posture — Phase H 定量ベンチマーク結果");
  md.push("");
  md.push(`commit: \`${commitSha}\``);
  md.push(`generated by: scripts/strategicPostureQuantBenchmark.ts`);
  md.push(`scenarios: ${SCENARIOS.join(", ")}`);
  md.push(`seeds: ${SEEDS.join(", ")}`);
  md.push(`companies: ${COMPANIES.join(", ")}`);
  md.push(`runs: ${rows.length} (pairs: ${pairs.length})`);
  md.push("");
  md.push("## 分類集計");
  md.push("");
  md.push(`- AGGRESSIVE_ADVANTAGE: ${advantageCount}`);
  md.push(`- MIXED: ${mixedCount}`);
  md.push(`- AGGRESSIVE_DISADVANTAGE: ${disadvantageCount}`);
  md.push(`- NO_MEANINGFUL_DIFFERENCE: ${noDiffCount}`);
  md.push("");
  md.push(
    "**注記（deltaMinCash/deltaPeakDebt=0が多いことについて）**: BALはCash/Debtが潤沢な状態で新工場に投資するため、run全体の最小Cash・最大Debtが新工場投資よりずっと前（例: turn5前後の一時的な落ち込み・初期借入）で決まり、両profileで完全に一致することがある。これは実測結果であり、run全体のmin/maxが投資の効果を隠してしまう。投資固有の効果は`investmentWindowMinCashUsd`/`investmentWindowMaxDebtUsd`（proposal-4Q〜completion+4Qの窓）と、pairs CSVの`deltaInvestmentWindowMinCash`/`deltaInvestmentWindowMaxDebt`列を参照。"
  );
  md.push("");
  for (const company of COMPANIES) {
    const list = byCompany(company);
    const leads = leadTurnsOf(list);
    md.push(`## ${company} summary`);
    md.push("");
    md.push(`- pairs: ${list.length}`);
    md.push(`- strategicLeadTurns: avg=${leads.length ? (leads.reduce((a, b) => a + b, 0) / leads.length).toFixed(1) : "n/a"}, min=${leads.length ? Math.min(...leads) : "n/a"}, max=${leads.length ? Math.max(...leads) : "n/a"}`);
    md.push(`- classification: ADVANTAGE=${list.filter((c) => c.classification === "AGGRESSIVE_ADVANTAGE").length} MIXED=${list.filter((c) => c.classification === "MIXED").length} DISADVANTAGE=${list.filter((c) => c.classification === "AGGRESSIVE_DISADVANTAGE").length} NO_DIFF=${list.filter((c) => c.classification === "NO_MEANINGFUL_DIFFERENCE").length}`);
    md.push("");
    md.push("| scenario | seed | lead(Q) | class | ΔOP(USD) | Δcontracts(t) | ΔminCash(USD) | ΔpeakDebt(USD) |");
    md.push("|---|---|---|---|---|---|---|---|");
    for (const { pair, classification } of list) {
      md.push(
        `| ${pair.scenario} | ${pair.seed} | ${pair.strategicLeadTurns ?? "n/a"} | ${classification} | ${pair.deltaCumulativeOperatingProfitUsd.toFixed(0)} | ${pair.deltaContractsQ32 ?? "n/a"} | ${pair.deltaMinimumCashUsd?.toFixed(0) ?? "n/a"} | ${pair.deltaPeakDebtUsd?.toFixed(0) ?? "n/a"} |`
      );
    }
    md.push("");
  }

  md.push("## §34/§35 assertion結果");
  md.push("");
  md.push(`- AGGRESSIVE run中、strategic提案時にreactiveがREADY_TO_BUILDだった違反件数: ${assertionFailures.length}`);
  for (const f of assertionFailures) md.push(`  - ${f}`);
  md.push(`- DEMAND_CONFIRMED runがstrategic routeを使った件数（0であるべき）: ${demandConfirmedUsedStrategic.length}`);
  for (const f of demandConfirmedUsedStrategic) md.push(`  - ${f}`);
  md.push("");

  writeFileSync("docs/standard_ai/benchmarks/strategic_posture_phase_h_summary.md", md.join("\n") + "\n");

  console.log(`done. rows=${rows.length} pairs=${pairs.length}`);
  console.log(`assertionFailures=${assertionFailures.length} demandConfirmedUsedStrategic=${demandConfirmedUsedStrategic.length}`);
}

main();
