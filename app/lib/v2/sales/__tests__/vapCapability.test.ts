// ShrimpX V2 — Test15新設: VAP能力合成係数（vapCapability）の成約競争力ウェイト
//
// 対応する要求事項:
//   - 同価格でVAP能力が高い会社ほど多く成約する
//   - vapCapabilityScore未設定・ウェイト既定0のときは既存挙動とビット単位で一致
//     （回帰確認）
//   - HOSO/PDの配分は一切影響を受けない
//   - ウェイトは1箇所（SalesParameters.competitivenessWeights.vapCapability）に
//     パラメータ化されている

import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateMarketProduct, computeCompetitivenessBreakdown } from "../allocation";
import { SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1, SALES_PARAMETERS_V1, SalesParameters } from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { hosoEqTons, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(9.0);

function entry(overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId: "X",
    market: "CN",
    product: "vap",
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 5,
    ...overrides,
  };
}

test("VAPCAP-1: SalesParameters.competitivenessWeights.vapCapabilityは既定0（既存挙動とビット単位で一致する後方互換）", () => {
  assert.equal(SALES_PARAMETERS_V1.competitivenessWeights.vapCapability, 0);
});

test("VAPCAP-2（単一パラメータ化の確認）: computeCompetitivenessBreakdownのvapCapabilityContributionは、SalesParameters.competitivenessWeights.vapCapabilityだけから決まる", () => {
  const params: SalesParameters = { ...SALES_PARAMETERS_V1, competitivenessWeights: { ...SALES_PARAMETERS_V1.competitivenessWeights, vapCapability: 0.5 } };
  const e = entry({ vapCapabilityScore: score0to100(80) });
  const breakdown = computeCompetitivenessBreakdown(e, BASE_PRICE, BASE_PRICE, 0.5, params);
  assert.ok(Math.abs(breakdown.vapCapabilityContribution - 0.5 * 0.8) < 1e-9, `実際: ${breakdown.vapCapabilityContribution}`);
});

test("VAPCAP-3（回帰確認・未設定）: vapCapabilityScoreが未設定でも、ウェイト既定0のため寄与は厳密に0", () => {
  const e = entry({}); // vapCapabilityScore未設定
  const breakdown = computeCompetitivenessBreakdown(e, BASE_PRICE, BASE_PRICE, 0.5, SALES_PARAMETERS_V1);
  assert.equal(breakdown.vapCapabilityContribution, 0);
});

test("VAPCAP-4（商品ゲート）: product!=='vap'のentryでは、vapCapabilityScoreを設定してもウェイトが正でも寄与は常に0（HOSO/PDには構造的に無関係）", () => {
  const paramsWithWeight: SalesParameters = { ...SALES_PARAMETERS_V1, competitivenessWeights: { ...SALES_PARAMETERS_V1.competitivenessWeights, vapCapability: 0.5 } };
  for (const product of ["hoso", "pd"] as const) {
    const e = entry({ product, vapCapabilityScore: score0to100(99) });
    const breakdown = computeCompetitivenessBreakdown(e, BASE_PRICE, BASE_PRICE, 0.5, paramsWithWeight);
    assert.equal(breakdown.vapCapabilityContribution, 0, `product=${product}`);
  }
});

test("VAPCAP-5（配分結果への効果）: 同価格・同条件でVAP能力の高い会社の方が多く成約する", () => {
  // maximumSupplierShareの上限に両社とも張り付いてしまうと重みの差が出ないため、
  // 上限を緩め・希望量を潤沢にして、水位法の競争力ウェイトで差がつく条件にする。
  const params: SalesParameters = { ...SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1, maximumSupplierShare: 1.0 };
  const entries: CompanySalesPlanEntry[] = [
    entry({ companyId: "HIGH", desiredQuantity: hosoEqTons(100000), vapCapabilityScore: score0to100(95) }),
    entry({ companyId: "LOW", desiredQuantity: hosoEqTons(100000), vapCapabilityScore: score0to100(5) }),
  ];
  const result = allocateMarketProduct("CN", "vap", P1, entries, BASE_PRICE, hosoEqTons(1500), params);
  const high = result.companies.find((c) => c.companyId === "HIGH")!;
  const low = result.companies.find((c) => c.companyId === "LOW")!;
  assert.ok(unwrapUnit(high.allocatedQuantity) > unwrapUnit(low.allocatedQuantity), `HIGH(${unwrapUnit(high.allocatedQuantity)}) should exceed LOW(${unwrapUnit(low.allocatedQuantity)})`);
});

test("VAPCAP-6（回帰確認・配分結果全体）: vapCapabilityウェイトが既定0のパラメータでは、vapCapabilityScoreの有無にかかわらず配分結果が完全に一致する", () => {
  const withScore: CompanySalesPlanEntry[] = [
    entry({ companyId: "A", vapCapabilityScore: score0to100(95) }),
    entry({ companyId: "B", vapCapabilityScore: score0to100(5) }),
  ];
  const withoutScore: CompanySalesPlanEntry[] = [entry({ companyId: "A" }), entry({ companyId: "B" })];

  const resultWithScore = allocateMarketProduct("CN", "vap", P1, withScore, BASE_PRICE, hosoEqTons(1500), SALES_PARAMETERS_V1);
  const resultWithoutScore = allocateMarketProduct("CN", "vap", P1, withoutScore, BASE_PRICE, hosoEqTons(1500), SALES_PARAMETERS_V1);

  for (const c of resultWithScore.companies) {
    const other = resultWithoutScore.companies.find((o) => o.companyId === c.companyId)!;
    assert.equal(unwrapUnit(c.allocatedQuantity), unwrapUnit(other.allocatedQuantity), c.companyId);
  }
});

test("VAPCAP-7: HOSO・PDの配分結果は、VAP能力ウェイトが正のパラメータであっても一切影響を受けない", () => {
  const params = SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1;
  for (const product of ["hoso", "pd"] as const) {
    const entriesWithScore: CompanySalesPlanEntry[] = [
      entry({ companyId: "A", product, vapCapabilityScore: score0to100(95) }),
      entry({ companyId: "B", product, vapCapabilityScore: score0to100(5) }),
    ];
    const entriesWithoutScore: CompanySalesPlanEntry[] = [
      entry({ companyId: "A", product }),
      entry({ companyId: "B", product }),
    ];
    const withScoreResult = allocateMarketProduct("CN", product, P1, entriesWithScore, BASE_PRICE, hosoEqTons(1500), params);
    const withoutScoreResult = allocateMarketProduct("CN", product, P1, entriesWithoutScore, BASE_PRICE, hosoEqTons(1500), params);
    for (const c of withScoreResult.companies) {
      const other = withoutScoreResult.companies.find((o) => o.companyId === c.companyId)!;
      assert.equal(unwrapUnit(c.allocatedQuantity), unwrapUnit(other.allocatedQuantity), `${product}/${c.companyId}`);
    }
  }
});
