// AMM-DUE-1..4 / AMM-CAP-1..6（AMM-M2.5・実装指示§10）— Due-Date Grounding Enforcement /
// Capacity Pool Semantics。
//
// 【背景】Test26系の新規BAL Turn1「現状を分析してください」で、COO/CFO/Commercialが
// 揃って、overdueTons=0のfuture backlog（US HOSO 1,443.43t・OTHER HOSO 814.04t、
// いずれも2015Q2納期＝次四半期）を「期限オーバー」「CAPEX・人員増が必要」と誤って
// 説明した。COOはさらに、14,107.5t（HOSO 6,840+PD 5,985+VAP 1,282.5の商品別ライン
// 合計）を「会社全体の実効生産能力」と呼び、common preprocessing（25,650t）・
// freezing/packing（25,650t）という遥かに大きい別poolの存在を無視した。
// 本テストは、backlogSemantics.ts（due status）・capacitySemantics.ts（capacity
// pools）・dueWordingGuard.ts（strong wording guard）・prompt.tsがこれらを
// server-side deterministicに、かつ強い語彙ガードとして防止することを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBacklogDueStatus, computeBacklogSemantics } from "../backlogSemantics";
import { buildCapacityPools, buildRawMaterialAvailabilityFact } from "../capacitySemantics";
import { findOverdueWordingViolations } from "../dueWordingGuard";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "../prompt";
import { RULE_SEMANTICS } from "../briefing";
import { SalesContract } from "../../../sales/types";

function contract(overrides: Partial<SalesContract>): SalesContract {
  return {
    contractId: "c1",
    companyId: "BAL",
    market: "US",
    product: "hoso",
    contractedPeriod: "2015Q1" as never,
    dueDate: "2015Q2" as never,
    originalQuantity: 100 as never,
    outstandingQuantity: 100 as never,
    unitPrice: 3.5 as never,
    status: "active" as never,
    ...overrides,
  } as SalesContract;
}

test("AMM-DUE-1: overdue=0の場合、応答テキストに禁止語彙があれば検知される（訂正文脈は除外）", () => {
  const violation = findOverdueWordingViolations(["未納期限オーバー4,400t以上あります。"], 0);
  assert.ok(violation.length > 0, "overdueTons=0なのに「期限オーバー」を使えば検知されるべき");

  const clean = findOverdueWordingViolations(["8,988tはforward backlogであり、次四半期の履行義務です。"], 0);
  assert.equal(clean.length, 0);

  // overdueTons>0なら判定対象外（本物のoverdueを説明する語彙まで禁止しない）。
  const notApplicable = findOverdueWordingViolations(["100tが期限オーバーです。"], 50);
  assert.equal(notApplicable.length, 0);

  // 訂正文脈（否定表現の近傍）は除外する。
  const negated = findOverdueWordingViolations(["これは納期遅延ではありません。"], 0);
  assert.equal(negated.length, 0);
});

test("AMM-DUE-2: 次四半期納期の受注はFUTURE_DUEとして分類される（現在のoverdueとは区別）", () => {
  const contracts = [
    contract({ market: "US", product: "hoso", outstandingQuantity: 1443.43 as never, dueDate: "2015Q2" as never }),
    contract({ market: "OTHER", product: "hoso", outstandingQuantity: 814.04 as never, dueDate: "2015Q2" as never }),
  ];
  // current processed period=2015Q1、next decision period=2015Q2（実装指示の実データ）。
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.equal(semantics.overdueTons, 0);
  assert.equal(semantics.status, "FUTURE_DUE");
  const usEntry = semantics.byMarketProduct.find((e) => e.market === "US" && e.product === "hoso");
  assert.equal(usEntry?.status, "FUTURE_DUE");
  assert.equal(classifyBacklogDueStatus(0, 0, 100), "FUTURE_DUE");
  assert.equal(classifyBacklogDueStatus(50, 0, 0), "OVERDUE");
  assert.equal(classifyBacklogDueStatus(0, 50, 0), "DUE_THIS_TURN");
  assert.equal(classifyBacklogDueStatus(10, 10, 0), "MIXED");
});

test("AMM-DUE-3: future backlogの履行がTrust改善につながるという断定は、engine factが無い限り禁止される", () => {
  assert.match(
    AI_MANAGEMENT_MEETING_SYSTEM_PROMPT,
    /future backlogを予定どおり履行する[\s\S]*ことが自動的にTrust改善につながる、というルールはShrimpXに存在しません/
  );
});

test("AMM-DUE-4: future backlog履行を「消化できれば改善」ではなく「予定どおり履行する必要がある」と表現する", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /Q2中に消化できれば評価改善」のような表現も禁止です/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /Q2納期なのでQ2中に予定どおり履行する必要がある/);
});

test("AMM-CAP-1: 商品別capacity合計(productLineSumTons)はcommon capacityと異なる別概念として保持される", () => {
  const factoryCapacity = [{ effective: { hoso: 6840, pd: 5985, vap: 1282.5, commonProcessing: 25650, freezingPackaging: 25650 } }];
  const pools = buildCapacityPools(factoryCapacity, 14107.5, "商品別実効能力");
  assert.equal(pools.productLineSumTons, 6840 + 5985 + 1282.5);
  assert.notEqual(pools.productLineSumTons, pools.commonProcessingTons);
  assert.ok(pools.productLineSumTons < pools.commonProcessingTons, "商品別ライン合計は共通前処理能力より小さいはず（実データどおり）");
});

test("AMM-CAP-2: capacity poolの各ラベル（common/freezing/hoso/pd/vap）が個別に保持される", () => {
  const factoryCapacity = [{ effective: { hoso: 6840, pd: 5985, vap: 1282.5, commonProcessing: 25650, freezingPackaging: 25650 } }];
  const pools = buildCapacityPools(factoryCapacity, 14107.5, "商品別実効能力");
  assert.equal(pools.hosoTons, 6840);
  assert.equal(pools.pdTons, 5985);
  assert.equal(pools.vapTons, 1282.5);
  assert.equal(pools.commonProcessingTons, 25650);
  assert.equal(pools.freezingPackagingTons, 25650);
});

test("AMM-CAP-3: どのcapacity poolがbindingかを明示するルールがpromptに存在する", () => {
  const factoryCapacity = [{ effective: { hoso: 6840, pd: 5985, vap: 1282.5, commonProcessing: 25650, freezingPackaging: 25650 } }];
  const pools = buildCapacityPools(factoryCapacity, 14107.5, "商品別実効能力");
  assert.equal(pools.bindingTons, 14107.5);
  assert.equal(pools.bindingPoolLabel, "商品別実効能力");
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /どのcapacity poolがbindingか/);
  assert.match(RULE_SEMANTICS.capacityPools, /bindingPoolLabel/);
});

test("AMM-CAP-4: raw material inventory=0が正確にgroundingされる（今期調達可能性とは分離）", () => {
  const fact = buildRawMaterialAvailabilityFact(0);
  assert.equal(fact.currentOnHandTons, 0);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /現在在庫が0だからと/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /今期の生産が不可能であるかのように断定してはいけません/);
});

test("AMM-CAP-5: production previewは確定結果と区別される", () => {
  assert.match(RULE_SEMANTICS.productionPreview, /forecast\/preview\/current-input estimate/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /確定した生産能力・確定生産量ではあり/);
});

test("AMM-CAP-6: future backlogが存在するだけではCAPEX必要性の根拠にならない", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /future backlogが/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /「CAPEXが必要」と断定してはいけません/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /少なくとも以下の/);
});

test("AMM-CAP-10 (Test26 BAL Turn1 reproduction): 実データでdue status・capacity poolsが正しく再現される", () => {
  const contracts = [
    contract({ market: "US", product: "hoso", outstandingQuantity: 1443.43 as never, dueDate: "2015Q2" as never }),
    contract({ market: "OTHER", product: "hoso", outstandingQuantity: 814.04 as never, dueDate: "2015Q2" as never }),
    contract({ market: "EU", product: "hoso", outstandingQuantity: 3625.95 - 1443.43 - 814.04 as never, dueDate: "2015Q2" as never }),
  ];
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.ok(Math.abs(semantics.totalTons - 3625.95) < 1e-6);
  assert.equal(semantics.overdueTons, 0);
  assert.equal(semantics.status, "FUTURE_DUE");

  const factoryCapacity = [{ effective: { hoso: 6840, pd: 5985, vap: 1282.5, commonProcessing: 25650, freezingPackaging: 25650 } }];
  const pools = buildCapacityPools(factoryCapacity, 14107.5, "商品別実効能力");
  assert.ok(Math.abs(pools.productLineSumTons - 14107.5) < 1e-6);
  assert.equal(pools.bindingPoolLabel, "商品別実効能力");

  const raw = buildRawMaterialAvailabilityFact(0);
  assert.equal(raw.currentOnHandTons, 0);

  // 応答が正しくFUTURE_DUE語彙を使い、禁止語彙を使わなければ違反は検知されない。
  const cleanResponse = "US HOSO 1,443.43t・OTHER HOSO 814.04tは2015Q2納期の次四半期の履行義務であり、現在のoverdueではありません。";
  assert.equal(findOverdueWordingViolations([cleanResponse], semantics.overdueTons).length, 0);
});
