// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: opt-in が実際にEngineへ到達することの実測
//
// 「宣言できるだけで効かない」ことがないよう、シナリオ定義へ数表を入れて
// 実際に四半期処理を回し、P&L・原料価格が動くことを確かめる。
// 既存Scenarioは何も宣言していないため、この経路は既存Runへ影響しない
// （その証明は simulation/__tests__/costFoundationRegression.test.ts）。
//
// 【定義の差し替え方】指数の解決元は state.scenarioState.definition
// （そのRunが持つスナップショット）であるため、セッション生成後に
// そのスナップショットだけを差し替えれば opt-in を再現できる。

import test from "node:test";
import assert from "node:assert/strict";

import { advanceSimulationTurn, createSimulationSession } from "../simulation/engine";
import { SimulationSession } from "../simulation/types";
import { ALL_SCENARIO_DEFINITIONS } from "../../scenario/definitions";
import { ScenarioDefinition } from "../../scenario/types";
import { unwrapUnit } from "../../core/units";

const BASE_DEFINITION = ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === "baseline-v0.1")!;

function sessionWithDefinition(definition: ScenarioDefinition): SimulationSession {
  const session = createSimulationSession({
    simulationRunId: "cf-optin",
    scenarioId: "baseline",
    seed: "cf-optin-seed",
    requestedTurns: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  return { ...session, state: { ...session.state, scenarioState: { ...session.state.scenarioState, definition } } };
}

function advance(session: SimulationSession): SimulationSession {
  const outcome = advanceSimulationTurn(session, "2026-01-01T01:00:00.000Z");
  assert.equal(outcome.error, null, outcome.error?.message);
  assert.equal(outcome.advanced, true);
  return outcome.session;
}

function totalSellingGeneralAdmin(session: SimulationSession): number {
  const last = session.state.history.at(-1)!;
  return last.financialResults.reduce((sum, r) => sum + (r.profitAndLoss.sellingGeneralAdmin as unknown as number), 0);
}

function totalOperatingProfit(session: SimulationSession): number {
  const last = session.state.history.at(-1)!;
  return last.financialResults.reduce((sum, r) => sum + (r.profitAndLoss.operatingProfit as unknown as number), 0);
}

test("OPTIN-1: 費用指数を宣言すると同一Turn・同一seedでも販管費が増え営業利益が減る", () => {
  const neutral = advance(sessionWithDefinition(BASE_DEFINITION));
  const inflated = advance(
    sessionWithDefinition({
      ...BASE_DEFINITION,
      operatingCostInflation: {
        settingsId: "optin-test",
        tracks: {
          sellingLogistics: { interpolation: "step", keyframes: [{ turn: 1, value: 2.0 }, { turn: 2, value: 2.0 }] },
          adminFixed: { interpolation: "step", keyframes: [{ turn: 1, value: 2.0 }, { turn: 2, value: 2.0 }] },
          factoryFixed: { interpolation: "step", keyframes: [{ turn: 1, value: 2.0 }, { turn: 2, value: 2.0 }] },
        },
      },
    })
  );
  const sgaNeutral = totalSellingGeneralAdmin(neutral);
  const sgaInflated = totalSellingGeneralAdmin(inflated);
  assert.ok(sgaInflated > sgaNeutral, `販管費が増えるべき: ${sgaInflated} > ${sgaNeutral}`);
  assert.ok(
    totalOperatingProfit(inflated) < totalOperatingProfit(neutral),
    "営業利益が減るべき"
  );
});

test("OPTIN-2: 原料捕捉指数を宣言すると原料価格が上がりスプレッドが縮む", () => {
  const neutral = advance(sessionWithDefinition(BASE_DEFINITION));
  const captured = advance(
    sessionWithDefinition({
      ...BASE_DEFINITION,
      rawMarketPricing: {
        settingsId: "optin-test",
        rawPriceCaptureIndex: { interpolation: "step", keyframes: [{ turn: 1, value: 1.08 }, { turn: 2, value: 1.08 }] },
      },
    })
  );
  const mkA = neutral.state.history.at(-1)!.marketResult;
  const mkB = captured.state.history.at(-1)!.marketResult;
  const rawA = unwrapUnit(mkA.vietnamDomestic.price);
  const rawB = unwrapUnit(mkB.vietnamDomestic.price);
  const hosoA = unwrapUnit(mkA.hosoPrices.VN.price);
  const hosoB = unwrapUnit(mkB.hosoPrices.VN.price);
  assert.ok(rawB > rawA, `原料価格が上がるべき: ${rawB} > ${rawA}`);
  assert.ok(hosoB - rawB < hosoA - rawA, "スプレッドが縮むべき");
  // 上限1.0の維持: 原料価格は買付上限を超えない。
  assert.ok(rawB <= unwrapUnit(mkB.vietnamDomestic.buyingCeiling) + 1e-9);
});

test("OPTIN-3: 中立シナリオでは診断キーがmarketResultへ現れない", () => {
  const neutral = advance(sessionWithDefinition(BASE_DEFINITION));
  const serialized = JSON.stringify(neutral.state.history.at(-1)!.marketResult.vietnamDomestic);
  assert.equal(serialized.includes("rawPriceCaptureIndex"), false);
  assert.equal(serialized.includes("priceMultiplier"), false);
});

test("OPTIN-4: 指数を宣言したRunでも決定論（2回実行が一致）", () => {
  const definition: ScenarioDefinition = {
    ...BASE_DEFINITION,
    operatingCostInflation: {
      settingsId: "optin-test",
      tracks: { factoryFixed: { interpolation: "linear", keyframes: [{ turn: 1, value: 1.0 }, { turn: 8, value: 1.4 }] } },
    },
    rawMarketPricing: {
      settingsId: "optin-test",
      rawPriceCaptureIndex: { interpolation: "linear", keyframes: [{ turn: 1, value: 1.0 }, { turn: 8, value: 1.06 }] },
    },
  };
  const a = advance(sessionWithDefinition(definition));
  const b = advance(sessionWithDefinition(definition));
  assert.equal(JSON.stringify(a.state.history), JSON.stringify(b.state.history));
});
