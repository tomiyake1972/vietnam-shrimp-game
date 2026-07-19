import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { createRandomStream } from "../../core/random";
import { calculateMarketQuarter } from "../../market/index";
import { MARKET_PARAMETERS_V1 } from "../../market/parameters";
import { baseMarketQuarterInput } from "../../market/__tests__/fixtures";
import { aggregateProductionSupplySignals, applySupplySignalToCountrySupply } from "../supplySignal";
import { ProductionSupplySignalInput } from "../types";

const COMPANY_COUNTRY = { C1: "VN", C2: "VN", C3: "EC" } as const;

test("PD/VAP供給計画増加は、他条件一定ならプレミアムを低下させる", () => {
  const base = baseMarketQuarterInput();

  const signals: ProductionSupplySignalInput[] = [
    { companyId: "C1", product: "pd", plannedQuantity: hosoEqTons(500), actualQuantity: hosoEqTons(0) },
    { companyId: "C2", product: "pd", plannedQuantity: hosoEqTons(500), actualQuantity: hosoEqTons(0) },
  ];
  const countrySignals = aggregateProductionSupplySignals(signals, COMPANY_COUNTRY, "pd");
  const vn = countrySignals.find((s) => s.country === "VN")!;
  assert.equal(unwrapUnit(vn.plannedCapacity), 1000);

  // 低い供給計画（既存のpdProcessingCapacityより低い）を適用してプレミアムを比較する。
  const lowSupply = applySupplySignalToCountrySupply(base.countries, countrySignals, "pd", false);
  const lowInput = { ...base, countries: lowSupply };

  const highSignals: ProductionSupplySignalInput[] = [
    { companyId: "C1", product: "pd", plannedQuantity: hosoEqTons(50000), actualQuantity: hosoEqTons(0) },
    { companyId: "C2", product: "pd", plannedQuantity: hosoEqTons(50000), actualQuantity: hosoEqTons(0) },
  ];
  const highCountrySignals = aggregateProductionSupplySignals(highSignals, COMPANY_COUNTRY, "pd");
  const highSupply = applySupplySignalToCountrySupply(base.countries, highCountrySignals, "pd", false);
  const highInput = { ...base, countries: highSupply };

  const lowResult = calculateMarketQuarter(lowInput, MARKET_PARAMETERS_V1, createRandomStream("seed-supply-signal"));
  const highResult = calculateMarketQuarter(highInput, MARKET_PARAMETERS_V1, createRandomStream("seed-supply-signal"));

  assert.ok(unwrapUnit(highResult.pdPremium.basePremium) < unwrapUnit(lowResult.pdPremium.basePremium));
});

test("PD/VAP供給シグナルはHOSO国際基準価格を変化させない", () => {
  const base = baseMarketQuarterInput();
  const signals: ProductionSupplySignalInput[] = [
    { companyId: "C1", product: "vap", plannedQuantity: hosoEqTons(5000), actualQuantity: hosoEqTons(0) },
  ];
  const countrySignals = aggregateProductionSupplySignals(signals, COMPANY_COUNTRY, "vap");
  const supply = applySupplySignalToCountrySupply(base.countries, countrySignals, "vap", false);
  const withSignal = { ...base, countries: supply };

  const baseResult = calculateMarketQuarter(base, MARKET_PARAMETERS_V1, createRandomStream("seed-hoso"));
  const signalResult = calculateMarketQuarter(withSignal, MARKET_PARAMETERS_V1, createRandomStream("seed-hoso"));

  for (const country of Object.keys(baseResult.hosoPrices) as (keyof typeof baseResult.hosoPrices)[]) {
    assert.equal(unwrapUnit(signalResult.hosoPrices[country].price), unwrapUnit(baseResult.hosoPrices[country].price));
  }
});

test("会社行動（供給シグナル）が無い産地はPhase3の既存前提をそのまま残す", () => {
  const base = baseMarketQuarterInput();
  const signals: ProductionSupplySignalInput[] = [{ companyId: "C1", product: "pd", plannedQuantity: hosoEqTons(100), actualQuantity: hosoEqTons(0) }];
  const countrySignals = aggregateProductionSupplySignals(signals, COMPANY_COUNTRY, "pd"); // VNのみ
  const supply = applySupplySignalToCountrySupply(base.countries, countrySignals, "pd", false);
  // EC/ID/INにはシグナルが無いため、既存値のまま。
  assert.equal(unwrapUnit(supply.EC.pdProcessingCapacity), unwrapUnit(base.countries.EC.pdProcessingCapacity));
  assert.equal(unwrapUnit(supply.ID.pdProcessingCapacity), unwrapUnit(base.countries.ID.pdProcessingCapacity));
  assert.equal(unwrapUnit(supply.IN.pdProcessingCapacity), unwrapUnit(base.countries.IN.pdProcessingCapacity));
  // VNは供給計画値に置き換わる。
  assert.equal(unwrapUnit(supply.VN.pdProcessingCapacity), 100);
});

test("能力があるだけで全量供給した扱いにはしない（plannedQuantityとactualQuantityを区別する）", () => {
  const base = baseMarketQuarterInput();
  const signals: ProductionSupplySignalInput[] = [
    { companyId: "C1", product: "pd", plannedQuantity: hosoEqTons(1000), actualQuantity: hosoEqTons(400) },
  ];
  const countrySignals = aggregateProductionSupplySignals(signals, COMPANY_COUNTRY, "pd");
  const plannedSupply = applySupplySignalToCountrySupply(base.countries, countrySignals, "pd", false);
  const actualSupply = applySupplySignalToCountrySupply(base.countries, countrySignals, "pd", true);
  assert.equal(unwrapUnit(plannedSupply.VN.pdProcessingCapacity), 1000);
  assert.equal(unwrapUnit(actualSupply.VN.pdProcessingCapacity), 400);
});

test("入力を変更しない（不変性）", () => {
  const base = baseMarketQuarterInput();
  const signals: ProductionSupplySignalInput[] = [{ companyId: "C1", product: "pd", plannedQuantity: hosoEqTons(100), actualQuantity: hosoEqTons(0) }];
  const beforeCountries = JSON.stringify(base.countries);
  const countrySignals = aggregateProductionSupplySignals(signals, COMPANY_COUNTRY, "pd");
  applySupplySignalToCountrySupply(base.countries, countrySignals, "pd", false);
  assert.equal(JSON.stringify(base.countries), beforeCountries);
});
