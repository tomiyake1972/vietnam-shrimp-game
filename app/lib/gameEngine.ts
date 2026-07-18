import { CompanyId } from "./gameData";
import { CompanyDecision, CompanyState, CompanyTurnResult } from "./gameTypes";

// All monetary constants are $/kg unless noted; company financials are tracked in $M.
const MARKET_PRICE_PER_KG: Record<string, number> = {
  "EU（バルク）": 3.8,
  "日本（VAP）": 8.5,
  "米国（バルク）": 3.6,
  "国内（スポット）": 3.2,
};
const PROCUREMENT_PRICE_PER_KG: Record<string, number> = { spot: 2.3, contract: 1.9 };
const FARMING_COST_PER_KG = 1.5;
const PROCESSING_COST_PER_KG = 0.4;
const BULK_RAW_PER_PRODUCT_TON = 1.3; // tons of raw material per ton of bulk product
const VAP_RAW_PER_PRODUCT_TON = 2.5; // tons of raw material per ton of VAP product
const OVERHEAD_BASE_M = 1.2; // $M/quarter fixed overhead
const OVERHEAD_PER_CAPACITY_TON = 0.00005; // $M/quarter per ton of processing capacity
const INTEREST_RATE_QUARTERLY = 0.02;
const DEFAULT_EQUITY_RAISE_GOOD_CREDIT_M = 10;
const DEFAULT_EQUITY_RAISE_POOR_CREDIT_M = 5;
const EQUITY_RAISE_CREDIT_THRESHOLD = 60;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// tons/kg $ helper: quantity in tons, price in $/kg -> $M
function tonsAtPricePerKgToM(tons: number, pricePerKg: number): number {
  return (tons * pricePerKg) / 1000;
}

export function resolveCompanyTurn(
  companyId: CompanyId,
  state: CompanyState,
  year: number,
  quarter: number,
  decision: CompanyDecision | undefined
): CompanyTurnResult {
  const notes: string[] = [];
  const submitted = decision !== undefined;
  const phases = decision?.phases ?? {};

  if (!submitted) {
    notes.push("意思決定が未提出のため既定値（保守的な運用）を適用しました。");
  }

  const maxFarmingInput = state.farmingArea * 5;
  const farmingInputRequested = submitted ? num(phases["phase2_farming"], 0) : state.farmingArea * 3;
  const farmingInput = Math.min(farmingInputRequested, maxFarmingInput);
  if (farmingInputRequested > maxFarmingInput) {
    notes.push(`養殖投入量が上限(${maxFarmingInput.toLocaleString()}t)を超えたため上限に調整しました。`);
  }

  const procurementQty = submitted ? num(phases["phase3_procurement"], 0) : 0;
  const procurementSource = phases["phase3_source"] === "contract" ? "contract" : "spot";
  const procurementPricePerKg = PROCUREMENT_PRICE_PER_KG[procurementSource];

  const rawMaterialAvailable = farmingInput + procurementQty;
  const rawMaterialUsed = Math.min(rawMaterialAvailable, state.processingCapacity);
  if (rawMaterialAvailable > state.processingCapacity) {
    notes.push(`加工能力(${state.processingCapacity.toLocaleString()}t/Q)を超える原料は在庫繰越されず未加工のまま失われました。`);
  }

  const vapRatioPct = Math.min(100, Math.max(0, submitted ? num(phases["phase4_vap_ratio"], 30) : 30));
  const rawToVap = rawMaterialUsed * (vapRatioPct / 100);
  const rawToBulk = rawMaterialUsed - rawToVap;
  const bulkOutput = rawToBulk / BULK_RAW_PER_PRODUCT_TON;
  const vapOutput = rawToVap / VAP_RAW_PER_PRODUCT_TON;

  let bulkRemaining = bulkOutput;
  let vapRemaining = vapOutput;
  const salesByMarket: Record<string, number> = {};
  let revenue = 0;
  for (const market of Object.keys(MARKET_PRICE_PER_KG)) {
    // 未提出時の既定値：バルクは国内スポット市場で全量販売、VAPは日本市場で全量販売。
    // （提出なし＝「保守的な継続運転」= 既存ルートで売り切る）
    const defaultQty = !submitted
      ? (market === "国内（スポット）" ? bulkRemaining : market === "日本（VAP）" ? vapRemaining : 0)
      : 0;
    const requested = submitted ? num(phases[`phase5_${market}`], 0) : defaultQty;
    const isVap = market.includes("VAP");
    const available = isVap ? vapRemaining : bulkRemaining;
    const sold = Math.min(requested, available);
    if (isVap) vapRemaining -= sold;
    else bulkRemaining -= sold;
    salesByMarket[market] = round2(sold);
    revenue += tonsAtPricePerKgToM(sold, MARKET_PRICE_PER_KG[market]);
  }
  if (bulkRemaining > 0.01 || vapRemaining > 0.01) {
    notes.push(`未販売の製品（バルク${bulkRemaining.toFixed(0)}t / VAP${vapRemaining.toFixed(0)}t）は在庫繰越されず機会損失となりました。`);
  }

  const farmingCost = tonsAtPricePerKgToM(farmingInput, FARMING_COST_PER_KG);
  const procurementCost = tonsAtPricePerKgToM(procurementQty, procurementPricePerKg);
  const processingCost = tonsAtPricePerKgToM(rawMaterialUsed, PROCESSING_COST_PER_KG);
  const cogs = round2(farmingCost + procurementCost);

  const debtBefore = state.totalAssets - state.equity;
  const interestExpense = round2(debtBefore * INTEREST_RATE_QUARTERLY);
  const overhead = round2(OVERHEAD_BASE_M + state.processingCapacity * OVERHEAD_PER_CAPACITY_TON);

  const netIncome = round2(revenue - cogs - processingCost - interestExpense - overhead);

  const borrow = submitted ? num(phases["phase6_borrow"], 0) : 0;
  const repayRequested = submitted ? num(phases["phase6_repay"], 0) : 0;
  const repay = Math.min(repayRequested, Math.max(debtBefore, 0));
  if (repayRequested > repay) {
    notes.push("返済希望額が残債務を上回ったため、残債務までの返済としました。");
  }

  const equityRaiseRequested = phases["phase6_equity"] ?? "";
  let equityInjection = 0;
  if (submitted && equityRaiseRequested !== "") {
    equityInjection =
      state.creditScore >= EQUITY_RAISE_CREDIT_THRESHOLD
        ? DEFAULT_EQUITY_RAISE_GOOD_CREDIT_M
        : DEFAULT_EQUITY_RAISE_POOR_CREDIT_M;
    notes.push(`増資（${equityRaiseRequested}）が承認され $${equityInjection}M を調達しました。`);
  }

  const cash = round2(state.cash + netIncome + borrow - repay + equityInjection);
  const equity = round2(state.equity + netIncome + equityInjection);
  const totalAssets = round2(state.totalAssets + netIncome + borrow - repay + equityInjection);
  const debtAfter = Math.max(0, round2(debtBefore + borrow - repay));
  const debtEquityRatio = equity > 0 ? round2(debtAfter / equity) : 99;

  let creditScoreDelta = 0;
  creditScoreDelta += netIncome > 0 ? 2 : -3;
  if (cash < 0) creditScoreDelta -= 10;
  creditScoreDelta += debtEquityRatio > state.debtEquityRatio ? -2 : 1;
  const creditScore = Math.max(0, Math.min(100, Math.round(state.creditScore + creditScoreDelta)));

  if (cash < 0) {
    notes.push("⚠️ 現金がマイナスになりました。資金繰りに注意してください。");
  }

  // BS詳細の四半期更新（equipmentGrossが設定されている場合のみ）
  const bsDetail: Partial<CompanyState> = {};
  if (state.equipmentGross !== undefined) {
    // 売掛金: 当期売上の1/3（30日回収サイト＝90日クォーターの1/3が未回収）
    const newAR = round2(revenue / 3);
    // 原料・製品在庫: エンジン上は期末ゼロだがBSの連続性のため期首値を維持
    const newRawInv = state.rawInventory ?? 0;
    const newFinInv = state.finishedInventory ?? 0;
    // 建物: 年5%（四半期1.25%）の定額償却
    const newBldgNet = round2((state.buildingsNet ?? 0) * 0.9875);
    // 設備: 総額固定。純額はtotalAssetsからの逆算（BS恒等式を常に保証）
    const equipGross = state.equipmentGross;
    const plugEquipNet = round2(totalAssets - cash - newAR - newRawInv - newFinInv - newBldgNet);
    const newAccumDepr = round2(equipGross - plugEquipNet);
    // 買掛金: 農業費＋調達費の30%（30日支払サイト）
    const newAP = round2((farmingCost + procurementCost) * 0.3);
    // 短期・長期借入金: 買掛金控除後の負債を3:7に分割
    const adjDebt = Math.max(0, round2(debtAfter - newAP));
    const newSTL = round2(adjDebt * 0.3);
    const newLTL = round2(adjDebt - newSTL);
    // 資本金: 増資があれば増加
    const newPIC = round2((state.paidInCapital ?? 0) + equityInjection);

    bsDetail.accountsReceivable = newAR;
    bsDetail.rawInventory = newRawInv;
    bsDetail.finishedInventory = newFinInv;
    bsDetail.buildingsNet = newBldgNet;
    bsDetail.equipmentGross = equipGross;
    bsDetail.accumulatedDepreciation = newAccumDepr;
    bsDetail.accountsPayable = newAP;
    bsDetail.shortTermLoans = newSTL;
    bsDetail.longTermLoans = newLTL;
    bsDetail.paidInCapital = newPIC;
  }

  const stateAfter: CompanyState = {
    cash,
    totalAssets,
    equity,
    debtEquityRatio,
    creditScore,
    farmingArea: state.farmingArea,
    processingCapacity: state.processingCapacity,
    ...bsDetail,
  };

  return {
    companyId,
    year,
    quarter,
    submitted,
    revenue: round2(revenue),
    cogs,
    processingCost: round2(processingCost),
    interestExpense,
    overhead,
    netIncome,
    rawMaterialAvailable: round2(rawMaterialAvailable),
    rawMaterialUsed: round2(rawMaterialUsed),
    productOutput: { bulk: round2(bulkOutput), vap: round2(vapOutput) },
    salesByMarket,
    stateBefore: state,
    stateAfter,
    notes,
  };
}

export function nextQuarter(year: number, quarter: number): { year: number; quarter: number } {
  return quarter >= 4 ? { year: year + 1, quarter: 1 } : { year, quarter: quarter + 1 };
}
