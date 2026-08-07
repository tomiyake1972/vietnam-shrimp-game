// ShrimpX V2 — Phase 8D-1/8D-2/8D-4/8D-6 共通view-modelの統合テスト
//
// 実装指示§12のテスト項目のうち、次を担当する。
//   1. Workerを減らすと、変更後人数と人件費が減少する
//   2. Worker不足時に処理可能数量が減り、未処理見込みが表示される
//   3. Workerを増やしても設備能力を超えて処理量が増えない
//   8. forecastの処理可能量と、実際の生産エンジン結果が一致する
//  11. 品質設備・環境設備の未実装効果が数値として表示されない
//  12. 投資回収計算が売上ではなく、実装済みの増分利益または増分CFを使用する
//  15. 同じ入力ではforecastが決定論的に一致する
//  16. 数量・金額・比率に NaN・Infinity・不正な負数が発生しない
//
// いずれも実際のエンジンを通して検証し、テスト側で計算式を再実装しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../lib/v2/core/units";
import {
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  CompanyDecisionInput,
  CompanyFixture,
  CompanyLabConfig,
  CompanyLabState,
  generateAutoPolicyDecision,
  initializeCompanyLab,
} from "../../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex";
import { buildDecisionInputFromDraft, buildInitialDraft, CompanyDecisionDraft } from "../decisionDraft";
import { FINANCE_PARAMETERS_V1 } from "../../../lib/v2/finance/parameters";
import { computeIncrementalRegularHires, computeQuarterlyLaborCost } from "../../../lib/v2/companyLab/workforce";
import {
  buildCompanyInvestmentPlanningViewModel,
  buildPaybackEstimate,
  PAYBACK_DOUBLE_COUNTING_NOTE,
  PROJECT_EFFECT_DISCLOSURES,
} from "../investmentPlanningViewModel";

const PLAYER = "BAL";

function baseConfig(seed: string, turns = 6): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns };
}

function setup(seed: string) {
  const { state, fixtures } = initializeCompanyLab(baseConfig(seed));
  const fixture = fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const auto = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, auto, ownState.workforceState);
  return { state, fixtures, fixture, ownState, draft };
}

function buildPlanning(
  state: CompanyLabState,
  fixture: CompanyFixture,
  draft: CompanyDecisionDraft,
  lastQuarterFinancialResult?: Parameters<typeof buildCompanyInvestmentPlanningViewModel>[0]["lastQuarterFinancialResult"]
) {
  const ownState = buildCompanyOwnState(state, fixture);
  const decisionInput = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  return buildCompanyInvestmentPlanningViewModel({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period: state.currentPeriod,
    productionPlans: decisionInput.productionPlans,
    workerAssignments: decisionInput.workerAssignments,
    workforceState: ownState.workforceState,
    rawMaterialLots: ownState.rawMaterialLots,
    finishedGoodsLots: ownState.finishedGoodsLots,
    lastQuarterFinancialResult,
    capexParams: CAPEX_PARAMETERS_V1,
  });
}

/** ワーカー行の常用人数を絶対値で置き換えたドラフトを作る（増減差分も更新する）。 */
function withHeadcount(draft: CompanyDecisionDraft, headcount: number): CompanyDecisionDraft {
  return {
    ...draft,
    workerAssignments: draft.workerAssignments.map((w) => {
      const before = w.regularHeadcountBefore ?? w.regularHeadcount;
      return { ...w, regularHeadcount: headcount, regularHeadcountBefore: before, regularHeadcountChange: headcount - before };
    }),
  };
}

function totalProcessedTons(planning: ReturnType<typeof buildCompanyInvestmentPlanningViewModel>): number {
  return planning.forecast.rows.reduce((s, r) => s + r.forecastProcessedTons, 0);
}

// ---------------------------------------------------------------------
// テスト項目1: Workerを減らすと、変更後人数と人件費が減少する
// ---------------------------------------------------------------------

test("IP-1（必須1）: Workerを減らすと、変更後人数と四半期人件費の両方が減少する", () => {
  const { state, fixture, draft } = setup("phase8d-ip-001");
  const before = buildPlanning(state, fixture, draft);
  const baseHeadcount = before.workforceRows[0].headcountAfter;
  assert.ok(baseHeadcount > 0);

  const reduced = buildPlanning(state, fixture, withHeadcount(draft, Math.floor(baseHeadcount / 4)));
  const rowBefore = before.workforceRows[0];
  const rowAfter = reduced.workforceRows[0];

  assert.ok(rowAfter.headcountAfter < rowBefore.headcountAfter, "変更後人数が減っていません");
  assert.ok(rowAfter.costAfter.totalCostUsd < rowBefore.costAfter.totalCostUsd, "四半期人件費が減っていません");
  assert.ok(rowAfter.costDeltaUsd < 0, "人件費の増減がマイナスで表示されていません");
  // 増減差分は「前期末人数 → 変更後人数」の差として表示される。
  assert.equal(rowAfter.headcountChange, rowAfter.headcountAfter - rowAfter.headcountBefore);
});

// ---------------------------------------------------------------------
// テスト項目2: Worker不足時に処理可能数量が減り、未処理見込みが表示される
// ---------------------------------------------------------------------

test("IP-2（必須2）: Workerを大幅に減らすと処理可能数量が減り、未処理見込みと不足の説明が表示される", () => {
  const { state, fixture, draft } = setup("phase8d-ip-002");
  const before = buildPlanning(state, fixture, draft);
  const starved = buildPlanning(state, fixture, withHeadcount(draft, 1));

  assert.ok(totalProcessedTons(starved) < totalProcessedTons(before), "Workerを減らしても処理可能量が減っていません");

  const row = starved.workforceRows[0];
  assert.equal(row.isShortage, true, "不足として判定されていません");
  assert.ok(row.unprocessedByLaborTons > 0, "Worker削減による未処理見込みが表示されていません");
  assert.ok(row.shortageSentence !== undefined && row.shortageSentence.length > 0, "不足の説明文がありません");

  const warning = starved.warnings.find((w) => w.kind === "workerShortage");
  assert.ok(warning, "Worker不足の警告が出ていません");
  // 色だけでなく、不足量と理由が文章で示されていること。
  assert.ok(warning!.sentence.includes("不足"), "警告文に不足の理由が書かれていません");
  assert.ok(warning!.shortfallAmount !== undefined && warning!.shortfallUnitLabel === "人");
});

// ---------------------------------------------------------------------
// テスト項目3: Workerを増やしても設備能力を超えて処理量が増えない
// ---------------------------------------------------------------------

test("IP-3（必須3）: Workerを増やしても、設備能力を超えて処理量は増えない", () => {
  const { state, fixture, draft } = setup("phase8d-ip-003");
  const many = buildPlanning(state, fixture, withHeadcount(draft, 50_000));
  const absurd = buildPlanning(state, fixture, withHeadcount(draft, 500_000));

  assert.equal(totalProcessedTons(absurd), totalProcessedTons(many), "人数を10倍にしても処理量は変わらないはず（設備・原料が上限）");

  // 推定労働能力も、設備の名目能力でクリップされている。
  const row = absurd.workforceRows[0];
  const factory = fixture.factories[0];
  for (const [product, capacity] of [
    ["hoso", unwrapUnit(factory.hosoCapacity)],
    ["pd", unwrapUnit(factory.pdCapacity)],
    ["vap", unwrapUnit(factory.vapCapacity)],
  ] as const) {
    const laborCapacity = row.laborCapacityByProductAfter[product] ?? 0;
    assert.ok(laborCapacity <= capacity + 1e-6, `${product}: 推定労働能力(${laborCapacity})が設備能力(${capacity})を超えています`);
  }
});

// ---------------------------------------------------------------------
// テスト項目8: forecastの処理可能量と、実際の生産エンジン結果が一致する
// ---------------------------------------------------------------------

test("IP-4（必須8）: 画面の処理見込みと、実際にターンを実行した生産結果が一致する", () => {
  const { state, fixtures, fixture, draft } = setup("phase8d-ip-004");

  // 当期に新しい原料が入庫すると、見込み計算時点の在庫と実行時の在庫がずれる
  // （これは見込み表の注意書きどおりの仕様）。ここでは「入庫が無い」条件を作って、
  // 見込みと実績が厳密に一致することを確認する。
  const noInflowDraft: CompanyDecisionDraft = {
    ...draft,
    domesticPurchase: { ...draft.domesticPurchase, desiredQuantity: 0 },
    importOrders: draft.importOrders.map((o) => ({ ...o, orderedQuantity: 0 })),
    aquacultureStockingPlans: draft.aquacultureStockingPlans.map((a) => ({ ...a, plannedStockingQuantity: 0 })),
  };

  const planning = buildPlanning(state, fixture, noInflowDraft);
  const forecastByKey = new Map(planning.forecast.rows.map((r) => [`${r.factoryId}::${r.product}`, r.forecastProcessedTons]));

  // 同じドラフトをそのままエンジンへ提出して1四半期進める。
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    if (f.companyId === PLAYER) {
      decisionsByCompanyId[f.companyId] = buildDecisionInputFromDraft(noInflowDraft, f, state.currentPeriod);
    } else {
      const ownState = buildCompanyOwnState(state, f);
      decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, 1);
    }
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
  const record = nextState.history[nextState.history.length - 1];

  const actualEntries = record.productionAllocation.entries.filter((e) => e.companyId === PLAYER);
  assert.ok(actualEntries.length > 0, "プレイヤー会社の生産配分結果が存在すること");

  for (const entry of actualEntries) {
    const key = `${entry.factoryId}::${entry.product}`;
    const forecastTons = forecastByKey.get(key);
    assert.ok(forecastTons !== undefined, `${key} の処理見込みが画面に出ていません`);
    assert.ok(
      Math.abs(forecastTons! - unwrapUnit(entry.allocatedQuantity)) < 1e-6,
      `${key}: 見込み ${forecastTons} と実績 ${unwrapUnit(entry.allocatedQuantity)} が一致しません`
    );
  }
});

// ---------------------------------------------------------------------
// テスト項目15: 同じ入力ではforecastが決定論的に一致する
// ---------------------------------------------------------------------

test("IP-5（必須15）: 同じ入力なら、共通view-modelの出力が完全に一致する（決定論性）", () => {
  const { state, fixture, draft } = setup("phase8d-ip-005");
  const a = buildPlanning(state, fixture, draft);
  const b = buildPlanning(state, fixture, draft);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
});

// ---------------------------------------------------------------------
// テスト項目16: NaN・Infinity・不正な負値が発生しない
// ---------------------------------------------------------------------

test("IP-6（必須16）: 共通view-modelの数量・金額・比率に NaN・Infinity が発生しない", () => {
  const { state, fixture, draft } = setup("phase8d-ip-006");
  // 極端な入力（Worker 0人・巨大な生産希望量）でも壊れないこと。
  const extreme: CompanyDecisionDraft = {
    ...withHeadcount(draft, 0),
    productionPlans: draft.productionPlans.map((p) => ({ ...p, desiredQuantity: 999_999 })),
  };
  const planning = buildPlanning(state, fixture, extreme);

  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value), `${path} が有限の数値ではありません: ${value}`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}.${k}`);
  };
  walk(planning, "planning");

  // 不正な負値が入りやすい箇所を明示的に確認する。
  assert.ok(planning.factorySpace.totalSpaceUnits >= 0);
  assert.ok(planning.factorySpace.freeSpaceUnits >= 0);
  assert.ok(planning.coldStorage.usedTons >= 0);
  assert.ok(planning.coldStorage.freeTons >= 0);
  for (const row of planning.workforceRows) {
    assert.ok(row.headcountAfter >= 0);
    assert.ok(row.costAfter.totalCostUsd >= 0);
    assert.ok(row.requiredRegularHeadcount >= 0);
  }
  for (const card of planning.investmentCards) {
    assert.ok(card.requiredSpaceUnits >= 0);
    assert.ok(card.incrementalProcessableTonsPerQuarter >= 0);
  }
});

// ---------------------------------------------------------------------
// テスト項目11: 品質設備・環境設備の未実装効果が数値として表示されない
// ---------------------------------------------------------------------

test("IP-7（必須11）: 品質設備・環境設備は、能力増加も投資回収年数も数値として出さず、未実装効果が明示される", () => {
  const { state, fixture, draft } = setup("phase8d-ip-007");
  const planning = buildPlanning(state, fixture, draft);

  for (const projectType of ["qualityControlEquipment", "environmentalEquipment"] as const) {
    const card = planning.investmentCards.find((c) => c.projectType === projectType)!;
    assert.ok(card, `${projectType} のカードが存在すること`);

    // 能力増加を数値として出さない。
    assert.equal(card.capacityIncreaseTons, 0, `${projectType}: 存在しない能力増加が表示されています`);
    assert.equal(card.incrementalProcessableTonsPerQuarter, 0, `${projectType}: 存在しない処理量増加が表示されています`);
    assert.equal(card.targetPoolKey, undefined);

    // 投資回収年数を数値として出さない。
    assert.equal(card.payback.isComputable, false, `${projectType}: 根拠のない投資回収年数が算定されています`);
    assert.equal(card.payback.paybackYears, undefined);
    assert.ok(card.payback.notComputableReason !== undefined && card.payback.notComputableReason.length > 0);

    // 未実装効果が明示されている。
    const disclosure = PROJECT_EFFECT_DISCLOSURES[projectType];
    assert.ok(disclosure.notImplementedEffects.length > 0, `${projectType}: 未実装効果の一覧が空です`);
    assert.ok(disclosure.notImplementedNote !== undefined, `${projectType}: 未実装であることの注記がありません`);
    assert.equal(card.effectDisclosure, disclosure);
  }
});

test("IP-8（必須11）: 品質設備の未実装効果には、格落ち率・再加工率・廃棄率・重大事故率・顧客信頼が含まれる", () => {
  const disclosure = PROJECT_EFFECT_DISCLOSURES.qualityControlEquipment;
  const joined = disclosure.notImplementedEffects.join(" ");
  for (const keyword of ["格落ち", "再加工", "廃棄", "重大品質事故", "顧客信頼"]) {
    assert.ok(joined.includes(keyword), `未実装効果の一覧に「${keyword}」が含まれていません`);
  }
  // 実装済みの効果に、品質への効果が紛れ込んでいないこと。
  assert.ok(!disclosure.implementedEffects.join(" ").includes("品質スコア"));
});

test("IP-9（必須11）: 環境設備の未実装効果には、排水処理能力・環境事故・行政処分・監査が含まれる", () => {
  const disclosure = PROJECT_EFFECT_DISCLOSURES.environmentalEquipment;
  const joined = disclosure.notImplementedEffects.join(" ");
  for (const keyword of ["排水処理能力", "環境事故", "行政処分", "監査"]) {
    assert.ok(joined.includes(keyword), `未実装効果の一覧に「${keyword}」が含まれていません`);
  }
});

// ---------------------------------------------------------------------
// テスト項目12: 投資回収計算が売上ではなく増分利益／増分CFを使う
// ---------------------------------------------------------------------

test("IP-10（必須12）: 投資回収は、売上ではなく実績の限界利益と増分キャッシュフローから算定される", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("phase8d-ip-010"));
  const fixture = fixtures.find((f) => f.companyId === PLAYER)!;

  // 1四半期進めて、実績の限界利益（＝算定の材料）を確定させる。
  const publicInfo = buildPublicMarketInfo(initialState);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(initialState, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, initialState.currentPeriod, 1);
  }
  const state = advanceCompanyLabQuarter(initialState, fixtures, decisions);
  const record = state.history[state.history.length - 1];
  const financialResult = record.financialResults.find((r) => r.companyId === PLAYER)!;

  const ownState = buildCompanyOwnState(state, fixture);
  const auto = generateAutoPolicyDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 2);
  const draft = buildInitialDraft(fixture, auto, ownState.workforceState);

  const withoutHistory = buildPlanning(state, fixture, draft, null);
  const withHistory = buildPlanning(state, fixture, draft, financialResult);

  // 実績が無ければ、数値を作らず「算定対象外」。
  for (const card of withoutHistory.investmentCards) {
    assert.equal(card.payback.isComputable, false, `${card.projectType}: 実績が無いのに回収年数が算定されています`);
    assert.equal(card.payback.paybackYears, undefined);
  }

  // 実績があり、かつ処理量が増える案件だけが算定対象になる。
  const computable = withHistory.investmentCards.filter((c) => c.payback.isComputable);
  for (const card of computable) {
    const p = card.payback;
    assert.ok(p.contributionMarginUsdPerTon !== undefined, "限界利益/トンが使われていません");
    assert.ok(p.incrementalContributionUsdPerQuarter !== undefined);
    assert.ok(p.incrementalCashFlowUsdPerQuarter !== undefined);

    // 増分限界利益 ＝ 増分処理量 × 限界利益/トン（売上ではない）。
    assert.ok(
      Math.abs(p.incrementalContributionUsdPerQuarter! - p.incrementalProcessableTonsPerQuarter * p.contributionMarginUsdPerTon!) < 1e-6,
      "増分限界利益が「増分処理量 × 限界利益/トン」になっていません"
    );
    // 増分CF ＝ 増分限界利益 − 増分保守費 − 増分Worker人件費
    // （減価償却は非現金なので引かない）。
    assert.ok(
      Math.abs(
        p.incrementalCashFlowUsdPerQuarter! -
          (p.incrementalContributionUsdPerQuarter! - p.incrementalMaintenanceUsdPerQuarter - p.incrementalLaborCostUsdPerQuarter)
      ) < 1e-6,
      "増分キャッシュフローが「増分限界利益 − 増分保守費 − 増分Worker人件費」になっていません"
    );
    // 追加Worker人件費は、カードに表示している人数と同じ人数から算出されている。
    assert.equal(p.incrementalRegularHeadcount, card.additionalRequiredHeadcount);
    assert.equal(p.incrementalLaborCostUsdPerQuarter, card.additionalQuarterlyLaborCostUsd);
    // 回収年数 ＝ 投資総額 ÷ (増分CF × 4四半期)。
    assert.ok(
      Math.abs(p.paybackYears! - card.candidate.totalInvestmentUsd / (p.incrementalCashFlowUsdPerQuarter! * 4)) < 1e-6,
      "回収年数の式が想定と異なります"
    );
    // 売上高そのものを使っていないことの確認: 限界利益率は必ず1未満のため、
    // 限界利益/トンは同四半期の平均販売単価（売上/トン）より小さい。
    const salesRecordEntry = financialResult.costRecords.find((r) => r.driver === "salesQuantity")!;
    const netRevenuePerTon = (financialResult.contributionMargin.netRevenue as unknown as number) / salesRecordEntry.driverQuantity;
    assert.ok(p.contributionMarginUsdPerTon! < netRevenuePerTon, "限界利益ではなく売上単価が使われている可能性があります");
  }

  assert.ok(withHistory.investmentCards.length > 0);
});

// ---------------------------------------------------------------------
// 補足: 「投資は完成するまで当期能力を増やさない」ことがカード上でも明示される
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 追補: 追加Worker人件費の控除と、二重控除でないことの確認
// ---------------------------------------------------------------------

test("IP-13（追補1）: 増分処理量に追加Workerが必要な場合、その四半期人件費が増分キャッシュフローから控除される", () => {
  // 純粋関数として直接検証する（実データでは原料がボトルネックになり増分0になる場合があるため、
  // 「人件費が確かに引かれること」を式のレベルで固定する）。
  const withoutLabor = buildPaybackEstimate({
    totalInvestmentUsd: 3_000_000,
    incrementalProcessableTonsPerQuarter: 500,
    contributionMarginUsdPerTon: 1_000,
    incrementalMaintenanceUsdPerQuarter: 22_500,
    incrementalRegularHeadcount: 0,
    incrementalLaborCostUsdPerQuarter: 0,
    hasLastQuarterResult: true,
    noEffectReason: undefined,
  });
  const withLabor = buildPaybackEstimate({
    totalInvestmentUsd: 3_000_000,
    incrementalProcessableTonsPerQuarter: 500,
    contributionMarginUsdPerTon: 1_000,
    incrementalMaintenanceUsdPerQuarter: 22_500,
    incrementalRegularHeadcount: 110,
    incrementalLaborCostUsdPerQuarter: 110_000,
    hasLastQuarterResult: true,
    noEffectReason: undefined,
  });

  assert.equal(withoutLabor.incrementalContributionUsdPerQuarter, 500_000);
  assert.equal(withoutLabor.incrementalCashFlowUsdPerQuarter, 500_000 - 22_500);
  assert.equal(withLabor.incrementalCashFlowUsdPerQuarter, 500_000 - 22_500 - 110_000);
  assert.ok(
    withLabor.paybackYears! > withoutLabor.paybackYears!,
    "追加Worker人件費を控除したのに回収年数が伸びていません"
  );
  assert.ok(withLabor.formulaText.includes("増分Worker四半期人件費"), "式に増分Worker人件費が明記されていません");
});

test("IP-14（追補1）: 増分限界利益が保守費＋Worker人件費を上回らない場合、回収年数を算定しない", () => {
  const result = buildPaybackEstimate({
    totalInvestmentUsd: 3_000_000,
    incrementalProcessableTonsPerQuarter: 100,
    contributionMarginUsdPerTon: 500, // 増分限界利益 50,000
    incrementalMaintenanceUsdPerQuarter: 22_500,
    incrementalRegularHeadcount: 40,
    incrementalLaborCostUsdPerQuarter: 40_000, // 合計 62,500 > 50,000
    hasLastQuarterResult: true,
    noEffectReason: undefined,
  });
  assert.equal(result.isComputable, false);
  assert.equal(result.paybackYears, undefined);
  assert.ok(result.notComputableReason!.includes("Worker人件費"), "理由に追加Worker人件費が触れられていません");
  assert.ok(result.incrementalCashFlowUsdPerQuarter! < 0);
});

test("IP-15（追補2）: 実績限界利益に常用Workerの給与が含まれておらず、二重控除にならないことをエンジンの実データで確認する", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("phase8d-ip-015"));
  const publicInfo = buildPublicMarketInfo(initialState);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(initialState, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, initialState.currentPeriod, 1);
  }
  const state = advanceCompanyLabQuarter(initialState, fixtures, decisions);
  const report = state.history[state.history.length - 1].financialResults.find((r) => r.companyId === PLAYER)!.contributionMargin;

  // 限界利益 ＝ 純売上高 − 変動費合計。この恒等式が成り立つことをまず確認する。
  const netRevenue = report.netRevenue as unknown as number;
  const totalVariableCost = report.totalVariableCost as unknown as number;
  assert.ok(
    Math.abs((report.contributionMargin as unknown as number) - (netRevenue - totalVariableCost)) < 1e-6,
    "限界利益＝純売上高−変動費合計 が成り立っていません"
  );

  // 変動費合計の内訳に、正社員給与の項目が存在しないこと（労務費は変動労務費のみ）。
  const variableParts =
    (report.variableRawMaterialCost as unknown as number) +
    (report.variableProcessingCost as unknown as number) +
    (report.variableLaborCost as unknown as number) +
    (report.variableQualityCost as unknown as number) +
    (report.variableSellingCost as unknown as number);
  assert.ok(Math.abs(variableParts - totalVariableCost) < 1e-6, "変動費の内訳合計が totalVariableCost と一致しません");

  // 正社員給与は固定製造費の側にあり、その金額は「正社員数 × 単価」以上である
  // （固定製造費＝正社員労務費＋工場固定費＋固定ユーティリティ＋減価償却）。
  const summary = state.history[state.history.length - 1].companySummaries.find((s) => s.companyId === PLAYER)!;
  void summary;
  const regularHeadcount = state.workforceState.companies.find((c) => c.companyId === PLAYER)!.factories[0].regularHeadcount;
  const regularSalaryTotal = regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
  assert.ok(regularSalaryTotal > 0, "前提: 常用Workerが存在すること");
  assert.ok(
    (report.fixedManufacturingCost as unknown as number) >= regularSalaryTotal - 1e-6,
    "正社員給与総額が固定製造費に含まれていません（含まれていれば固定製造費はこれ以上になる）"
  );

  // 変動労務費は、正社員給与総額よりはるかに小さい（＝正社員給与が変動費側に紛れ込んでいない）。
  assert.ok(
    (report.variableLaborCost as unknown as number) < regularSalaryTotal,
    "変動労務費に正社員給与が含まれている可能性があります（二重控除の危険）"
  );

  // 説明文が、この費用構成をそのまま述べていること。
  assert.ok(PAYBACK_DOUBLE_COUNTING_NOTE.includes("固定製造費"));
  assert.ok(PAYBACK_DOUBLE_COUNTING_NOTE.includes("臨時ワーカー費＋残業費"));
});

// ---------------------------------------------------------------------
// 追補2: 増分Worker人数は「設備投資によって新たに発生する不足人数」だけ
// ---------------------------------------------------------------------

test("IP-16（追補2-1）: 投資前後で必要人数が同じなら、増分Workerは0人", () => {
  const r = computeIncrementalRegularHires({
    requiredHeadcountBefore: 4_204.3,
    requiredHeadcountAfter: 4_204.3,
    currentRegularHeadcount: 1_000, // 大幅に不足していても、投資による「増分」は0
  });
  assert.equal(r.incrementalHires, 0, "必要人数が変わらないのに採用が発生しています");
});

test("IP-17（追補2-2）: 現在人員に余力があれば、余力を使い切るまで増分Workerは0人", () => {
  // 現在6,000人。投資前4,204人必要 → 余力1,796人。
  // 投資で必要人数が5,000人へ増えても、まだ余力の範囲内なので採用は不要。
  const withinSlack = computeIncrementalRegularHires({
    requiredHeadcountBefore: 4_204,
    requiredHeadcountAfter: 5_000,
    currentRegularHeadcount: 6_000,
  });
  assert.equal(withinSlack.hiresBefore, 0);
  assert.equal(withinSlack.hiresAfter, 0);
  assert.equal(withinSlack.incrementalHires, 0, "人員余力があるのに採用が計上されています");

  // ちょうど使い切る（6,000人必要）ところまでは0人。
  const exactlyAtSlack = computeIncrementalRegularHires({
    requiredHeadcountBefore: 4_204,
    requiredHeadcountAfter: 6_000,
    currentRegularHeadcount: 6_000,
  });
  assert.equal(exactlyAtSlack.incrementalHires, 0, "必要人数が現在人数と同じなら採用は不要");

  // 余力を超えた瞬間から採用が発生する。
  const beyondSlack = computeIncrementalRegularHires({
    requiredHeadcountBefore: 4_204,
    requiredHeadcountAfter: 6_300,
    currentRegularHeadcount: 6_000,
  });
  assert.equal(beyondSlack.incrementalHires, 300);
});

test("IP-18（追補2-3）: 必要人数が整数境界を越えたときだけ1人増える", () => {
  const current = 100;
  // 100.0 まではちょうど足りている → 0人
  assert.equal(
    computeIncrementalRegularHires({ requiredHeadcountBefore: 99.2, requiredHeadcountAfter: 100.0, currentRegularHeadcount: current }).incrementalHires,
    0
  );
  // 100 をわずかに超えた瞬間に1人（切り上げは「総必要人数」に対して行う）
  assert.equal(
    computeIncrementalRegularHires({ requiredHeadcountBefore: 99.2, requiredHeadcountAfter: 100.01, currentRegularHeadcount: current }).incrementalHires,
    1
  );
  // 101.0 までは1人のまま
  assert.equal(
    computeIncrementalRegularHires({ requiredHeadcountBefore: 99.2, requiredHeadcountAfter: 101.0, currentRegularHeadcount: current }).incrementalHires,
    1
  );
  // 101 を超えると2人
  assert.equal(
    computeIncrementalRegularHires({ requiredHeadcountBefore: 99.2, requiredHeadcountAfter: 101.01, currentRegularHeadcount: current }).incrementalHires,
    2
  );

  // 【過大計上の回帰防止】増分量を単独で切り上げる旧実装なら、
  // 増分0.81人（99.2→100.01）でも1人、さらに小さな増分でも常に1人になってしまう。
  // 現在の実装では、現在人数を超えない限り0人であることを確認する。
  assert.equal(
    computeIncrementalRegularHires({ requiredHeadcountBefore: 10.2, requiredHeadcountAfter: 11.01, currentRegularHeadcount: 100 }).incrementalHires,
    0,
    "増分だけを単独で切り上げる過大計上に戻っています"
  );
});

test("IP-19（追補2-4）: 投資前から存在する人員不足は、増分人数に含めない", () => {
  // 現在100人。投資前からすでに150人必要（50人不足）。
  // 投資で必要人数が160人になる → 投資に起因する採用は10人だけ。
  const r = computeIncrementalRegularHires({
    requiredHeadcountBefore: 150,
    requiredHeadcountAfter: 160,
    currentRegularHeadcount: 100,
  });
  assert.equal(r.hiresBefore, 50, "投資前から存在する不足人数");
  assert.equal(r.hiresAfter, 60);
  assert.equal(r.incrementalHires, 10, "投資前から存在する不足が増分に混入しています");

  // 投資しても必要人数が変わらなければ、既存の不足50人は増分に含まれない。
  const noChange = computeIncrementalRegularHires({
    requiredHeadcountBefore: 150,
    requiredHeadcountAfter: 150,
    currentRegularHeadcount: 100,
  });
  assert.equal(noChange.hiresBefore, 50);
  assert.equal(noChange.incrementalHires, 0);
});

test("IP-20（追補2）: 実データでも、人員に余力がある間は投資カードの追加Workerが0人になる", () => {
  const { state, fixture, draft } = setup("phase8d-ip-020");
  // fixtureの初期人数（BAL 6,000人）は現在の生産計画に対して余力がある状態。
  const planning = buildPlanning(state, fixture, draft);
  const surplus = planning.workforceRows[0].headcountSurplus;
  assert.ok(surplus > 0, "前提: 現在の人員に余力があること");

  for (const card of planning.investmentCards) {
    assert.equal(
      card.additionalRequiredHeadcount,
      0,
      `${card.projectType}: 人員余力があるのに追加Workerが計上されています（${card.additionalRequiredHeadcount}人）`
    );
    assert.equal(card.additionalQuarterlyLaborCostUsd, 0);
    assert.equal(card.payback.incrementalLaborCostUsdPerQuarter, 0);
  }
});

test("IP-21（追補2）: 人員を必要ぎりぎりまで削ると、増産を伴う投資カードで追加Workerが計上される", () => {
  const { state, fixture, draft } = setup("phase8d-ip-021");
  const before = buildPlanning(state, fixture, draft);
  // 必要人数ちょうどまで削り、余力を無くす。
  const tight = Math.ceil(before.workforceRows[0].requiredRegularHeadcount);
  const planning = buildPlanning(state, fixture, withHeadcount(draft, tight));

  // 増産効果がある案件があれば、そこには追加Workerが計上されるはず。
  const growing = planning.investmentCards.filter((c) => c.incrementalProcessableTonsPerQuarter > 0);
  for (const card of growing) {
    assert.ok(
      card.additionalRequiredHeadcount > 0,
      `${card.projectType}: 余力が無いのに追加Workerが0人です`
    );
    assert.equal(
      card.additionalQuarterlyLaborCostUsd,
      card.additionalRequiredHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter
    );
  }
  // 増産効果が無い案件には、追加Workerは計上されない。
  for (const card of planning.investmentCards.filter((c) => c.incrementalProcessableTonsPerQuarter <= 0)) {
    assert.equal(card.additionalRequiredHeadcount, 0, `${card.projectType}: 増産しないのに追加Workerが計上されています`);
  }
});

test("IP-22（追補2）: 追加Worker人件費の単価は、常用Worker給与の共通パラメータを参照している（ハードコードでない）", () => {
  // Worker増減パネルの人件費試算と、投資カードの追加人件費が、
  // どちらも finance/parameters.ts の同じ単価を使っていることを確認する。
  const headcount = 37;
  const viaCommonHelper = computeQuarterlyLaborCost(headcount, 0, FINANCE_PARAMETERS_V1).regularCostUsd;
  assert.equal(viaCommonHelper, headcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter);

  // 単価を差し替えると金額も追随する（＝リテラルが埋め込まれていない）。
  const doubled = computeQuarterlyLaborCost(headcount, 0, {
    ...FINANCE_PARAMETERS_V1,
    labor: { ...FINANCE_PARAMETERS_V1.labor, regularWorkerSalaryUsdPerQuarter: FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter * 2 },
  }).regularCostUsd;
  assert.equal(doubled, viaCommonHelper * 2, "給与単価がハードコードされている可能性があります");

  // 実際のview-modelの追加人件費も同じ単価で算出されている。
  const { state, fixture, draft } = setup("phase8d-ip-022");
  const planning = buildPlanning(state, fixture, draft);
  for (const card of planning.investmentCards) {
    assert.equal(
      card.additionalQuarterlyLaborCostUsd,
      card.additionalRequiredHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter,
      `${card.projectType}: 追加人件費が共通単価と一致しません`
    );
  }
});

test("IP-11: すべての投資カードに、当期には利用できないことの注記が付く", () => {
  const { state, fixture, draft } = setup("phase8d-ip-011");
  const planning = buildPlanning(state, fixture, draft);
  for (const card of planning.investmentCards) {
    assert.ok(card.notAvailableThisQuarterNote.includes("当期の生産能力は増えません"), `${card.projectType}: 当期利用不可の注記がありません`);
  }
});

test("IP-12: 警告の種別が、設備能力不足・Worker不足・工場スペース不足・凍結包装不足・保管超過・完成前・未接続で区別される", () => {
  const { state, fixture, draft } = setup("phase8d-ip-012");
  const planning = buildPlanning(state, fixture, withHeadcount(draft, 1));
  const kinds = new Set(planning.warnings.map((w) => w.kind));
  assert.ok(kinds.has("workerShortage"), "Worker不足の警告種別がありません");
  assert.ok(kinds.has("engineNotConnected"), "エンジン未接続の警告種別が常時出ていません");
  for (const w of planning.warnings) {
    assert.ok(w.sentence.length > 0, `${w.kind}: 説明文が空です（色だけの表現は禁止）`);
    assert.ok(w.label.length > 0);
  }
});
