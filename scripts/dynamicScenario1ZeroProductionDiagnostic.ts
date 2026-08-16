#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — ゼロ生産に陥る会社の診断（read-only、#05 引き渡し用）
//
// Dynamic Scenario 1 では T7 の原料ショック以降、5社のうち2社（MASS / VAP）が
// 成約・生産ともに 0 のまま32ターン回復しない。損益が毎四半期ほぼ一定の赤字
// （固定費のみ）になっており、「経営が苦しい」ではなく「操業が止まっている」。
//
// これは Scenario 側の設計問題ではなく、Standard AI / 生産採算判断側の検討事項
// として #05 へ引き渡す。本スクリプトはそのための事実だけを出力する。
// **AI policy は一切変更していない。**

import { runCompanyLab, DS1_SAI5_FLAGS } from "./_dynamicScenario1Harness";
import { calculateLandedPrice } from "../app/lib/v2/rawMaterials/imports";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../app/lib/v2/rawMaterials/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";

const scenarioId = process.argv[2] ?? "dynamic-scenario-1";
const seed = process.argv[3] ?? "ds1-benchmark";
const result = runCompanyLab({ scenarioId, seed, turns: 32, sai5: DS1_SAI5_FLAGS });

console.log(`# ゼロ生産診断 — scenario=${scenarioId} seed=${seed} completed=${result.completedTurns}/32`);

// どの会社がいつ止まったか
console.log("\n## 1. 操業停止の発生時点（生産量が0になった最初のターン）");
console.log(["company", "初回生産0ターン", "初回成約0ターン", "初回現金マイナスターン", "32Q累計営業利益"].join("\t"));
for (const fixture of result.fixtures) {
  const id = fixture.companyId;
  let firstZeroProd: number | string = "-";
  let firstZeroContract: number | string = "-";
  let firstNegCash: number | string = "-";
  let cumOp = 0;
  for (const h of result.state.history) {
    const s = h.companySummaries.find((c) => c.companyId === id);
    const fin = h.financialResults.find((f) => f.companyId === id);
    if (fin) cumOp += Number(fin.profitAndLoss.operatingProfit);
    if (!s) continue;
    const produced = unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced);
    if (produced <= 0 && firstZeroProd === "-") firstZeroProd = h.turn;
    if (unwrapUnit(s.newContractedQuantity) <= 0 && firstZeroContract === "-") firstZeroContract = h.turn;
    if (fin && Number(fin.balanceSheet.cash) < 0 && firstNegCash === "-") firstNegCash = h.turn;
  }
  console.log([id, firstZeroProd, firstZeroContract, firstNegCash, Math.round(cumOp).toLocaleString()].join("\t"));
}

// 停止前後の詳細（#04 が指定した診断項目）
const STALLED = result.fixtures
  .map((f) => f.companyId)
  .filter((id) =>
    result.state.history.slice(-4).every((h) => {
      const s = h.companySummaries.find((c) => c.companyId === id);
      if (!s) return false;
      return unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced) <= 0;
    })
  );

console.log(`\n## 2. 停止した会社の詳細（${STALLED.join(", ") || "なし"}）`);
console.log(
  [
    "turn","company","国内原料価格","IN着地","EC着地","国内買付希望","国内買付実績","輸入到着","原料在庫",
    "生産量","成約量","受注残","現金","有利子負債","営業利益","原料不足","設備稼働率","理由コード",
  ].join("\t")
);
for (const h of result.state.history) {
  const dom = unwrapUnit(h.marketResult.vietnamDomestic.price);
  const inL = unwrapUnit(calculateLandedPrice(h.marketResult.hosoPrices.IN.price, "IN", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  const ecL = unwrapUnit(calculateLandedPrice(h.marketResult.hosoPrices.EC.price, "EC", RAW_MATERIALS_PARAMETERS_V1).landedPrice);
  for (const id of STALLED) {
    const s = h.companySummaries.find((c) => c.companyId === id);
    const fin = h.financialResults.find((f) => f.companyId === id);
    const decision = h.decisions.find((d) => d.companyId === id);
    if (!s) continue;
    const produced = unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced);
    const debt = fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : 0;
    // 当期の理由コードのうち、この会社に紐づくものを最大3件まで。
    const reasons = s.reasonCodes.slice(0, 3).map((r) => r.code).join("|");
    console.log(
      [
        h.turn,
        id,
        dom.toFixed(3),
        inL.toFixed(3),
        ecL.toFixed(3),
        decision ? Math.round(unwrapUnit(decision.domesticPurchasePlan.desiredQuantity)) : "-",
        Math.round(unwrapUnit(s.domesticPurchaseQuantity)),
        Math.round(unwrapUnit(s.importArrivedQuantity)),
        Math.round(unwrapUnit(s.rawMaterialInventory)),
        Math.round(produced),
        Math.round(unwrapUnit(s.newContractedQuantity)),
        Math.round(unwrapUnit(s.outstandingQuantity)),
        fin ? Math.round(Number(fin.balanceSheet.cash)) : "-",
        Math.round(debt),
        fin ? Math.round(Number(fin.profitAndLoss.operatingProfit)) : "-",
        Math.round(unwrapUnit(s.rawMaterialShortfall)),
        unwrapUnit(s.equipmentUtilizationRate).toFixed(3),
        reasons || "-",
      ].join("\t")
    );
  }
}

// 販売計画がそもそも提出されているか（needs vs 提示）
console.log("\n## 3. 停止会社の販売計画・生産計画の提出状況");
console.log(["turn", "company", "販売計画件数", "販売希望合計", "生産計画件数", "生産希望合計", "営業人員"].join("\t"));
for (const h of result.state.history) {
  for (const id of STALLED) {
    const d = h.decisions.find((x) => x.companyId === id);
    if (!d) continue;
    console.log(
      [
        h.turn,
        id,
        d.salesPlans.length,
        Math.round(d.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0)),
        d.productionPlans.length,
        Math.round(d.productionPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0)),
        d.salesPlans.reduce((s, p) => s + p.salesForceHeadcount, 0),
      ].join("\t")
    );
  }
}
