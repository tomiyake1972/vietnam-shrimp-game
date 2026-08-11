// ShrimpX V2 — Strategic Posture Phase H: 定量ベンチマークの純粋計算ヘルパー。
//
// 【位置づけ】ここは本番のゲームロジック・Standard AI判断には一切使われない。
// scripts/strategicPostureQuantBenchmark.ts がシミュレーションを実行して集めた
// 時系列（長さ32Qの{turn, value}配列）を受け取り、集計・pairing・分類だけを行う
// 純粋関数の集合である。app/lib配下に置くのは既存のnpm test（tsx --test
// "app/lib/**/__tests__/**/*.test.ts"）でユニットテストできるようにするため。

export interface TurnValue {
  readonly turn: number;
  readonly value: number;
}

/** 時系列の合計（値が無いturnは0扱いではなく単純にスキップする＝存在しないターンを捏造しない）。 */
export function sumSeries(series: readonly TurnValue[]): number {
  return series.reduce((acc, tv) => acc + tv.value, 0);
}

export interface TurnValueOrNull {
  readonly turn: number;
  readonly value: number;
}

/** 系列中の最小値とそのturn。系列が空ならnull。 */
export function minimumOf(series: readonly TurnValue[]): TurnValueOrNull | null {
  if (series.length === 0) return null;
  return series.reduce((best, tv) => (tv.value < best.value ? tv : best), series[0]);
}

/** 系列中の最大値とそのturn。系列が空ならnull。 */
export function maximumOf(series: readonly TurnValue[]): TurnValueOrNull | null {
  if (series.length === 0) return null;
  return series.reduce((best, tv) => (tv.value > best.value ? tv : best), series[0]);
}

/** 単純平均。系列が空ならnull（0と混同しない）。 */
export function averageOf(series: readonly TurnValue[]): number | null {
  if (series.length === 0) return null;
  return sumSeries(series) / series.length;
}

/**
 * 新工場完成turn（completionTurn）を起点に、+1/+2/+4四半期後の稼働率を系列から拾う。
 * その turn の値が系列に存在しなければ null（無い物を0や直近値で埋めない）。
 */
export function postFactoryUtilization(
  utilizationSeries: readonly TurnValue[],
  completionTurn: number | null
): { readonly q1: number | null; readonly q2: number | null; readonly q4: number | null } {
  if (completionTurn === null) return { q1: null, q2: null, q4: null };
  const at = (offset: number) => utilizationSeries.find((tv) => tv.turn === completionTurn + offset)?.value ?? null;
  return { q1: at(1), q2: at(2), q4: at(4) };
}

/**
 * strategicLeadTurns = DEMAND_CONFIRMEDが（同一条件のpair runで）実際に提案した turn
 * − AGGRESSIVEが提案した turn。
 * DEMAND_CONFIRMED側が32Q以内に一度も提案しなかった場合は null（「32Qより大きい」を
 * 捏造しない。呼び出し側はUIで「32Q以内では未発火」と表示する）。
 */
export function strategicLeadTurns(aggressiveProposalTurn: number | null, demandConfirmedProposalTurn: number | null): number | null {
  if (aggressiveProposalTurn === null || demandConfirmedProposalTurn === null) return null;
  return demandConfirmedProposalTurn - aggressiveProposalTurn;
}

export interface RunRow {
  readonly scenario: string;
  readonly seed: string;
  readonly company: string;
  readonly profile: "AGGRESSIVE_EARLY_CAPACITY" | "DEMAND_CONFIRMED";
  readonly firstFactoryProposalTurn: number | null;
  readonly decisionRoute: string | null;
  readonly factoryCompletionTurn: number | null;
  readonly cumulativeOperatingProfitUsd: number;
  readonly minimumCashUsd: number | null;
  readonly peakDebtUsd: number | null;
  readonly averageUtilization: number | null;
  readonly contractsQ32: number | null;
  readonly productionQ32: number | null;
  readonly maxFinishedGoodsTons: number | null;
  readonly maxBacklogTons: number | null;
  readonly distressQuarters: number;
}

export interface PairRow {
  readonly scenario: string;
  readonly seed: string;
  readonly company: string;
  readonly aggressive: RunRow;
  readonly demandConfirmed: RunRow;
  readonly strategicLeadTurns: number | null;
  readonly deltaCumulativeOperatingProfitUsd: number;
  readonly deltaContractsQ32: number | null;
  readonly deltaProductionQ32: number | null;
  readonly deltaMinimumCashUsd: number | null;
  readonly deltaPeakDebtUsd: number | null;
}

/**
 * 【BENCH-H1】同一 scenario/seed/company の AGGRESSIVE行・DEMAND_CONFIRMED行を
 * ペアにする。片方しか無い組み合わせはペアにしない（欠けたデータで比較を捏造しない）。
 */
export function pairRuns(rows: readonly RunRow[]): readonly PairRow[] {
  const byKey = new Map<string, { aggressive?: RunRow; demandConfirmed?: RunRow }>();
  for (const row of rows) {
    const key = `${row.scenario}::${row.seed}::${row.company}`;
    const entry = byKey.get(key) ?? {};
    if (row.profile === "AGGRESSIVE_EARLY_CAPACITY") entry.aggressive = row;
    else entry.demandConfirmed = row;
    byKey.set(key, entry);
  }
  const pairs: PairRow[] = [];
  for (const [, entry] of byKey) {
    if (!entry.aggressive || !entry.demandConfirmed) continue;
    const a = entry.aggressive;
    const d = entry.demandConfirmed;
    pairs.push({
      scenario: a.scenario,
      seed: a.seed,
      company: a.company,
      aggressive: a,
      demandConfirmed: d,
      strategicLeadTurns: strategicLeadTurns(a.firstFactoryProposalTurn, d.firstFactoryProposalTurn),
      deltaCumulativeOperatingProfitUsd: a.cumulativeOperatingProfitUsd - d.cumulativeOperatingProfitUsd,
      deltaContractsQ32: a.contractsQ32 !== null && d.contractsQ32 !== null ? a.contractsQ32 - d.contractsQ32 : null,
      deltaProductionQ32: a.productionQ32 !== null && d.productionQ32 !== null ? a.productionQ32 - d.productionQ32 : null,
      deltaMinimumCashUsd: a.minimumCashUsd !== null && d.minimumCashUsd !== null ? a.minimumCashUsd - d.minimumCashUsd : null,
      deltaPeakDebtUsd: a.peakDebtUsd !== null && d.peakDebtUsd !== null ? a.peakDebtUsd - d.peakDebtUsd : null,
    });
  }
  return pairs;
}

export type OutcomeClassification = "AGGRESSIVE_ADVANTAGE" | "MIXED" | "AGGRESSIVE_DISADVANTAGE" | "NO_MEANINGFUL_DIFFERENCE";

const MEANINGFUL_RATIO = 0.02; // ±2%未満の差は「意味のある差」として数えない（ノイズと区別する最小限の閾値）。

/**
 * 【BENCH-H6】単一KPIだけで判定しない（指示§15）。cumulativeOP・contracts/production・
 * minimumCash・peakDebtの4指標それぞれについて「AGGRESSIVE優位／DEMAND_CONFIRMED優位／
 * 差なし」の符号を取り、優位方向の数で分類する。
 *   - 4指標のうち「AGGRESSIVE優位」が「DEMAND_CONFIRMED優位」を上回り、かつ差なし以外が
 *     1つ以上あれば ADVANTAGE 寄り。両方が混在すれば MIXED。全指標が差なしなら
 *     NO_MEANINGFUL_DIFFERENCE。
 */
export function classifyOutcome(pair: PairRow): OutcomeClassification {
  const signals: (1 | 0 | -1)[] = [];

  const pushRatioSignal = (delta: number | null, baseline: number) => {
    if (delta === null) return;
    const base = Math.abs(baseline) > 1 ? Math.abs(baseline) : 1;
    const ratio = delta / base;
    if (Math.abs(ratio) < MEANINGFUL_RATIO) signals.push(0);
    else signals.push(ratio > 0 ? 1 : -1);
  };

  pushRatioSignal(pair.deltaCumulativeOperatingProfitUsd, pair.demandConfirmed.cumulativeOperatingProfitUsd);
  pushRatioSignal(pair.deltaContractsQ32, pair.demandConfirmed.contractsQ32 ?? 0);
  pushRatioSignal(pair.deltaProductionQ32, pair.demandConfirmed.productionQ32 ?? 0);
  // Cash・Debtは「AGGRESSIVEが多く使う／多く借りる」ことがコストであり、
  // 経営指標として悪化方向（Cashは減る＝マイナス、Debtは増える＝プラス）を
  // 「AGGRESSIVEにとって不利な符号」として反転させる。
  if (pair.deltaMinimumCashUsd !== null) {
    const base = Math.abs(pair.demandConfirmed.minimumCashUsd ?? 0) > 1 ? Math.abs(pair.demandConfirmed.minimumCashUsd ?? 1) : 1;
    const ratio = pair.deltaMinimumCashUsd / base;
    if (Math.abs(ratio) >= MEANINGFUL_RATIO) signals.push(ratio > 0 ? 1 : -1);
    else signals.push(0);
  }
  if (pair.deltaPeakDebtUsd !== null) {
    const base = Math.abs(pair.demandConfirmed.peakDebtUsd ?? 0) > 1 ? Math.abs(pair.demandConfirmed.peakDebtUsd ?? 1) : 1;
    const ratio = pair.deltaPeakDebtUsd / base;
    if (Math.abs(ratio) >= MEANINGFUL_RATIO) signals.push(ratio > 0 ? -1 : 1);
    else signals.push(0);
  }

  const advantageCount = signals.filter((s) => s === 1).length;
  const disadvantageCount = signals.filter((s) => s === -1).length;

  if (advantageCount === 0 && disadvantageCount === 0) return "NO_MEANINGFUL_DIFFERENCE";
  if (advantageCount > 0 && disadvantageCount > 0) return "MIXED";
  return advantageCount > disadvantageCount ? "AGGRESSIVE_ADVANTAGE" : "AGGRESSIVE_DISADVANTAGE";
}
