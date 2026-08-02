// ShrimpX V2 — develop/v2統合（Required fix 2）: 新設Factory（newFactoryConstruction）が
// 稼働開始した後、既存Factoryと同じカテゴリの意思決定（工場×商品別生産計画・
// ワーカー配置・臨時工/残業入力・PD省人化投資の対象選択）を実際に入力できることを
// 確認する統合テスト。
//
// 背景（コーディネーター指摘のバグ）: 以前はdecisionDraft.ts・DecisionEditor.tsxが
// fixture.factories（作成時点の静的一覧）を直接参照しており、稼働開始した新設
// Factoryへは入力する手段が無かった。修正後は capex/factoryConstruction.ts の
// computeEffectiveFactories を唯一の計算箇所とし、CompanyOwnState.effectiveFactories
// 経由でdecisionDraft.tsへ渡す。本テストはこの配線が実際に機能することを、
// companyLabの実ラン（initializeCompanyLab／advanceCompanyLabQuarter）を通して確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../types";
import { CompanyFixture } from "../types";
import { buildNewFactoryId } from "../../capex/factoryConstruction";
import { CapexDecisionInput } from "../../capex/types";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../persistence/snapshot";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../persistence/codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../persistence/types";
import { buildInitialDraft, buildDecisionInputFromDraft } from "../../../../v2/company-lab/decisionDraft";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { nextPeriod } from "../../core/period";

const TARGET_COMPANY_ID = "BAL"; // 初期cash=30,000,000（新工場建設$22M・分割払いに十分な余裕がある会社）
const TOTAL_TURNS = 12;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "newfactory-decision-input-001", turns: TOTAL_TURNS, ...overrides };
}

function buildAutoDecisions(state: CompanyLabState, fixtures: readonly CompanyFixture[]): Record<string, CompanyDecisionInput> {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisions[f.companyId] = generateAutoPolicyDecision(f, own, publicInfo, state.currentPeriod, 1);
  }
  return decisions;
}

/**
 * TOTAL_TURNS四半期を通しで走らせ、各四半期の「新設Factory入力可否」を記録する。
 * turn1にnewFactoryConstructionを提案し、稼働開始した四半期以降は新設Factoryへ
 * 実際にワーカー・生産計画を入力する（ゼロから積み増す）。
 */
function runScenario() {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig());
  const targetFixture = fixtures.find((f) => f.companyId === TARGET_COMPANY_ID)!;
  const existingFactoryIds = new Set(targetFixture.factories.map((f) => f.factoryId));

  let state = initialState;
  let newFactoryId: string | undefined;
  let becameOperationalTurn: number | undefined;
  const effectiveIdsByTurn: { readonly turn: number; readonly ids: readonly string[] }[] = [];
  const draftFactoryIdsByTurn: { readonly turn: number; readonly ids: readonly string[] }[] = [];
  const snapshots: CompanyLabPersistedStateV1[] = [];

  for (let turn = 1; turn <= TOTAL_TURNS; turn++) {
    const decisions = buildAutoDecisions(state, fixtures);
    const own = buildCompanyOwnState(state, targetFixture);
    const effectiveIds = own.effectiveFactories.map((f) => f.factoryId);
    effectiveIdsByTurn.push({ turn, ids: effectiveIds });

    if (turn === 1) {
      const capexDecision: CapexDecisionInput = {
        companyId: TARGET_COMPANY_ID,
        newProjectProposals: [{ projectType: "newFactoryConstruction" }],
        cancelRequests: [],
        resumeRequests: [],
      };
      decisions[TARGET_COMPANY_ID] = { ...decisions[TARGET_COMPANY_ID], capexDecision };
    }

    if (newFactoryId && effectiveIds.includes(newFactoryId) && becameOperationalTurn === undefined) {
      becameOperationalTurn = turn;
    }

    // 意思決定ドラフトを構築し、実際にUI層と同じ経路（buildInitialDraft →
    // buildDecisionInputFromDraft）で意思決定を作る。新設Factoryが稼働開始した
    // 四半期以降は、そのFactoryへワーカー・生産計画を実際に入力する。
    let draft = buildInitialDraft(targetFixture, decisions[TARGET_COMPANY_ID], own.workforceState, own.effectiveFactories);
    draftFactoryIdsByTurn.push({ turn, ids: Array.from(new Set(draft.productionPlans.map((p) => p.factoryId))) });

    if (newFactoryId && effectiveIds.includes(newFactoryId)) {
      const workerIdx = draft.workerAssignments.findIndex((w) => w.factoryId === newFactoryId);
      assert.ok(workerIdx >= 0, `turn${turn}: 稼働開始済みの新設Factory(${newFactoryId})のワーカー入力行が存在しない`);
      const workerRow = draft.workerAssignments[workerIdx];
      // 稼働開始直後はゼロ人・ゼロ生産から始まる（自動でワーカー・需要が積み増されない）ことを確認。
      if (turn === becameOperationalTurn) {
        assert.equal(workerRow.regularHeadcount, 0, "新設Factoryは稼働開始時点でワーカー0人から始まるはず（自動積み増し禁止）");
      }
      const nextWorkerAssignments = [...draft.workerAssignments];
      nextWorkerAssignments[workerIdx] = {
        ...workerRow,
        regularHeadcountBefore: workerRow.regularHeadcount,
        regularHeadcountChange: 80,
        regularHeadcount: workerRow.regularHeadcount + 80,
        attendanceRate: 0.95,
      };

      const productionIdx = draft.productionPlans.findIndex((p) => p.factoryId === newFactoryId && p.product === "hoso");
      assert.ok(productionIdx >= 0, `turn${turn}: 稼働開始済みの新設Factory(${newFactoryId})の生産計画入力行(hoso)が存在しない`);
      const nextProductionPlans = [...draft.productionPlans];
      nextProductionPlans[productionIdx] = { ...nextProductionPlans[productionIdx], desiredQuantity: 500, priority: 1 };

      draft = { ...draft, workerAssignments: nextWorkerAssignments, productionPlans: nextProductionPlans };
    }

    decisions[TARGET_COMPANY_ID] = buildDecisionInputFromDraft(draft, targetFixture, state.currentPeriod);

    state = advanceCompanyLabQuarter(state, fixtures, decisions);

    // 【テスト専用の早送り】新工場建設($22,000,000・3四半期分割払い)は、baselineシナリオの
    // 自動方針が生む現金水準（定常的にほぼ0近辺で推移する）だけでは、資金繰り上
    // 現実的な四半期数内には完成しない（自動方針は営業キャッシュフローを使い切る
    // 設計であり、これ自体はTest15の対象外の既存挙動）。本テストの目的は
    // 「稼働開始後の入力配線が正しく機能するか」であって支払能力のシミュレーションでは
    // ないため、turn1の提案・着工（実際のcloseQuarterWithCapexを1回通した結果）の
    // 直後に、案件を完成・稼働準備完了相当まで暦上だけ早送りする（cumulativePaidUsd・
    // ステージ数・completedPeriodを、実際に3四半期分割払いが成功した場合と同じ値へ
    // 直接設定するのみ。isCapexProjectOperationalAt・buildNewFactoryFromProduct等の
    // 判定ロジック自体は一切変更せず、以降は本物のcomputeEffectiveFactories／
    // advanceCompanyLabQuarterの実処理のみで稼働開始・生産を検証する）。
    if (turn === 1) {
      const template = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction;
      const companyCapex = state.capexState.companies.find((c) => c.companyId === TARGET_COMPANY_ID)!;
      const project = companyCapex.portfolio.projects.find((p) => p.projectType === "newFactoryConstruction")!;
      newFactoryId = buildNewFactoryId(project);
      // 実際に3四半期連続で支払が成功した場合と同じ完成期（提案期から2四半期後）。
      const completedPeriod = nextPeriod(nextPeriod(project.proposedPeriod));
      const fastForwardedProject = {
        ...project,
        cumulativePaidUsd: template.standardBudgetUsd,
        completedPaymentStagesCount: template.paymentRatios.length,
        elapsedConstructionQuartersWithPayment: template.standardConstructionQuarters,
        status: "completed" as const,
        completedPeriod,
        capitalizedAmountUsd: template.standardBudgetUsd,
      };
      const nextCompanyCapex = {
        ...companyCapex,
        portfolio: {
          ...companyCapex.portfolio,
          projects: companyCapex.portfolio.projects.map((p) => (p.projectId === project.projectId ? fastForwardedProject : p)),
        },
      };
      state = {
        ...state,
        capexState: {
          companies: state.capexState.companies.map((c) => (c.companyId === TARGET_COMPANY_ID ? nextCompanyCapex : c)),
        },
      };
    }

    // 稼働開始後、1回だけ永続化スナップショットを取得しておく（save/reload検証用）。
    if (turn === becameOperationalTurn) {
      const runtime = createCompanyLabRuntimeSnapshot(state);
      const persisted: CompanyLabPersistedStateV1 = {
        schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
        engineVersion: "test-v2-companyLab-engine-newfactory",
        labId: "lab-newfactory-001",
        playerCompanyId: TARGET_COMPANY_ID,
        config: baseConfig(),
        fixtures,
        currentState: { runtime, revision: 1, lastProcessedTurnId: `turn-${turn}` },
        draft: null,
        metadata: { createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" },
      };
      snapshots.push(persisted);
    }
  }

  return { state, fixtures, targetFixture, existingFactoryIds, newFactoryId, becameOperationalTurn, effectiveIdsByTurn, draftFactoryIdsByTurn, snapshots };
}

const scenario = runScenario();

test("NF-1: 新設Factoryは稼働開始するまで、意思決定入力対象（effectiveFactories・生産計画ドラフト）に一切現れない", () => {
  assert.ok(scenario.newFactoryId, "newFactoryConstruction案件からfactoryIdを特定できなかった");
  assert.ok(scenario.becameOperationalTurn !== undefined, "TOTAL_TURNS以内に新設Factoryが稼働開始しなかった（テストのターン数を見直す必要あり）");
  for (const { turn, ids } of scenario.effectiveIdsByTurn) {
    if (turn < scenario.becameOperationalTurn!) {
      assert.ok(!ids.includes(scenario.newFactoryId!), `turn${turn}: 稼働開始前なのにeffectiveFactoriesに新設Factoryが含まれている`);
    }
  }
  for (const { turn, ids } of scenario.draftFactoryIdsByTurn) {
    if (turn < scenario.becameOperationalTurn!) {
      assert.ok(!ids.includes(scenario.newFactoryId!), `turn${turn}: 稼働開始前なのに生産計画ドラフトに新設Factoryの行がある`);
    }
  }
});

test("NF-2: 新設Factoryは稼働開始した、まさにその四半期からeffectiveFactories・生産計画ドラフトに現れる", () => {
  const turnRecord = scenario.effectiveIdsByTurn.find((r) => r.turn === scenario.becameOperationalTurn);
  assert.ok(turnRecord);
  assert.ok(turnRecord!.ids.includes(scenario.newFactoryId!), "稼働開始したその四半期のeffectiveFactoriesに新設Factoryが含まれていない");

  const draftRecord = scenario.draftFactoryIdsByTurn.find((r) => r.turn === scenario.becameOperationalTurn);
  assert.ok(draftRecord!.ids.includes(scenario.newFactoryId!), "稼働開始したその四半期の生産計画ドラフトに新設Factoryの行がない");
});

test("NF-3: 稼働開始後の新設Factoryへワーカー配置＋生産計画を入力すると、実際に生産バッチ（finishedGoodsQuantity>0）が発生する", () => {
  const history = scenario.state.history;
  const producedTurns = history.filter((r) => r.batches.some((b) => b.factoryId === scenario.newFactoryId && Number(b.finishedGoodsQuantity) > 0));
  assert.ok(
    producedTurns.length > 0,
    `新設Factory(${scenario.newFactoryId})への入力後、一度も生産バッチ(finishedGoodsQuantity>0)が発生しなかった`
  );
});

test("NF-4: 既存Factoryの意思決定入力・挙動は新設Factory追加によって影響を受けない（回帰確認）", () => {
  for (const { turn, ids } of scenario.draftFactoryIdsByTurn) {
    for (const existingId of scenario.existingFactoryIds) {
      assert.ok(ids.includes(existingId), `turn${turn}: 既存Factory(${existingId})が生産計画ドラフトから消えている`);
    }
  }
  // 既存Factoryの生産バッチも通期で発生し続けている（新設Factory追加で既存の生産経路が壊れていない）。
  const history = scenario.state.history;
  for (const existingId of scenario.existingFactoryIds) {
    const producedAny = history.some((r) => r.batches.some((b) => b.factoryId === existingId && Number(b.finishedGoodsQuantity) > 0));
    assert.ok(producedAny, `既存Factory(${existingId})が通期で一度も生産していない`);
  }
});

test("NF-5: 保存(snapshot)→復元(decode)→四半期進行後も、新設FactoryのIDで正しくルーティングされ続ける", () => {
  assert.ok(scenario.snapshots.length > 0, "稼働開始四半期のスナップショットが取得できていない");
  const persisted = scenario.snapshots[0];

  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(persisted));
  const restoredState = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  const restoredOwn = buildCompanyOwnState(restoredState, scenario.targetFixture);
  assert.ok(
    restoredOwn.effectiveFactories.map((f) => f.factoryId).includes(scenario.newFactoryId!),
    "復元後のeffectiveFactoriesに新設FactoryのIDが含まれていない"
  );

  // 復元後さらに1四半期進め、新設Factoryへの入力が引き続きそのFactoryIDへルーティングされることを確認する。
  const { fixtures } = initializeCompanyLab(baseConfig());
  const decisions = buildAutoDecisions(restoredState, fixtures);
  const draft = buildInitialDraft(scenario.targetFixture, decisions[TARGET_COMPANY_ID], restoredOwn.workforceState, restoredOwn.effectiveFactories);
  const workerIdx = draft.workerAssignments.findIndex((w) => w.factoryId === scenario.newFactoryId);
  assert.ok(workerIdx >= 0, "復元後、新設Factoryのワーカー入力行が見つからない");
  const productionIdx = draft.productionPlans.findIndex((p) => p.factoryId === scenario.newFactoryId && p.product === "hoso");
  assert.ok(productionIdx >= 0, "復元後、新設Factoryの生産計画入力行が見つからない");

  const nextWorkerAssignments = [...draft.workerAssignments];
  const workerRow = nextWorkerAssignments[workerIdx];
  nextWorkerAssignments[workerIdx] = { ...workerRow, regularHeadcountChange: 0, attendanceRate: 0.95 };
  const nextProductionPlans = [...draft.productionPlans];
  nextProductionPlans[productionIdx] = { ...nextProductionPlans[productionIdx], desiredQuantity: 300, priority: 1 };
  const nextDraft = { ...draft, workerAssignments: nextWorkerAssignments, productionPlans: nextProductionPlans };
  decisions[TARGET_COMPANY_ID] = buildDecisionInputFromDraft(nextDraft, scenario.targetFixture, restoredState.currentPeriod);

  const advanced = advanceCompanyLabQuarter(restoredState, fixtures, decisions);
  const record = advanced.history[advanced.history.length - 1];
  assert.ok(
    record.batches.some((b) => b.factoryId === scenario.newFactoryId),
    "復元→進行後、新設FactoryのIDで生産バッチが記録されていない（ルーティングが崩れている）"
  );
});

test("NF-6: 稼働開始済みの新設Factoryを、PD省人化投資（pdMechanization）のtargetFactoryIdとして選択できる（既存工場と同様に拒否されない）", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig({ seed: "newfactory-pdtarget-001" }));
  const targetFixture = fixtures.find((f) => f.companyId === TARGET_COMPANY_ID)!;
  let state = initialState;
  let newFactoryId: string | undefined;
  let becameOperationalTurn: number | undefined;

  for (let turn = 1; turn <= TOTAL_TURNS; turn++) {
    const decisions = buildAutoDecisions(state, fixtures);
    const own = buildCompanyOwnState(state, targetFixture);
    const effectiveIds = own.effectiveFactories.map((f) => f.factoryId);

    if (turn === 1) {
      decisions[TARGET_COMPANY_ID] = {
        ...decisions[TARGET_COMPANY_ID],
        capexDecision: {
          companyId: TARGET_COMPANY_ID,
          newProjectProposals: [{ projectType: "newFactoryConstruction" }],
          cancelRequests: [],
          resumeRequests: [],
        },
      };
    } else if (newFactoryId && effectiveIds.includes(newFactoryId) && becameOperationalTurn === undefined) {
      becameOperationalTurn = turn;
      // 稼働開始した四半期に、新設FactoryをターゲットとしたpdMechanization案件を提案する。
      decisions[TARGET_COMPANY_ID] = {
        ...decisions[TARGET_COMPANY_ID],
        capexDecision: {
          ...decisions[TARGET_COMPANY_ID].capexDecision,
          newProjectProposals: [
            ...decisions[TARGET_COMPANY_ID].capexDecision.newProjectProposals,
            { projectType: "pdMechanization" as const, targetFactoryId: newFactoryId },
          ],
        },
      };
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);

    // 【テスト専用の早送り】NF-1〜NF-5と同じ理由・同じ方式で、turn1着工直後に
    // 完成・稼働準備完了相当まで暦上だけ早送りする（詳細な理由はrunScenario()の
    // 同処理のコメント参照）。
    if (turn === 1) {
      const template = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction;
      const companyCapex = state.capexState.companies.find((c) => c.companyId === TARGET_COMPANY_ID)!;
      const project = companyCapex.portfolio.projects.find((p) => p.projectType === "newFactoryConstruction")!;
      newFactoryId = buildNewFactoryId(project);
      const completedPeriod = nextPeriod(nextPeriod(project.proposedPeriod));
      const fastForwardedProject = {
        ...project,
        cumulativePaidUsd: template.standardBudgetUsd,
        completedPaymentStagesCount: template.paymentRatios.length,
        elapsedConstructionQuartersWithPayment: template.standardConstructionQuarters,
        status: "completed" as const,
        completedPeriod,
        capitalizedAmountUsd: template.standardBudgetUsd,
      };
      const nextCompanyCapex = {
        ...companyCapex,
        portfolio: {
          ...companyCapex.portfolio,
          projects: companyCapex.portfolio.projects.map((p) => (p.projectId === project.projectId ? fastForwardedProject : p)),
        },
      };
      state = {
        ...state,
        capexState: {
          companies: state.capexState.companies.map((c) => (c.companyId === TARGET_COMPANY_ID ? nextCompanyCapex : c)),
        },
      };
    }
  }

  assert.ok(becameOperationalTurn !== undefined, "TOTAL_TURNS以内に新設Factoryが稼働開始しなかった");
  const pdProject = state.capexState.companies
    .find((c) => c.companyId === TARGET_COMPANY_ID)!
    .portfolio.projects.find((p) => p.projectType === "pdMechanization" && p.targetFactoryId === newFactoryId);
  assert.ok(pdProject, "新設FactoryをtargetとしたpdMechanization案件が承認・登録されていない（拒否された可能性）");
});
