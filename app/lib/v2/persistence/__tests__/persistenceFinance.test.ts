// ShrimpX V2 — 永続化schema v4（財務状態）テスト（Phase 8A）
//
// 対応する重要テスト項目（実装指示より）:
//   17. schema旧版を読み込める（v1/v2/v3の後方互換）
//   18. NaN、Infinity、不正残高を拒否する（財務状態の永続化レベル）
//   （財務状態のencode/decode往復一致・繰越可能性）

import { test } from "node:test";
import assert from "node:assert/strict";
import { PeriodV2 } from "../../core/period";
import { createInitialPersistedGameState } from "../builder";
import { encodePersistedGameState, decodePersistedGameState } from "../codec";
import { validatePersistedGameState } from "../schema";
import { PersistedGameStateV2, CURRENT_PERSISTED_GAME_STATE_VERSION } from "../types";
import { PersistedStateValidationError } from "../errors";
import { CompanyFinanceState, usd } from "../../finance/types";

function makeFinanceState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  return {
    companyId: "BAL",
    cash: usd(30_000_000),
    receivables: [
      {
        id: "BAL-AR-2015Q1-US",
        companyId: "BAL",
        market: "US",
        amount: usd(1_234_567.89),
        originPeriod: "2015Q1" as PeriodV2,
        dueSettlementPeriod: "2015Q2" as PeriodV2,
        sourceRef: "fulfillment:2015Q1:US",
      },
    ],
    payables: [
      {
        id: "BAL-AP-2015Q1-import",
        companyId: "BAL",
        source: "importRawMaterial",
        amount: usd(500_000),
        originPeriod: "2015Q1" as PeriodV2,
        dueSettlementPeriod: "2015Q2" as PeriodV2,
        sourceRef: "importOrders:2015Q1",
      },
    ],
    otherCurrentAssets: usd(5_000_000),
    fixedAssetsGross: usd(90_000_000),
    accumulatedDepreciation: usd(2_250_000),
    shortTermLoans: usd(20_000_000),
    longTermLoans: usd(30_000_000),
    otherLiabilities: usd(5_000_000),
    capitalStock: usd(50_000_000),
    retainedEarnings: usd(-1_500_000), // 負の利益剰余金は許容される
    distributableEarnings: usd(0),
    finishedGoodsCostLedger: [
      {
        lotId: "FG-2015Q1-hoso-BAL-F1-BAL-1",
        companyId: "BAL",
        product: "hoso",
        remainingQuantity: 123.45,
        unitCost: {
          rawMaterialPerTon: 3000,
          processingPerTon: 350,
          laborVariablePerTon: 55.5,
          utilityVariablePerTon: 25,
          laborFixedPerTon: 380,
          factoryFixedPerTon: 90,
          utilityFixedPerTon: 19,
          depreciationPerTon: 140,
        },
        downgradeRatio: 0.0125,
        producedPeriod: "2015Q1" as PeriodV2,
      },
    ],
    ...overrides,
  };
}

function makeState(financeStates: readonly CompanyFinanceState[]): PersistedGameStateV2 {
  return createInitialPersistedGameState({
    gameId: "game-fin",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "persistence-finance-seed",
    initialContracts: [],
    initialRawMaterialLots: [],
    initialFinanceStates: financeStates,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("受入確認P-1: schemaVersionは6で、財務状態つき状態がencode→decodeで往復一致する（繰越可能性）", () => {
  // Phase 8B-1でschemaVersionが4→5（financingStates追加）、Phase 8B-2Aで5→6
  // （capexStates追加）へ上がった（types.tsのバージョン履歴コメント参照）。
  // 本テストの意図（財務状態つき状態の往復一致）自体は変わらないため、
  // リテラルの期待値のみを現行バージョンへ追随させる。
  assert.equal(CURRENT_PERSISTED_GAME_STATE_VERSION, 6);
  const state = makeState([makeFinanceState()]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded, state);
  assert.equal(decoded.financeStates.length, 1);
  assert.equal(decoded.financeStates[0].retainedEarnings as number, -1_500_000);
  assert.equal(decoded.financeStates[0].finishedGoodsCostLedger[0].unitCost.laborVariablePerTon, 55.5);
});

test("受入確認P-2: 同一状態のencode結果は完全一致する（決定論的シリアライズ）", () => {
  const state = makeState([makeFinanceState()]);
  assert.equal(encodePersistedGameState(state), encodePersistedGameState(state));
});

test("受入確認P-3: financeStatesキーのないv3相当データを読み込むと空配列（財務状態未初期化）が補われる（重要テスト17）", () => {
  const state = makeState([makeFinanceState()]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete dto.financeStates;
  dto.schemaVersion = 3;
  const decoded = validatePersistedGameState(dto);
  assert.deepEqual(decoded.financeStates, []);
  assert.equal(decoded.schemaVersion, 3);
});

test("受入確認P-4: v1/v2相当（qualityReliabilityもfinanceStatesもない）の旧データも後方互換で読み込める（重要テスト17）", () => {
  const state = makeState([]);
  const dto = JSON.parse(encodePersistedGameState(state)) as Record<string, unknown>;
  delete dto.financeStates;
  delete dto.qualityReliability;
  dto.schemaVersion = 1;
  const decoded = validatePersistedGameState(dto);
  assert.deepEqual(decoded.financeStates, []);
  assert.deepEqual(decoded.qualityReliability.qualityByCompanyProduct, []);
});

test("受入確認P-5: 財務状態のNaN・Infinity・不正値を拒否する（重要テスト18）", () => {
  const base = JSON.parse(encodePersistedGameState(makeState([makeFinanceState()]))) as { financeStates: Record<string, unknown>[] } & Record<string, unknown>;

  // cash: null（非number）
  const c1 = structuredClone(base);
  c1.financeStates[0].cash = null;
  assert.throws(() => validatePersistedGameState(c1), PersistedStateValidationError);

  // cash: 文字列"NaN"相当（JSON上NaNは表現できないため不正型で検証）
  const c2 = structuredClone(base);
  c2.financeStates[0].cash = "NaN";
  assert.throws(() => validatePersistedGameState(c2), PersistedStateValidationError);

  // 負の売掛金（負数を許容しない残高）
  const c3 = structuredClone(base);
  (c3.financeStates[0].receivables as Record<string, unknown>[])[0].amount = -100;
  assert.throws(() => validatePersistedGameState(c3), PersistedStateValidationError);

  // 負の借入金
  const c4 = structuredClone(base);
  c4.financeStates[0].shortTermLoans = -1;
  assert.throws(() => validatePersistedGameState(c4), PersistedStateValidationError);

  // 減価償却累計額 > 固定資産取得原価
  const c5 = structuredClone(base);
  c5.financeStates[0].accumulatedDepreciation = 90_000_001;
  assert.throws(() => validatePersistedGameState(c5), PersistedStateValidationError);

  // 台帳の負の残数量
  const c6 = structuredClone(base);
  (c6.financeStates[0].finishedGoodsCostLedger as Record<string, unknown>[])[0].remainingQuantity = -5;
  assert.throws(() => validatePersistedGameState(c6), PersistedStateValidationError);

  // 格落ち率 > 1
  const c7 = structuredClone(base);
  (c7.financeStates[0].finishedGoodsCostLedger as Record<string, unknown>[])[0].downgradeRatio = 1.5;
  assert.throws(() => validatePersistedGameState(c7), PersistedStateValidationError);

  // 不正な買掛金source
  const c8 = structuredClone(base);
  (c8.financeStates[0].payables as Record<string, unknown>[])[0].source = "unknownSource";
  assert.throws(() => validatePersistedGameState(c8), PersistedStateValidationError);
});

test("受入確認P-6: 負の現金・負の利益剰余金は明示的な状態として永続化・復元できる（資金不足を隠さない）", () => {
  const state = makeState([makeFinanceState({ cash: usd(-42_000_000) })]);
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.equal(decoded.financeStates[0].cash as number, -42_000_000);
  assert.equal(decoded.financeStates[0].retainedEarnings as number, -1_500_000);
});
