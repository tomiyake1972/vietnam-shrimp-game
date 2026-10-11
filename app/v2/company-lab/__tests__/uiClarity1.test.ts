// ShrimpX V2 — UI-CLARITY-1: 「ユーザーから見て分からない点」の解消
//
// ここで固定する契約
//   A-2 排水・環境設備には便益が無いことを、投資カードが明言する
//   A-3 品質管理設備の効果を、実際にエンジンへ接続されている内容どおりに説明する
//       （以前は「便益はありません」と書いていたが事実と違っていた）
//   A-4 案件どうしの割高・割安を比べられる単価を出す
//   A-5 投資額は固定で、金額を指定できないことを明言する
//   A-7 借入がいつ資金になるかを財務画面が明言する

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import InvestmentPlanningScreen from "../components/decisionStudio/InvestmentPlanningScreen";
import FinancePlanningScreen from "../components/decisionStudio/FinancePlanningScreen";
import { capexUnitCostUsdPerCapacityTon, PROJECT_EFFECT_DISCLOSURES } from "../investmentPlanningViewModel";
import { CAPEX_EXPLANATION_TEXT } from "../capexViewModel";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex/parameters";
import { buildInitialDraft } from "../decisionDraft";
import { buildDecisionStudioViewModel } from "../decisionStudioViewModel";
import { buildCompanyOwnState, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { buildPublicMarketInfo } from "../../../lib/v2/companyLab";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-clarity-1", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });
  return { fixture, ownState, draft, vm };
}

function renderInvestment(): string {
  const { fixture, ownState, draft, vm } = setup();
  return renderToStaticMarkup(
    React.createElement(InvestmentPlanningScreen, { fixture, ownState, draft, onChange: () => {}, disabled: false, vm })
  );
}

function renderFinance(): string {
  const { draft, vm } = setup();
  return renderToStaticMarkup(React.createElement(FinancePlanningScreen, { draft, onChange: () => {}, disabled: false, vm }));
}

test("UIC1-1 (A-4): 能力1tあたり投資額は、投資額÷追加能力で、能力が増えない案件では出さない", () => {
  assert.equal(capexUnitCostUsdPerCapacityTon(8_000_000, 4_000), 2_000);
  assert.equal(capexUnitCostUsdPerCapacityTon(6_000_000, 250), 24_000);
  // 能力が増えない案件は割り算が意味を持たない。0で割った無限大を出さない。
  assert.equal(capexUnitCostUsdPerCapacityTon(1_200_000, 0), undefined);
  assert.equal(capexUnitCostUsdPerCapacityTon(1_200_000, -5), undefined);
  assert.equal(capexUnitCostUsdPerCapacityTon(Number.NaN, 100), undefined);
});

test("UIC1-2 (A-4): カタログの実データで、VAPがHOSOより大幅に割高であることが単価に出る", () => {
  const t = CAPEX_PARAMETERS_V1.templatesByType;
  const unit = (type: keyof typeof t): number => {
    const tpl = t[type];
    const cost = capexUnitCostUsdPerCapacityTon(tpl.standardBudgetUsd, tpl.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0);
    assert.ok(cost !== undefined, `${String(type)} の単価が出ない`);
    return cost;
  };
  const hoso = unit("hosoLineExpansion");
  const vap = unit("vapLineExpansion");
  assert.ok(vap > hoso * 5, `VAPがHOSOより大幅に割高であること（hoso=${hoso} vap=${vap}）`);
});

test("UIC1-3 (A-4): 投資カードに単価が描画される", () => {
  const html = renderInvestment();
  assert.ok(html.includes('data-testid="capex-unit-cost-hosoLineExpansion"'), "HOSOラインの単価が無い");
  assert.ok(html.includes('data-testid="capex-unit-cost-vapLineExpansion"'), "VAPラインの単価が無い");
  assert.ok(html.includes("能力1t（四半期）あたり投資額"), "単価の見出しが無い");
});

test("UIC1-4 (A-2): 排水・環境設備は便益が無いことを明言する", () => {
  const note = PROJECT_EFFECT_DISCLOSURES.environmentalEquipment.notImplementedNote ?? "";
  assert.ok(note.includes("この投資に便益はありません"), "便益が無いことが明言されていない");
  assert.ok(note.includes("投資しないでください"), "研修での扱いが書かれていない");
  assert.ok(renderInvestment().includes("この投資に便益はありません"), "画面に描画されていない");
});

test("UIC1-5 (A-3): 品質管理設備は、実際に接続されている2つの効果を実装済みとして説明する", () => {
  const disclosure = PROJECT_EFFECT_DISCLOSURES.qualityControlEquipment;
  const implemented = disclosure.implementedEffects.join(" / ");
  assert.ok(implemented.includes("操業リスク"), "操業リスク低減の効果が実装済みに入っていない");
  assert.ok(implemented.includes("品質評価へ加点"), "販売時の品質評価への加点が実装済みに入っていない");
  // 否定対照: 以前の誤った説明が残っていないこと。
  const all = `${implemented} / ${disclosure.notImplementedEffects.join(" / ")} / ${disclosure.notImplementedNote ?? ""}`;
  assert.ok(!all.includes("操業上の便益はありません"), "品質管理設備に便益が無いという誤った説明が残っている");
  // 効果の出かた（間接・三層モデル限定）が書かれていること。
  assert.ok((disclosure.notImplementedNote ?? "").includes("三層顧客価格モデル"), "適用条件が書かれていない");
});

test("UIC1-6 (A-5): 投資額は固定で指定できないことを明言する", () => {
  assert.ok(CAPEX_EXPLANATION_TEXT.includes("金額を指定することはできません"), "固定であることが書かれていない");
  assert.ok(renderInvestment().includes("金額を指定することはできません"), "画面に描画されていない");
});

test("UIC1-7 (A-7): 借入がいつ資金になるかを財務画面が明言する", () => {
  const html = renderFinance();
  assert.ok(html.includes('data-testid="financing-timing-note"'), "入金タイミングの注記が無い");
  assert.ok(html.includes("申請した四半期のうちに審査され"), "同一四半期に使えることが書かれていない");
  assert.ok(html.includes("実行額は申請額と異なることがあります"), "申請額と実行額が別であることが書かれていない");
});

// ---------------------------------------------------------------------------
// A-1: 申請する前に「いくらまで借りられそうか」と「何が上限を決めているか」を出す
// ---------------------------------------------------------------------------

import {
  BORROWING_CONSTRAINT_LABELS,
  borrowingConstraintLabel,
  buildBorrowingCapacityGuide,
} from "../borrowingCapacityGuide";
import { advanceCompanyLabQuarter, generateAutoPolicyDecision } from "../../../lib/v2/companyLab";
import type { CompanyLabState } from "../../../lib/v2/companyLab/types";

/** 実際にTurnを進めて、engineが作った本物の財務記録を得る（手作りのfixtureを使わない）。 */
function realFinancingResult(turns: number) {
  const { state: initial, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-clarity-a1", turns: turns + 2 });
  let state: CompanyLabState = initial;
  for (let i = 0; i < turns; i += 1) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = Object.fromEntries(
      fixtures.map((f) => [
        f.companyId,
        generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn),
      ])
    );
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }
  const lastRecord = state.history[state.history.length - 1];
  return lastRecord.financingResults.find((f) => f.companyId === "BAL");
}

test("UIC1-8 (A-1): engineが返す上限要因の識別子すべてに日本語訳がある", () => {
  // financing/borrowingCapacity.ts が bindingConstraint に入れ得る値の全列挙。
  const engineValues = ["collateralBased", "earningsBased", "creditTierEquityCap", "existingLoanBalance", "insolvent", "severeArrears", "creditTierE"];
  for (const value of engineValues) {
    assert.ok(BORROWING_CONSTRAINT_LABELS[value] !== undefined, `${value} の日本語訳が無い`);
    assert.ok(!borrowingConstraintLabel(value).includes("説明が用意されていません"), `${value} が未知扱いになっている`);
  }
});

test("UIC1-9 (A-1): 未知の識別子は推測で訳さず、そのまま出す", () => {
  const label = borrowingConstraintLabel("someNewConstraintV2");
  assert.ok(label.includes("someNewConstraintV2"), "元の識別子が消えている");
  assert.ok(label.includes("説明が用意されていません"), "未知であることが示されていない");
});

test("UIC1-10 (A-1): 記録が無ければ何も出さない（残高から逆算しない）", () => {
  assert.equal(buildBorrowingCapacityGuide(null), null);
  assert.equal(buildBorrowingCapacityGuide(undefined), null);
});

test("UIC1-11 (A-1): 本物の財務記録から、額・要因・信用区分を引き継ぐ", () => {
  const result = realFinancingResult(3);
  assert.ok(result !== undefined, "engineの財務記録が取れない＝この検査が意味を持たない");
  const guide = buildBorrowingCapacityGuide(result);
  assert.ok(guide !== null);
  assert.equal(guide.availableAdditionalCapacityUsd, result.borrowingCapacity.availableAdditionalCapacityUsd);
  assert.equal(guide.existingLoanBalanceUsd, result.borrowingCapacity.existingLoanBalanceUsd);
  assert.equal(guide.creditTier, result.creditScore.tier);
  assert.equal(guide.underwritingFrozen, result.borrowingCapacity.underwritingFrozen);
  assert.equal(guide.covenantBreach, result.covenant.anyBreach);
  // 内部の識別子がそのまま画面へ出ないこと。
  assert.ok(!guide.bindingConstraintLabel.includes("binding:"), "engineの内部表記が残っている");
  assert.notEqual(guide.bindingConstraintLabel, result.borrowingCapacity.bindingConstraint);
});

test("UIC1-12 (A-1): 財務画面が借入余力を描画する（記録があるとき／無いとき）", () => {
  const { draft, vm } = setup();
  const withoutRecord = renderToStaticMarkup(
    React.createElement(FinancePlanningScreen, { draft, onChange: () => {}, disabled: false, vm })
  );
  assert.ok(withoutRecord.includes('data-testid="borrowing-capacity-guide-unavailable"'), "記録が無いときの表示が無い");
  assert.ok(!withoutRecord.includes('data-testid="borrowing-capacity-available"'), "記録が無いのに額を出している");

  const result = realFinancingResult(3);
  assert.ok(result !== undefined);
  const withRecord = renderToStaticMarkup(
    React.createElement(FinancePlanningScreen, {
      draft,
      onChange: () => {},
      disabled: false,
      vm,
      lastQuarterFinancingResult: result,
    })
  );
  assert.ok(withRecord.includes('data-testid="borrowing-capacity-guide"'), "借入余力が描画されていない");
  assert.ok(withRecord.includes('data-testid="borrowing-capacity-available"'), "額が描画されていない");
  assert.ok(withRecord.includes('data-testid="borrowing-capacity-binding"'), "上限要因が描画されていない");
  assert.ok(withRecord.includes("今期の審査を約束するものではありません"), "前期記録であることの但し書きが無い");
});

// ---------------------------------------------------------------------------
// A-4 案1: 単価だけでなく、稼ぎ側（商品別の限界利益）と回収年数の目安も並べる
// ---------------------------------------------------------------------------

import {
  capexTargetProductOf,
  productContributionMarginUsdPerProducedTon,
  capexYearsOfMarginToRecoverUnitCost,
} from "../investmentPlanningViewModel";
import type { CompanyFinancialQuarterResult } from "../../../lib/v2/finance/types";

/** contributionMargin.byProduct だけを持つ最小の財務結果（他の経路は使わない）。 */
function financialResultWith(byProduct: readonly { key: string; contributionMargin: number }[]): CompanyFinancialQuarterResult {
  return {
    contributionMargin: {
      byProduct: byProduct.map((r) => ({ key: r.key, contributionMargin: r.contributionMargin })),
    },
  } as unknown as CompanyFinancialQuarterResult;
}

test("UIC1-18 (A-4): 能力を増やす3案件だけが商品に対応する", () => {
  assert.equal(capexTargetProductOf("hosoLineExpansion"), "hoso");
  assert.equal(capexTargetProductOf("pdLineExpansion"), "pd");
  assert.equal(capexTargetProductOf("vapLineExpansion"), "vap");
  // 能力を増やさない案件・商品に紐づかない案件は対応しない。
  assert.equal(capexTargetProductOf("qualityControlEquipment"), undefined);
  assert.equal(capexTargetProductOf("newFactoryConstruction"), undefined);
  assert.equal(capexTargetProductOf("coldStorageExpansion"), undefined);
});

test("UIC1-19 (A-4): 商品別の限界利益は、管理会計の値を生産量で割る", () => {
  const result = financialResultWith([
    { key: "hoso", contributionMargin: 1_000_000 },
    { key: "vap", contributionMargin: 2_000_000 },
  ]);
  assert.equal(productContributionMarginUsdPerProducedTon(result, { hoso: 500, vap: 100 }, "hoso"), 2_000);
  assert.equal(productContributionMarginUsdPerProducedTon(result, { hoso: 500, vap: 100 }, "vap"), 20_000);
});

test("UIC1-20 (A-4): 記録が無い・生産量が0なら数字を作らない", () => {
  const result = financialResultWith([{ key: "hoso", contributionMargin: 1_000_000 }]);
  assert.equal(productContributionMarginUsdPerProducedTon(null, { hoso: 500 }, "hoso"), undefined);
  assert.equal(productContributionMarginUsdPerProducedTon(result, undefined, "hoso"), undefined);
  assert.equal(productContributionMarginUsdPerProducedTon(result, { hoso: 0 }, "hoso"), undefined);
  // その商品の行が無いときも作らない。
  assert.equal(productContributionMarginUsdPerProducedTon(result, { vap: 100 }, "vap"), undefined);
});

test("UIC1-21 (A-4): 回収年数は 単価 ÷（限界利益×4四半期）。出せないときは undefined", () => {
  assert.equal(capexYearsOfMarginToRecoverUnitCost(24_000, 6_000), 1);
  assert.equal(capexYearsOfMarginToRecoverUnitCost(2_000, 1_250), 0.4);
  assert.equal(capexYearsOfMarginToRecoverUnitCost(undefined, 6_000), undefined);
  assert.equal(capexYearsOfMarginToRecoverUnitCost(24_000, undefined), undefined);
  assert.equal(capexYearsOfMarginToRecoverUnitCost(24_000, 0), undefined);
  assert.equal(capexYearsOfMarginToRecoverUnitCost(24_000, -100), undefined);
});

test("UIC1-22 (A-4): 実測どおり、VAPは単価ではHOSOより割高でもPDより早く回収できる", () => {
  // 32Turn実測（docs/int1/logs/vap-investment-economics.log）の限界利益/t を使う。
  const hoso = capexYearsOfMarginToRecoverUnitCost(2_000, 1_283);
  const pd = capexYearsOfMarginToRecoverUnitCost(11_429, 2_079);
  const vap = capexYearsOfMarginToRecoverUnitCost(24_000, 5_822);
  assert.ok(hoso !== undefined && pd !== undefined && vap !== undefined);
  assert.ok(vap < pd, `VAPがPDより早く回収できること（vap=${vap.toFixed(2)} pd=${pd.toFixed(2)}）`);
  assert.ok(hoso < vap, `HOSOがいちばん早いこと（hoso=${hoso.toFixed(2)} vap=${vap.toFixed(2)}）`);
});

test("UIC1-23 (A-4): カードに限界利益と回収年数の欄が出る", () => {
  const html = renderInvestment();
  for (const type of ["hosoLineExpansion", "pdLineExpansion", "vapLineExpansion"]) {
    assert.ok(html.includes(`data-testid="capex-margin-per-ton-${type}"`), `${type}: 限界利益の欄が無い`);
    assert.ok(html.includes(`data-testid="capex-unit-cost-years-${type}"`), `${type}: 回収年数の欄が無い`);
  }
  assert.ok(html.includes("前四半期の限界利益（生産1tあたり）"), "分母の基準が見出しに書かれていない");
});
