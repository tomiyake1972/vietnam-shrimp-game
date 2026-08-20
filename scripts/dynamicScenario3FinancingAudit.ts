// ShrimpX V2 — DS3: 運転資金・銀行与信・調達ゲートの経路監査（読み取り専用）
//
// #08 事前報告 項目2「DS3で生産が頭打ちになるまでの資金・原料・生産の処理経路」
// を実測するための診断。ゲームロジック・シナリオ定義・保存データは一切変更しない。
//
// 目的は3原因の分離:
//   (1) 資金不足        … procurementConstraint.scaleRatio < 1
//   (2) 原料の物理的不足 … scaleRatio = 1 なのに国内調達が希望に届かない／原料在庫が枯渇
//   (3) Standard AI判断  … 与信枠(availableAdditionalCapacityUsd)が余っているのに
//                          借入希望(underwriting.requestedAmountUsd)を出していない
//
//   npx tsx scripts/dynamicScenario3FinancingAudit.ts
//   SEEDS=ds3-a,ds3-b COMPANIES=MASS,BAL npx tsx scripts/dynamicScenario3FinancingAudit.ts
//   SUMMARY=1 npx tsx scripts/dynamicScenario3FinancingAudit.ts

import { createSimulationSession, advanceSimulationTurn } from "../app/lib/v2/companyLab/simulation/engine";
import { SimulationSession } from "../app/lib/v2/companyLab/simulation/types";
import { DYNAMIC_SCENARIO_3 } from "../app/lib/v2/scenario/definitions/dynamicScenario3";
import { unwrapUnit } from "../app/lib/v2/core/units";

const SCENARIO_ID = process.env.SCENARIO ?? DYNAMIC_SCENARIO_3.scenarioId;
const SEEDS = (process.env.SEEDS ?? "ds3-a").split(",");
const COMPANIES = (process.env.COMPANIES ?? "MASS,BAL,JPQ,VAP,CONSV").split(",");
const TURNS = Number(process.env.TURNS ?? 32);
const SUMMARY_ONLY = process.env.SUMMARY === "1";
const AT = "2026-01-01T00:00:00.000Z";

const M = (v: number) => (v / 1e6).toFixed(1);
const n0 = (v: number) => Math.round(v).toLocaleString();
const pct = (v: number) => (v * 100).toFixed(1);

interface Row {
  seed: string;
  company: string;
  turn: number;
  tier: string;
  grossLimit: number;
  existingLoan: number;
  availableCapacity: number;
  binding: string;
  frozen: boolean;
  requested: number;
  approved: number;
  denied: number;
  loanDraw: number;
  cash: number;
  scaleRatio: number;
  plannedCashNeed: number;
  availableLiquidity: number;
  wantTons: number;
  gotTons: number;
  importBlocked: boolean;
  domesticPurchased: number;
  importArrived: number;
  rawInventory: number;
  produced: number;
  capacity: number;
  fgInventory: number;
  backlog: number;
  rawShortfall: number;
  equipShortfall: number;
  laborShortfall: number;
  operatingProfit: number;
  equity: number;
}

const rows: Row[] = [];

for (const seed of SEEDS) {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: `ds3-fin-audit-${seed}`,
    scenarioId: SCENARIO_ID,
    seed,
    requestedTurns: TURNS,
    startedAt: AT,
  });

  for (let t = 0; t < TURNS; t++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) break;
    session = outcome.session;
    const turn = t + 1;
    const record = session.state.history[session.state.history.length - 1];

    for (const company of COMPANIES) {
      const fin = record.financialResults.find((r) => r.companyId === company);
      const summary = record.companySummaries.find((s) => s.companyId === company);
      const financing = record.financingResults.find((r) => r.companyId === company);
      const decision = record.decisions.find((d) => d.companyId === company);
      const cap = session.capacityByTurn.find((x) => x.turn === turn && x.companyId === company);
      if (!fin || !summary || !financing) continue;

      const bc = financing.borrowingCapacity;
      const pc = financing.procurementConstraint;
      const uw = financing.underwriting;
      const produced =
        unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced);
      const backlog = unwrapUnit(summary.outstandingQuantity);

      rows.push({
        seed,
        company,
        turn,
        tier: financing.creditScore.tier,
        grossLimit: bc.grossLimitUsd,
        existingLoan: bc.existingLoanBalanceUsd,
        availableCapacity: bc.availableAdditionalCapacityUsd,
        binding: bc.bindingConstraint,
        frozen: bc.underwritingFrozen,
        requested: uw.requestedAmountUsd,
        approved: uw.approvedAmountUsd,
        denied: uw.deniedAmountUsd,
        loanDraw: financing.loanDrawUsd,
        cash: Number(fin.balanceSheet.cash),
        scaleRatio: pc ? pc.scaleRatio : 1,
        plannedCashNeed: pc ? pc.plannedCashNeedUsd : 0,
        availableLiquidity: pc ? pc.availableLiquidityUsd : 0,
        wantTons: pc ? pc.originalDomesticPurchaseQuantityTons : 0,
        gotTons: pc ? pc.constrainedDomesticPurchaseQuantityTons : 0,
        importBlocked: pc ? pc.importOrdersBlocked : false,
        domesticPurchased: unwrapUnit(summary.domesticPurchaseQuantity),
        importArrived: unwrapUnit(summary.importArrivedQuantity),
        rawInventory: unwrapUnit(summary.rawMaterialInventory),
        produced,
        capacity: cap ? Math.min(cap.hoso + cap.pd + cap.vap, cap.commonProcessing) : 0,
        fgInventory: unwrapUnit(summary.finishedGoodsInventory),
        backlog,
        rawShortfall: unwrapUnit(summary.rawMaterialShortfall),
        equipShortfall: unwrapUnit(summary.equipmentShortfall),
        laborShortfall: unwrapUnit(summary.laborShortfall),
        operatingProfit: Number(fin.profitAndLoss.operatingProfit),
        equity: Number(fin.balanceSheet.totalEquity),
        // decisionは診断出力では使わないが、AI希望額の突き合わせ用に残す
        ...(decision ? {} : {}),
      });
    }
  }
}

if (!SUMMARY_ONLY) {
  for (const seed of SEEDS) {
    for (const company of COMPANIES) {
      const sub = rows.filter((r) => r.seed === seed && r.company === company);
      if (sub.length === 0) continue;
      console.log(`\n${"=".repeat(168)}`);
      console.log(`=== ${company} 資金→原料→生産 経路（scenario=${SCENARIO_ID} / seed=${seed}）`);
      console.log("=".repeat(168));
      console.log(
        "  Turn 与信 総枠M 既存借入M 余枠M  binding          希望借入M 承認M 実行M  現金M | 希望調達t 必要資金M 使える資金M 縮小率  実調達t | 国内t 輸入t 原料在庫t 生産t 能力t 原料不足t 設備不足t 労務不足t 受注残t 営利M"
      );
      for (const r of sub) {
        console.log(
          `  T${String(r.turn).padEnd(3)}` +
            String(r.tier + (r.frozen ? "*" : "")).padStart(4) +
            M(r.grossLimit).padStart(7) +
            M(r.existingLoan).padStart(10) +
            M(r.availableCapacity).padStart(7) +
            "  " +
            r.binding.padEnd(17) +
            M(r.requested).padStart(9) +
            M(r.approved).padStart(6) +
            M(r.loanDraw).padStart(6) +
            M(r.cash).padStart(7) +
            " |" +
            n0(r.wantTons).padStart(10) +
            M(r.plannedCashNeed).padStart(10) +
            M(r.availableLiquidity).padStart(12) +
            (pct(r.scaleRatio) + "%").padStart(8) +
            n0(r.gotTons).padStart(9) +
            " |" +
            n0(r.domesticPurchased).padStart(7) +
            n0(r.importArrived).padStart(6) +
            n0(r.rawInventory).padStart(10) +
            n0(r.produced).padStart(7) +
            n0(r.capacity).padStart(6) +
            n0(r.rawShortfall).padStart(10) +
            n0(r.equipShortfall).padStart(10) +
            n0(r.laborShortfall).padStart(10) +
            n0(r.backlog).padStart(8) +
            M(r.operatingProfit).padStart(7)
        );
      }
    }
  }
}

// ---- 3原因の分離サマリ -------------------------------------------------
console.log(`\n${"=".repeat(168)}`);
console.log("=== 3原因分離サマリ（Turn 9-32、全seed平均。scaleRatio<0.999 を資金ゲート発動とみなす）");
console.log("=".repeat(168));
console.log(
  "  会社   資金ゲート発動Q数 平均縮小率 資金不足で失った原料t | 与信余枠が余っていたQ数 平均余枠M 借入希望0だったQ数 | 平均稼働率 平均原料在庫t 平均受注残t"
);
for (const company of COMPANIES) {
  const sub = rows.filter((r) => r.company === company && r.turn >= 9);
  if (sub.length === 0) continue;
  const gated = sub.filter((r) => r.scaleRatio < 0.999);
  const lostTons = sub.reduce((a, r) => a + Math.max(0, r.wantTons - r.gotTons), 0) / SEEDS.length;
  const slack = sub.filter((r) => r.availableCapacity > 1e6);
  const noRequest = sub.filter((r) => r.requested < 1e3);
  const util = sub.reduce((a, r) => a + (r.capacity > 0 ? Math.min(1, r.produced / r.capacity) : 0), 0) / sub.length;
  console.log(
    `  ${company.padEnd(6)}` +
      String(gated.length).padStart(14) +
      (gated.length > 0 ? (pct(gated.reduce((a, r) => a + r.scaleRatio, 0) / gated.length) + "%").padStart(11) : "-".padStart(11)) +
      n0(lostTons).padStart(20) +
      " |" +
      String(slack.length).padStart(21) +
      M(sub.reduce((a, r) => a + r.availableCapacity, 0) / sub.length).padStart(10) +
      String(noRequest.length).padStart(18) +
      " |" +
      (pct(util) + "%").padStart(11) +
      n0(sub.reduce((a, r) => a + r.rawInventory, 0) / sub.length).padStart(13) +
      n0(sub.reduce((a, r) => a + r.rawShortfall, 0) / sub.length).padStart(13) +
      n0(sub.reduce((a, r) => a + r.backlog, 0) / sub.length).padStart(12)
  );
}

// ---- 資金ゲート発動Qの内訳（なぜ資金が足りなかったのか） ---------------
console.log(`${"=".repeat(168)}`);
console.log("=== 資金ゲート発動Q（scaleRatio<0.999）の内訳。Turn 9-32・全seed合算");
console.log("=".repeat(168));
console.log(
  "  会社   発動Q数 | 与信凍結 与信枠ゼロ(<1M) 銀行が減額(承認<希望) AIが希望を出さず(希望<1k) AI希望不足(希望>0だが不足額未満) | 不足額の平均M"
);
for (const company of COMPANIES) {
  const gated = rows.filter((r) => r.company === company && r.turn >= 9 && r.scaleRatio < 0.999);
  if (gated.length === 0) {
    console.log(`  ${company.padEnd(6)}` + "0".padStart(8) + "   （資金ゲートの発動なし）");
    continue;
  }
  const frozen = gated.filter((r) => r.frozen).length;
  const noCapacity = gated.filter((r) => !r.frozen && r.availableCapacity < 1e6).length;
  const bankCut = gated.filter((r) => !r.frozen && r.availableCapacity >= 1e6 && r.approved < r.requested - 1e3).length;
  const noRequest = gated.filter((r) => !r.frozen && r.availableCapacity >= 1e6 && r.requested < 1e3).length;
  const shortRequest = gated.filter(
    (r) =>
      !r.frozen &&
      r.availableCapacity >= 1e6 &&
      r.requested >= 1e3 &&
      r.approved >= r.requested - 1e3 &&
      r.approved < r.plannedCashNeed - r.availableLiquidity + r.approved - 1e3
  ).length;
  const avgGap = gated.reduce((a, r) => a + Math.max(0, r.plannedCashNeed - r.availableLiquidity), 0) / gated.length;
  console.log(
    `  ${company.padEnd(6)}` +
      String(gated.length).padStart(8) +
      " |" +
      String(frozen).padStart(9) +
      String(noCapacity).padStart(16) +
      String(bankCut).padStart(22) +
      String(noRequest).padStart(26) +
      String(shortRequest).padStart(33) +
      " |" +
      M(avgGap).padStart(14)
  );
}
console.log("");
