// ShrimpX V2 — 永続化schema v5（資金繰り状態）テスト（Phase 8B-1）
//
// 対応する重要テスト項目（実装指示より、永続化カテゴリ）:
//   PF-1. schema v5でfinancingStates（融資ポートフォリオ・未払利息・信用/延滞/
//         緊急融資履歴）がencode→decodeで往復一致する
//   PF-2. 複数件の融資（融資ポートフォリオ内の複数LoanRecord）が save/restore できる
//   PF-3. 延滞・信用・条項違反の履歴（CompanyFinancingHistory）が save/restore できる
//   PF-4. financingStatesキーが存在しないv1〜v4相当データを読み込むと、空配列
//         （資金繰り状態未初期化）が安全な初期値として補われる（後方互換）
//   PF-5. undefined/NaN/Infinity・不正な融資残高（currentPrincipalUsdが
//         originalPrincipalUsdを超える等）・負の返済額を拒否する

import { test } from "node:test";
import assert from "node:assert/strict";
import { PeriodV2, period } from "../../core/period";
import { createInitialPersistedGameState } from "../builder";
import { encodePersistedGameState, decodePersistedGameState } from "../codec";
import { validatePersistedGameState } from "../schema";
import { PersistedGameStateV2, CURRENT_PERSISTED_GAME_STATE_VERSION } from "../types";
import { PersistedStateValidationError } from "../errors";
import { CompanyFinancingState, LoanRecord } from "../../financing/types";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const P5 = period(2016, 1);

function makeLoan(overrides: Partial<LoanRecord> = {}): LoanRecord {
  return {
    loanId: "BAL-LOAN-2015Q1-1",
    companyId: "BAL",
    loanType: "workingCapital",
    originalPrincipalUsd: 20_000_000,
    currentPrincipalUsd: 20_000_000,
    originationPeriod: P1,
    maturityPeriod: P2,
    annualInterestRate: 0.09,
    creditSpreadAnnual: 0.04,
    repaymentMethod: "bulletAtMaturity",
    equalPrincipalInstallmentUsd: 0,
    arrearsPrincipalUsd: 0,
    arrearsInterestUsd: 0,
    status: "current",
    isEmergency: false,
    ...overrides,
  };
}

function makeFinancingState(overrides: Partial<CompanyFinancingState> = {}): CompanyFinancingState {
  return {
    companyId: "BAL",
    loanPortfolio: {
      companyId: "BAL",
      loans: [
        makeLoan(),
        makeLoan({
          loanId: "BAL-LOAN-2014Q3-2",
          loanType: "termLoan",
          originalPrincipalUsd: 30_000_000,
          currentPrincipalUsd: 28_500_000,
          originationPeriod: period(2014, 3),
          maturityPeriod: P5,
          annualInterestRate: 0.07,
          creditSpreadAnnual: 0.02,
          repaymentMethod: "equalPrincipal",
          equalPrincipalInstallmentUsd: 1_500_000,
        }),
      ],
    },
    accruedInterestPayableUsd: 175_000,
    history: {
      consecutiveArrearsQuarters: 0,
      consecutiveCovenantBreachQuarters: 0,
      totalOnTimeRepaymentEventsCount: 4,
      totalArrearsEventsCount: 0,
      totalEmergencyLoanDrawsCount: 0,
      lastFinancialHealth: "healthy",
    },
    ...overrides,
  };
}

function makeState(financingStates: readonly CompanyFinancingState[]): PersistedGameStateV2 {
  return createInitialPersistedGameState({
    gameId: "game-financing",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "persistence-financing-seed",
    initialContracts: [],
    initialRawMaterialLots: [],
    initialFinancingStates: financingStates,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("受入確認PF-1: schemaVersionは6で、資金繰り状態つき状態がencode→decodeで往復一致する", () => {
  // Phase 8B-2Aでschemaversion が5→6へ上がった（capexStates追加）。本テストの
  // 意図（資金繰り状態つき状態の往復一致）自体は変わらないため、リテラルの
  // 期待値のみを現行バージョンへ追随させる。
  assert.equal(CURRENT_PERSISTED_GAME_STATE_VERSION, 6);
  const state = makeState([makeFinancingState()]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded, state);
  assert.equal(decoded.financingStates.length, 1);
  assert.equal(decoded.financingStates[0].loanPortfolio.loans.length, 2);
  assert.equal(decoded.financingStates[0].accruedInterestPayableUsd, 175_000);
});

test("受入確認PF-2: 複数件の融資（異なるloanType・repaymentMethod）を含むポートフォリオがそのまま save/restore できる", () => {
  const state = makeState([
    makeFinancingState({
      companyId: "MASS",
      loanPortfolio: {
        companyId: "MASS",
        loans: [
          makeLoan({ loanId: "MASS-L-1", companyId: "MASS", loanType: "workingCapital", repaymentMethod: "bulletAtMaturity" }),
          makeLoan({ loanId: "MASS-L-2", companyId: "MASS", loanType: "termLoan", repaymentMethod: "equalPrincipal", equalPrincipalInstallmentUsd: 2_000_000 }),
          makeLoan({ loanId: "MASS-L-3", companyId: "MASS", loanType: "emergency", isEmergency: true, annualInterestRate: 0.22, status: "delinquent" }),
        ],
      },
    }),
  ]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.equal(decoded.financingStates[0].loanPortfolio.loans.length, 3);
  const byId = new Map(decoded.financingStates[0].loanPortfolio.loans.map((l) => [l.loanId, l]));
  assert.equal(byId.get("MASS-L-3")?.isEmergency, true);
  assert.equal(byId.get("MASS-L-3")?.status, "delinquent");
  assert.equal(byId.get("MASS-L-2")?.equalPrincipalInstallmentUsd, 2_000_000);
});

test("受入確認PF-3: 延滞・条項違反の連続四半期数・信用/緊急融資履歴カウンタが save/restore できる", () => {
  const state = makeState([
    makeFinancingState({
      history: {
        consecutiveArrearsQuarters: 5,
        consecutiveCovenantBreachQuarters: 3,
        totalOnTimeRepaymentEventsCount: 2,
        totalArrearsEventsCount: 6,
        totalEmergencyLoanDrawsCount: 4,
        lastFinancialHealth: "paymentDefault",
      },
    }),
  ]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded.financingStates[0].history, {
    consecutiveArrearsQuarters: 5,
    consecutiveCovenantBreachQuarters: 3,
    totalOnTimeRepaymentEventsCount: 2,
    totalArrearsEventsCount: 6,
    totalEmergencyLoanDrawsCount: 4,
    lastFinancialHealth: "paymentDefault",
  });
});

test("受入確認PF-4: financingStatesキーのないv1〜v4相当データを読み込むと空配列（資金繰り状態未初期化）が補われる（後方互換）", () => {
  const state = makeState([makeFinancingState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete dto.financingStates;
  dto.schemaVersion = 4;
  const decoded = validatePersistedGameState(dto);
  assert.deepEqual(decoded.financingStates, []);
  assert.equal(decoded.schemaVersion, 4);
});

test("受入確認PF-4b: v1相当（financingStates・financeStates・qualityReliabilityがいずれもない）旧データも後方互換で読み込める", () => {
  const state = makeState([]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete dto.financingStates;
  delete dto.financeStates;
  delete dto.qualityReliability;
  dto.schemaVersion = 1;
  const decoded = validatePersistedGameState(dto);
  assert.deepEqual(decoded.financingStates, []);
  assert.deepEqual(decoded.financeStates, []);
});

test("受入確認PF-5a: 融資残高・利率のundefined/NaN/Infinityを拒否する", () => {
  const state = makeState([makeFinancingState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const financingStates = dto.financingStates as Array<Record<string, unknown>>;
  const loans = (financingStates[0].loanPortfolio as Record<string, unknown>).loans as Array<Record<string, unknown>>;
  loans[0].currentPrincipalUsd = Number.NaN;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);

  const dto2 = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const loans2 = ((dto2.financingStates as Array<Record<string, unknown>>)[0].loanPortfolio as Record<string, unknown>).loans as Array<
    Record<string, unknown>
  >;
  loans2[0].annualInterestRate = Number.POSITIVE_INFINITY;
  assert.throws(() => validatePersistedGameState(dto2), PersistedStateValidationError);

  const dto3 = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete (((dto3.financingStates as Array<Record<string, unknown>>)[0].loanPortfolio as Record<string, unknown>).loans as Array<
    Record<string, unknown>
  >)[0].originalPrincipalUsd;
  assert.throws(() => validatePersistedGameState(dto3), PersistedStateValidationError);
});

test("受入確認PF-5b: currentPrincipalUsdがoriginalPrincipalUsdを超える不正な融資残高を拒否する", () => {
  const state = makeState([makeFinancingState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const loans = ((dto.financingStates as Array<Record<string, unknown>>)[0].loanPortfolio as Record<string, unknown>).loans as Array<
    Record<string, unknown>
  >;
  loans[0].currentPrincipalUsd = (loans[0].originalPrincipalUsd as number) + 1_000_000;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PF-5c: 負の返済額（equalPrincipalInstallmentUsd）・負の未払利息を拒否する", () => {
  const state = makeState([makeFinancingState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const loans = ((dto.financingStates as Array<Record<string, unknown>>)[0].loanPortfolio as Record<string, unknown>).loans as Array<
    Record<string, unknown>
  >;
  loans[0].equalPrincipalInstallmentUsd = -1;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);

  const dto2 = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  (dto2.financingStates as Array<Record<string, unknown>>)[0].accruedInterestPayableUsd = -100;
  assert.throws(() => validatePersistedGameState(dto2), PersistedStateValidationError);
});

test("受入確認PF-5d: ポートフォリオ内の融資companyIdが所属会社と一致しない場合を拒否する", () => {
  const state = makeState([makeFinancingState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const loans = ((dto.financingStates as Array<Record<string, unknown>>)[0].loanPortfolio as Record<string, unknown>).loans as Array<
    Record<string, unknown>
  >;
  loans[0].companyId = "OTHER";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("受入確認PF-5e: maturityPeriodがoriginationPeriodより前の不正な融資を拒否する", () => {
  const state = makeState([makeFinancingState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  const loans = ((dto.financingStates as Array<Record<string, unknown>>)[0].loanPortfolio as Record<string, unknown>).loans as Array<
    Record<string, unknown>
  >;
  loans[0].originationPeriod = "2015Q3";
  loans[0].maturityPeriod = "2015Q1";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});
