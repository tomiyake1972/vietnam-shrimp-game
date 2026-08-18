// ShrimpX V2 — シナリオ別 会社営業組織能力上書きの単体テスト（Dynamic Scenario 3）

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyScenarioSalesCapacityOverride } from "../salesCapacityOverride";
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";
import { companySalesOrganizationCapacity, SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1 } from "../../sales/salesCapacityModel";
import { ScenarioDefinition } from "../types";
import { DYNAMIC_SCENARIO_1 } from "../definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../definitions/dynamicScenario2";
import { BASELINE_SCENARIO } from "../definitions/baseline";

test("SCAP-1: 上書きを宣言していないシナリオでは、同一オブジェクト参照がそのまま返る（挙動ビット単位不変）", () => {
  for (const definition of [BASELINE_SCENARIO, DYNAMIC_SCENARIO_1, DYNAMIC_SCENARIO_2]) {
    assert.equal(
      applyScenarioSalesCapacityOverride(SALES_PARAMETERS_V1, definition),
      SALES_PARAMETERS_V1,
      `${definition.scenarioId} は上書きを宣言していないので同一参照であるべき`
    );
  }
});

test("SCAP-2: baseline / DS1 / DS2 は salesOrganizationCapacityOverride を持たない（DS1・DS2不変の担保）", () => {
  for (const definition of [BASELINE_SCENARIO, DYNAMIC_SCENARIO_1, DYNAMIC_SCENARIO_2]) {
    assert.equal(definition.salesOrganizationCapacityOverride, undefined, definition.scenarioId);
  }
});

test("SCAP-3: 宣言した項目だけが差し替わり、宣言しなかった項目とkindは維持される", () => {
  const definition = {
    ...DYNAMIC_SCENARIO_2,
    scenarioId: "scap-test",
    salesOrganizationCapacityOverride: { companyCapacityMaxIncrementTons: 190_000 },
  } as ScenarioDefinition;
  const applied = applyScenarioSalesCapacityOverride(SALES_PARAMETERS_V1, definition);

  assert.notEqual(applied, SALES_PARAMETERS_V1, "上書きがある場合は別オブジェクトになる");
  assert.equal(applied.salesCapacityModel?.companyCapacityMaxIncrementTons, 190_000);
  assert.equal(
    applied.salesCapacityModel?.companyBaselineCapacityTons,
    SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.companyBaselineCapacityTons,
    "宣言していない項目は元のまま"
  );
  assert.equal(
    applied.salesCapacityModel?.companyCapacitySaturationHeadcount,
    SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.companyCapacitySaturationHeadcount
  );
  assert.equal(applied.salesCapacityModel?.kind, SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1.kind, "kindは勝手に変えない");

  // 営業工数係数は世界共通の性質なので、シナリオ上書きでは動かない。
  assert.deepEqual(applied.salesEffortCoefficients, SALES_PARAMETERS_V1.salesEffortCoefficients);
});

test("SCAP-4: 上書きすると能力曲線の漸近上限が実際に上がる（天井が動くことの確認）", () => {
  const base = SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1;
  const definition = {
    ...DYNAMIC_SCENARIO_2,
    scenarioId: "scap-test-2",
    salesOrganizationCapacityOverride: { companyCapacityMaxIncrementTons: 190_000, companyCapacitySaturationHeadcount: 260 },
  } as ScenarioDefinition;
  const model = applyScenarioSalesCapacityOverride(SALES_PARAMETERS_V1, definition).salesCapacityModel!;

  // 漸近上限（baseline + maxIncrement）が上がっている。
  assert.equal(base.companyBaselineCapacityTons + base.companyCapacityMaxIncrementTons, 96_000);
  assert.equal(model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons, 191_000);

  // 同じ人員での能力も単調に増える（人員をいくら増やしても届かない天井が上がる）。
  for (const h of [100, 250, 500, 1000]) {
    assert.ok(
      companySalesOrganizationCapacity(h, model) > companySalesOrganizationCapacity(h, base),
      `h=${h} で上書き後の方が大きいはず`
    );
  }
});
