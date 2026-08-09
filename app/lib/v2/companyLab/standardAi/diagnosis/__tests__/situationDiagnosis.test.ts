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

/**
 * BAL会社のturn1状態。
 *
 * 【2026-08-08・Test16の初期営業人数変更に伴う分離】
 * このファイルのゴールデンケースは「営業が強い制約である状況で、Standard AIが
 * 何をどう診断するか」を固定するものであり、**営業不足が前提条件**である。
 *
 * Test16でゲームの初期営業人数が60人になったため、fixtureの既定値をそのまま使うと
 * 営業はもうボトルネックではなくなり、このテストが何を検証していたのかが失われる。
 *
 * そこで指示Oに従い、**このテスト専用に営業人数を低く固定**する。
 * 「初期ゲーム状態の検証」ではなく「営業不足診断そのものの検証」であるため、
 * 期待値を書き換えるのではなく前提条件を明示的に作る、という扱いにしてある。
 *
 * この値は、Test16以前のBALの初期営業人数（18人）である。
 */
const SALES_SHORTAGE_CASE_HEADCOUNT = 18;

function setupBal(seed = "sai6-situation-diagnosis-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const baseFixture = fixtures.find((f) => f.companyId === "BAL")!;
  // 営業不足ケースを意図的に作る（ゲームの初期値には依存させない）。
  const fixture = { ...baseFixture, salesForceHeadcountTotal: SALES_SHORTAGE_CASE_HEADCOUNT };
  const ownState = {
    ...buildCompanyOwnState(state, baseFixture),
    salesForceHiringState: { companyId: baseFixture.companyId, headcount: SALES_SHORTAGE_CASE_HEADCOUNT },
  };
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
  // 【2026-08-02・能力認識監査Phase 3対応】Production Load Ratioの分母が、名目能力
  // （capex加算後のみ）から、実効能力・共有ボトルネック（共通前処理・凍結包装）を
  // 反映したbinding capacityへ変わったため、比率自体は名目ベースの時より高くなる
  // （0.855の稼働率derate＋共有ボトルネックの分だけ分母が小さくなるため）。ここでの
  // 検証意図（生産能力がshortageの制約にならないこと）はproductionLoadState
  // アサーションで既に確認済みであり、この比率の閾値は「shortage判定閾値
  // （0.9）を明確に下回ること」の確認に更新する（0.8という固定値は名目capacity
  // ベースの旧仕様に依存した値だったため、意味のある閾値へ引き直した）。
  assert.ok(diagnosis!.productionLoadRatio < 0.9, `生産能力がshortage閾値に達していないはずが、Production Load Ratio=${diagnosis!.productionLoadRatio}`);
  // 【Test15統合branchでのgolden更新: surplus → balanced】
  // 商品別労働集約度（HOSO:PD:VAP = 1.0:1.2:3.0）はTest15の採用仕様であり、
  // PD・VAPが同じトン数でもHOSOより多くの労働を要するようになった。Test14 Turn1の
  // 商品構成（HOSO/PD/VAPを併産）では必要労働が増え、workerLoadRatioが上がって
  // surplus判定閾値を外れ、balancedになった。これは労働集約度導入の直接的な帰結
  // であり、診断ロジックの退行ではない（労働集約度係数そのものは変更していない）。
  //
  // 本テストの検証意図は「Workerが制約になっていないこと」であり、その意味は
  // balancedでも保たれている（shortageでないことは下のassertで明示的に固定する）。
  assert.equal(diagnosis!.workerLoadState, "balanced", `Workerの負荷状態が想定外: workerLoadState=${diagnosis!.workerLoadState}`);
  assert.notEqual(diagnosis!.workerLoadState, "shortage", "Workerが制約（shortage）になっているはずがない");
  assert.notEqual(diagnosis!.inventoryExcessState, "surplus", `在庫に大きな問題は無いはずが、inventoryExcessState=${diagnosis!.inventoryExcessState}`);

  // 【SAI-6.4修正】原料は「期首在庫＋確定入荷だけでは不足（procurement needed）」であっても、
  // 「当期国内市場から現実的に追加調達可能な量」が不明（unknown）である限り、真の供給制約
  // （raw_material_shortage）としてprimary/secondary候補に入らない（三宅さんの指摘・調査結果。
  // Test14 Turn1では国内原料を当期中に追加調達できるため、これは正しい訂正である）。
  // したがって、primaryConstraintは営業（sales_shortage）であるべき。
  assert.equal(diagnosis!.primaryConstraint, "sales_shortage", `主要制約が想定外: ${diagnosis!.primaryConstraint}`);
  // 原料は「procurement needed」（調達行為が必要）であることは診断されるが、それ自体は
  // ボトルネックではない。
  assert.equal(diagnosis!.rawMaterialProcurementNeeded, true, "Test14 Turn1では原料の追加調達が必要と診断されるはず");
  assert.equal(
    diagnosis!.rawMaterialSupplyConstraintState,
    "unknown",
    "現行のStandard AI観測には国内追加調達可能量が無いため、真の供給制約はunknownであるべき"
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

// ---------------------------------------------------------------------
// SAI-6.4 Golden Case（Test14 Turn1型）: 22,100t過剰生産問題の構造的解消
//
// 【三宅さんの指示どおりの方針】人間案（生産11,100t・国内買付8,500t）への
// 完全一致を目的にしない。ハードコードした数値との一致テストではなく、
// 「currentPeriodDeliveryDemand + normalInventoryTarget - openingFinishedGoods」
// という構成要素が実際に生産計画へ反映されていることと、22,100tより明確に
// 小さくなることを検証する。
// ---------------------------------------------------------------------

test("SAI-6.4 Golden Case: Test14 Turn1型の生産計画が22,100tより明確に小さくなり、currentPeriodDeliveryDemand起点の式で説明できる", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const diagnosis = diagnostics.situationDiagnosis!;

  const totalProduction = decision.productionPlans.reduce((sum, p) => sum + Number(p.desiredQuantity), 0);

  // 【必須（実装指示E-2）】22,100tより明確に小さいこと。
  assert.ok(totalProduction < 18000, `SAI-6.4適用後もTest14 Turn1相当の生産計画が22,100t付近から明確に縮小していない: ${totalProduction}`);

  // 【必須（実装指示E-2）】人間案11,100t近辺への一致を狭いレンジで要求せず、
  // 「demand + normal inventory - opening inventory」の構成要素が実際に生産計画の
  // 合計と一致することを優先して検証する（production capacityがbindingでない
  // Test14 Turn1では、能力キャップは発生しないため厳密に一致するはず）。
  const basicRequirementTotal =
    diagnosis.basicCurrentPeriodProductionRequirementByProduct.hoso +
    diagnosis.basicCurrentPeriodProductionRequirementByProduct.pd +
    diagnosis.basicCurrentPeriodProductionRequirementByProduct.vap;
  assert.ok(
    Math.abs(totalProduction - basicRequirementTotal) < 1,
    `生産計画合計(${totalProduction})が基本当期生産必要量(${basicRequirementTotal})と一致しない（能力制約が無いはずのケースで不一致）`
  );

  // production capacityはbindingでないこと（実装指示B-5・E-1）。
  assert.notEqual(diagnosis.productionLoadState, "shortage", "Test14 Turn1では生産能力が制約になっていないはず");

  // 戦略在庫理由なしで過剰生産しない（実装指示E-1）: 在庫過多にならない。
  assert.notEqual(diagnosis.inventoryExcessState, "surplus", "戦略在庫理由がないのに在庫過多と診断されている");

  // Workerが制約になっていないことを認識する（実装指示E-1）。
  // 【Test15統合branchでのgolden更新: surplus → balanced】商品別労働集約度
  // （HOSO:PD:VAP = 1.0:1.2:3.0、Test15採用仕様）の導入によりPD・VAPの必要労働が
  // 増え、Test14 Turn1型の商品構成ではworkerLoadRatioがsurplus閾値を外れて
  // balancedになった。労働集約度導入の直接的な帰結であり、実装指示E-1の意図
  // （Workerがボトルネックではないと認識できること）はbalancedでも満たされる。
  assert.equal(diagnosis.workerLoadState, "balanced");
  assert.notEqual(diagnosis.workerLoadState, "shortage", "Workerが制約（shortage）になっているはずがない");

  // 人間案（生産11,100t・国内買付8,500t）と桁・方向性が整合しているかの参考記録
  // （断定的な一致テストではない。開発日誌へも同様の値を記録する）。
  const domesticPurchase = Number(decision.domesticPurchasePlan?.desiredQuantity ?? 0);
  assert.ok(domesticPurchase > 0, "国内買付が0になっている（原料調達の連動が失われている）");
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

test("人工ケース: 資金不足が診断される（現金を大幅マイナスにする。primary/secondary候補には入らずCASH_BUFFER_BELOW_TARGETのみ）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const cashShortOwnState: CompanyOwnState = { ...ownState, financeState: { ...ownState.financeState, cash: usd(-999_999_999) } };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, cashShortOwnState, publicInfo, period, turn);
  assert.equal(diagnostics.situationDiagnosis!.liquidityCoverageState, "shortage");
  // 【SAI-6.4修正】借入余力を含めた資金調達力全体が今回未接続のため、
  // liquidityCoverageState==="shortage"だけではprimary/secondary候補に入らない。
  assert.notEqual(diagnostics.situationDiagnosis!.primaryConstraint, "liquidity_shortage");
  assert.notEqual(diagnostics.situationDiagnosis!.secondaryConstraint, "liquidity_shortage");
  assert.ok(
    diagnostics.entries.some((e) => e.code === "CASH_BUFFER_BELOW_TARGET"),
    "CASH_BUFFER_BELOW_TARGETのwarningが出ていない"
  );
});

// ---------------------------------------------------------------------
// Phase F（実装指示）: Test14への過学習を避けるための逆方向・人工ケース
// ---------------------------------------------------------------------

test("F-1. 生産能力制約ケース: 当期納品需要が生産能力を上回る場合、生産がcapacityで上限になり、production capacity constraintが診断される", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  // 工場能力を極端に縮小し、当期納品需要（実際の販売可能量+既存契約）が
  // 能力を上回る状況を作る。営業制約ロジックを機械的に適用して販売量まで
  // 縮小しないことも確認する（実装指示F-1）。
  const shrunkFixture = {
    ...fixture,
    factories: fixture.factories.map((f) => ({ ...f, hosoCapacity: hosoEqTons(50), pdCapacity: hosoEqTons(50), vapCapacity: hosoEqTons(50) })),
  };
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(shrunkFixture, ownState, publicInfo, period, turn);
  const diagnosis = diagnostics.situationDiagnosis!;
  assert.equal(diagnosis.productionLoadState, "shortage", "生産能力制約が診断されていない");
  assert.ok(diagnosis.productionCapacityHeadroom < 0, "生産能力の余力が負になっていない");

  // 生産が能力でキャップされていること（各工場×商品の生産計画が、その工場の
  // 商品別能力を実質的に超えないこと）。
  for (const plan of decision.productionPlans) {
    const factory = shrunkFixture.factories.find((f) => f.factoryId === plan.factoryId)!;
    const capacity = plan.product === "hoso" ? factory.hosoCapacity : plan.product === "pd" ? factory.pdCapacity : factory.vapCapacity;
    assert.ok(Number(plan.desiredQuantity) <= Number(capacity) + 1, `生産計画(${plan.desiredQuantity})が能力(${capacity})を超えている`);
  }
  assert.ok(
    diagnostics.entries.some((e) => e.code === "CAPACITY_CONSTRAINT"),
    "CAPACITY_CONSTRAINT診断が出ていない"
  );

  // 販売計画自体は、営業制約ロジック（営業人員配分）を機械的に適用して縮小されて
  // いないこと（=salesPlansはsalesForceHeadcount起因の制約のみで決まり、生産能力
  // 不足を理由に販売量まで縮小するロジックは今回導入していない）。
  const salesTotal = decision.salesPlans.reduce((sum, p) => sum + Number(p.desiredQuantity), 0);
  assert.ok(salesTotal > 0, "販売計画がゼロになっている（生産能力制約が販売側へ誤って伝播している可能性）");
});

test("F-2. 期首完成品在庫ありケース: 十分なFG在庫があれば、その分だけ生産必要量が減る", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const { diagnostics: baseline } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const baselineHosoRequirement = baseline.situationDiagnosis!.basicCurrentPeriodProductionRequirementByProduct.hoso;

  const extraFgLot: FinishedGoodsLot = {
    lotId: "sai6-test-f2-lot",
    companyId: fixture.companyId,
    factoryId: fixture.factories[0].factoryId,
    product: "hoso",
    producedPeriod: period,
    originalQuantity: hosoEqTons(2000),
    remainingQuantity: hosoEqTons(2000),
    sourceRawMaterialLots: [],
    rawMaterialOriginCountries: [],
    rawMaterialUnitCost: usdPerHosoEqKg(4.2),
    baseProcessingCost: usdM(0),
    availableFromPeriod: period,
    status: "available",
  };
  const withExtraFgOwnState: CompanyOwnState = { ...ownState, finishedGoodsLots: [...ownState.finishedGoodsLots, extraFgLot] };
  const { diagnostics: withExtraFg } = generateStandardAiDecisionWithDiagnostics(fixture, withExtraFgOwnState, publicInfo, period, turn);
  const withExtraFgHosoRequirement = withExtraFg.situationDiagnosis!.basicCurrentPeriodProductionRequirementByProduct.hoso;

  assert.ok(
    withExtraFgHosoRequirement < baselineHosoRequirement,
    `期首FG在庫を積んだのにHOSOの生産必要量が減っていない（baseline=${baselineHosoRequirement}, withExtraFg=${withExtraFgHosoRequirement}）`
  );
  assert.ok(
    Math.abs(baselineHosoRequirement - withExtraFgHosoRequirement - 2000) < 1,
    `生産必要量の減少幅がFG在庫積み増し分(2000t)と一致しない（減少幅=${baselineHosoRequirement - withExtraFgHosoRequirement}）`
  );
});

test("F-3. 需要ゼロ／極小ケース: 通常在庫以外の理由なき生産をせず、NaN・負値・division by zeroを起こさない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  // 全市場の需要をゼロ相当にするため、営業人員をゼロにし、既存契約もゼロにする。
  const zeroDemandFixture = { ...fixture, salesForceHeadcountTotal: 0 };
  const zeroDemandOwnState: CompanyOwnState = {
    ...ownState,
    salesForceHiringState: { ...ownState.salesForceHiringState, headcount: 0 },
    contracts: [],
  };
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(zeroDemandFixture, zeroDemandOwnState, publicInfo, period, turn);
  const diagnosis = diagnostics.situationDiagnosis!;

  for (const key of ["hoso", "pd", "vap"] as const) {
    assert.ok(Number.isFinite(diagnosis.basicCurrentPeriodProductionRequirementByProduct[key]), `${key}の生産必要量がNaN/Infinity`);
    assert.ok(diagnosis.basicCurrentPeriodProductionRequirementByProduct[key] >= 0, `${key}の生産必要量が負値`);
  }
  for (const plan of decision.productionPlans) {
    assert.ok(Number.isFinite(Number(plan.desiredQuantity)), "生産計画の数量がNaN/Infinity");
    assert.ok(Number(plan.desiredQuantity) >= 0, "生産計画の数量が負値");
  }
  // 通常在庫目標以外に生産する理由がないため、生産必要量の合計は通常在庫目標の合計を
  // 大きく超えないはず（需要ゼロなので基本的には通常在庫目標分だけが残る）。
  const requirementTotal =
    diagnosis.basicCurrentPeriodProductionRequirementByProduct.hoso +
    diagnosis.basicCurrentPeriodProductionRequirementByProduct.pd +
    diagnosis.basicCurrentPeriodProductionRequirementByProduct.vap;
  const deliveryDemandTotal =
    diagnosis.currentPeriodDeliveryDemandByProduct.hoso + diagnosis.currentPeriodDeliveryDemandByProduct.pd + diagnosis.currentPeriodDeliveryDemandByProduct.vap;
  const { diagnostics: baselineForComparison } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const baselineDeliveryDemandTotal = sumOf(baselineForComparison.currentPeriodDeliveryDemand!.byProduct);
  // 【注記】営業人員をゼロにしても、市場側の最低受注ライン等により当期納品需要が
  // 厳密にゼロにはならない場合がある（既存の市場ロジックの仕様であり、今回変更しない）。
  // ここではNaN/負値が出ないことを主目的とし、需要が通常時より大幅に縮小することのみ検証する。
  assert.ok(
    deliveryDemandTotal < baselineDeliveryDemandTotal * 0.3,
    `営業人員ゼロなのにcurrentPeriodDeliveryDemandが通常時と同水準のまま: baseline=${baselineDeliveryDemandTotal}, zero-demand=${deliveryDemandTotal}`
  );
  assert.ok(Number.isFinite(requirementTotal), "生産必要量合計がNaN/Infinity");
});

test("F-4. 営業人員採用／減員後: 動的headcountからrealisticSalesByProductが変わり、production requirementも自然に変わる", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupBal();
  const { diagnostics: baseline } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const baselineTotal = sumOf(baseline.situationDiagnosis!.basicCurrentPeriodProductionRequirementByProduct);

  const hiredOwnState: CompanyOwnState = {
    ...ownState,
    salesForceHiringState: { ...ownState.salesForceHiringState, headcount: ownState.salesForceHiringState.headcount + 20 },
  };
  const { diagnostics: hired } = generateStandardAiDecisionWithDiagnostics(fixture, hiredOwnState, publicInfo, period, turn);
  const hiredTotal = sumOf(hired.situationDiagnosis!.basicCurrentPeriodProductionRequirementByProduct);

  const reducedOwnState: CompanyOwnState = {
    ...ownState,
    salesForceHiringState: { ...ownState.salesForceHiringState, headcount: Math.max(1, ownState.salesForceHiringState.headcount - 20) },
  };
  const { diagnostics: reduced } = generateStandardAiDecisionWithDiagnostics(fixture, reducedOwnState, publicInfo, period, turn);
  const reducedTotal = sumOf(reduced.situationDiagnosis!.basicCurrentPeriodProductionRequirementByProduct);

  assert.ok(
    hiredTotal >= baselineTotal,
    `営業人員を増員したのに生産必要量が減っている（baseline=${baselineTotal}, hired=${hiredTotal}）`
  );
  assert.ok(
    reducedTotal <= baselineTotal,
    `営業人員を減員したのに生産必要量が増えている（baseline=${baselineTotal}, reduced=${reducedTotal}）`
  );
});

function sumOf(p: { hoso: number; pd: number; vap: number }): number {
  return p.hoso + p.pd + p.vap;
}

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
