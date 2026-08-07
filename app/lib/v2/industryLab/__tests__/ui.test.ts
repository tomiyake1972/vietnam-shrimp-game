import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, usdPerHosoEqKg, ratio, score0to100 } from "../../core/units";
import { COUNTRY_IDS, MarketPriceDriver } from "../../market/types";
import { runIndustrySimulation } from "../simulationRunner";
import {
  marketPriceDriverLabel,
  scenarioEventTypeLabel,
  scenarioEventPhaseLabel,
  displayInformationLevelLabel,
  MARKET_PRICE_DRIVER_LABELS,
} from "../ui/labels";
import {
  formatHosoEqTons,
  formatUsdPerHosoEqKg,
  formatRatioAsPercent,
  formatSignedPercent,
  formatScore,
  formatIndex,
  formatSignedHosoEqTons,
  formatSupplyDemandBalance,
} from "../ui/formatters";
import { selectQuarterByTurn, selectLatestQuarter, selectInformationForLevel, selectCurrentlyActiveEvents } from "../ui/selectors";
import { buildHosoPriceSeries, buildSupplyDemandSeries, buildCountrySupplySeries, buildMarketDemandSeries } from "../ui/chartData";
import { IndustrySimulationConfig } from "../types";

// --- labels ---

test("MarketPriceDriverの全19値に日本語ラベルが定義されている", () => {
  const allDrivers: readonly MarketPriceDriver[] = [
    "GLOBAL_SUPPLY_SHORTAGE",
    "GLOBAL_SUPPLY_SURPLUS",
    "COUNTRY_SUPPLY_SHORTAGE",
    "COUNTRY_SUPPLY_SURPLUS",
    "AQUACULTURE_COST_INCREASE",
    "AQUACULTURE_COST_DECREASE",
    "DEMAND_GROWTH",
    "DEMAND_CONTRACTION",
    "PRICE_CHANGE_CAPPED",
    "MARKET_SHOCK_APPLIED",
    "VIETNAM_RAW_MATERIAL_SHORTAGE",
    "VIETNAM_RAW_MATERIAL_SURPLUS",
    "MINIMUM_OFFTAKE_RULE_APPLIED",
    "PROCESSING_CAPACITY_OVERSUPPLY",
    "PD_CAPACITY_TIGHTNESS",
    "VAP_CAPACITY_TIGHTNESS",
    "VAP_DEMAND_STRENGTH",
    "ECUADOR_PD_CAPACITY_EXPANSION",
    "QUALITY_PREMIUM_APPLIED",
  ];
  for (const driver of allDrivers) {
    assert.equal(typeof MARKET_PRICE_DRIVER_LABELS[driver], "string");
    assert.ok(MARKET_PRICE_DRIVER_LABELS[driver].length > 0);
    assert.equal(marketPriceDriverLabel(driver), MARKET_PRICE_DRIVER_LABELS[driver]);
  }
});

test("scenarioEventTypeLabel・scenarioEventPhaseLabel・displayInformationLevelLabelは既知の値に対し文字列を返す", () => {
  assert.equal(typeof scenarioEventTypeLabel("DISEASE_OUTBREAK"), "string");
  assert.equal(typeof scenarioEventPhaseLabel("rampUp"), "string");
  assert.equal(typeof displayInformationLevelLabel("gm"), "string");
});

// --- formatters ---

test("formatHosoEqTons: 桁区切り付きでトン単位を表示する", () => {
  assert.equal(formatHosoEqTons(hosoEqTons(1234567)), "1,234,567 トン");
  assert.equal(formatHosoEqTons(1234567), "1,234,567 トン");
});

test("formatUsdPerHosoEqKg: USD/kg単位を表示する", () => {
  assert.equal(formatUsdPerHosoEqKg(usdPerHosoEqKg(5.1234)), "$5.1234/kg");
});

test("formatRatioAsPercent: 0〜1の比率をパーセント表示する", () => {
  assert.equal(formatRatioAsPercent(ratio(0.85)), "85.0%");
});

test("formatSignedPercent: 符号付きパーセントを表示する", () => {
  assert.equal(formatSignedPercent(0.032), "+3.2%");
  assert.equal(formatSignedPercent(-0.08), "-8.0%");
});

test("formatScore: 点数表示", () => {
  assert.equal(formatScore(score0to100(62.5)), "62.5点");
});

test("formatIndex: 倍率表示", () => {
  assert.equal(formatIndex(1.03), "1.03倍");
});

test("formatSignedHosoEqTons: 符号付き数量表示", () => {
  assert.equal(formatSignedHosoEqTons(1234), "+1,234 トン");
  assert.equal(formatSignedHosoEqTons(-1234), "-1,234 トン");
});

test("formatSupplyDemandBalance: 供給不足・過剰・均衡を表示する", () => {
  assert.equal(formatSupplyDemandBalance(0.123), "供給不足 12.3%");
  assert.equal(formatSupplyDemandBalance(-0.08), "供給過剰 8.0%");
  assert.equal(formatSupplyDemandBalance(0), "均衡");
});

// --- selectors ---

function baseConfig(overrides?: Partial<IndustrySimulationConfig>): IndustrySimulationConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "ui-test-seed", turns: 12, ...overrides };
}

test("selectQuarterByTurn: turnに一致する四半期を返す。存在しなければundefined", () => {
  const result = runIndustrySimulation(baseConfig());
  const found = selectQuarterByTurn(result.quarters, 5);
  assert.ok(found);
  assert.equal(found!.turn, 5);
  assert.equal(selectQuarterByTurn(result.quarters, 999), undefined);
});

test("selectLatestQuarter: 最後の四半期を返す", () => {
  const result = runIndustrySimulation(baseConfig());
  const latest = selectLatestQuarter(result.quarters);
  assert.equal(latest!.turn, 12);
  assert.equal(selectLatestQuarter([]), undefined);
});

test("selectInformationForLevel: レベルに応じて事前計算済みの配列をそのまま返す（public表示中にgm情報が混入しない）", () => {
  const result = runIndustrySimulation(baseConfig({ scenarioId: "global-disease-crisis-v0.1" }));
  const quarterWithGm = result.quarters.find((q) => q.gmInformation.length > q.publicInformation.length);
  assert.ok(quarterWithGm, "gm情報がpublic情報より多い四半期が存在するはず");

  const publicIds = new Set(selectInformationForLevel(quarterWithGm!, "public").map((r) => r.informationId));
  const gmIds = new Set(selectInformationForLevel(quarterWithGm!, "gm").map((r) => r.informationId));
  // public⊂standard⊂advanced⊂gmの累積アクセスのため、publicのIDはすべてgmにも含まれるはず。
  for (const id of publicIds) {
    assert.ok(gmIds.has(id), `public情報 ${id} はgm情報にも含まれるはず`);
  }
  assert.ok(gmIds.size >= publicIds.size);
  assert.equal(selectInformationForLevel(quarterWithGm!, "advanced"), quarterWithGm!.advancedInformation);
  assert.equal(selectInformationForLevel(quarterWithGm!, "standard"), quarterWithGm!.standardInformation);
});

test("selectCurrentlyActiveEvents: rampUp・active・recoveringのみを抽出する", () => {
  const result = runIndustrySimulation(baseConfig({ scenarioId: "global-disease-crisis-v0.1", turns: 32 }));
  for (const q of result.quarters) {
    const active = selectCurrentlyActiveEvents(q);
    for (const e of active) {
      assert.ok(e.phase === "rampUp" || e.phase === "active" || e.phase === "recovering");
    }
  }
});

// --- chartData ---

test("buildHosoPriceSeries: 四半期数と同じ長さの系列を返し、値がmarketResultと一致する", () => {
  const result = runIndustrySimulation(baseConfig());
  const series = buildHosoPriceSeries(result.quarters);
  assert.equal(series.length, result.quarters.length);
  for (let i = 0; i < series.length; i++) {
    for (const c of COUNTRY_IDS) {
      assert.equal(series[i][c], result.quarters[i].marketResult.hosoPrices[c].price);
    }
  }
});

test("buildSupplyDemandSeries・buildCountrySupplySeries・buildMarketDemandSeriesは四半期数と同じ長さを返す", () => {
  const result = runIndustrySimulation(baseConfig());
  assert.equal(buildSupplyDemandSeries(result.quarters).length, result.quarters.length);
  assert.equal(buildCountrySupplySeries(result.quarters).length, result.quarters.length);
  assert.equal(buildMarketDemandSeries(result.quarters).length, result.quarters.length);
});
