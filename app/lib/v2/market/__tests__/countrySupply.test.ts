import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateExportableSupply, calculateCostPressure, summarizeCountrySupply } from "../countrySupply";
import { unwrapUnit, hosoEqTons, ratio } from "../../core/units";
import { baseCountryInput } from "./fixtures";
import { COUNTRY_IDS } from "../types";

test("輸出可能供給量 = 生産量 × 輸出可能比率", () => {
  const input = baseCountryInput("EC", { production: hosoEqTons(10000), exportCapacityRatio: ratio(0.7) });
  const supply = calculateExportableSupply(input);
  assert.ok(Math.abs(unwrapUnit(supply) - 7000) < 1e-9);
});

test("コスト指数が上昇するとコスト変化率は正になる", () => {
  const input = baseCountryInput("EC", { aquacultureCostIndex: 1.1, priorAquacultureCostIndex: 1.0 });
  const pressure = calculateCostPressure(input);
  assert.ok(Math.abs(pressure - 0.1) < 1e-9);
});

test("コスト指数が下落するとコスト変化率は負になる", () => {
  const input = baseCountryInput("EC", { aquacultureCostIndex: 0.9, priorAquacultureCostIndex: 1.0 });
  const pressure = calculateCostPressure(input);
  assert.ok(pressure < 0);
});

test("コスト指数が非正の場合は例外", () => {
  assert.throws(() => calculateCostPressure(baseCountryInput("EC", { aquacultureCostIndex: 0 })));
  assert.throws(() => calculateCostPressure(baseCountryInput("EC", { priorAquacultureCostIndex: -1 })));
});

test("summarizeCountrySupplyは4か国分をまとめて返し、入力を変更しない", () => {
  const countries = {
    EC: baseCountryInput("EC"),
    IN: baseCountryInput("IN"),
    ID: baseCountryInput("ID"),
    VN: baseCountryInput("VN"),
  };
  const snapshot = JSON.parse(JSON.stringify(countries));
  const summary = summarizeCountrySupply(countries, COUNTRY_IDS);
  for (const c of COUNTRY_IDS) {
    assert.equal(summary[c].country, c);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(countries)), snapshot);
});
