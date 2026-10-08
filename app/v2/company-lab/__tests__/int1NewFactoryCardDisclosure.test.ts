// ShrimpX V2 — INT-1 §6: 新工場建設カードの能力表示
//
// 【修正前の症状】新工場建設カードが「この投資は生産能力を増加させません。」と表示していた。
// 原因は capex/parameters.ts が新工場建設の futureCapacityEffect を
// （targetProduct省略・capacityIncreaseTonsPerQuarter=0）にしているため、
// investmentPlanningViewModel の「能力を増やさない案件」分岐へ落ちていたこと。
// 研修で工場建設そのものを避ける判断へ誘導するため、Release Critical として修正した。
//
// 【このテストが固定する契約】文言はUI側で能力値を決め打ちせず、Engineが稼働開始時に
// 実際に使う newFactoryEffect（fullCapacities / rampMultipliers）から作る。
// 期待値もテスト側で数値を書かず、同じ CAPEX_PARAMETERS_V1 から導出して突き合わせる。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompanyOwnState,
  buildPublicMarketInfo,
  CompanyLabConfig,
  generateAutoPolicyDecision,
  initializeCompanyLab,
} from "../../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import { buildCompanyInvestmentPlanningViewModel } from "../investmentPlanningViewModel";

const PLAYER = "BAL";
const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "int1-newfactory-card", turns: 6 };

function planning() {
  const { state, fixtures } = initializeCompanyLab(config);
  const fixture = fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const auto = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, auto, ownState.workforceState);
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
    capexParams: CAPEX_PARAMETERS_V1,
  });
}

test("INT1-UI-1: 新工場建設カードは「生産能力を増加させません」と表示しない", () => {
  const card = planning().investmentCards.find((c) => c.projectType === "newFactoryConstruction");
  assert.ok(card, "新工場建設のカードが存在しない");
  assert.ok(card.noEffectReason !== undefined, "説明文が無い");
  assert.ok(
    !card.noEffectReason.includes("生産能力を増加させません"),
    `誤表示が残っている: ${card.noEffectReason}`
  );
});

test("INT1-UI-2: 新工場建設カードの能力値はEngineのnewFactoryEffectと一致する（UI側で決め打ちしない）", () => {
  const card = planning().investmentCards.find((c) => c.projectType === "newFactoryConstruction")!;
  const effect = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction.newFactoryEffect;
  assert.ok(effect, "newFactoryEffect がテンプレートに無い（前提が崩れている）");
  const text = card.noEffectReason!;

  // フルランプ時の各プール能力が、Engineの定義値どおりに出ている。
  for (const key of ["commonProcessing", "hoso", "pd", "vap", "freezingPackaging", "coldStorage"] as const) {
    const expected = Math.round(effect.fullCapacities[key]).toLocaleString();
    assert.ok(text.includes(expected), `${key} の能力値 ${expected} が文言に無い: ${text}`);
  }
  // ランプアップ倍率も定義値どおりに出ている。
  for (const [i, m] of effect.rampMultipliers.entries()) {
    const expected = `稼働${i}四半期目 ${Math.round(m * 100)}%`;
    assert.ok(text.includes(expected), `ランプアップ表記 "${expected}" が文言に無い: ${text}`);
  }
  // 工場を新設することが明示されている。
  assert.ok(text.includes("工場を1つ新設"), `新設の明示が無い: ${text}`);
});

test("INT1-UI-3: 当期の処理見込みは増やさない（架空の即時効果を作らない）", () => {
  const card = planning().investmentCards.find((c) => c.projectType === "newFactoryConstruction")!;
  assert.equal(card.incrementalProcessableTonsPerQuarter, 0, "新工場で当期の処理見込みを増やしている");
  assert.equal(card.capacityIncreaseTons, 0, "targetProduct方式の能力増加を捏造している");
  assert.equal(card.targetPoolKey, undefined, "新工場建設に単一プールのtargetPoolKeyを付けている");
  assert.ok(card.noEffectReason!.includes("当期の処理見込みは増えません"), "当期は増えないことの明示が無い");
});

test("INT1-UI-4: 本当に能力を増やさない案件は従来文言のまま（回帰）", () => {
  const cards = planning().investmentCards;
  for (const projectType of ["qualityControlEquipment", "environmentalEquipment", "pdMechanization"] as const) {
    const card = cards.find((c) => c.projectType === projectType)!;
    assert.ok(card, `${projectType} のカードが無い`);
    assert.equal(
      card.noEffectReason,
      "この投資は生産能力を増加させません。",
      `${projectType}: 能力を増やさない案件の文言が変わっている`
    );
  }
});
