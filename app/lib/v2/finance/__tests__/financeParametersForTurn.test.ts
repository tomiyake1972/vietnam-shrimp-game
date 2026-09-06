// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: Turn別FinanceParameters解決

import test from "node:test";
import assert from "node:assert/strict";

import { FINANCE_PARAMETERS_V1, financeParametersForTurn, normalCashFixedFactoryCostUsdPerQuarter } from "../parameters";
import { OPERATING_COST_INDEX_KEYS } from "../../scenario/costIndex";
import type { OperatingCostIndexKey } from "../../scenario/types";

function indices(overrides: Partial<Record<OperatingCostIndexKey, number>> = {}): Record<OperatingCostIndexKey, number> {
  const base = {} as Record<OperatingCostIndexKey, number>;
  for (const key of OPERATING_COST_INDEX_KEYS) base[key] = 1;
  return { ...base, ...overrides };
}

test("FIN-IDX-1: 全指数1.00なら base を同一参照で返す（現行計算とビット一致）", () => {
  const result = financeParametersForTurn(FINANCE_PARAMETERS_V1, indices());
  assert.equal(result, FINANCE_PARAMETERS_V1);
});

test("FIN-IDX-2: construction 指数は会社費用単価へ影響しない", () => {
  const result = financeParametersForTurn(FINANCE_PARAMETERS_V1, indices({ construction: 2.0 }));
  assert.equal(result, FINANCE_PARAMETERS_V1);
});

test("FIN-IDX-3: 各指数は対応する費目だけへ作用する（クロス汚染なし）", () => {
  const cases: ReadonlyArray<{
    readonly key: OperatingCostIndexKey;
    readonly read: (p: typeof FINANCE_PARAMETERS_V1) => number;
  }> = [
    { key: "sellingLogistics", read: (p) => p.sellingGeneralAdmin.sellingLogisticsUsdPerTon },
    { key: "regularLabor", read: (p) => p.labor.regularWorkerSalaryUsdPerQuarter },
    { key: "temporaryLabor", read: (p) => p.labor.temporaryWorkerCostUsdPerQuarter },
    { key: "factoryUtilityVariable", read: (p) => p.manufacturing.factoryUtilityVariableUsdPerTon },
    { key: "adminFixed", read: (p) => p.sellingGeneralAdmin.adminFixedUsdPerQuarter },
    { key: "qualityAssurance", read: (p) => p.manufacturing.reworkCostUsdPerTon },
  ];
  for (const { key, read } of cases) {
    const result = financeParametersForTurn(FINANCE_PARAMETERS_V1, indices({ [key]: 1.5 }));
    assert.equal(read(result), read(FINANCE_PARAMETERS_V1) * 1.5, key);
    // 他の費目は不変
    for (const other of cases) {
      if (other.key === key) continue;
      assert.equal(other.read(result), other.read(FINANCE_PARAMETERS_V1), `${key} -> ${other.key}`);
    }
    // factoryFixed 系も不変
    assert.equal(result.manufacturing.factoryFixedCostUsdPerQuarter, FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter, key);
    assert.equal(
      result.manufacturing.factoryUtilityFixedUsdPerQuarter,
      FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter,
      key
    );
  }
});

test("FIN-IDX-4: factoryFixed 指数は工場固定費と固定ユーティリティの両方へ掛かる", () => {
  const result = financeParametersForTurn(FINANCE_PARAMETERS_V1, indices({ factoryFixed: 1.4 }));
  assert.equal(
    result.manufacturing.factoryFixedCostUsdPerQuarter,
    FINANCE_PARAMETERS_V1.manufacturing.factoryFixedCostUsdPerQuarter * 1.4
  );
  assert.equal(
    result.manufacturing.factoryUtilityFixedUsdPerQuarter,
    FINANCE_PARAMETERS_V1.manufacturing.factoryUtilityFixedUsdPerQuarter * 1.4
  );
});

test("FIN-IDX-5: mothball 25% / sale pending 10% の基準額が自動追随する", () => {
  const index = 1.4;
  const result = financeParametersForTurn(FINANCE_PARAMETERS_V1, indices({ factoryFixed: index }));
  const baseNormal = normalCashFixedFactoryCostUsdPerQuarter(FINANCE_PARAMETERS_V1);
  const turnNormal = normalCashFixedFactoryCostUsdPerQuarter(result);
  // 各単価へ個別に指数を掛けてから合計するため、合計へ一度に掛けた場合と
  // IEEE754の最下位ビットだけ差が出る。経済的には同値であり、相対誤差で確認する。
  const relativeError = Math.abs(turnNormal - baseNormal * index) / (baseNormal * index);
  assert.ok(relativeError < 1e-12, `relativeError=${relativeError}`);
  // 比率そのものは定義を変えていない（基準額に対する25%/10%のまま）。
  assert.ok(Math.abs(turnNormal * 0.25 - baseNormal * index * 0.25) / (baseNormal * index) < 1e-12);
  assert.ok(Math.abs(turnNormal * 0.1 - baseNormal * index * 0.1) / (baseNormal * index) < 1e-12);
});

test("FIN-IDX-6: 固定費のドライバーを売上・数量へ変えていない（構造の固定）", () => {
  // FinanceParameters は「単価」しか持たない。数量ドライバー（activeFactoryCount）は
  // finance/quarterClose.ts 側の構造であり、この関数は単価しか触らない。
  const result = financeParametersForTurn(FINANCE_PARAMETERS_V1, indices({ factoryFixed: 3 }));
  assert.equal(typeof result.manufacturing.factoryFixedCostUsdPerQuarter, "number");
  assert.equal(Object.keys(result).sort().join(","), Object.keys(FINANCE_PARAMETERS_V1).sort().join(","));
});
