// ShrimpX V2 — INT-1 §6: 提出値の消失・無効な値の保存を止める
//
// 【統合候補上で実測した修正前の挙動】
//   buildDecisionInputFromDraft は安全側に倒して無効値を黙って置換・行を黙って削除する。
//     salesPlans[0].desiredQuantity = null / -5000 / "abc" → その行が decision から消える
//     productionPlans[0].desiredQuantity = -9999            → その行が消える
//     workerAssignments[0].regularHeadcount = -100          → 0 になる（全員解雇相当）
//     workerAssignments[0].overtimeRate = 99                → 1 にクランプ
//     dividendAmountUsd = -1000000 / null                   → 0
//   いずれも利用者へ何も伝えないため、「提出したはずの値が消えた」「知らない値が保存された」
//   という形で研修中に現れる。
//
// 【このテストが固定する契約】
//   サニタイズそのものは変更しない（既存Runの再現性を壊さない）。
//   無効入力は validateDecisionDraftNumbers が提出前に検出し、提出・確定を拒否する。
//   正当な 0（売らない・借りない・配当しない）は無効ではない。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompanyOwnState,
  buildPublicMarketInfo,
  CompanyLabConfig,
  initializeCompanyLab,
} from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft, validateDecisionDraftNumbers } from "../decisionDraft";

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "int1-draft-validation", turns: 6 };

function baseDraft() {
  const { state, fixtures } = initializeCompanyLab(config);
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return { state, fixture, draft };
}

/** クライアント→サーバのJSON往復を模す（NaN/Infinityはnullになる）。 */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("INT1-UI-5: 既定ドラフト（AI判断そのまま）は妥当と判定される", () => {
  const { draft } = baseDraft();
  assert.deepEqual(validateDecisionDraftNumbers(wire(draft)), [], "正常な下書きが無効と判定されている");
});

test("INT1-UI-6: 正当な0は無効ではない（売らない・借りない・配当しない）", () => {
  const { draft } = baseDraft();
  const zeroed = wire(draft) as unknown as Record<string, unknown>;
  (zeroed.salesPlans as Record<string, unknown>[]).forEach((p) => (p.desiredQuantity = 0));
  (zeroed.productionPlans as Record<string, unknown>[]).forEach((p) => (p.desiredQuantity = 0));
  (zeroed.domesticPurchase as Record<string, unknown>).desiredQuantity = 0;
  (zeroed.financingRequest as Record<string, unknown>).desiredAmountUsd = 0;
  zeroed.dividendAmountUsd = 0;
  zeroed.salesForceHireCount = 0;
  assert.deepEqual(
    validateDecisionDraftNumbers(zeroed as never),
    [],
    "0が無効扱いされている（0は「しない」という正当な意思決定）"
  );
});

const CASES: readonly { readonly label: string; readonly mutate: (d: Record<string, unknown>) => void; readonly expect: RegExp }[] = [
  {
    label: "salesPlans の数量が null（NaN/Infinityの実体）",
    mutate: (d) => ((d.salesPlans as Record<string, unknown>[])[0].desiredQuantity = null),
    expect: /提示数量/,
  },
  {
    label: "salesPlans の数量が負数",
    mutate: (d) => ((d.salesPlans as Record<string, unknown>[])[0].desiredQuantity = -5000),
    expect: /提示数量/,
  },
  {
    label: "salesPlans の数量が文字列",
    mutate: (d) => ((d.salesPlans as Record<string, unknown>[])[0].desiredQuantity = "abc"),
    expect: /提示数量/,
  },
  {
    label: "productionPlans の数量が負数",
    mutate: (d) => ((d.productionPlans as Record<string, unknown>[])[0].desiredQuantity = -9999),
    expect: /生産数量/,
  },
  {
    label: "workerAssignments の常用人数が負数",
    mutate: (d) => ((d.workerAssignments as Record<string, unknown>[])[0].regularHeadcount = -100),
    expect: /常用人数/,
  },
  {
    label: "workerAssignments の残業率が範囲外（99）",
    mutate: (d) => ((d.workerAssignments as Record<string, unknown>[])[0].overtimeRate = 99),
    expect: /残業率/,
  },
  {
    label: "配当額が負数",
    mutate: (d) => (d.dividendAmountUsd = -1_000_000),
    expect: /配当額/,
  },
  {
    label: "営業人員の採用人数が負数",
    mutate: (d) => (d.salesForceHireCount = -5),
    expect: /採用人数/,
  },
  {
    label: "借入の希望額が null",
    mutate: (d) => ((d.financingRequest as Record<string, unknown>).desiredAmountUsd = null),
    expect: /希望額/,
  },
];

for (const c of CASES) {
  test(`INT1-UI-7: 無効入力を提出前に検出する — ${c.label}`, () => {
    const { draft } = baseDraft();
    const mutated = wire(draft) as unknown as Record<string, unknown>;
    c.mutate(mutated);
    const errors = validateDecisionDraftNumbers(mutated as never);
    assert.ok(errors.length > 0, `無効入力が検出されていない: ${c.label}`);
    assert.ok(
      errors.some((e) => c.expect.test(e)),
      `該当項目のエラー文が無い（${c.expect}）: ${errors.join(" / ")}`
    );
  });
}

test("INT1-UI-8: 検出対象は「サニタイズが値を書き換える入力」と一致する（消失・改変の実体を確認）", () => {
  const { state, fixture, draft } = baseDraft();
  const sanitizedCount = (d: unknown) => buildDecisionInputFromDraft(d as never, fixture, state.currentPeriod).salesPlans.length;
  const baseCount = sanitizedCount(wire(draft));
  assert.ok(baseCount > 0, "基準の販売計画が空");

  // 無効な数量の行は、修正前は黙って消えていた（＝提出値の消失）。
  const dropped = wire(draft) as unknown as Record<string, unknown>;
  (dropped.salesPlans as Record<string, unknown>[])[0].desiredQuantity = null;
  assert.equal(sanitizedCount(dropped), baseCount - 1, "無効行が消えるという前提が崩れている（再現できていない）");
  assert.ok(validateDecisionDraftNumbers(dropped as never).length > 0, "消失する入力が検証で止まっていない");

  // 負の人員は、修正前は黙って0になっていた（＝無効な値の保存）。
  const clamped = wire(draft) as unknown as Record<string, unknown>;
  (clamped.workerAssignments as Record<string, unknown>[])[0].regularHeadcount = -100;
  const built = buildDecisionInputFromDraft(clamped as never, fixture, state.currentPeriod);
  assert.equal(built.workerAssignments[0].regularHeadcount, 0, "負の人員が0になるという前提が崩れている");
  assert.ok(validateDecisionDraftNumbers(clamped as never).length > 0, "0へ改変される入力が検証で止まっていない");
});

test("INT1-UI-9: 形が壊れた下書き（配列欠落）も例外ではなくエラー一覧として返す", () => {
  // /api/v2/play/submit はクライアントのJSONをそのまま受けるため、
  // 形が壊れていても 500 ではなく 400 相当（人が読めるエラー）にする必要がある。
  const errors = validateDecisionDraftNumbers({ companyId: "BAL" } as never);
  assert.ok(errors.length > 0, "形が壊れた下書きが妥当と判定されている");
  assert.ok(
    errors.some((e) => e.includes("配列ではありません")),
    `形の不正が報告されていない: ${errors.join(" / ")}`
  );
  // 例外を投げないこと（投げると500になる）。
  assert.doesNotThrow(() => validateDecisionDraftNumbers({} as never));
  assert.doesNotThrow(() => validateDecisionDraftNumbers(null as never));
});
