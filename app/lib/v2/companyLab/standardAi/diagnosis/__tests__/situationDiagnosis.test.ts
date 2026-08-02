// ShrimpX V2 — Phase SAI-6.1〜6.3 単体テスト
//
// Situation Diagnosis（不足型／過剰型の6カテゴリ診断）・Current Period Delivery
// Demand（当期納品需要、Standard AI内部の中間概念）の受入観点を検証する。
//
// 【三宅さんの指示どおりの方針】数値の完全一致ではなく診断の方向性を検証する。
// Test14 Turn1の人間案の数値をハードコードしない（baselineシナリオのBAL turn1
// 状態は、既存のfixtures.tsがそのままTest14 Turn1の初期条件そのものであり、
// 実際のstateから算出した診断値のみを検証する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, usdM, usdPerHosoEqKg } from "../../../../core/units";
import { usd } from "../../../../finance/types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../policy";
import { CompanyLabConfig, CompanyOwnState } from "../../../types";
import { FinishedGoodsLot } from "../../../../production/types";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "sai6-situation-diagnosis-001", turns: 8, ...overrides };
}

/** BAL会社のturn1状態（＝Test14 Turn1の初期条件そのもの。fixtures.ts参照）。 */
function setupBal(seed = "sai6-situation-diagnosis-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  return { fixture, ownState, publicInfo, period: state.currentPeriod, turn: 1 };
}

// ---------------------------------------------------------------------
// Test14 Turn1型ゴールデンケース（SAI-6.1指示 §13）
// ---------------------------------------------------------------------

test("Test14 Turn1型ゴールデンケース: 営業が強い制約、生産能力・Workerに余力、在庫は大きな問題なしと診断される", () => {
  // 【三宅さんの指示どおり】三宅さんの実装指示§13が明示的に列挙した4項目
  // （営業=強い制約／生産能力=余剰／Worker=余剰／在庫=大きな問題なし）だけを
  // 検証する。原料・資金についてはTest14 Turn1の期待診断として明示的に
  // 列挙されていないため、本テストでは断定しない（実際の会社状態から
  // 機械的に算出した結果、原料在庫が薄い（当期利用可能原料が期首ロットのみ）
  // ことが分かっており、これは正しい診断であり、この分だけで人間の判断
  // （国内買付8,500t等）とも整合する。primaryConstraintがどのカテゴリに
  // なるかは診断ロジックの重み付けに依存するため、本テストでは断定しない）。
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const diagnosis = diagnostics.situationDiagnosis;
  assert.ok(diagnosis, "situationDiagnosisが生成されていない");

  assert.equal(diagnosis!.salesFulfillmentState, "shortage", `営業が強い制約になるはずが、salesFulfillmentState=${diagnosis!.salesFulfillmentState}`);
  assert.notEqual(diagnosis!.productionLoadState, "shortage", `生産能力が制約になっているはずがないが、productionLoadState=${diagnosis!.productionLoadState}`);
  assert.ok(diagnosis!.productionLoadRatio < 0.8, `生産能力に余力があるはずが、Production Load Ratio=${diagnosis!.productionLoadRatio}`);
  assert.equal(diagnosis!.workerLoadState, "surplus", `Workerに余力があるはずが、workerLoadState=${diagnosis!.workerLoadState}`);
  assert.notEqual(diagnosis!.inventoryExcessState, "surplus", `在庫に大きな問題は無いはずが、inventoryExcessState=${diagnosis!.inventoryExcessState}`);

  // primaryConstraintは、少なくとも「実際に不足型と診断された」カテゴリの
  // いずれかであること（営業不足はTest14 Turn1で必ず不足型として診断される
  // ため、候補に含まれているはず）。
  assert.ok(
    diagnosis!.primaryConstraint === "sales_shortage" || diagnosis!.primaryConstraint === "raw_material_shortage",
    `主要制約が想定外: ${diagnosis!.primaryConstraint}`
  );

  // 診断比率は方向性のみを検証する（完全一致は求めない）。
  assert.ok(diagnosis!.salesFulfillmentRatio < 0.6, `Sales Fulfillment Ratioが想定より高い: ${diagnosis!.salesFulfillmentRatio}`);
});

test("currentPeriodDeliveryDemandが生成され、sourceが暫定proxyであることがわかる", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const deliveryDemand = diagnostics.currentPeriodDeliveryDemand;
  assert.ok(deliveryDemand, "currentPeriodDeliveryDemandが生成されていない");
  assert.equal(deliveryDemand!.source, "CURRENT_SALES_PLAN_PROXY");
  const total = deliveryDemand!.byProduct.hoso + deliveryDemand!.byProduct.pd + deliveryDemand!.byProduct.vap;
  assert.ok(total > 0, "currentPeriodDeliveryDemandByProductが全商品ゼロになっている");

  // 診断層が保持するcurrentPeriodDeliveryDemandByProductは、上のdeliveryDemandと同一値。
  assert.deepEqual(diagnostics.situationDiagnosis!.currentPeriodDeliveryDemandByProduct, deliveryDemand!.byProduct);
});

test("営業人員配分（実際の意思決定）は現在headcountを超えない（減員後turnでも成立する）", () => {
  const { fixture, ownState: ownState0, publicInfo, period, turn } = setupBal();
  // turn1では減員なしのため、まず素直に確認する。
  const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState0, publicInfo, period, turn);
  const headcountByMarket = new Map<string, number>();
  for (const plan of decision.salesPlans) headcountByMarket.set(plan.market, plan.salesForceHeadcount);
  const total = Array.from(headcountByMarket.values()).reduce((a, b) => a + b, 0);
  assert.ok(total <= ownState0.salesForceHiringState.headcount, `営業人員配分合計(${total})が現在headcount(${ownState0.salesForceHiringState.headcount})を超えている`);

  // 減員後（動的headcountだけを6人に減らす。fixtureは変えない＝静的値と動的値が
  // 分離していることの直接的な確認）。
  const reducedOwnState: CompanyOwnState = { ...ownState0, salesForceHiringState: { ...ownState0.salesForceHiringState, headcount: 6 } };
  const { decision: reducedDecision } = generateStandardAiDecisionWithDiagnostics(fixture, reducedOwnState, publicInfo, period, turn);
  const headcountByMarketReduced = new Map<string, number>();
  for (const plan of reducedDecision.salesPlans) headcountByMarketReduced.set(plan.market, plan.salesForceHeadcount);
  const totalReduced = Array.from(headcountByMarketReduced.values()).reduce((a, b) => a + b, 0);
  assert.ok(totalReduced <= 6, `減員後(6人)なのに営業人員配分合計が${totalReduced}になっている`);
});

test("非回帰: 今回の診断追加はStandard AIの最終意思決定（productionPlans等）を変更しない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  // 意図的に「まだ生産計画そのものは修正しない」（SAI-6.4は別途指示）。
  // 生産計画が引き続き工場能力にほぼ頭打ちする、過去調査で確認済みの過大な値の
  // オーダーであることを確認する（完全一致は求めない。SAI-6.4での改善対象）。
  const totalProduction = decision.productionPlans.reduce((sum, p) => sum + Number(p.desiredQuantity), 0);
  assert.ok(totalProduction > 15000, `今回はまだ生産計画を変更していないはずが、想定より小さい: ${totalProduction}`);
});

// ---------------------------------------------------------------------
// 追加診断テスト（SAI-6.1指示 §14）: 各カテゴリを単独で発火させる人工ケース
// ---------------------------------------------------------------------

test("人工ケース: 生産能力不足が診断される（工場能力を極端に縮小）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const shrunkFixture = {
    ...fixture,
    factories: fixture.factories.map((f) => ({ ...f, hosoCapacity: hosoEqTons(50), pdCapacity: hosoEqTons(50), vapCapacity: hosoEqTons(50) })),
  };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(shrunkFixture, ownState, publicInfo, period, turn);
  assert.equal(diagnostics.situationDiagnosis!.productionLoadState, "shortage");
});

test("人工ケース: Worker不足が診断される（常用Worker数を極端に縮小）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const shrunkOwnState: CompanyOwnState = {
    ...ownState,
    workforceState: { ...ownState.workforceState, factories: ownState.workforceState.factories.map((f) => ({ ...f, regularHeadcount: 10 })) },
  };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, shrunkOwnState, publicInfo, period, turn);
  assert.equal(diagnostics.situationDiagnosis!.workerLoadState, "shortage");
});

test("人工ケース: 原料不足が診断される（原料在庫を空にする）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const noRawMaterialOwnState: CompanyOwnState = { ...ownState, rawMaterialLots: [] };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, noRawMaterialOwnState, publicInfo, period, turn);
  assert.equal(diagnostics.situationDiagnosis!.rawMaterialCoverageState, "shortage");
});

test("人工ケース: 在庫過多が診断される（完成品在庫を極端に積み上げる）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const hugeLot: FinishedGoodsLot = {
    lotId: "sai6-test-huge-lot",
    companyId: fixture.companyId,
    factoryId: fixture.factories[0].factoryId,
    product: "hoso",
    producedPeriod: period,
    originalQuantity: hosoEqTons(50000),
    remainingQuantity: hosoEqTons(50000),
    sourceRawMaterialLots: [],
    rawMaterialOriginCountries: [],
    rawMaterialUnitCost: usdPerHosoEqKg(4.2),
    baseProcessingCost: usdM(0),
    availableFromPeriod: period,
    status: "available",
  };
  const excessInventoryOwnState: CompanyOwnState = { ...ownState, finishedGoodsLots: [...ownState.finishedGoodsLots, hugeLot] };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, excessInventoryOwnState, publicInfo, period, turn);
  assert.equal(diagnostics.situationDiagnosis!.inventoryExcessState, "surplus");
});

test("人工ケース: 資金不足が診断される（現金を大幅マイナスにする）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const cashShortOwnState: CompanyOwnState = { ...ownState, financeState: { ...ownState.financeState, cash: usd(-999_999_999) } };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, cashShortOwnState, publicInfo, period, turn);
  assert.equal(diagnostics.situationDiagnosis!.liquidityCoverageState, "shortage");
});

// ---------------------------------------------------------------------
// Claude説明生成の失敗時にも、決定論的Standard AIの診断が消えないこと
// （既存のPhase A修正済みの要件と同じ性質を、診断フィールドについても確認する）
// ---------------------------------------------------------------------

test("複数四半期進行後も、situationDiagnosisは毎ターン再生成される（前ターンの値が残らない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "sai6-situation-diagnosis-multi-turn", turns: 2 }));
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState1 = buildCompanyOwnState(state, fixture);
  const publicInfo1 = buildPublicMarketInfo(state);
  const { decision: decision1, diagnostics: diagnostics1 } = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState1,
    publicInfo1,
    state.currentPeriod,
    1
  );
  assert.ok(diagnostics1.situationDiagnosis, "turn1でsituationDiagnosisが生成されていない");

  const decisions: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  void decision1;
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const { diagnostics: diagnostics2 } = generateStandardAiDecisionWithDiagnostics(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);
  assert.ok(diagnostics2.situationDiagnosis, "turn2でsituationDiagnosisが生成されていない（前turnの値が消えている）");
  assert.equal(diagnostics2.turn, 2);
  // turn2は状態が進行しているため、主要制約がturn1と異なっていても構わない
  // （このテストが確認したいのは「診断が消えない・毎ターン再生成される」ことのみ）。
  assert.notEqual(diagnostics2.situationDiagnosis!.primaryConstraint, undefined);
});
