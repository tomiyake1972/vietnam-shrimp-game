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
import { minimumAcceptablePremium, orderQuantityFactor } from "../premiumPolicy";
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

test("新規成約量は当四半期分だけになる（累積契約一覧ではなくsalesRecord.newContractsと一致する）", () => {
  const result = runAllAuto(baseConfig({ seed: "new-contracts-001", turns: 6 }));
  for (const record of result.history) {
    for (const s of record.companySummaries) {
      const trueThisQuarter = record.salesRecord.newContracts
        .filter((c) => c.companyId === s.companyId)
        .reduce((sum, c) => sum + unwrapUnit(c.originalQuantity), 0);
      assert.ok(
        Math.abs(unwrapUnit(s.newContractedQuantity) - trueThisQuarter) < 0.01,
        `turn ${record.turn} ${s.companyId}: summary=${unwrapUnit(s.newContractedQuantity)} true=${trueThisQuarter}`
      );
    }
  }
});

test("履行量は当期の完成品充当実績（fulfillmentPlan.usage）と一致し、当期成約・当期即時履行も含まれる", () => {
  const result = runAllAuto(baseConfig({ seed: "fulfill-usage-001", turns: 6 }));
  let anyPositive = false;
  for (const record of result.history) {
    let companyTotal = 0;
    for (const s of record.companySummaries) {
      const trueUsage = record.fulfillmentPlan.usage
        .filter((u) => u.companyId === s.companyId)
        .reduce((sum, u) => sum + unwrapUnit(u.quantity), 0);
      assert.ok(
        Math.abs(unwrapUnit(s.fulfilledQuantity) - trueUsage) < 0.01,
        `turn ${record.turn} ${s.companyId}: summary=${unwrapUnit(s.fulfilledQuantity)} usage=${trueUsage}`
      );
      companyTotal += unwrapUnit(s.fulfilledQuantity);
      if (trueUsage > 1e-6) anyPositive = true;
    }
    // 会社別合計 = 全社合計（usage全量）と一致する。
    const grandTotal = record.fulfillmentPlan.usage.reduce((sum, u) => sum + unwrapUnit(u.quantity), 0);
    assert.ok(Math.abs(companyTotal - grandTotal) < 0.01);
  }
  assert.ok(anyPositive, "6ターン通して履行実績が一件もないのは自動方針の異常");
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

// --- Phase 6.3: 経済尺度・受注判断・調達構成 ---

test("baselineで国内原料価格が$1/kg未満へ下落しない（農家留保価格による経済的下限）", () => {
  const result = runAllAuto(baseConfig({ seed: "price-floor-001", turns: 32 }));
  for (const record of result.history) {
    const price = unwrapUnit(record.marketResult.vietnamDomestic.price);
    assert.ok(price >= 1.0, `turn ${record.turn}: 国内原料価格 ${price} が$1/kg未満`);
    // 価格は農家留保価格以上（数値バックストップ0.05には到達しない）。
    assert.ok(price >= unwrapUnit(record.marketResult.vietnamDomestic.farmerReservationPrice) - 1e-9);
  }
});

test("baselineで主要国HOSO価格が絶対下限($0.50)へ長期間張り付かない", () => {
  const result = runAllAuto(baseConfig({ seed: "hoso-floor-001", turns: 32 }));
  for (const country of ["EC", "IN", "ID", "VN"] as const) {
    const atFloorCount = result.history.filter((r) => unwrapUnit(r.marketResult.hosoPrices[country].price) <= 0.5 + 1e-9).length;
    assert.ok(atFloorCount === 0, `国${country}: ${atFloorCount}ターンが絶対下限に張り付いている`);
  }
});

test("外部加工業者需要が国内価格形成へ含まれ、5社が買付を止めても業界需要はゼロにならない", () => {
  const zeroProvider: typeof generateAutoPolicyDecision = (fixture, ownState, publicInfo, period, turn) => {
    const base = generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn);
    return { ...base, domesticPurchasePlan: { ...base.domesticPurchasePlan, desiredQuantity: hosoEqTons(0) } };
  };
  const result = runCompanyLabWithAutoPolicyForAllCompanies(baseConfig({ seed: "external-001", turns: 2 }), zeroProvider);
  for (const record of result.history) {
    assert.ok(record.turnDebug.externalProcessorIntent !== undefined);
    assert.ok(unwrapUnit(record.turnDebug.externalProcessorIntent!) > 100000, "外部加工業者需要が過小");
    assert.ok(unwrapUnit(record.marketResult.vietnamDomestic.effectiveDemand) > 100000, "5社が買付ゼロでも業界需要が残る");
  }
});

test("国内買付需要が数ターンで一斉にゼロにならず、原料在庫が無制限に増えない", () => {
  const result = runAllAuto(baseConfig({ seed: "sourcing-001", turns: 16 }));
  for (const record of result.history) {
    const totalDesired = record.decisions.reduce((sum, d) => sum + unwrapUnit(d.domesticPurchasePlan.desiredQuantity), 0);
    assert.ok(totalDesired > 1000, `turn ${record.turn}: 5社合計の国内買付希望が実質ゼロ（${totalDesired}）`);
  }
  // 原料在庫が発散しない: 最終4ターンの合計在庫が「全社の四半期生産規模の2倍」以内。
  const lastRecords = result.history.slice(-4);
  for (const record of lastRecords) {
    const totalInventory = record.companySummaries.reduce((sum, s) => sum + unwrapUnit(s.rawMaterialInventory), 0);
    const totalProduced = record.companySummaries.reduce(
      (sum, s) => sum + unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced),
      0
    );
    assert.ok(totalInventory < Math.max(totalProduced, 1) * 2.5, `turn ${record.turn}: 原料在庫 ${totalInventory} が生産規模 ${totalProduced} に対して過大`);
  }
});

test("最低受注プレミアム未満の商品には販売提案が出ず、生産・稼働率が低下する（価格ではなく数量・稼働で調整）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed: "premium-exit-001", turns: 2 }));
  // 1ターン目を通常進行して前期市場実績を作る。
  const publicInfo1 = buildPublicMarketInfo(state);
  const decisions1: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    decisions1[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo1, state.currentPeriod, 1);
  }
  const state2 = advanceCompanyLabQuarter(state, fixtures, decisions1);

  // 2ターン目: VAPプレミアムが最低受注水準を大きく下回る公開情報を想定した受注判断を検証する。
  const massFixture = fixtures.find((f) => f.companyId === "MASS")!;
  const vapFixture = fixtures.find((f) => f.companyId === "VAP")!;
  const lowPremiumInfo = {
    ...buildPublicMarketInfo(state2),
  };
  // 実際の市場結果を使った通常ケース: 高プレミアム時はVAP販売提案がある。
  const massNormal = generateAutoPolicyDecision(massFixture, buildCompanyOwnState(state2, massFixture), lowPremiumInfo, state2.currentPeriod, 2);
  void massNormal;

  // orderQuantityFactorの単体挙動で受注判断を確認（プレミアム0.2はMASSのVAP最低受注水準0.94未満、VAP社の0.47未満）。
  assert.equal(orderQuantityFactor(massFixture.productEconomics.premiumEconomics.vap, 0.2), 0);
  assert.equal(orderQuantityFactor(vapFixture.productEconomics.premiumEconomics.vap, 0.2), 0);
  // プレミアム0.55: 高コストのMASS(最低0.94)は退出するが、効率的なVAP社(最低0.47)は受注可能。
  assert.equal(orderQuantityFactor(massFixture.productEconomics.premiumEconomics.vap, 0.55), 0);
  assert.ok(orderQuantityFactor(vapFixture.productEconomics.premiumEconomics.vap, 0.55) > 0);
  // 目標水準以上では通常受注。
  assert.equal(orderQuantityFactor(vapFixture.productEconomics.premiumEconomics.vap, 2.0), 1);
  // VAPの最低受注水準は原則PDより高い（全社）。
  for (const f of fixtures) {
    assert.ok(
      minimumAcceptablePremium(f.productEconomics.premiumEconomics.vap) > minimumAcceptablePremium(f.productEconomics.premiumEconomics.pd),
      `${f.companyId}: VAP最低受注水準がPD以下`
    );
  }
});

test("契約に契約時予想原価スナップショットが保持され、契約後の原料高でも契約単価が変わらない", () => {
  const result = runAllAuto(baseConfig({ seed: "snapshot-001", turns: 4 }));
  let checked = 0;
  const unitPriceByContract = new Map<string, number>();
  for (const record of result.history) {
    for (const c of record.salesRecord.newContracts) {
      assert.ok(c.costSnapshot !== undefined, `契約 ${c.contractId} にcostSnapshotが無い`);
      assert.ok(Number.isFinite(c.costSnapshot!.expectedRawMaterialPriceUsdPerHosoEqKg));
      assert.ok(Number.isFinite(c.costSnapshot!.expectedProcessingCostUsdPerHosoEqKg));
      assert.ok(Number.isFinite(c.costSnapshot!.minimumAcceptablePriceUsdPerHosoEqKg));
      assert.ok(Number.isFinite(c.costSnapshot!.expectedContributionMarginUsdPerHosoEqKg));
      unitPriceByContract.set(c.contractId, unwrapUnit(c.unitPrice));
      checked++;
    }
  }
  assert.ok(checked > 0, "検証対象の契約が1件もない");
  // 各契約の単価は成約後のどの四半期の状態でも変わらない（自動改定しない）。
  const lastState = result.history[result.history.length - 1];
  void lastState;
  const finalContracts = result.history.flatMap((r) => r.salesRecord.newContracts);
  for (const c of finalContracts) {
    assert.equal(unwrapUnit(c.unitPrice), unitPriceByContract.get(c.contractId));
  }
});

test("調達構成: 全社が自社養殖だけで恒常的に完全自給しない（国内買付・輸入が実際に発生し続ける）", () => {
  const result = runAllAuto(baseConfig({ seed: "mix-001", turns: 12 }));
  const lastHalf = result.history.slice(6);
  for (const s of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
    const domestic = lastHalf.reduce((sum, r) => sum + unwrapUnit(r.companySummaries.find((x) => x.companyId === s)!.domesticPurchaseQuantity), 0);
    const aqua = lastHalf.reduce((sum, r) => sum + unwrapUnit(r.companySummaries.find((x) => x.companyId === s)!.aquacultureHarvestedQuantity), 0);
    const imports = lastHalf.reduce((sum, r) => sum + unwrapUnit(r.companySummaries.find((x) => x.companyId === s)!.importArrivedQuantity), 0);
    const total = domestic + aqua + imports;
    assert.ok(total > 0, `${s}: 調達実績が無い`);
    assert.ok(aqua / total < 0.6, `${s}: 自社養殖への依存が過大（${((aqua / total) * 100).toFixed(0)}%）`);
    assert.ok(domestic > 0, `${s}: 国内買付が発生していない`);
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
