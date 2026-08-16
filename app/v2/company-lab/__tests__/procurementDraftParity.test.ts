// ShrimpX V2 — Procurement Planning: 旧UI相当の直接spread変更と、新UI（Step 5）が
// 呼ぶ updateDomesticPurchaseDraft/updateImportOrderDraft/updateAquacultureStockingDraft
// が、同一入力値に対して完全に同じ CompanyDecisionDraft・CompanyDecisionInput を
// 生成することを固定する（PROC-PARITY-1〜4）。
//
// 「旧UI相当」はDecisionEditor.tsxが削除前に持っていた
//   onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, desiredQuantity: n } })
// 等のインラインspreadパターンをそのままこのテストへ書き写したものである
// （旧component自体は削除済みのため、契約として固定する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import {
  buildDecisionInputFromDraft,
  buildInitialDraft,
  CompanyDecisionDraft,
  updateAquacultureStockingDraft,
  updateDomesticPurchaseDraft,
  updateImportOrderDraft,
} from "../decisionDraft";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "procurement-parity-001", turns: 8, ...overrides };
}

function buildBaseDraft(): { readonly draft: CompanyDecisionDraft; readonly fixture: ReturnType<typeof initializeCompanyLab>["fixtures"][number]; readonly period: ReturnType<typeof initializeCompanyLab>["state"]["currentPeriod"] } {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => (f.aquacultureCapacity as unknown as number) > 0) ?? fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);
  return { draft, fixture, period: state.currentPeriod };
}

// PROC-PARITY-1: 国内買付の3フィールド変更が、旧spreadパターンと新setterで同一のdraftを生成する
test("PROC-PARITY-1: 国内買付（Desired/Adjustment/Headcount）の旧spread変更と新setterのdraftが一致する", () => {
  const { draft: base } = buildBaseDraft();

  // 旧DecisionEditor.tsxが直接書いていたのと同じspreadパターン。
  let oldStyle = base;
  oldStyle = { ...oldStyle, domesticPurchase: { ...oldStyle.domesticPurchase, desiredQuantity: 8000 } };
  oldStyle = { ...oldStyle, domesticPurchase: { ...oldStyle.domesticPurchase, priceAdjustmentUsdPerHosoEqKg: 0.3 } };
  oldStyle = { ...oldStyle, domesticPurchase: { ...oldStyle.domesticPurchase, procurementHeadcount: 25 } };

  // 新Procurement Planning componentが呼ぶsetter。
  let newStyle = base;
  newStyle = updateDomesticPurchaseDraft(newStyle, { desiredQuantity: 8000 });
  newStyle = updateDomesticPurchaseDraft(newStyle, { priceAdjustmentUsdPerHosoEqKg: 0.3 });
  newStyle = updateDomesticPurchaseDraft(newStyle, { procurementHeadcount: 25 });

  assert.deepEqual(newStyle, oldStyle);
});

// PROC-PARITY-2: 輸入発注（原産国別）の旧spreadと新setterのdraftが一致する
test("PROC-PARITY-2: 輸入発注（Ordered Quantity/Lead Time）の旧spread変更と新setterのdraftが一致する", () => {
  const { draft: base } = buildBaseDraft();
  const targetCountry = base.importOrders[0].originCountry;

  let oldStyle = base;
  {
    const next = [...oldStyle.importOrders];
    const idx = next.findIndex((o) => o.originCountry === targetCountry);
    next[idx] = { ...next[idx], orderedQuantity: 1200 };
    oldStyle = { ...oldStyle, importOrders: next };
  }
  {
    const next = [...oldStyle.importOrders];
    const idx = next.findIndex((o) => o.originCountry === targetCountry);
    next[idx] = { ...next[idx], leadTimeTurns: 3 };
    oldStyle = { ...oldStyle, importOrders: next };
  }

  let newStyle = base;
  newStyle = updateImportOrderDraft(newStyle, targetCountry, { orderedQuantity: 1200 });
  newStyle = updateImportOrderDraft(newStyle, targetCountry, { leadTimeTurns: 3 });

  assert.deepEqual(newStyle, oldStyle);
});

// PROC-PARITY-3: 養殖（Stocking/Intensity/BioSecurity）の旧spreadと新setterのdraftが一致する
test("PROC-PARITY-3: 養殖池入れの旧spread変更と新setterのdraftが一致する（養殖能力を持つ会社のみ）", () => {
  const { draft: base, fixture } = buildBaseDraft();
  if ((fixture.aquacultureCapacity as unknown as number) <= 0 || base.aquacultureStockingPlans.length === 0) {
    // このフィクスチャ構成では養殖能力を持つ会社が居ない場合、テストの前提が成立しないためスキップ相当で終える。
    return;
  }

  let oldStyle = base;
  oldStyle = { ...oldStyle, aquacultureStockingPlans: [{ ...oldStyle.aquacultureStockingPlans[0], plannedStockingQuantity: 4000 }] };
  oldStyle = { ...oldStyle, aquacultureStockingPlans: [{ ...oldStyle.aquacultureStockingPlans[0], aquacultureIntensity: 0.6 }] };
  oldStyle = { ...oldStyle, aquacultureStockingPlans: [{ ...oldStyle.aquacultureStockingPlans[0], bioSecurityLevel: 0.8 }] };

  let newStyle = base;
  newStyle = updateAquacultureStockingDraft(newStyle, { plannedStockingQuantity: 4000 });
  newStyle = updateAquacultureStockingDraft(newStyle, { aquacultureIntensity: 0.6 });
  newStyle = updateAquacultureStockingDraft(newStyle, { bioSecurityLevel: 0.8 });

  assert.deepEqual(newStyle, oldStyle);
});

// PROC-PARITY-4: draft一致だけでなく、buildDecisionInputFromDraftの出力（エンジン入力）も完全に一致する
test("PROC-PARITY-4: 旧UI相当・新UI相当のいずれで作った draft も、buildDecisionInputFromDraft の出力が完全一致する", () => {
  const { draft: base, fixture, period } = buildBaseDraft();
  const targetCountry = base.importOrders[0].originCountry;

  let oldStyle = base;
  oldStyle = { ...oldStyle, domesticPurchase: { ...oldStyle.domesticPurchase, desiredQuantity: 6500, priceAdjustmentUsdPerHosoEqKg: -0.2, procurementHeadcount: 18 } };
  {
    const next = [...oldStyle.importOrders];
    const idx = next.findIndex((o) => o.originCountry === targetCountry);
    next[idx] = { ...next[idx], orderedQuantity: 900, leadTimeTurns: 2 };
    oldStyle = { ...oldStyle, importOrders: next };
  }

  let newStyle = base;
  newStyle = updateDomesticPurchaseDraft(newStyle, { desiredQuantity: 6500, priceAdjustmentUsdPerHosoEqKg: -0.2, procurementHeadcount: 18 });
  newStyle = updateImportOrderDraft(newStyle, targetCountry, { orderedQuantity: 900, leadTimeTurns: 2 });

  const oldInput = buildDecisionInputFromDraft(oldStyle, fixture, period);
  const newInput = buildDecisionInputFromDraft(newStyle, fixture, period);
  assert.deepEqual(newInput, oldInput);
});
