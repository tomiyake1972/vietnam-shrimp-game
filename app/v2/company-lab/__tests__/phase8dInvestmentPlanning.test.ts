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
import { buildCompanyInvestmentPlanningViewModel, PROJECT_EFFECT_DISCLOSURES } from "../investmentPlanningViewModel";

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
    // 増分CF ＝ 増分限界利益 − 増分保守費（減価償却は非現金なので引かない）。
    assert.ok(
      Math.abs(p.incrementalCashFlowUsdPerQuarter! - (p.incrementalContributionUsdPerQuarter! - p.incrementalMaintenanceUsdPerQuarter)) < 1e-6,
      "増分キャッシュフローが「増分限界利益 − 増分保守費」になっていません"
    );
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
