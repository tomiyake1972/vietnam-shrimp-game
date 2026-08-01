// ShrimpX V2 — companyLab/workforce.ts のテスト（Test15新設）
//
// 商品別労働集約度係数（production/parameters.ts labor.laborIntensityCoefficient、
// HOSO:PD:VAP=1.0:1.2:3.0）が、computeRequiredRegularHeadcount（意思決定画面・
// Standard AIの両方が経由する「必要Worker人数」の唯一の情報源）へ正しく反映されるか
// を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRequiredRegularHeadcount } from "../workforce";

test("Test15: 同じ数量を処理する場合、必要常用人数はHOSO<PD<VAPの順で増える", () => {
  const baseInput = {
    attendanceRate: 1,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  };

  const hoso = computeRequiredRegularHeadcount({
    ...baseInput,
    quantityByProduct: { hoso: 100 },
    skillByProduct: { hoso: 1 },
  });
  const pd = computeRequiredRegularHeadcount({
    ...baseInput,
    quantityByProduct: { pd: 100 },
    skillByProduct: { pd: 1 },
  });
  const vap = computeRequiredRegularHeadcount({
    ...baseInput,
    quantityByProduct: { vap: 100 },
    skillByProduct: { vap: 1 },
  });

  assert.ok(hoso.requiredRegularHeadcount < pd.requiredRegularHeadcount);
  assert.ok(pd.requiredRegularHeadcount < vap.requiredRegularHeadcount);
  assert.ok(Math.abs(pd.requiredRegularHeadcount / hoso.requiredRegularHeadcount - 1.2) < 1e-6);
  assert.ok(Math.abs(vap.requiredRegularHeadcount / hoso.requiredRegularHeadcount - 3.0) < 1e-6);
});

test("Test15: HOSOのみを生産する場合の必要人数は、労働集約度係数導入前の素の逆算式と一致する（回帰確認）", () => {
  const result = computeRequiredRegularHeadcount({
    quantityByProduct: { hoso: 60 },
    skillByProduct: { hoso: 0.8 },
    attendanceRate: 0.9,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  });
  // HOSOの係数は1.0なので、regularEfficiencyPerHeadTons(6) * 0.9 * 0.8 が分母になるはず。
  const expected = 60 / (6 * 0.9 * 0.8);
  assert.ok(Math.abs(result.requiredRegularHeadcount - expected) < 1e-6);
});
