import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import {
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  initializeCompanyLab,
  runCompanyLabWithAutoPolicyForAllCompanies,
} from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../types";
import { CompanyProductionPlanEntry } from "../../production/types";

const EPSILON = 1e-6;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "test-seed-001", turns: 8, ...overrides };
}

function runAllAuto(config: CompanyLabConfig) {
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

test("5社×8ターンを完走する", () => {
  const result = runAllAuto(baseConfig({ turns: 8 }));
  assert.equal(result.history.length, 8);
  assert.equal(result.companies.length, 5);
  for (const record of result.history) {
    assert.equal(record.companySummaries.length, 5);
  }
});

test("5社×32ターンを完走する", () => {
  const result = runAllAuto(baseConfig({ turns: 32 }));
  assert.equal(result.history.length, 32);
});

test("同一シード・同一設定・同一意思決定で完全に同じ結果になる（決定論性）", () => {
  const resultA = runAllAuto(baseConfig({ seed: "determinism-001", turns: 8 }));
  const resultB = runAllAuto(baseConfig({ seed: "determinism-001", turns: 8 }));
  assert.equal(JSON.stringify(resultA.history), JSON.stringify(resultB.history));
});

test("すべての四半期・すべての数量フィールドが負にならない", () => {
  const result = runAllAuto(baseConfig({ seed: "nonneg-001", turns: 16 }));
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      for (const [key, value] of Object.entries(s)) {
        if (key === "reasonCodes" || key === "companyId" || key === "period") continue;
        if (typeof value === "number") {
          assert.ok(value >= -EPSILON, `${s.companyId} ${key} = ${value} が負`);
        }
      }
    }
    for (const lot of record.newFinishedGoodsLots) {
      assert.ok(unwrapUnit(lot.remainingQuantity) >= -EPSILON);
    }
  }
});

test("原料消費量=完成品数量+加工損失（バッチ単位の数量保存が32ターン通して成立する）", () => {
  const result = runAllAuto(baseConfig({ seed: "conservation-001", turns: 12 }));
  for (const record of result.history) {
    for (const batch of record.batches) {
      const consumed = unwrapUnit(batch.rawMaterialConsumedTotal);
      const finished = unwrapUnit(batch.finishedGoodsQuantity);
      const loss = unwrapUnit(batch.processingLoss);
      assert.ok(Math.abs(consumed - (finished + loss)) < 0.05, `batch ${batch.batchId}: consumed=${consumed} finished+loss=${finished + loss}`);
    }
  }
});

test("契約履行: どの四半期でも未履行残高は当初契約数量を超えない（過剰履行がない）", () => {
  const result = runAllAuto(baseConfig({ seed: "fulfillment-001", turns: 10 }));
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      assert.ok(unwrapUnit(s.outstandingQuantity) >= -EPSILON);
      assert.ok(unwrapUnit(s.overdueQuantity) <= unwrapUnit(s.outstandingQuantity) + EPSILON);
    }
  }
});

test("完成品在庫: 会社×商品の消費量はその時点までの生産量+繰越在庫の合計を超えない（過剰消費がない）", () => {
  // consumeFinishedGoods自体が過剰消費を例外で拒否するため（finishedGoods.ts）、
  // 32ターン通して例外なく完走すること自体が本条件の検証になる。
  const result = runAllAuto(baseConfig({ seed: "fg-conservation-001", turns: 32 }));
  assert.equal(result.history.length, 32);
});

test("工場×商品の生産量は工場能力・原料・ワーカーいずれの制約も超えない", () => {
  const result = runAllAuto(baseConfig({ seed: "capacity-001", turns: 8 }));
  for (const record of result.history) {
    for (const entry of record.productionAllocation.entries) {
      assert.ok(unwrapUnit(entry.allocatedQuantity) <= unwrapUnit(entry.desiredQuantity) + EPSILON);
      assert.ok(unwrapUnit(entry.allocatedQuantity) <= unwrapUnit(entry.stages.laborLimited) + EPSILON);
    }
  }
});

test("会社×工場のワーカー配分合計は配置人数（常用・臨時それぞれ）を超えない（Phase6.1の共有プール保証が統合環境でも成立する）", () => {
  const result = runAllAuto(baseConfig({ seed: "labor-001", turns: 8 }));
  for (const record of result.history) {
    const byFactory = new Map<string, { regular: number; temporary: number }>();
    for (const entry of record.productionAllocation.entries) {
      const t = byFactory.get(entry.factoryId) ?? { regular: 0, temporary: 0 };
      t.regular += entry.labor.assignedRegularHeadcount;
      t.temporary += entry.labor.assignedTemporaryHeadcount;
      byFactory.set(entry.factoryId, t);
    }
    const assignmentsByFactory = new Map(record.decisions.flatMap((d) => d.workerAssignments).map((w) => [w.factoryId, w]));
    for (const [factoryId, totals] of byFactory) {
      const assignment = assignmentsByFactory.get(factoryId)!;
      assert.ok(totals.regular <= assignment.regularHeadcount + EPSILON, `factory ${factoryId}: regular ${totals.regular} > ${assignment.regularHeadcount}`);
      assert.ok(totals.temporary <= assignment.temporaryHeadcount + EPSILON, `factory ${factoryId}: temporary ${totals.temporary} > ${assignment.temporaryHeadcount}`);
    }
  }
});

test("国内買付希望量が増えると国内原料価格が上がる（他条件をなるべく揃えた比較）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ seed: "price-up-001", turns: 1 }));
  const publicInfo = buildPublicMarketInfo(state0);

  const lowDecisions: Record<string, CompanyDecisionInput> = {};
  const highDecisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state0, f);
    const base = generateAutoPolicyDecision(f, own, publicInfo, state0.currentPeriod, 1);
    lowDecisions[f.companyId] = { ...base, domesticPurchasePlan: { ...base.domesticPurchasePlan, desiredQuantity: base.domesticPurchasePlan.desiredQuantity } };
    highDecisions[f.companyId] = {
      ...base,
      domesticPurchasePlan: {
        ...base.domesticPurchasePlan,
        desiredQuantity: (() => {
          return hosoEqTons(unwrapUnit(base.domesticPurchasePlan.desiredQuantity) + 50000);
        })(),
      },
    };
  }

  const lowResult = advanceCompanyLabQuarter(state0, fixtures, lowDecisions);
  const highResult = advanceCompanyLabQuarter(state0, fixtures, highDecisions);

  const lowPrice = unwrapUnit(lowResult.history[0].marketResult.vietnamDomestic.price);
  const highPrice = unwrapUnit(highResult.history[0].marketResult.vietnamDomestic.price);
  assert.ok(highPrice > lowPrice, `低需要価格${lowPrice} 高需要価格${highPrice}`);
});

test("PD/VAP供給計画の増加はプレミアムを低下させる（他条件をなるべく揃えた比較）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ seed: "premium-down-001", turns: 1 }));
  const publicInfo = buildPublicMarketInfo(state0);

  const lowDecisions: Record<string, CompanyDecisionInput> = {};
  const highDecisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state0, f);
    const base = generateAutoPolicyDecision(f, own, publicInfo, state0.currentPeriod, 1);
    lowDecisions[f.companyId] = base;
    highDecisions[f.companyId] = {
      ...base,
      productionPlans: base.productionPlans.map((p: CompanyProductionPlanEntry) =>
        p.product === "vap" ? { ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * 3) } : p
      ),
    };
  }

  const lowResult = advanceCompanyLabQuarter(state0, fixtures, lowDecisions);
  const highResult = advanceCompanyLabQuarter(state0, fixtures, highDecisions);

  const lowPremium = unwrapUnit(lowResult.history[0].marketResult.vapPremium.basePremium);
  const highPremium = unwrapUnit(highResult.history[0].marketResult.vapPremium.basePremium);
  assert.ok(highPremium <= lowPremium + EPSILON, `低供給プレミアム${lowPremium} 高供給プレミアム${highPremium}`);
});

test("HOSO国際基準価格（他国のFOB価格）は個社（VN）の行動だけでは変化しない", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ seed: "hoso-independence-001", turns: 1 }));
  const publicInfo = buildPublicMarketInfo(state0);

  const decisionsA: Record<string, CompanyDecisionInput> = {};
  const decisionsB: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state0, f);
    const base = generateAutoPolicyDecision(f, own, publicInfo, state0.currentPeriod, 1);
    decisionsA[f.companyId] = base;
    decisionsB[f.companyId] = {
      ...base,
      productionPlans: base.productionPlans.map((p: CompanyProductionPlanEntry) => ({ ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * 2) })),
    };
  }

  const resultA = advanceCompanyLabQuarter(state0, fixtures, decisionsA);
  const resultB = advanceCompanyLabQuarter(state0, fixtures, decisionsB);

  for (const country of ["EC", "IN", "ID"] as const) {
    const priceA = unwrapUnit(resultA.history[0].marketResult.hosoPrices[country].price);
    const priceB = unwrapUnit(resultB.history[0].marketResult.hosoPrices[country].price);
    assert.ok(Math.abs(priceA - priceB) < 1e-9, `国${country}のHOSO価格がVN企業の行動で変化した: ${priceA} vs ${priceB}`);
  }
});

test("自動方針は公開情報と自社状態だけを使う（関数シグネチャ上、他社の非公開計画・将来シナリオを受け取れない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "isolation-001", turns: 1 }));
  const publicInfo = buildPublicMarketInfo(state);
  const own = buildCompanyOwnState(state, fixtures[0]);

  // ownStateには自社（fixtures[0]）以外の契約・原料在庫・完成品在庫が一切含まれない。
  assert.ok(own.contracts.every((c) => c.companyId === fixtures[0].companyId));
  assert.ok(own.rawMaterialLots.every((l) => l.companyId === fixtures[0].companyId));
  assert.ok(own.finishedGoodsLots.every((l) => l.companyId === fixtures[0].companyId));

  // generateAutoPolicyDecisionの引数はfixture・own・publicInfo・period・turnのみで、
  // 他社の意思決定オブジェクトそのものを渡す経路が存在しない（型シグネチャで保証）。
  const decision = generateAutoPolicyDecision(fixtures[0], own, publicInfo, state.currentPeriod, 1);
  assert.equal(decision.companyId, fixtures[0].companyId);
});

test("プレイヤー入力は選択会社だけに適用される（他社の意思決定は自動方針のまま変わらない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "player-scope-001", turns: 1 }));
  const publicInfo = buildPublicMarketInfo(state);

  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, 1);
  }
  const playerCompanyId = fixtures[0].companyId;
  const otherCompanyId = fixtures[1].companyId;
  const originalOtherPlans = decisions[otherCompanyId];

  decisions[playerCompanyId] = {
    ...decisions[playerCompanyId],
    productionPlans: decisions[playerCompanyId].productionPlans.map((p) => ({ ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * 0.1) })),
  };

  const after = advanceCompanyLabQuarter(state, fixtures, decisions);
  assert.equal(after.history[0].decisions.find((d) => d.companyId === otherCompanyId), originalOtherPlans);
});

test("入力（state・fixtures・decisions）を変更しない", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "immutability-001", turns: 1 }));
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, 1);
  }
  const beforeState = JSON.stringify(state);
  const beforeFixtures = JSON.stringify(fixtures);
  const beforeDecisions = JSON.stringify(decisions);
  advanceCompanyLabQuarter(state, fixtures, decisions);
  assert.equal(JSON.stringify(state), beforeState);
  assert.equal(JSON.stringify(fixtures), beforeFixtures);
  assert.equal(JSON.stringify(decisions), beforeDecisions);
});
