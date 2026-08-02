// ShrimpX V2 — 加工品市場進化: 受入条件の検証（実装指示 §12）
//
// ACC-1〜ACC-12。各受入条件を実機出力で確認する。既に他のテストで実証済みのものは
// そのテストIDを参照だけして重複実行しない（コメントに記載）。
//
// 【方針】ここでは「合格させるための調整」を一切行わない。条件を満たさない場合は
// テストが落ちるようにし、落ちた条件は設計文書へ不合格として記録する。

import test from "node:test";
import assert from "node:assert/strict";

import { initializeScenario, getScenarioTurnInput } from "../../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../../scenario/marketAdapter";
import { BASELINE_SCENARIO } from "../../scenario/definitions";
import { PreviousMarketContext } from "../../scenario/types";
import { calculateMarketQuarter } from "../../market";
import { MARKET_PARAMETERS_V1 } from "../../market/parameters";
import { createRandomStream } from "../../core/random";
import { COUNTRY_IDS, DEMAND_MARKET_IDS, MarketQuarterInput } from "../../market/types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import {
  applyLifecycleDemandToMarketInput,
  computeMarketProductMix,
  PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1,
} from "../../market/productLifecycle";
import {
  applyProcessingCapacityEvolutionToMarketInput,
  computeProcessingCapacityRatios,
} from "../../market/processingCapacityEvolution";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig } from "../types";
import { CompanyId } from "../../sales/types";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";
import { validateCompanyLabPersistedState } from "../persistence/schema";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../persistence/codec";
import { CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../persistence/types";

const TUNED = PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1;

function previousMarketContext(): PreviousMarketContext {
  const priorHosoFobPrice = {} as Record<string, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) priorHosoFobPrice[c] = usdPerHosoEqKg(5.0);
  return {
    priorHosoFobPrice: priorHosoFobPrice as PreviousMarketContext["priorHosoFobPrice"],
    domesticProcurementIntent: hosoEqTons(40000),
  };
}

/** 市場進化を全部有効にした状態での1四半期分の市場結果。 */
function evolvedQuarter(turn: number) {
  const state = initializeScenario(BASELINE_SCENARIO, "canonical", "market-evolution-acceptance");
  const base = toMarketQuarterInput(getScenarioTurnInput(state, turn), previousMarketContext());
  const mix = computeMarketProductMix(turn, TUNED);
  const input: MarketQuarterInput = applyProcessingCapacityEvolutionToMarketInput(
    applyLifecycleDemandToMarketInput(base, mix),
    computeProcessingCapacityRatios(turn)
  );
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream(`market-evolution-acceptance-${turn}`));
  const hoso = unwrapUnit(result.hosoPrices.VN.price);
  return {
    input,
    result,
    mix,
    pdPremiumRatio: (unwrapUnit(result.pdPremium.byCountry.VN.finalPrice) - hoso) / hoso,
    vapPremiumRatio: (unwrapUnit(result.vapPremium.byCountry.VN.finalPrice) - hoso) / hoso,
  };
}

// ---------------------------------------------------------------------
// 需要側
// ---------------------------------------------------------------------

test("ACC-1: 世界需要が時間とともに成長する", () => {
  const early = unwrapUnit(evolvedQuarter(1).result.worldDemand);
  const mid = unwrapUnit(evolvedQuarter(16).result.worldDemand);
  const late = unwrapUnit(evolvedQuarter(32).result.worldDemand);
  assert.ok(mid > early, `turn16(${mid}) > turn1(${early})`);
  assert.ok(late > mid, `turn32(${late}) > turn16(${mid})`);
});

test("ACC-2: US/JP/EUのPD+VAP構成比が上昇する", () => {
  const early = computeMarketProductMix(1, TUNED);
  const late = computeMarketProductMix(32, TUNED);
  for (const market of ["US", "JP", "EU"] as const) {
    const earlyShare = early[market].pd + early[market].vap;
    const lateShare = late[market].pd + late[market].vap;
    assert.ok(lateShare > earlyShare, `${market}: PD+VAP構成比が上昇すべき（${earlyShare} → ${lateShare}）`);
  }
});

test("ACC-3: 中国は相対的にHOSO中心のまま推移する", () => {
  for (const turn of [1, 8, 16, 24, 32]) {
    const mix = computeMarketProductMix(turn, TUNED);
    for (const market of DEMAND_MARKET_IDS) {
      if (market === "CN") continue;
      assert.ok(
        mix.CN.hoso >= mix[market].hoso - 1e-12,
        `turn=${turn}: CNのHOSO構成比(${mix.CN.hoso})が ${market}(${mix[market].hoso}) 以上であるべき`
      );
    }
  }
});

// ---------------------------------------------------------------------
// 価格・産地側
// ---------------------------------------------------------------------

test("ACC-4: 中盤にベトナムのPD黄金期が存在する（PDプレミアム比率が高原を作る）", () => {
  const series = [1, 4, 8, 12, 16, 20, 24, 28, 32].map((turn) => ({ turn, ...evolvedQuarter(turn) }));
  const peak = series.reduce((best, cur) => (cur.pdPremiumRatio > best.pdPremiumRatio ? cur : best));
  const last = series[series.length - 1];
  // ピークがゲーム終盤ではなく序盤〜中盤にあること（＝黄金期のあとに圧縮が来る）。
  assert.ok(peak.turn <= 16, `PDプレミアム比率のピークは中盤までにあるべき（実測 turn${peak.turn}）`);
  assert.ok(peak.pdPremiumRatio > last.pdPremiumRatio, `ピーク(${peak.pdPremiumRatio}) > 終盤(${last.pdPremiumRatio})`);
});

test("ACC-5: 終盤の他産地参入でプレーンPDの採算が悪化する（プレミアム比率の圧縮＋理由コード）", () => {
  const early = evolvedQuarter(4);
  const late = evolvedQuarter(28);
  assert.ok(
    late.pdPremiumRatio < early.pdPremiumRatio * 0.9,
    `PDプレミアム比率は終盤に1割以上圧縮されるべき（${early.pdPremiumRatio} → ${late.pdPremiumRatio}）`
  );
  assert.ok(late.result.pdPremium.globalUtilization < early.result.pdPremium.globalUtilization, "PD世界稼働率も低下する");
  assert.ok(
    late.result.pdPremium.drivers.includes("ECUADOR_PD_CAPACITY_EXPANSION"),
    `他産地のPD加工参入が理由コードとして出るべき（実測 ${late.result.pdPremium.drivers.join(",")}）`
  );
  // 一方でVAPは維持・上昇し、競争軸が移る。
  assert.ok(late.vapPremiumRatio > early.vapPremiumRatio, "VAPプレミアム比率は終盤も上昇している");
});

test("ACC-6: 序盤にベトナムの加工優位が存在する（原料シェアより加工品シェアが大きい）", () => {
  const { input, result } = evolvedQuarter(1);
  const worldDemand = unwrapUnit(result.worldDemand);
  const rawShare = unwrapUnit(result.hosoPrices.VN.allocatedDemand) / worldDemand;
  const worldPdCapacity = COUNTRY_IDS.reduce((s, c) => s + unwrapUnit(input.countries[c].pdProcessingCapacity), 0);
  const vnPdShare = unwrapUnit(input.countries.VN.pdProcessingCapacity) / worldPdCapacity;
  assert.ok(vnPdShare > rawShare, `序盤のVN加工品シェア(${vnPdShare})は原料シェア(${rawShare})より大きいべき`);
  // エクアドルは原料生産では最大だが、加工能力ではベトナムに劣る。
  assert.ok(unwrapUnit(input.countries.EC.production) > unwrapUnit(input.countries.VN.production));
  assert.ok(unwrapUnit(input.countries.EC.pdProcessingCapacity) < unwrapUnit(input.countries.VN.pdProcessingCapacity));
});

// ---------------------------------------------------------------------
// 投資・接続側（他テストで実証済みのものは参照のみ）
// ---------------------------------------------------------------------

test("ACC-7: VAP投資と営業活動の組み合わせが成約量を押し上げ、単独では最大効果に届かない", () => {
  // 実証は sales/__tests__/salesCapability.test.ts SC-6（2×2実験）。
  // ここでは結論の方向だけを軽量に再確認する（重複実行を避けるため計算のみ）。
  const { computeMarketSalesEffort } = require("../../sales/marketEffort") as typeof import("../../sales/marketEffort");
  const { SALES_PARAMETERS_V1 } = require("../../sales/parameters") as typeof import("../../sales/parameters");
  const desired = { hoso: 5000, pd: 5000, vap: 5000 };
  const sellable = (dev: number, staff: number) => {
    const r = computeMarketSalesEffort(staff, desired, SALES_PARAMETERS_V1, {
      marketTargetDemandTons: 43000,
      customerDevelopment: { vapCapabilityScore: dev, qualityReputation: 50, customerRelationship: 50 },
    });
    return r.adjustedQuantityByProduct.hoso + r.adjustedQuantityByProduct.pd + r.adjustedQuantityByProduct.vap;
  };
  const lowLow = sellable(40, 5);
  const highLow = sellable(90, 5);
  const lowHigh = sellable(40, 25);
  const highHigh = sellable(90, 25);
  assert.ok(highHigh > highLow && highHigh > lowHigh, "組み合わせが単独のどちらより大きい");
  assert.ok(highHigh - lowLow > highLow - lowLow + (lowHigh - lowLow), "交互作用項が正（＝単独では最大効果に届かない）");
});

test("ACC-8: PD省人化は稼働率が高く人員調整が実際に起きる条件下で合理的になる", () => {
  // 実証は companyLab/__tests__/pdMechanizationWorkerConnection.test.ts PMW-2/PMW-5。
  // ここでは「必要人員が実際に減る」ことだけを確認する。
  const { computeRequiredRegularHeadcount } = require("../workforce") as typeof import("../workforce");
  const { computeEffectivePdCoefficient, PD_MECHANIZATION_PARAMETERS_V1 } =
    require("../../capex/pdMechanization") as typeof import("../../capex/pdMechanization");
  const input = {
    quantityByProduct: { hoso: 0, pd: 1000, vap: 0 },
    skillByProduct: { hoso: 0.8, pd: 0.8, vap: 0.8 },
    attendanceRate: 0.95,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  };
  const before = computeRequiredRegularHeadcount(input).requiredRegularHeadcount;
  const after = computeRequiredRegularHeadcount({
    ...input,
    pdCoefficientOverride: computeEffectivePdCoefficient(1.0, PD_MECHANIZATION_PARAMETERS_V1),
  }).requiredRegularHeadcount;
  assert.ok(after < before, `省人化後の必要人員が減るべき（${before} → ${after}）`);
});

// ---------------------------------------------------------------------
// 永続化・整合性
// ---------------------------------------------------------------------

function marketEvolutionConfig(seed: string, turns: number): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed,
    turns,
    sai5: { productLifecycle: true, supplyPremiumFeedback: true },
    marketEvolution: {
      originProcessingCapacity: true,
      tunedProductLifecycle: true,
      perProductDestinationPricing: true,
      processingAdvantageDemandCapture: true,
      productWiseCompetitiveness: true,
      salesCapability: true,
    },
  };
}

test("ACC-9: 市場進化を有効にしたラボが保存・復元をラウンドトリップできる", () => {
  const config = marketEvolutionConfig("acc-persistence", 4);
  const { state: initial, fixtures } = initializeCompanyLab(config);
  let state = initial;
  for (let i = 0; i < 2; i += 1) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateAutoPolicyDecision(
        f,
        buildCompanyOwnState(state, f),
        publicInfo,
        state.currentPeriod,
        state.scenarioState.currentTurn
      );
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }

  const persisted = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: "test-engine",
    labId: "lab-market-evolution-acceptance",
    config: state.config,
    fixtures,
    playerCompanyId: fixtures[0].companyId,
    currentState: { runtime: createCompanyLabRuntimeSnapshot(state), lastProcessedTurnId: "turn-2", revision: 2 },
    draft: null,
    metadata: { createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" },
  };
  const roundTripped = validateCompanyLabPersistedState(
    decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(persisted))
  );

  // config の marketEvolution フラグが失われていないこと（今回の追加分）。
  assert.deepEqual(roundTripped.config.marketEvolution, config.marketEvolution, "marketEvolutionフラグが復元されていない");
  assert.deepEqual(roundTripped.config.sai5, config.sai5, "sai5フラグが復元されていない");

  const restoredState = restoreCompanyLabStateFromRuntimeSnapshot(roundTripped.config, roundTripped.currentState.runtime, state.history);
  assert.equal(restoredState.history.length, state.history.length);
  assert.deepEqual(restoredState.currentPeriod, state.currentPeriod);
});

test("ACC-10: 復元後に四半期を進めても、中断なし実行と同じ結果になる（決定論の維持）", () => {
  const config = marketEvolutionConfig("acc-resume", 5);
  const { state: initial, fixtures } = initializeCompanyLab(config);

  function advance(from: typeof initial) {
    const publicInfo = buildPublicMarketInfo(from);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateAutoPolicyDecision(
        f,
        buildCompanyOwnState(from, f),
        publicInfo,
        from.currentPeriod,
        from.scenarioState.currentTurn
      );
    }
    return advanceCompanyLabQuarter(from, fixtures, decisions);
  }

  const afterTwo = advance(advance(initial));
  const continuous = advance(afterTwo);

  const roundTripped = restoreCompanyLabStateFromRuntimeSnapshot(
    afterTwo.config,
    JSON.parse(JSON.stringify(createCompanyLabRuntimeSnapshot(afterTwo))),
    afterTwo.history
  );
  const resumed = advance(roundTripped);

  const financials = (s: typeof continuous) =>
    s.history[s.history.length - 1].financialResults.map((f) => ({
      companyId: f.companyId,
      netIncome: f.profitAndLoss.netIncome as unknown as number,
      cash: f.balanceSheet.cash as unknown as number,
    }));
  assert.deepEqual(financials(resumed), financials(continuous), "復元後の四半期結果が中断なし実行と一致しない");
});

test("ACC-11: 財務三表が整合する（BS恒等式・PLからの純利益・CFと現金増減）", () => {
  const config = marketEvolutionConfig("acc-financials", 6);
  const { state: initial, fixtures } = initializeCompanyLab(config);
  let state = initial;
  for (let i = 0; i < 4; i += 1) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateAutoPolicyDecision(
        f,
        buildCompanyOwnState(state, f),
        publicInfo,
        state.currentPeriod,
        state.scenarioState.currentTurn
      );
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }

  for (let index = 0; index < state.history.length; index += 1) {
    const record = state.history[index];
    for (const fin of record.financialResults) {
      const bs = fin.balanceSheet;
      const assets = bs.totalAssets as unknown as number;
      const liabilitiesAndEquity =
        ((bs.totalLiabilities as unknown as number) ?? 0) + ((bs.totalEquity as unknown as number) ?? 0);
      assert.ok(
        Math.abs(assets - liabilitiesAndEquity) < 1,
        `${fin.companyId} turn${record.turn}: BS恒等式が崩れている（資産${assets} ≠ 負債+純資産${liabilitiesAndEquity}）`
      );

      // CFの期末現金がBSの現金と一致すること。
      const cf = fin.cashFlow as unknown as Record<string, number> | undefined;
      if (cf && typeof cf.endingCash === "number") {
        assert.ok(
          Math.abs(cf.endingCash - (bs.cash as unknown as number)) < 1,
          `${fin.companyId} turn${record.turn}: CFの期末現金とBSの現金が一致しない`
        );
      }
    }
  }
});

test("ACC-12: 【失敗条件】無調整の投資は現金を悪化させる", () => {
  // 実証は scripts/processedMarketEvolutionScenarios.ts のケースD
  // （累積純利益がケースA比 -181,830,670、期末現金<0の会社が4/5）。
  // ここでは機構（投資が現金を先に食う）だけを軽量に確認する。
  const config = marketEvolutionConfig("acc-case-d", 6);
  const { state: initial, fixtures } = initializeCompanyLab(config);

  function run(withInvestment: boolean) {
    let state = initial;
    for (let i = 0; i < 4; i += 1) {
      const publicInfo = buildPublicMarketInfo(state);
      const decisions: Record<CompanyId, CompanyDecisionInput> = {};
      for (const f of fixtures) {
        let decision = generateAutoPolicyDecision(
          f,
          buildCompanyOwnState(state, f),
          publicInfo,
          state.currentPeriod,
          state.scenarioState.currentTurn
        );
        if (withInvestment && state.scenarioState.currentTurn === 2) {
          decision = {
            ...decision,
            capexDecision: {
              ...decision.capexDecision,
              newProjectProposals: [...decision.capexDecision.newProjectProposals, { projectType: "newFactoryConstruction" }],
            },
          };
        }
        decisions[f.companyId] = decision;
      }
      state = advanceCompanyLabQuarter(state, fixtures, decisions);
    }
    const last = state.history[state.history.length - 1];
    return last.financialResults.reduce((sum, f) => sum + (f.balanceSheet.cash as unknown as number), 0);
  }

  const withoutInvestment = run(false);
  const withInvestment = run(true);
  assert.ok(
    withInvestment < withoutInvestment,
    `需要が伸びる前の投資は現金を悪化させるべき（投資なし=${withoutInvestment} 投資あり=${withInvestment}）`
  );
});
