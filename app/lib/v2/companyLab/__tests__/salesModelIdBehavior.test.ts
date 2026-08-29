// ShrimpX V2 — ENG-SALES-MODEL-PERSIST-2 §16/§12/§17/§24/§25
// salesModelId ごとの挙動・quality equipment 継続・resume equivalence・Scenario 分離。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { period as makePeriod, toYearQuarter } from "../../core/period";
import { unwrapUnit } from "../../core/units";

/** Usd は unwrapUnit の Brand と別系統のため、既存テストと同じ `as number` で取り出す。 */
const usd = (v: unknown): number => v as number;
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyQuarterRecord } from "../types";
import { CapitalProject } from "../../capex/types";
import { CUSTOMER_TIER_IDS } from "../../sales/parameters";
import { salesParametersForModelId } from "../../sales/salesModels";
import { resolveTierParameters } from "../../sales/tieredAllocation";
import { EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS } from "../qualityEquipmentMarketBonus";
import { createInMemoryCompanyLabStateRepository } from "../persistence/repository";
import { createCompanyLabQuarterFlowService } from "../application/companyLabQuarterFlowService";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../persistence/codec";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";

const NOW = "2026-01-01T00:00:00.000Z";

function cfg(overrides: Partial<CompanyLabConfig>): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "smid-behavior", turns: 8, ...overrides } as CompanyLabConfig;
}

function decisionsFor(state: CompanyLabState, fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"], turn: number) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, turn);
  }
  return decisions;
}

/** 完成済み・フルランプの品質管理設備を state へ注入する。 */
function withQualityEquipment(state: CompanyLabState, companyId: string, factoryId: string): CompanyLabState {
  const yq = toYearQuarter(state.currentPeriod);
  const completed = makePeriod(yq.year - 1, yq.quarter);
  const project = {
    projectId: "QE-SMID-1", companyId, projectType: "qualityControlEquipment", approvedBudgetUsd: 1_000_000,
    paymentSchedule: [], completedPaymentStagesCount: 2, cumulativePaidUsd: 1_000_000,
    elapsedConstructionQuartersWithPayment: 2, requiredConstructionQuarters: 2, status: "completed",
    proposedPeriod: completed, approvedPeriod: completed, completedPeriod: completed, capitalizedAmountUsd: 1_000_000,
    targetFactoryId: factoryId, futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 },
    lastDiagnosticReasons: [], priority: 1,
  } as unknown as CapitalProject;
  return {
    ...state,
    capexState: {
      ...state.capexState,
      companies: state.capexState.companies.map((c) =>
        c.companyId === companyId ? { ...c, portfolio: { ...c.portfolio, projects: [...c.portfolio.projects, project] } } : c
      ),
    },
  };
}

/** 記録から比較用のダイジェストを作る。 */
function digest(rec: CompanyQuarterRecord, config: CompanyLabConfig): string {
  const sales = rec.salesRecord.allocations.reduce(
    (s, a) => s + a.companies.reduce((t, c) => t + unwrapUnit(c.allocatedQuantity), 0), 0
  );
  const external = rec.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.externalOptionQuantity), 0);
  const prod = rec.productionAllocation.entries.reduce((s, e) => s + unwrapUnit(e.allocatedQuantity), 0);
  const fin = rec.financialResults
    .map((f) => [f.companyId, usd(f.balanceSheet.cash).toFixed(4), usd(f.profitAndLoss.netRevenue).toFixed(4),
      usd(f.profitAndLoss.operatingProfit).toFixed(4), usd(f.balanceSheet.finishedGoodsInventory).toFixed(4)].join(":"))
    .join("|");
  const quality = rec.companySummaries.map((c) => `${c.companyId}=${JSON.stringify(c.qualityScoreByProduct)}`).join("|");
  const evo = rec.sai5MarketEvolution
    ? `${rec.sai5MarketEvolution.addressableDemandByProduct.pd.toFixed(4)}/${rec.sai5MarketEvolution.addressableDemandByProduct.vap.toFixed(4)}`
    : "NONE";
  const sai5 = config.sai5 === undefined ? "undefined" : JSON.stringify(Object.fromEntries(Object.entries(config.sai5).sort()));
  return [`salesModelId=${config.salesModelId}`, `sai5=${sai5}`, `sales=${sales.toFixed(4)}`, `external=${external.toFixed(4)}`,
    `prod=${prod.toFixed(4)}`, `contracts=${rec.salesRecord.newContracts.length}`, `fin=${fin}`, `quality=${quality}`, `evo=${evo}`].join("\t");
}

/** production 相当の codec 経路で state を往復させる。 */
async function persistRestore(state: CompanyLabState, fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"], labId: string, rawConfig: CompanyLabConfig) {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  // Lab はターン0で raw config から作られる（実運用と同じ）。
  const { stored } = await service.createLab({ labId, config: rawConfig, playerCompanyId: fixtures[0].companyId, now: NOW });
  const payload = { ...stored, currentState: { ...stored.currentState, runtime: createCompanyLabRuntimeSnapshot(state) } };
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(payload));
  // 【Standard AI 履歴問題の分離】engine / market model の resume 等価性を測るため、
  // 確定履歴は全件注入する（別途報告している「resume 時に直近1件だけ注入する」問題は
  // 意思決定層の論点であり、本テストの対象ではない）。
  return restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, state.history);
}

async function run(rawConfig: CompanyLabConfig, opts: { turns: number; resumeAt?: readonly number[]; equipment?: boolean } ) {
  const init = initializeCompanyLab(rawConfig);
  let state: CompanyLabState = opts.equipment
    ? withQualityEquipment(init.state, init.fixtures[0].companyId, init.fixtures[0].factories[0].factoryId)
    : init.state;
  const out: string[] = [];
  for (let turn = 1; turn <= opts.turns; turn++) {
    if (opts.resumeAt?.includes(turn)) state = await persistRestore(state, init.fixtures, `lab-smid-r${turn}`, rawConfig);
    state = advanceCompanyLabQuarter(state, init.fixtures, decisionsFor(state, init.fixtures, turn));
    out.push(digest(state.history[state.history.length - 1], state.config));
  }
  return { digests: out, state };
}

const tieredWeightsAreNormalized = (state: CompanyLabState) =>
  state.history.every((rec) =>
    rec.salesRecord.allocations.every((a) => a.companies.reduce((s, c) => s + c.competitivenessWeight, 0) <= 1 + 1e-9)
  );

// =====================================================================

test("SMID-BEHAVIOR-1: legacy ID と tiered ID で市場配分モデルが切り替わる", async () => {
  const legacy = await run(cfg({ salesModelId: "legacy-waterfall-v1" }), { turns: 2 });
  const tiered = await run(cfg({ salesModelId: "tiered-v200-candidate-v1" }), { turns: 2 });
  assert.equal(salesParametersForModelId("legacy-waterfall-v1"), undefined);
  assert.equal(salesParametersForModelId("tiered-v200-candidate-v1")!.marketAllocationMode, "tieredSimultaneousAllocation");
  assert.equal(tieredWeightsAreNormalized(tiered.state), true, "tiered の competitivenessWeight が正規化シェアになっていない");
  assert.equal(tieredWeightsAreNormalized(legacy.state), false, "legacy が tiered と同じ形になっている（判別できていない）");
  assert.notDeepEqual(tiered.digests, legacy.digests);
});

test("SMID-BEHAVIOR-2: tiered ID で 15セル demandShare / anchor qualitySensitivity / external utility 1.6 が使われる", () => {
  const params = salesParametersForModelId("tiered-v200-candidate-v1")!;
  const t = params.tieredMarketAllocation!;
  // 15セル（CN/hoso と JP/vap を代表として厳密照合）
  const cn = resolveTierParameters(t, "CN", "hoso");
  assert.deepEqual(CUSTOMER_TIER_IDS.map((id) => cn[id].demandShare), [0.55, 0.35, 0.1]);
  const jp = resolveTierParameters(t, "JP", "vap");
  assert.deepEqual(CUSTOMER_TIER_IDS.map((id) => jp[id].demandShare), [0.1, 0.4, 0.5]);
  // anchor calibration（CN/hoso ×2.5、JP/vap ×3.9、US/vap ×0.6×4.2）
  assert.equal(cn.PREMIUM.qualitySensitivity, 2.4 * 2.5);
  assert.equal(jp.PREMIUM.qualitySensitivity, 2.4 * 3.9);
  assert.ok(Math.abs(resolveTierParameters(t, "US", "vap").PREMIUM.qualitySensitivity - 2.4 * 0.6 * 4.2) < 1e-12);
  // external option base utility 1.6（全層・全セル）
  for (const tierId of CUSTOMER_TIER_IDS) assert.equal(cn[tierId].externalOptionBaseUtility, 1.6);
});

test("SMID-BEHAVIOR-3: quality equipment 市場評価 +4 は tiered ID でのみ成約配分へ効く", async () => {
  assert.equal(EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS, 4);
  // 【比較対象を配分に限定する理由】品質管理設備は tiered 専用の direct bonus とは別に、
  // 既存の operationalRisk 低減 → 品質スコア改善という正当な経路を legacy でも持つ。
  // ここで確認したいのは「tiered 専用の market 評価ボーナスが legacy へ漏れていないこと」
  // なので、当四半期の成約配分（数量・外部・競争力ウェイト）だけを比較する。
  const allocationKey = (state: CompanyLabState) =>
    JSON.stringify(state.history.map((rec) =>
      rec.salesRecord.allocations.map((a) => [a.market, a.product, unwrapUnit(a.externalOptionQuantity),
        a.companies.map((c) => [c.companyId, unwrapUnit(c.allocatedQuantity), c.competitivenessWeight])])));
  const tieredCfg = cfg({ salesModelId: "tiered-v200-candidate-v1" });
  const legacyCfg = cfg({ salesModelId: "legacy-waterfall-v1" });
  const tieredWith = await run(tieredCfg, { turns: 1, equipment: true });
  const tieredWithout = await run(tieredCfg, { turns: 1 });
  const legacyWith = await run(legacyCfg, { turns: 1, equipment: true });
  const legacyWithout = await run(legacyCfg, { turns: 1 });
  assert.notEqual(allocationKey(tieredWith.state), allocationKey(tieredWithout.state), "tiered で設備ボーナスが成約配分へ効いていない");
  assert.equal(allocationKey(legacyWith.state), allocationKey(legacyWithout.state), "legacy の成約配分に設備ボーナスが漏れている");
});

test("SMID-RESUME-1: tiered Lab は resume を挟んでも結果が完全一致（T4 / T8 で往復）", async () => {
  const raw = cfg({ salesModelId: "tiered-v200-candidate-v1", turns: 8 });
  const a = await run(raw, { turns: 8 });
  const b = await run(raw, { turns: 8, resumeAt: [4, 8] });
  assert.deepEqual(b.digests, a.digests);
  assert.equal(b.state.config.salesModelId, "tiered-v200-candidate-v1", "resume 後に salesModelId が失われている");
  assert.equal(tieredWeightsAreNormalized(b.state), true, "resume 後に tiered から legacy へ戻っている");
});

test("SMID-RESUME-2: quality equipment 付き tiered Lab も resume 前後で完全一致", async () => {
  const raw = cfg({ salesModelId: "tiered-v200-candidate-v1", turns: 6 });
  const a = await run(raw, { turns: 6, equipment: true });
  const b = await run(raw, { turns: 6, resumeAt: [3], equipment: true });
  assert.deepEqual(b.digests, a.digests);
});

test("SMID-RESUME-3: legacy（field なし）と明示 legacy-waterfall-v1 は resume 後も同一挙動", async () => {
  const none = await run(cfg({ turns: 6 }), { turns: 6, resumeAt: [3] });
  const explicit = await run(cfg({ salesModelId: "legacy-waterfall-v1", turns: 6 }), { turns: 6, resumeAt: [3] });
  // salesModelId の表示だけ異なり、それ以外は完全一致であること。
  const strip = (d: string[]) => d.map((line) => line.split("\t").slice(1).join("\t"));
  assert.deepEqual(strip(explicit.digests), strip(none.digests));
  // 連続実行とも一致（resume で挙動が変わらない）。
  const noneContinuous = await run(cfg({ turns: 6 }), { turns: 6 });
  assert.deepEqual(none.digests, noneContinuous.digests);
});

test("SMID-SCENARIO-1: 同一 Scenario で salesModelId だけを切り替えると市場モデルだけが変わる", async () => {
  // scenarioId・seed・turns・targetDemand の入力は同一。
  const legacy = await run(cfg({ salesModelId: "legacy-waterfall-v1", turns: 4 }), { turns: 4 });
  const tiered = await run(cfg({ salesModelId: "tiered-v200-candidate-v1", turns: 4 }), { turns: 4 });
  // turn 1 は両者の入力が完全に同一（前期実績のフィードバックがまだ無い）。
  // ここで targetDemand / basePrice が一致することが「Scenario 側は動いていない」証拠になる。
  // turn 2 以降は当期の成約結果が翌期の市場（消費国在庫・参照価格）へ正当にフィードバックするため、
  // 入力が一致しなくなるのは仕様どおりであり、Scenario が変わったことを意味しない。
  const key = (rec: CompanyQuarterRecord) =>
    rec.salesRecord.allocations.map((a) => `${a.market}/${a.product}=${unwrapUnit(a.targetDemand).toFixed(4)}@${unwrapUnit(a.basePrice).toFixed(6)}`).join("|");
  assert.equal(key(tiered.state.history[0]), key(legacy.state.history[0]), "turn 1 の targetDemand / basePrice が違う（Scenario 側が動いている）");
  // Scenario の進行（どのシナリオを何ターン目まで進めたか）は両者で同一。
  // なお scenarioState.turnHistory には「実現した市場結果」のフィードバックが入るため、
  // 配分が変われば当然変わる。そこは Scenario 定義ではなく実績なので比較対象にしない。
  assert.equal(tiered.state.scenarioState.currentTurn, legacy.state.scenarioState.currentTurn);
  assert.equal(tiered.state.config.scenarioId, legacy.state.config.scenarioId);
  assert.equal(tiered.state.config.seed, legacy.state.config.seed);
  // salesModelId 以外の config が完全一致していることも確認する。
  const withoutModelId = (c: CompanyLabConfig) => {
    const rest = { ...c } as Record<string, unknown>;
    delete rest.salesModelId;
    return rest;
  };
  assert.deepEqual(withoutModelId(tiered.state.config), withoutModelId(legacy.state.config));
  // 一方で配分結果は変わる＝差は市場清算モデルだけから出ている。
  assert.notDeepEqual(tiered.digests, legacy.digests);
});

test("SMID-DS-1: DS1 / DS2 + tiered ID で requiredCapabilities・salesModelId・tiered 配分・会計不変条件が両立", async () => {
  for (const scenarioId of ["dynamic-scenario-1", "dynamic-scenario-2"]) {
    const raw = cfg({ scenarioId, salesModelId: "tiered-v200-candidate-v1", turns: 4 });
    const r = await run(raw, { turns: 4, resumeAt: [2] });
    // Scenario 由来の機能フラグが resume 後も保持される
    assert.equal(r.state.config.sai5?.productLifecycle, true, `${scenarioId}: productLifecycle`);
    assert.equal(r.state.config.sai5?.supplyPremiumFeedback, true, `${scenarioId}: supplyPremiumFeedback`);
    assert.equal(r.state.config.sai5?.salesBaseAccumulation, true, `${scenarioId}: salesBaseAccumulation`);
    assert.equal(r.state.config.salesModelId, "tiered-v200-candidate-v1", `${scenarioId}: salesModelId`);
    assert.equal(tieredWeightsAreNormalized(r.state), true, `${scenarioId}: tiered 配分が使われていない`);
    // 会計不変条件と需要保存
    for (const rec of r.state.history) {
      for (const f of rec.financialResults) {
        assert.ok(Math.abs(usd(f.balanceSheet.balanceDifference)) < 0.05, `${scenarioId}: balanceDifference`);
        assert.ok(usd(f.balanceSheet.finishedGoodsInventory) >= -1e-6, `${scenarioId}: 在庫が負`);
      }
      for (const a of rec.salesRecord.allocations) {
        const total = a.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(a.externalOptionQuantity);
        assert.ok(Math.abs(total - unwrapUnit(a.targetDemand)) < 0.05 * a.companies.length + 0.05, `${scenarioId}: 需要保存 ${a.market}/${a.product}`);
      }
    }
  }
});
