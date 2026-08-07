// ShrimpX V2 — 永続化schema v6（設備投資状態）テスト（Phase 8B-2A）
//
// 対応する重要テスト項目（実装指示より、永続化カテゴリ）:
//   PC-1. schema v6でcapexStates（投資案件ポートフォリオ・分割支払スケジュール・
//         案件連番）がencode→decodeで往復一致する
//   PC-2. 複数件の投資案件（異なるprojectType・status）が save/restore できる
//   PC-3. capexStatesキーが存在しないv1〜v5相当データを読み込むと、空配列
//         （設備投資状態未初期化）が安全な初期値として補われる（後方互換）
//   PC-4. undefined/NaN/Infinity・不正な案件データ（paymentSchedule比率合計が
//         1.0でない、cumulativePaidUsdがapprovedBudgetUsdを超える等）を拒否する
//   PC-5. status別のフィールド整合性（completed/cancelled/approvedと関連
//         フィールドの矛盾）を拒否する

import { test } from "node:test";
import assert from "node:assert/strict";
import { PeriodV2, period } from "../../core/period";
import { createInitialPersistedGameState } from "../builder";
import { encodePersistedGameState, decodePersistedGameState } from "../codec";
import { validatePersistedGameState } from "../schema";
import { PersistedGameStateV2, CURRENT_PERSISTED_GAME_STATE_VERSION } from "../types";
import { PersistedStateValidationError } from "../errors";
import { CapitalProject, CompanyCapexState } from "../../capex/types";

const P1 = period(2015, 1);
const P2 = period(2015, 2);

function makeProject(overrides: Partial<CapitalProject> = {}): CapitalProject {
  return {
    projectId: "BAL-CAPEX-1",
    companyId: "BAL",
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.6 },
      { stageIndex: 1, plannedRatio: 0.4 },
    ],
    completedPaymentStagesCount: 0,
    cumulativePaidUsd: 0,
    elapsedConstructionQuartersWithPayment: 0,
    requiredConstructionQuarters: 2,
    status: "approved",
    proposedPeriod: P1,
    approvedPeriod: P1,
    priority: 1,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

function makeCapexState(overrides: Partial<CompanyCapexState> = {}): CompanyCapexState {
  return {
    companyId: "BAL",
    portfolio: { companyId: "BAL", projects: [makeProject()] },
    nextProjectSequence: 2,
    ...overrides,
  };
}

function makeState(capexStates: readonly CompanyCapexState[]): PersistedGameStateV2 {
  return createInitialPersistedGameState({
    gameId: "game-capex",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "persistence-capex-seed",
    initialContracts: [],
    initialRawMaterialLots: [],
    initialCapexStates: capexStates,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("受入確認PC-1: schemaVersionは6で、設備投資状態つき状態がencode→decodeで往復一致する", () => {
  assert.equal(CURRENT_PERSISTED_GAME_STATE_VERSION, 6);
  const state = makeState([makeCapexState()]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded, state);
  assert.equal(decoded.capexStates.length, 1);
  assert.equal(decoded.capexStates[0].portfolio.projects.length, 1);
  assert.equal(decoded.capexStates[0].portfolio.projects[0].approvedBudgetUsd, 1_200_000);
});

test("受入確認PC-2: 複数件・異なるprojectType/statusの投資案件を含むポートフォリオがそのまま save/restore できる", () => {
  const state = makeState([
    makeCapexState({
      companyId: "MASS",
      portfolio: {
        companyId: "MASS",
        projects: [
          makeProject({ projectId: "MASS-CAPEX-1", companyId: "MASS", projectType: "hosoLineExpansion", status: "approved" }),
          makeProject({
            projectId: "MASS-CAPEX-2",
            companyId: "MASS",
            projectType: "vapLineExpansion",
            status: "underConstruction",
            approvedBudgetUsd: 6_000_000,
            paymentSchedule: [
              { stageIndex: 0, plannedRatio: 0.25 },
              { stageIndex: 1, plannedRatio: 0.35 },
              { stageIndex: 2, plannedRatio: 0.25 },
              { stageIndex: 3, plannedRatio: 0.15 },
            ],
            completedPaymentStagesCount: 2,
            cumulativePaidUsd: 3_600_000,
            elapsedConstructionQuartersWithPayment: 2,
            requiredConstructionQuarters: 4,
            constructionStartedPeriod: P1,
          }),
          makeProject({
            projectId: "MASS-CAPEX-3",
            companyId: "MASS",
            projectType: "coldStorageExpansion",
            status: "completed",
            approvedBudgetUsd: 2_500_000,
            paymentSchedule: [
              { stageIndex: 0, plannedRatio: 0.5 },
              { stageIndex: 1, plannedRatio: 0.5 },
            ],
            completedPaymentStagesCount: 2,
            cumulativePaidUsd: 2_500_000,
            elapsedConstructionQuartersWithPayment: 2,
            requiredConstructionQuarters: 2,
            constructionStartedPeriod: P1,
            completedPeriod: P2,
            capitalizedAmountUsd: 2_500_000,
          }),
          makeProject({
            projectId: "MASS-CAPEX-4",
            companyId: "MASS",
            projectType: "environmentalEquipment",
            status: "cancelled",
            approvedBudgetUsd: 1_800_000,
            paymentSchedule: [
              { stageIndex: 0, plannedRatio: 0.5 },
              { stageIndex: 1, plannedRatio: 0.5 },
            ],
            cancelledPeriod: P2,
          }),
          makeProject({
            projectId: "MASS-CAPEX-5",
            companyId: "MASS",
            projectType: "pdLineExpansion",
            status: "suspended",
            approvedBudgetUsd: 4_000_000,
            paymentSchedule: [
              { stageIndex: 0, plannedRatio: 0.3 },
              { stageIndex: 1, plannedRatio: 0.4 },
              { stageIndex: 2, plannedRatio: 0.3 },
            ],
            completedPaymentStagesCount: 1,
            cumulativePaidUsd: 1_200_000,
            elapsedConstructionQuartersWithPayment: 1,
            requiredConstructionQuarters: 3,
            constructionStartedPeriod: P1,
            lastDiagnosticReasons: ["現金不足のため見送り"],
          }),
        ],
      },
      nextProjectSequence: 6,
    }),
  ]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  const projects = decoded.capexStates[0].portfolio.projects;
  assert.equal(projects.length, 5);
  const byId = new Map(projects.map((p) => [p.projectId, p]));
  assert.equal(byId.get("MASS-CAPEX-2")?.status, "underConstruction");
  assert.equal(byId.get("MASS-CAPEX-3")?.capitalizedAmountUsd, 2_500_000);
  assert.equal(byId.get("MASS-CAPEX-4")?.cancelledPeriod, P2);
  assert.deepEqual(byId.get("MASS-CAPEX-5")?.lastDiagnosticReasons, ["現金不足のため見送り"]);
});

test("受入確認PC-3: capexStatesキーのないv1〜v5相当データを読み込むと空配列（設備投資状態未初期化）が補われる（後方互換）", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete dto.capexStates;
  dto.schemaVersion = 5;
  const decoded = validatePersistedGameState(dto);
  assert.deepEqual(decoded.capexStates, []);
  assert.equal(decoded.schemaVersion, 5);
});

test("受入確認PC-3b: v1相当（capexStates・financingStates・financeStates・qualityReliabilityがいずれもない）旧データも後方互換で読み込める", () => {
  const state = makeState([]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete dto.capexStates;
  delete dto.financingStates;
  delete dto.financeStates;
  delete dto.qualityReliability;
  dto.schemaVersion = 1;
  const decoded = validatePersistedGameState(dto);
  assert.deepEqual(decoded.capexStates, []);
  assert.deepEqual(decoded.financingStates, []);
  assert.deepEqual(decoded.financeStates, []);
});

test("受入確認PC-4a: 予算・比率のundefined/NaN/Infinityを拒否する", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].approvedBudgetUsd = Number.NaN;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);

  const dto2 = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects2 = ((dto2.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects2[0].cumulativePaidUsd = Number.POSITIVE_INFINITY;
  assert.throws(() => validatePersistedGameState(dto2), PersistedStateValidationError);

  const dto3 = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects3 = ((dto3.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  delete projects3[0].approvedBudgetUsd;
  assert.throws(() => validatePersistedGameState(dto3), PersistedStateValidationError);
});

test("受入確認PC-4b: 分割支払比率の合計が1.0でない場合を拒否する", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].paymentSchedule = [
    { stageIndex: 0, plannedRatio: 0.6 },
    { stageIndex: 1, plannedRatio: 0.6 },
  ];
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-4c: cumulativePaidUsdがapprovedBudgetUsdを超える不正な投資案件を拒否する", () => {
  const state = makeState([makeCapexState({ portfolio: { companyId: "BAL", projects: [makeProject({ status: "underConstruction", cumulativePaidUsd: 0, completedPaymentStagesCount: 0 })] } })]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].cumulativePaidUsd = (projects[0].approvedBudgetUsd as number) + 1_000_000;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-4d: ポートフォリオ内の投資案件companyIdが所属会社と一致しない場合を拒否する", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].companyId = "OTHER";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-4e: 投資案件IDの重複を拒否する", () => {
  const state = makeState([
    makeCapexState({
      portfolio: {
        companyId: "BAL",
        projects: [makeProject({ projectId: "BAL-CAPEX-DUP" }), makeProject({ projectId: "BAL-CAPEX-DUP" })],
      },
    }),
  ]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-5a: status=\"completed\"の案件にcompletedPeriod・capitalizedAmountUsdが無い場合を拒否する", () => {
  const state = makeState([
    makeCapexState({
      portfolio: {
        companyId: "BAL",
        projects: [
          makeProject({
            status: "completed",
            completedPaymentStagesCount: 2,
            cumulativePaidUsd: 1_200_000,
            elapsedConstructionQuartersWithPayment: 2,
            constructionStartedPeriod: P1,
            completedPeriod: P2,
            capitalizedAmountUsd: 1_200_000,
          }),
        ],
      },
    }),
  ]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  delete projects[0].completedPeriod;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-5b: status=\"cancelled\"の案件にcumulativePaidUsd>0が含まれる場合を拒否する", () => {
  const state = makeState([
    makeCapexState({
      portfolio: { companyId: "BAL", projects: [makeProject({ status: "cancelled", cancelledPeriod: P2 })] },
    }),
  ]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].cumulativePaidUsd = 500_000;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-5c: status=\"approved\"（未着工）の案件に支払実績が含まれる場合を拒否する", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].cumulativePaidUsd = 100_000;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-5d: completedPeriodがapproved等（completed以外）の案件に含まれる場合を拒否する", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].completedPeriod = "2015Q2";
  projects[0].capitalizedAmountUsd = 1_200_000;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PC-5e: nextProjectSequenceが1未満・非整数の場合を拒否する", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  (dto.capexStates as Array<Record<string, unknown>>)[0].nextProjectSequence = 0;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);

  const dto2 = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  (dto2.capexStates as Array<Record<string, unknown>>)[0].nextProjectSequence = 1.5;
  assert.throws(() => validatePersistedGameState(dto2), PersistedStateValidationError);
});

// ---------------------------------------------------------------------
// Phase 8B-2B: 新規投資案件種別（commonProcessingExpansion）・targetProduct拡張
// ---------------------------------------------------------------------

test("受入確認PC-6: 新規追加のcommonProcessingExpansion案件がencode→decodeで往復一致し、schemaVersionは6のまま据え置かれる（互換フィールド追加のみ）", () => {
  assert.equal(CURRENT_PERSISTED_GAME_STATE_VERSION, 6, "Phase 8B-2Bはcapexスキーマの形自体を変更しないためschemaVersion据え置きのはず");
  const project = makeProject({
    projectId: "BAL-CAPEX-2",
    projectType: "commonProcessingExpansion",
    approvedBudgetUsd: 5_000_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.3 },
      { stageIndex: 1, plannedRatio: 0.4 },
      { stageIndex: 2, plannedRatio: 0.3 },
    ],
    requiredConstructionQuarters: 3,
    status: "completed",
    completedPaymentStagesCount: 3,
    cumulativePaidUsd: 5_000_000,
    elapsedConstructionQuartersWithPayment: 3,
    completedPeriod: P2,
    capitalizedAmountUsd: 5_000_000,
    futureCapacityEffect: { targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 700, readinessQuartersAfterCompletion: 1 },
  });
  const state = makeState([makeCapexState({ portfolio: { companyId: "BAL", projects: [project] } })]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded, state);
  assert.equal(decoded.capexStates[0].portfolio.projects[0].projectType, "commonProcessingExpansion");
  assert.equal(decoded.capexStates[0].portfolio.projects[0].futureCapacityEffect?.targetProduct, "commonProcessing");
});

test("受入確認PC-7: coldStorageExpansionのfutureCapacityEffect.targetProduct=\"freezingPackaging\"がencode→decodeで往復一致する", () => {
  const project = makeProject({
    projectType: "coldStorageExpansion",
    futureCapacityEffect: { targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 },
  });
  const state = makeState([makeCapexState({ portfolio: { companyId: "BAL", projects: [project] } })]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.equal(decoded.capexStates[0].portfolio.projects[0].futureCapacityEffect?.targetProduct, "freezingPackaging");
});

test("受入確認PC-8: 旧targetProduct=\"common\"の生データ（Phase 8B-2A時点の値。実際にはどの保存データにも書き込まれたことがないが、万一の後方互換として）を引き続きdecodeできる", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].futureCapacityEffect = { targetProduct: "common", capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 };
  const decoded = decodePersistedGameState(JSON.stringify(dto));
  assert.equal((decoded.capexStates[0].portfolio.projects[0].futureCapacityEffect as { targetProduct?: string })?.targetProduct, "common");
});

test("受入確認PC-9: 未知のtargetProduct値（新旧いずれの許容リストにも無い文字列）は拒否される（構造的な破損データの検出）", () => {
  const state = makeState([makeCapexState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const projects = ((dto.capexStates as Array<Record<string, unknown>>)[0].portfolio as Record<string, unknown>).projects as Array<
    Record<string, unknown>
  >;
  projects[0].futureCapacityEffect = { targetProduct: "nonexistentProduct", capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 };
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

// ---------------------------------------------------------------------
// Phase 8D監査M-2修正: 無印/v2スキーマのFUTURE_CAPACITY_TARGET_PRODUCTSに
// "coldStorage"を追加（companyLab側は既に対応済みだが、無印/v2側の列挙リストへの
// 追加が漏れていた）
// ---------------------------------------------------------------------

test('受入確認PC-10: 新規coldStorageExpansionのfutureCapacityEffect.targetProduct="coldStorage"が無印/v2schemaのencode→decodeで往復一致し、値が失われたり別の値へ変換されたりしない', () => {
  const project = makeProject({
    projectId: "BAL-CAPEX-COLDSTORAGE",
    projectType: "coldStorageExpansion",
    approvedBudgetUsd: 2_500_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.5 },
      { stageIndex: 1, plannedRatio: 0.5 },
    ],
    requiredConstructionQuarters: 2,
    status: "completed",
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 2_500_000,
    elapsedConstructionQuartersWithPayment: 2,
    completedPeriod: P2,
    capitalizedAmountUsd: 2_500_000,
    futureCapacityEffect: { targetProduct: "coldStorage", capacityIncreaseTonsPerQuarter: 1_250, readinessQuartersAfterCompletion: 1 },
  });
  const state = makeState([makeCapexState({ portfolio: { companyId: "BAL", projects: [project] } })]);

  // encode→decode（PersistedGameStateV2としての完全往復一致）
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded, state, "coldStorageを含む状態全体がencode→decodeで完全一致するはず");
  assert.equal(decoded.capexStates[0].portfolio.projects[0].futureCapacityEffect?.targetProduct, "coldStorage");
  assert.equal(decoded.capexStates[0].portfolio.projects[0].futureCapacityEffect?.capacityIncreaseTonsPerQuarter, 1_250);

  // 生JSONを経由したrestore相当（validatePersistedGameStateを直接通す）でも
  // "coldStorage"のまま validate を通過し、他の値へ変換されないことを確認する。
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const restored = validatePersistedGameState(dto);
  assert.equal(restored.capexStates[0].portfolio.projects[0].futureCapacityEffect?.targetProduct, "coldStorage");
  assert.deepEqual(restored, state);
});
