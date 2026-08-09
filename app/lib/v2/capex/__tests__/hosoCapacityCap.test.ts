// ShrimpX V2 — Test16: HOSO加工能力の投資と明示上限の回帰テスト
//
// 【固定したいこと】
//   ・HOSO加工ライン増設が 8,000,000 USD / +4,000t/期 / 工期1Q であること
//   ・HOSO専用能力が 24,000t を超えないこと（共通能力とは別の明示的な上限）
//   ・上限は初期8,000t + 4,000t×4回 で到達すること
//   ・PD/VAPには上限を掛けていないこと（HOSO固有の上限であること）

import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import { MAX_HOSO_CAPACITY_TONS } from "../capacityEffect";

test("【Test16】HOSO加工ライン増設は 8M USD / +4,000t/期 / 工期1Q", () => {
  const t = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion;
  assert.equal(t.standardBudgetUsd, 8_000_000, "投資額は8M USD");
  assert.equal(t.futureCapacityEffect?.capacityIncreaseTonsPerQuarter, 4_000, "1回の能力増加は+4,000t/期");
  assert.equal(t.futureCapacityEffect?.targetProduct, "hoso");
  assert.equal(t.standardConstructionQuarters, 1, "工期は1Q（既存のPD・common・freezingと同じ）");
});

test("【Test16】HOSO専用能力の明示上限は24,000t（初期8,000 + 4,000×4回）", () => {
  assert.equal(MAX_HOSO_CAPACITY_TONS, 24_000);
  const increment = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.futureCapacityEffect!.capacityIncreaseTonsPerQuarter!;
  const initialHoso = 8_000;
  assert.equal(initialHoso + increment * 4, MAX_HOSO_CAPACITY_TONS, "4回の投資でちょうど上限へ到達すること");
  const budget = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.standardBudgetUsd;
  assert.equal(budget * 4, 32_000_000, "上限までの投資総額は32M USD");
});

test("【Test16】HOSOの投資単価はPD/VAPより意図的に安い（大量処理型の性格づけ）", () => {
  const hoso = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion;
  const pd = CAPEX_PARAMETERS_V1.templatesByType.pdLineExpansion;
  const vap = CAPEX_PARAMETERS_V1.templatesByType.vapLineExpansion;
  const unitCost = (t: typeof hoso) => t.standardBudgetUsd / t.futureCapacityEffect!.capacityIncreaseTonsPerQuarter!;
  assert.ok(unitCost(hoso) < unitCost(pd), "HOSOの単価はPDより安いこと");
  assert.ok(unitCost(hoso) < unitCost(vap), "HOSOの単価はVAPより安いこと");
  // 意図した水準（2,000 USD/t）であることも固定する。
  assert.equal(unitCost(hoso), 2_000);
});

test("【Test16】上限はHOSO固有であり、PD/VAPには適用されない", () => {
  const source = require("fs").readFileSync(require("path").resolve(__dirname, "..", "capacityEffect.ts"), "utf8");
  assert.ok(/hosoCapacity: hosoEqTons\(Math\.min\(MAX_HOSO_CAPACITY_TONS/.test(source), "HOSOにだけ上限が掛かっていること");
  assert.ok(!/pdCapacity: hosoEqTons\(Math\.min/.test(source), "PDには上限を掛けていないこと");
  assert.ok(!/vapCapacity: hosoEqTons\(Math\.min/.test(source), "VAPには上限を掛けていないこと");
});
