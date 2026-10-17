// ShrimpX V2 — PLAYER-INTRO-1 §9 検証：目安表示がEngineの現行計算と一致すること

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHeadcountChangeRules,
  buildLaborCostBaselines,
  buildSalesBaselines,
  buildWorkerBaselines,
  PRODUCTS_FOR_BASELINES,
} from "../managementBaselines";
import { checkYieldAssumption } from "../yieldAssumption";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { SALES_MODEL_IDS, salesParametersForModelId } from "../../../sales/salesModels";
import { companySalesOrganizationCapacity, SALES_CAPACITY_MODEL_PER_MARKET } from "../../../sales/salesCapacityModel";
import { processingCapacity } from "../../../sales/salesForce";
import { salesEffortWeightedQuantity } from "../../../sales/marketEffort";
import { unwrapUnit } from "../../../core/units";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { effectiveEfficiencyPerHeadTons } from "../../../production/labor";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { computeQuarterlyLaborCost } from "../../../companyLab/workforce";
import { computeMaxSalesHiresPerQuarter } from "../../../companyLab/salesForceHiring";

// ---------------------------------------------------------------------
// §3 歩留まり100％の前提とコードの照合
// ---------------------------------------------------------------------

test("INTRO-YIELD-1: 数量換算に使われる saleableRecoveryRatio は全商品 1.00（原料1t＝製品1t）", () => {
  const check = checkYieldAssumption();
  assert.equal(check.saleableRecoveryRatioIsUnityForAllProducts, true);
  for (const product of PRODUCTS_FOR_BASELINES) {
    assert.equal(check.saleableRecoveryRatioByProduct[product], 1, product);
  }
});

test("INTRO-YIELD-2: physicalYieldRatio は参考値専用であり、1.00 以外の値を持つ（混同防止の固定）", () => {
  const check = checkYieldAssumption();
  // PD は 0.54。この値は数量換算へ使われないことが前提であり、
  // もし将来 saleableRecoveryRatio 側へ流入したら INTRO-YIELD-1 が落ちる。
  assert.equal(check.referenceOnlyPhysicalYieldRatio.pd, 0.54);
  assert.equal(check.referenceOnlyPhysicalYieldRatio.hoso, 1.0);
  assert.equal(check.referenceOnlyPhysicalYieldRatio.vap, undefined);
});

test("INTRO-YIELD-3: 品質事故の廃棄で下回りうる下限が取得できる（捏造しない）", () => {
  const check = checkYieldAssumption();
  assert.ok(check.qualityDiscardFloorRatio > 0 && check.qualityDiscardFloorRatio <= 1);
  assert.equal(check.qualityDiscardFloorRatio, 0.9);
});

// ---------------------------------------------------------------------
// §5A 営業能力
// ---------------------------------------------------------------------

test("INTRO-SALES-1: 会社全体の目安がEngineの能力 ÷ 営業工数係数と一致する", () => {
  const model = SALES_PARAMETERS_V1.salesCapacityModel;
  assert.ok(model, "既定 SalesParameters が営業能力モデルを持っていない");
  for (const headcount of [0, 1, 5, 20, 74, 190]) {
    const b = buildSalesBaselines({ currentSalesHeadcount: headcount, marketCount: 5 });
    const capacity = companySalesOrganizationCapacity(headcount, model);
    for (const row of b.byProduct) {
      assert.equal(
        row.companyTotalTons.value,
        capacity / SALES_PARAMETERS_V1.salesEffortCoefficients[row.product],
        `headcount=${headcount} ${row.product}`
      );
    }
  }
});

test("INTRO-SALES-2: 1人あたりの目安は 会社全体 ÷ 現在人数 である", () => {
  const b = buildSalesBaselines({ currentSalesHeadcount: 60, marketCount: 5 });
  for (const row of b.byProduct) {
    assert.equal(row.perHeadTons.value, (row.companyTotalTons.value ?? 0) / 60, row.product);
  }
  // HOSO > PD > VAP（手間の重い商品ほど1人で扱える量が少ない）。
  const [hoso, pd, vap] = ["hoso", "pd", "vap"].map((p) => b.byProduct.find((r) => r.product === p)!.perHeadTons.value!);
  assert.ok(hoso > pd && pd > vap, "商品別の大小関係が手間の重さと合っていない");
});

test("INTRO-SALES-3: 商品別は「その商品だけ」条件であり、能力を重複計上しない", () => {
  const b = buildSalesBaselines({ currentSalesHeadcount: 60, marketCount: 5 });
  for (const row of b.byProduct) {
    assert.equal(row.perHeadTons.kind, "singleProductOnly");
    assert.equal(row.companyTotalTons.kind, "singleProductOnly");
    assert.match(row.perHeadTons.condition, /3つを足して同時には売れません/);
  }
  // 「それぞれの目安に対する割合の合計が100%以内」という説明が、
  // Engine の営業工数制約と数式として等価であることを確認する。
  // Σ q_p / (C/coef_p) = Σ coef_p·q_p / C であり、これは Engine の
  // salesEffortWeightedQuantity(q) / C と一致する。
  const quantities = { hoso: 5000, pd: 3000, vap: 1000 };
  const shareSum = b.byProduct.reduce(
    (sum, row) => sum + quantities[row.product] / (row.companyTotalTons.value ?? Infinity),
    0
  );
  const model = SALES_PARAMETERS_V1.salesCapacityModel!;
  const capacity = companySalesOrganizationCapacity(60, model);
  const engineEffort = salesEffortWeightedQuantity(quantities, SALES_PARAMETERS_V1);
  assert.ok(Math.abs(shareSum - engineEffort / capacity) < 1e-9, "割合合計の説明がEngineの制約と等価でない");
});

test("INTRO-SALES-4: 1人増やしたときの増分は人数が増えるほど小さくなる", () => {
  const at5 = buildSalesBaselines({ currentSalesHeadcount: 5, marketCount: 5 }).byProduct[0].addedPerHeadTons.value;
  const at50 = buildSalesBaselines({ currentSalesHeadcount: 50, marketCount: 5 }).byProduct[0].addedPerHeadTons.value;
  assert.ok(at5 !== null && at50 !== null);
  assert.ok(at5 > at50, "逓減していない");
});

test("INTRO-SALES-5: 0人でも基礎的な数量が残り、1人あたりは計算不能として null にする", () => {
  const b = buildSalesBaselines({ currentSalesHeadcount: 0, marketCount: 5 });
  assert.ok((b.baselineTonsAtZeroHeadcount.value ?? 0) > 0);
  for (const row of b.byProduct) {
    assert.equal(row.perHeadTons.value, null, row.product);
    assert.match(row.perHeadTons.condition, /計算できません/);
  }
});

test("INTRO-SALES-6: 受講者向けの文言に「工数」という語を使わない", () => {
  const b = buildSalesBaselines({ currentSalesHeadcount: 60, marketCount: 5 });
  const playerFacing = [
    b.mixedSalesRule,
    b.baselineTonsAtZeroHeadcount.label,
    b.baselineTonsAtZeroHeadcount.unit,
    b.baselineTonsAtZeroHeadcount.condition,
    ...b.byProduct.flatMap((r) => [
      r.perHeadTons.label, r.perHeadTons.unit, r.perHeadTons.condition,
      r.addedPerHeadTons.label, r.addedPerHeadTons.unit, r.addedPerHeadTons.condition,
      r.companyTotalTons.label, r.companyTotalTons.unit, r.companyTotalTons.condition,
    ]),
  ];
  for (const text of playerFacing) {
    assert.doesNotMatch(text, /工数/, `受講者向け文言に「工数」が残っている: ${text}`);
  }
});

test("INTRO-SALES-7: registry の全 salesModelId で営業能力パラメータが一致する（API契約変更が不要な根拠）", () => {
  for (const id of SALES_MODEL_IDS) {
    const params = salesParametersForModelId(id) ?? SALES_PARAMETERS_V1;
    assert.deepEqual(params.salesEffortCoefficients, SALES_PARAMETERS_V1.salesEffortCoefficients, id);
    assert.deepEqual(params.salesCapacityModel, SALES_PARAMETERS_V1.salesCapacityModel, id);
    assert.deepEqual(params.salesForce, SALES_PARAMETERS_V1.salesForce, id);
  }
});

test("INTRO-SALES-8: perMarket モデルを渡した場合は条件文がその旨を述べる", () => {
  const perMarketParams = { ...SALES_PARAMETERS_V1, salesCapacityModel: SALES_CAPACITY_MODEL_PER_MARKET };
  const b = buildSalesBaselines({ currentSalesHeadcount: 8, marketCount: 5, salesParams: perMarketParams });
  assert.equal(b.capacityModelKind, "perMarket");
  const hoso = b.byProduct.find((r) => r.product === "hoso")!;
  assert.equal(hoso.companyTotalTons.value, unwrapUnit(processingCapacity(8, perMarketParams)));
  assert.match(hoso.companyTotalTons.condition, /1つの市場/);
});

// ---------------------------------------------------------------------
// §5B Worker 生産能力
// ---------------------------------------------------------------------

test("INTRO-WORKER-1: 1人あたり生産能力がEngineの effectiveEfficiencyPerHeadTons と一致する", () => {
  const b = buildWorkerBaselines({});
  for (const row of b.byProduct) {
    assert.equal(
      row.regularPerHead.value,
      effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, row.product, PRODUCTION_PARAMETERS_V1),
      row.product
    );
    assert.equal(
      row.temporaryPerHead.value,
      effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.temporaryEfficiencyPerHeadTons, row.product, PRODUCTION_PARAMETERS_V1),
      row.product
    );
    // 「人数×能力＝必ず実生産量」と読めないよう、設備・原料の条件を必ず添える。
    assert.match(row.regularPerHead.condition, /設備能力・原料/);
  }
});

test("INTRO-WORKER-2: 臨時Workerは常用より1人あたり能力が低い", () => {
  const b = buildWorkerBaselines({});
  for (const row of b.byProduct) {
    assert.ok((row.temporaryPerHead.value ?? 0) < (row.regularPerHead.value ?? 0), row.product);
  }
});

test("INTRO-WORKER-3: 工場別の係数上書き（PD省人化など）が反映され、表示種別も変わる", () => {
  const base = buildWorkerBaselines({});
  const mechanized = buildWorkerBaselines({
    coefficientOverrideByProduct: { pd: 0.8 },
    factoryLabel: "HCM第1工場",
  });
  const basePd = base.byProduct.find((r) => r.product === "pd")!;
  const mechPd = mechanized.byProduct.find((r) => r.product === "pd")!;
  assert.ok((mechPd.regularPerHead.value ?? 0) > (basePd.regularPerHead.value ?? 0), "係数を下げたのに能力が増えていない");
  assert.equal(mechPd.regularPerHead.kind, "currentCondition");
  assert.equal(basePd.regularPerHead.kind, "baseParameter");
  assert.match(mechPd.regularPerHead.condition, /HCM第1工場/);
  // 上書きしていない商品は会社標準のまま。
  const mechHoso = mechanized.byProduct.find((r) => r.product === "hoso")!;
  const baseHoso = base.byProduct.find((r) => r.product === "hoso")!;
  assert.equal(mechHoso.regularPerHead.value, baseHoso.regularPerHead.value);
});

test("INTRO-WORKER-4: 残業の上限・係数が parameters.ts と一致する", () => {
  const b = buildWorkerBaselines({});
  assert.equal(b.overtimeRateCap.value, PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap);
  assert.equal(b.overtimeEfficiencyFactor.value, PRODUCTION_PARAMETERS_V1.labor.overtimeEfficiencyFactor);
  assert.equal(b.overtimeRateCap.kind, "hardLimit");
});

// ---------------------------------------------------------------------
// §5C 増減員の反映時期・一時費用
// ---------------------------------------------------------------------

test("INTRO-HEADCOUNT-1: Worker は当期反映・一時費用なし、営業は翌期反映・退職金あり", () => {
  const rules = buildHeadcountChangeRules({ currentSalesHeadcount: 20 });
  const worker = rules.find((r) => r.subject === "worker")!;
  const sales = rules.find((r) => r.subject === "salesForce")!;

  assert.match(worker.effectiveTiming, /すぐ反映/);
  assert.equal(worker.oneTimeCost, null);
  assert.equal(worker.hireLimitPerQuarter, null);
  assert.match(worker.notModeled, /モデル化されていません/);

  assert.match(sales.effectiveTiming, /次の四半期/);
  assert.ok(sales.oneTimeCost);
  assert.ok(sales.hireLimitPerQuarter);
});

test("INTRO-HEADCOUNT-2: 営業増員上限がEngineの computeMaxSalesHiresPerQuarter と一致する", () => {
  for (const headcount of [0, 5, 10, 20, 30, 40, 74]) {
    const rules = buildHeadcountChangeRules({ currentSalesHeadcount: headcount });
    const sales = rules.find((r) => r.subject === "salesForce")!;
    assert.equal(sales.hireLimitPerQuarter!.value, computeMaxSalesHiresPerQuarter(headcount), `headcount=${headcount}`);
  }
});

test("INTRO-HEADCOUNT-3: 営業の退職金が「四半期給与の2四半期分」である", () => {
  const rules = buildHeadcountChangeRules({ currentSalesHeadcount: 20 });
  const sales = rules.find((r) => r.subject === "salesForce")!;
  assert.equal(sales.oneTimeCost!.value, FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter * 2);
});

// ---------------------------------------------------------------------
// §5D 人件費
// ---------------------------------------------------------------------

test("INTRO-COST-1: 単価が finance/parameters.ts と一致し、試算が workforce.ts と一致する", () => {
  const b = buildLaborCostBaselines({ currentRegularHeadcount: 1200, currentTemporaryHeadcount: 300, isIndexApplied: false });
  assert.equal(b.regularWorkerPerHead.value, FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter);
  assert.equal(b.temporaryWorkerPerHead.value, FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter);
  assert.equal(b.overtimePremiumFactor.value, FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor);
  assert.equal(b.salesForcePerHead.value, FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter);

  const expected = computeQuarterlyLaborCost(1200, 300, FINANCE_PARAMETERS_V1);
  assert.equal(b.currentQuarterEstimate.regularCostUsd, expected.regularCostUsd);
  assert.equal(b.currentQuarterEstimate.temporaryCostUsd, expected.temporaryCostUsd);
  assert.equal(b.currentQuarterEstimate.totalCostUsd, expected.totalCostUsd);
  assert.equal(b.currentQuarterEstimate.excludesOvertime, true);
});

test("INTRO-COST-2: 費用指数を適用した現在値を渡すと、その値と表示種別が変わる", () => {
  const indexed = {
    ...FINANCE_PARAMETERS_V1,
    labor: { ...FINANCE_PARAMETERS_V1.labor, regularWorkerSalaryUsdPerQuarter: 1150, temporaryWorkerCostUsdPerQuarter: 920 },
  };
  const b = buildLaborCostBaselines({
    currentRegularHeadcount: 10,
    currentTemporaryHeadcount: 0,
    financeParams: indexed,
    isIndexApplied: true,
  });
  assert.equal(b.regularWorkerPerHead.value, 1150);
  assert.equal(b.regularWorkerPerHead.kind, "currentCondition");
  assert.match(b.regularWorkerPerHead.condition, /このTurnに実際に適用される値/);
  assert.equal(b.isIndexApplied, true);

  const notIndexed = buildLaborCostBaselines({ currentRegularHeadcount: 10, currentTemporaryHeadcount: 0, isIndexApplied: false });
  assert.equal(notIndexed.regularWorkerPerHead.kind, "baseParameter");
  assert.match(notIndexed.regularWorkerPerHead.condition, /未取得/);
});

test("INTRO-COST-3: 人数に依存しない固定費は「一人あたり人件費」へ混ぜず別項目にする", () => {
  const b = buildLaborCostBaselines({ currentRegularHeadcount: 10, currentTemporaryHeadcount: 0, isIndexApplied: false });
  const labels = b.headcountIndependentFixed.map((i) => i.label);
  assert.ok(labels.some((l) => l.includes("管理固定費")));
  assert.ok(labels.some((l) => l.includes("工場固定費")));
  // 一人あたり項目の単位に「／人」が入っていること（固定費と混ざっていないこと）。
  assert.match(b.regularWorkerPerHead.unit, /／人/);
  for (const item of b.headcountIndependentFixed) {
    assert.doesNotMatch(item.unit, /／人\b/);
  }
  // 試算には固定費を含めない。
  assert.equal(b.currentQuarterEstimate.totalCostUsd, 10 * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter);
});

test("INTRO-COST-4: 営業給与にシナリオ費用指数が適用されない事実を condition が述べている", () => {
  const b = buildLaborCostBaselines({ currentRegularHeadcount: 1, currentTemporaryHeadcount: 0, isIndexApplied: true });
  assert.match(b.salesForcePerHead.condition, /費用指数（常用労務・臨時労務）は適用されません/);
});

// ---------------------------------------------------------------------
// §5D 常用 と 臨時 の金銭面の比較
// ---------------------------------------------------------------------

test("INTRO-COST-5: 常用/臨時の単価・1人あたり生産量がEngineの値と一致する", () => {
  const b = buildLaborCostBaselines({ currentRegularHeadcount: 10, currentTemporaryHeadcount: 0, isIndexApplied: false });
  const reg = b.workerTypeComparison.find((c) => c.workerType === "regular")!;
  const tmp = b.workerTypeComparison.find((c) => c.workerType === "temporary")!;

  assert.equal(reg.costPerHead.value, FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter);
  assert.equal(tmp.costPerHead.value, FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter);
  assert.equal(
    reg.tonsPerHead.value,
    effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, "hoso", PRODUCTION_PARAMETERS_V1)
  );
  assert.equal(
    tmp.tonsPerHead.value,
    effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.temporaryEfficiencyPerHeadTons, "hoso", PRODUCTION_PARAMETERS_V1)
  );
});

test("INTRO-COST-6: 1トンあたり人件費は 単価 ÷ 1人あたり生産量 であり、臨時のほうが割高になる", () => {
  const b = buildLaborCostBaselines({ currentRegularHeadcount: 10, currentTemporaryHeadcount: 0, isIndexApplied: false });
  for (const c of b.workerTypeComparison) {
    assert.equal(c.costPerTon.value, (c.costPerHead.value ?? 0) / (c.tonsPerHead.value ?? 1), c.workerType);
  }
  const reg = b.workerTypeComparison.find((c) => c.workerType === "regular")!;
  const tmp = b.workerTypeComparison.find((c) => c.workerType === "temporary")!;
  // 単価は臨時のほうが安い。
  assert.ok((tmp.costPerHead.value ?? 0) < (reg.costPerHead.value ?? 0), "臨時の単価が常用より高い");
  // それでも1トンあたりでは臨時のほうが高い（これが受講者へ伝えたい逆転）。
  assert.ok((tmp.costPerTon.value ?? 0) > (reg.costPerTon.value ?? 0), "1トンあたりの逆転が起きていない");
});

test("INTRO-COST-7: 常用は配置しなくても満額・残業可、臨時は使った分のみ・残業不可、と説明している", () => {
  const b = buildLaborCostBaselines({ currentRegularHeadcount: 10, currentTemporaryHeadcount: 0, isIndexApplied: false });
  const reg = b.workerTypeComparison.find((c) => c.workerType === "regular")!;
  const tmp = b.workerTypeComparison.find((c) => c.workerType === "temporary")!;
  assert.ok(reg.notes.some((n) => n.includes("配置しなかった人の給与も、そのまま満額")), "遊休労務費の説明が無い");
  assert.ok(reg.notes.some((n) => n.includes("残業をさせられるのは常用Workerだけ")), "残業の説明が無い");
  assert.ok(tmp.notes.some((n) => n.includes("使った人数ぶんだけ")), "臨時が使った分のみである説明が無い");
  assert.ok(tmp.notes.some((n) => n.includes("残業はできません")), "臨時が残業不可である説明が無い");
});
