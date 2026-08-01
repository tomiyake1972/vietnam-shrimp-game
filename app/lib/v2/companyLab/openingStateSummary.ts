// ShrimpX V2 — 会社ラボ「自社の状態（turn開始時点）」パネル向け 集計ヘルパー（Phase 8C-3B拡張）
//
// 【経緯】test/sai6-manual-observation-2026-08-01 の手動観察テストで、三宅さんから
// 「自己資本（純資産）が無く財政状態が理解できない」「工場能力・労働生産性・
// 営業人員のカバー範囲・原料在庫の利用可能時期が分からない」という指摘を受けた。
// これらはいずれも既存のエンジン内に真実のソースを持つ値であり、本ファイルは
// それらを**読み取り専用で集計するだけ**の純粋関数群（値の推定・再計算は行わない）。
//
// 【設計原則】
//   - 数量・金額の生成ロジック（Standard AIの判断ロジック本体、finance/production/
//     sales各モジュールの計算式）には一切手を入れず、既存の計算関数
//     （rawMaterialInventoryValueUsd・totalUnitCostPerTon・calculateFactoryEffectiveCapacity・
//     processingCapacity・salesCoverageScore・isActiveStatus）をそのまま呼び出して使う。
//   - 期首BSの合計式は finance/quarterClose.ts の期末BS算出式（totalAssets/
//     totalLiabilities/totalEquity）と同じ構成要素を、期首時点（= 前四半期末までの
//     確定値であるownState）に対して適用したものである。

import { PeriodV2, toYearQuarter } from "../core/period";
import { unwrapUnit } from "../core/units";
import { isActiveStatus } from "../capex/projectLifecycle";
import { rawMaterialInventoryValueUsd } from "../finance/initialState";
import { totalUnitCostPerTon } from "../finance/types";
import { Product } from "../market/types";
import { calculateFactoryEffectiveCapacity } from "../production/capacity";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../production/parameters";
import { Factory, FactoryEffectiveCapacity, WorkerAssignment } from "../production/types";
import { RawMaterialLot, RawMaterialLotStatus } from "../rawMaterials/types";
import { SALES_PARAMETERS_V1, SalesParameters } from "../sales/parameters";
import { processingCapacity, salesCoverageScore } from "../sales/salesForce";
import { DemandMarketId } from "../market/types";
import { SalesContract } from "../sales/types";
import { CompanyOwnState } from "./types";

// ---------------------------------------------------------------------
// 1. 期首BS（貸借対照表）サマリー — ①自己資本を含む完全な期首BS
// ---------------------------------------------------------------------

export interface OpeningBalanceSheetSummary {
  readonly cashUsd: number;
  readonly receivablesUsd: number;
  readonly rawMaterialInventoryUsd: number;
  readonly finishedGoodsInventoryUsd: number;
  readonly otherCurrentAssetsUsd: number;
  readonly fixedAssetsNetUsd: number;
  /** 建設中の設備投資案件の累計支払額（未完成・未減価償却）。capex/projectLifecycle.tsのisActiveStatusで
   *  現在進行中と判定された案件のcumulativePaidUsd合計。 */
  readonly constructionInProgressUsd: number;
  readonly totalAssetsUsd: number;

  readonly payablesUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly accruedInterestPayableUsd: number;
  readonly otherLiabilitiesUsd: number;
  readonly totalLiabilitiesUsd: number;

  readonly capitalStockUsd: number;
  readonly retainedEarningsUsd: number;
  readonly totalEquityUsd: number;

  /** totalAssetsUsd - totalLiabilitiesUsd - totalEquityUsd。開始時点では構造上ほぼ0であるはずの検算値。 */
  readonly balanceCheckDifferenceUsd: number;

  /** 融資ポートフォリオ（loanPortfolio.loans、非closedのみ）から集計した元本合計。 */
  readonly loanPortfolioPrincipalUsd: number;
  /** loanPortfolioPrincipalUsd と (shortTermLoansUsd + longTermLoansUsd) の差の絶対値。
   *  本来一致するはずの2つの独立集計元が食い違っている場合に気付けるようにするための診断値。 */
  readonly loanPortfolioMismatchUsd: number;
}

export function computeOpeningBalanceSheetSummary(ownState: CompanyOwnState): OpeningBalanceSheetSummary {
  const fs = ownState.financeState;

  const cashUsd = fs.cash as number;
  const receivablesUsd = fs.receivables.reduce((sum, r) => sum + (r.amount as number), 0);
  const payablesUsd = fs.payables.reduce((sum, p) => sum + (p.amount as number), 0);
  const rawMaterialInventoryUsd = rawMaterialInventoryValueUsd(ownState.rawMaterialLots, ownState.companyId);
  const finishedGoodsInventoryUsd = fs.finishedGoodsCostLedger.reduce(
    (sum, entry) => sum + entry.remainingQuantity * totalUnitCostPerTon(entry.unitCost),
    0
  );
  const otherCurrentAssetsUsd = fs.otherCurrentAssets as number;
  const fixedAssetsNetUsd = (fs.fixedAssetsGross as number) - (fs.accumulatedDepreciation as number);

  const activeCapexProjects = ownState.capexState.portfolio.projects.filter((p) => isActiveStatus(p.status));
  const constructionInProgressUsd = activeCapexProjects.reduce((sum, p) => sum + p.cumulativePaidUsd, 0);

  const totalAssetsUsd =
    cashUsd + receivablesUsd + rawMaterialInventoryUsd + finishedGoodsInventoryUsd + otherCurrentAssetsUsd + fixedAssetsNetUsd + constructionInProgressUsd;

  const shortTermLoansUsd = fs.shortTermLoans as number;
  const longTermLoansUsd = fs.longTermLoans as number;
  const otherLiabilitiesUsd = fs.otherLiabilities as number;
  const accruedInterestPayableUsd = ownState.financingState.accruedInterestPayableUsd;

  const totalLiabilitiesUsd = payablesUsd + shortTermLoansUsd + longTermLoansUsd + accruedInterestPayableUsd + otherLiabilitiesUsd;

  const capitalStockUsd = fs.capitalStock as number;
  const retainedEarningsUsd = fs.retainedEarnings as number;
  const totalEquityUsd = capitalStockUsd + retainedEarningsUsd;

  const balanceCheckDifferenceUsd = totalAssetsUsd - totalLiabilitiesUsd - totalEquityUsd;

  const activeLoans = ownState.financingState.loanPortfolio.loans.filter((l) => l.status !== "closed");
  const loanPortfolioPrincipalUsd = activeLoans.reduce((sum, l) => sum + l.currentPrincipalUsd, 0);
  const loanPortfolioMismatchUsd = Math.abs(loanPortfolioPrincipalUsd - (shortTermLoansUsd + longTermLoansUsd));

  return {
    cashUsd,
    receivablesUsd,
    rawMaterialInventoryUsd,
    finishedGoodsInventoryUsd,
    otherCurrentAssetsUsd,
    fixedAssetsNetUsd,
    constructionInProgressUsd,
    totalAssetsUsd,
    payablesUsd,
    shortTermLoansUsd,
    longTermLoansUsd,
    accruedInterestPayableUsd,
    otherLiabilitiesUsd,
    totalLiabilitiesUsd,
    capitalStockUsd,
    retainedEarningsUsd,
    totalEquityUsd,
    balanceCheckDifferenceUsd,
    loanPortfolioPrincipalUsd,
    loanPortfolioMismatchUsd,
  };
}

// ---------------------------------------------------------------------
// 2. Period（四半期）表示・差分ヘルパー
// ---------------------------------------------------------------------

/** to - from（四半期数）。同じ四半期なら0、1四半期先なら1。 */
export function periodDifferenceInQuarters(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year - a.year) * 4 + (b.quarter - a.quarter);
}

/** "2015Q1" → "2015年Q1"。表示専用（永続化・比較には使わない）。 */
export function periodLabel(p: PeriodV2): string {
  const { year, quarter } = toYearQuarter(p);
  return `${year}年Q${quarter}`;
}

// ---------------------------------------------------------------------
// 3. ⑤ 売掛金・買掛金の決済サイト（発生期→決済予定期の四半期ラグ）
// ---------------------------------------------------------------------

export interface SettlementLagSummary {
  readonly count: number;
  readonly minQuarters: number;
  readonly maxQuarters: number;
  /** 全件が同じラグ（四半期数）かどうか。falseの場合、単一の代表値で表示すると誤解を招く。 */
  readonly allSame: boolean;
}

export function summarizeSettlementLag(
  records: readonly { readonly originPeriod: PeriodV2; readonly dueSettlementPeriod: PeriodV2 }[]
): SettlementLagSummary | null {
  if (records.length === 0) return null;
  const lags = records.map((r) => periodDifferenceInQuarters(r.originPeriod, r.dueSettlementPeriod));
  const minQuarters = Math.min(...lags);
  const maxQuarters = Math.max(...lags);
  return { count: lags.length, minQuarters, maxQuarters, allSame: minQuarters === maxQuarters };
}

// ---------------------------------------------------------------------
// 4. ⑥ 原料在庫の利用可能時期別グルーピング
// ---------------------------------------------------------------------

export interface RawMaterialAvailabilityGroup {
  readonly availableFromPeriod: PeriodV2;
  readonly availableFromLabel: string;
  readonly quantityTons: number;
  readonly lotCount: number;
  /** このグループに含まれるロットのstatus一覧（重複排除）。輸送中・養殖中等が混在する場合は複数になる。 */
  readonly statuses: readonly RawMaterialLotStatus[];
}

/**
 * 会社の原料ロットを「利用可能開始四半期」でグルーピングする（同じ開始四半期のロットはまとめる）。
 * remainingQuantityが0のロット（消費済み・完全廃棄済み）は表示上の意味がないため除外する。
 * 開始四半期の昇順（＝今使えるものから先）でソートする。
 */
export function groupRawMaterialLotsByAvailability(
  lots: readonly RawMaterialLot[],
  companyId: CompanyOwnState["companyId"]
): readonly RawMaterialAvailabilityGroup[] {
  const groups = new Map<PeriodV2, { quantityTons: number; lotCount: number; statuses: Set<RawMaterialLotStatus> }>();
  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    const quantity = unwrapUnit(lot.remainingQuantity);
    if (quantity <= 0) continue;
    const key = lot.availableFromPeriod;
    const existing = groups.get(key);
    if (existing) {
      existing.quantityTons += quantity;
      existing.lotCount += 1;
      existing.statuses.add(lot.status);
    } else {
      groups.set(key, { quantityTons: quantity, lotCount: 1, statuses: new Set([lot.status]) });
    }
  }
  return Array.from(groups.entries())
    .map(([availableFromPeriod, v]) => ({
      availableFromPeriod,
      availableFromLabel: periodLabel(availableFromPeriod),
      quantityTons: v.quantityTons,
      lotCount: v.lotCount,
      statuses: Array.from(v.statuses),
    }))
    .sort((x, y) => (toYearQuarter(x.availableFromPeriod).year - toYearQuarter(y.availableFromPeriod).year) * 4 +
      (toYearQuarter(x.availableFromPeriod).quarter - toYearQuarter(y.availableFromPeriod).quarter));
}

// ---------------------------------------------------------------------
// 5. ① 工場能力（名目 vs 有効）
// ---------------------------------------------------------------------

export interface FactoryCapacityTonsSet {
  readonly commonProcessing: number;
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly freezingPackaging: number;
}

export interface FactoryCapacitySummary {
  readonly factoryId: string;
  /** Standard AIが判断時に参照する名目能力（フィクスチャの生値）。 */
  readonly nominal: FactoryCapacityTonsSet;
  /** 実際にエンジンが生産配分で使う有効能力（基準稼働率×設備利用可能率を適用後）。 */
  readonly effective: FactoryCapacityTonsSet;
}

/** Factory（フィクスチャの名目能力。*Capacityというフィールド名）をトンの組へ変換する。 */
function nominalTonsSetOf(factory: Factory): FactoryCapacityTonsSet {
  return {
    commonProcessing: unwrapUnit(factory.commonProcessingCapacity),
    hoso: unwrapUnit(factory.hosoCapacity),
    pd: unwrapUnit(factory.pdCapacity),
    vap: unwrapUnit(factory.vapCapacity),
    freezingPackaging: unwrapUnit(factory.freezingPackagingCapacity),
  };
}

/** FactoryEffectiveCapacity（エンジンが実際に使う有効能力）をトンの組へ変換する。 */
function effectiveTonsSetOf(capacity: FactoryEffectiveCapacity): FactoryCapacityTonsSet {
  return {
    commonProcessing: unwrapUnit(capacity.commonProcessing),
    hoso: unwrapUnit(capacity.hoso),
    pd: unwrapUnit(capacity.pd),
    vap: unwrapUnit(capacity.vap),
    freezingPackaging: unwrapUnit(capacity.freezingPackaging),
  };
}

export function computeFactoryCapacitySummaries(factories: readonly Factory[]): readonly FactoryCapacitySummary[] {
  return factories.map((factory) => ({
    factoryId: factory.factoryId,
    nominal: nominalTonsSetOf(factory),
    effective: effectiveTonsSetOf(calculateFactoryEffectiveCapacity(factory)),
  }));
}

// ---------------------------------------------------------------------
// 6. ② Worker1人あたりの生産力（商品別。工場のworkerBaselineに基づく）
// ---------------------------------------------------------------------

export interface LaborProductivityEntry {
  readonly factoryId: string;
  readonly product: Product;
  readonly skillLevel: number;
  readonly attendanceRate: number;
  /** 正社員1人あたりの生産力（HOSO換算トン/四半期。基礎効率×出勤率×技能水準。残業・設備能力上限は加味しない参考値）。 */
  readonly tonsPerRegularWorker: number;
}

const LABOR_PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export function computeLaborProductivityByProduct(
  workerBaseline: readonly Pick<WorkerAssignment, "factoryId" | "companyId" | "regularHeadcount" | "skills" | "attendanceRate">[],
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): readonly LaborProductivityEntry[] {
  const entries: LaborProductivityEntry[] = [];
  for (const w of workerBaseline) {
    const attendanceRate = unwrapUnit(w.attendanceRate);
    for (const product of LABOR_PRODUCTS) {
      const skillEntry = w.skills.find((s) => s.product === product);
      const skillLevel = skillEntry ? unwrapUnit(skillEntry.skillLevel) : 0;
      entries.push({
        factoryId: w.factoryId,
        product,
        skillLevel,
        attendanceRate,
        tonsPerRegularWorker: params.labor.regularEfficiencyPerHeadTons * attendanceRate * skillLevel,
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------
// 7. ③ 営業人員の現在の処理能力・カバレッジ（実在人数を実関数へ渡して算出）
// ---------------------------------------------------------------------

export interface SalesForceCapacitySummary {
  readonly headcountTotal: number;
  /** salesForce.tsのsalesCoverageScore(headcountTotal)。0〜1。 */
  readonly coverageScore: number;
  /** salesForce.tsのprocessingCapacity(headcountTotal)。現在の実在人数による処理能力上限（HOSO換算トン）。 */
  readonly currentProcessingCapacityTons: number;
  /** processingCapacity(headcountTotal+1) - processingCapacity(headcountTotal)。もう1人増やした場合の限界増分（トン）。逓減曲線のため線形ではない。 */
  readonly marginalCapacityTonsForOneMoreHeadcount: number;
}

export function computeSalesForceCapacitySummary(
  headcountTotal: number,
  params: SalesParameters = SALES_PARAMETERS_V1
): SalesForceCapacitySummary {
  const current = unwrapUnit(processingCapacity(headcountTotal, params));
  const plusOne = unwrapUnit(processingCapacity(headcountTotal + 1, params));
  const coverageScore = salesCoverageScore(headcountTotal, params);
  return {
    headcountTotal,
    coverageScore,
    currentProcessingCapacityTons: current,
    marginalCapacityTonsForOneMoreHeadcount: plusOne - current,
  };
}

// ---------------------------------------------------------------------
// 8. 受注残（未履行契約）の市場×商品別グルーピング
// ---------------------------------------------------------------------
//
// 【経緯】三宅さんの3回目の手動観察テストで、「受注残（未履行契約）」が集計トンの
// 単一値しか出ておらず、どの市場×商品の受注が積み上がっているのか分からない、
// という指摘を受けた。集計値そのものは既存のCompanyOwnState.contracts
// （Standard AIが実際に参照する自社の契約一覧、standardAi/policy.tsの入力そのもの）
// から導出しているため誤りではないが、単一の合計トンだけでは行動に繋がりにくい。
// ここでは同じcontractsを市場×商品でグルーピングするだけの純粋関数を追加する
// （数量・単価等の値は一切再計算しない。outstandingQuantity・dueDateの転記と
// 集計のみ）。

export interface BacklogByMarketProductEntry {
  readonly market: DemandMarketId;
  readonly product: Product;
  /** このグループの未履行数量（outstandingQuantity）合計。HOSO換算トン。 */
  readonly outstandingTons: number;
  /** outstandingQuantity > 0 の契約件数。 */
  readonly contractCount: number;
  /** このグループの中で最も近い納期（PeriodV2）。 */
  readonly nearestDueDate: PeriodV2;
  readonly nearestDueDateLabel: string;
}

/**
 * 自社契約（ownState.contracts）を市場×商品でグルーピングし、未履行数量・件数・
 * 最も近い納期を返す。outstandingQuantity <= 0（完了・キャンセル等）の契約は
 * このグルーピングの対象外とする（受注「残」という性質上、表示上の意味がないため）。
 * 合計トンの降順で返す（最も積み上がっている市場×商品から見えるようにするため）。
 */
export function computeBacklogByMarketProduct(
  contracts: readonly SalesContract[],
  companyId: CompanyOwnState["companyId"]
): readonly BacklogByMarketProductEntry[] {
  const groups = new Map<string, { market: DemandMarketId; product: Product; outstandingTons: number; contractCount: number; nearestDueDate: PeriodV2 }>();
  for (const c of contracts) {
    if (c.companyId !== companyId) continue;
    const outstanding = c.outstandingQuantity as number;
    if (outstanding <= 0) continue;
    const key = `${c.market}::${c.product}`;
    const existing = groups.get(key);
    if (existing) {
      existing.outstandingTons += outstanding;
      existing.contractCount += 1;
      if (periodDifferenceInQuarters(c.dueDate, existing.nearestDueDate) > 0) {
        existing.nearestDueDate = c.dueDate;
      }
    } else {
      groups.set(key, { market: c.market, product: c.product, outstandingTons: outstanding, contractCount: 1, nearestDueDate: c.dueDate });
    }
  }
  return Array.from(groups.values())
    .map((g) => ({ ...g, nearestDueDateLabel: periodLabel(g.nearestDueDate) }))
    .sort((a, b) => b.outstandingTons - a.outstandingTons);
}
