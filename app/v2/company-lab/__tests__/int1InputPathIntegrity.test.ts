// ShrimpX V2 — INT-1 §1: 入力 → 下書き → 送信 → 保存 → 実行 で値が無言に変わらない
//
// 【旧実装の実測】UIの入力セルが Number(raw) の非有限結果を 0 へ落としていた。
// Number("") === 0 なので「空欄」と「明示的な0」が下書き上で区別できず、
//   販売数量を空欄のまま確定 → 下書き 0 → 検証を通過 → その販売計画の行が消える
//   常用人数の増減を空欄のまま確定 → 下書き 0 → 増減なしとして保存
//   残業率に 99（0.99の打ち間違い）→ Math.min(1,…) で 1 へクランプして保存
// が利用者へ何も伝えずに起きていた。
//
// 【修正】parseNumberInput / parseRatioInput は空欄・非数を NaN にし、0へ変換しない。
// 負数・範囲外も丸めない。いずれも validateDecisionDraftNumbers が項目名を示して
// 提出・確定を止める（Console内PLAYER=PlayerWorkspace.handleConfirm と
// Independent Player=/api/v2/play/submit の両方が同じ関数を呼ぶ）。
// engine 直前の buildDecisionInputFromDraft のサニタイズは変更していない（二重防御のまま）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumberInput, parseRatioInput } from "../components/InputCells";
import { buildDecisionInputFromDraft, buildInitialDraft, validateDecisionDraftNumbers } from "../decisionDraft";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-input-path", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return { state, fixture, draft };
}

/** 下書きを編集可能な素のオブジェクトへ落とす（NaNを入れる前に行う）。 */
function editable(draft: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
}

test("INT1-IP-1: 明示的な0は受理し、空欄・非数は0へ変換しない", () => {
  // 明示的な0は正当な意思決定なので、必ず 0 として受理する。
  assert.equal(parseNumberInput("0"), 0);
  assert.equal(parseNumberInput("0.0"), 0);
  assert.equal(parseRatioInput("0"), 0);
  // 空欄・空白のみ・非数は NaN。0 にしない（ここが監査指摘の修正点）。
  assert.ok(Number.isNaN(parseNumberInput("")), "空欄が0へ変換されている（無言の書き換え）");
  assert.ok(Number.isNaN(parseNumberInput("   ")), "空白のみが0へ変換されている");
  assert.ok(Number.isNaN(parseNumberInput("abc")), "非数が0へ変換されている");
  assert.ok(Number.isNaN(parseRatioInput("")), "比率の空欄が0へ変換されている");
  // 正当な値はそのまま。
  assert.equal(parseNumberInput("1234.5"), 1234.5);
  assert.equal(parseRatioInput("0.25"), 0.25);
  // 負数・範囲外は丸めない（無言で別の値に変えない）。
  assert.equal(parseNumberInput("-5000"), -5000, "負数が0へ丸められている（無言の書き換え）");
  assert.equal(parseRatioInput("99"), 99, "範囲外の比率がクランプされている（無言の書き換え）");
  assert.equal(parseRatioInput("-1"), -1);
});

test("INT1-IP-2: UI経由でも負数は提出前検証で止まる（丸められて検出不能にならない）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  // 利用者が販売数量へ "-5000" と打った状態を、実際の入力セル関数を通して再現する。
  (viaUi.salesPlans as Record<string, unknown>[])[0].desiredQuantity = parseNumberInput("-5000");
  const errors = validateDecisionDraftNumbers(viaUi as never);
  assert.ok(errors.length > 0, "UI経由の負数が検証をすり抜けている");
  assert.ok(errors.some((e) => e.includes("提示数量")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-3: UI経由でも負の人員は提出前検証で止まる", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  (viaUi.workerAssignments as Record<string, unknown>[])[0].regularHeadcount = parseNumberInput("-100");
  const errors = validateDecisionDraftNumbers(viaUi as never);
  assert.ok(errors.length > 0, "UI経由の負の人員が検証をすり抜けている");
  assert.ok(errors.some((e) => e.includes("常用人数")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-4: UI経由でも範囲外の残業率は提出前検証で止まる", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  (viaUi.workerAssignments as Record<string, unknown>[])[0].overtimeRate = parseRatioInput("99");
  const errors = validateDecisionDraftNumbers(viaUi as never);
  assert.ok(errors.length > 0, "UI経由の範囲外残業率が検証をすり抜けている");
  assert.ok(errors.some((e) => e.includes("残業率")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-5: engine直前のサニタイズは変更していない（不正値はengineへ届かない）", () => {
  const { state, fixture, draft } = setup();
  const bad = editable(draft);
  (bad.workerAssignments as Record<string, unknown>[])[0].regularHeadcount = -100;
  (bad.workerAssignments as Record<string, unknown>[])[0].overtimeRate = 99;
  const built = buildDecisionInputFromDraft(bad as never, fixture, state.currentPeriod);
  // 検証を通さずにここへ到達した場合でも、engineへ渡る値は範囲内に収まっている。
  assert.equal(built.workerAssignments[0].regularHeadcount, 0, "engine直前のサニタイズが変わっている");
  assert.equal(built.workerAssignments[0].overtimeRate as unknown as number, 1, "engine直前のratioサニタイズが変わっている");
});

test("INT1-IP-6: 正常な下書きは今までどおり通る（回帰）", () => {
  const { state, fixture, draft } = setup();
  assert.deepEqual(validateDecisionDraftNumbers(editable(draft) as never), []);
  const built = buildDecisionInputFromDraft(editable(draft) as never, fixture, state.currentPeriod);
  assert.ok(built.salesPlans.length > 0, "正常な下書きで販売計画が消えている");
  assert.ok(built.workerAssignments.length > 0, "正常な下書きで人員配置が消えている");
});

test("INT1-IP-7: 空欄の販売数量は提出前検証で止まる（0として確定しない）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  const row = (viaUi.salesPlans as Record<string, unknown>[])[0];
  row.desiredQuantity = parseNumberInput(""); // 利用者が数量欄を空にした状態
  const errors = validateDecisionDraftNumbers(viaUi as never);
  assert.ok(errors.length > 0, "空欄の販売数量が0として受理されている");
  assert.ok(errors.some((e) => e.includes("提示数量")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-8: 明示的な0の販売数量は受理される（0は正当な意思決定）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  for (const row of viaUi.salesPlans as Record<string, unknown>[]) {
    row.desiredQuantity = parseNumberInput("0");
  }
  assert.deepEqual(validateDecisionDraftNumbers(viaUi as never), [], "明示的な0が無効と判定されている");
});

test("INT1-IP-9: 空欄の増員／減員は提出前検証で止まる（engineのapplyHeadcountChangeでは検出できない）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  const row = (viaUi.workerAssignments as Record<string, unknown>[])[0];
  // 画面が編集するのは差分。engineのapplyHeadcountChangeは非有限を0扱いするため、
  // regularHeadcount は「前期末のまま」の正当な値になり、そちらでは検出できない。
  row.regularHeadcountChange = parseNumberInput("");
  const errors = validateDecisionDraftNumbers(viaUi as never);
  assert.ok(errors.length > 0, "空欄の増減差分が受理されている");
  assert.ok(errors.some((e) => e.includes("増員／減員")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-10: 空欄の残業率は提出前検証で止まる", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  (viaUi.workerAssignments as Record<string, unknown>[])[0].overtimeRate = parseRatioInput("");
  const errors = validateDecisionDraftNumbers(viaUi as never);
  assert.ok(errors.length > 0, "空欄の残業率が0として受理されている");
  assert.ok(errors.some((e) => e.includes("残業率")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-11: 不正値を直せば再度通る（修正後の再提出）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  const row = (viaUi.salesPlans as Record<string, unknown>[])[0];
  row.desiredQuantity = parseNumberInput("");
  assert.ok(validateDecisionDraftNumbers(viaUi as never).length > 0, "空欄が止まっていない");
  row.desiredQuantity = parseNumberInput("1200"); // 打ち直し
  assert.deepEqual(validateDecisionDraftNumbers(viaUi as never), [], "修正後も止まったままになっている");
});

test("INT1-IP-12: JSON送信でNaNがnullへ変わっても検証は項目名を示して止める（Independent Player経路）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  (viaUi.salesPlans as Record<string, unknown>[])[0].desiredQuantity = parseNumberInput("");
  // fetch の body は JSON.stringify を通るため、NaN は null になって届く（実測）。
  const overWire = JSON.parse(JSON.stringify(viaUi)) as Record<string, unknown>;
  assert.equal((overWire.salesPlans as Record<string, unknown>[])[0].desiredQuantity, null, "NaNがnull以外で届いている");
  const errors = validateDecisionDraftNumbers(overWire as never);
  assert.ok(errors.length > 0, "wire経由の空欄が受理されている");
  assert.ok(errors.some((e) => e.includes("提示数量")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

// ---------------------------------------------------------------------
// 【最終監査】JSON送信時の検証漏れ（空欄のNaNがnullになり、省略可能な項目の
// 検証を飛ばしていた）。Independent Player は下書きを JSON.stringify して
// POST するため、この経路でも拒否されなければならない。
// 省略（キーが無い）・明示的な0・正当な減員（負値）は通さなければならない。
// 再現は scripts/int1/reproJsonNullBypass.ts。
// ---------------------------------------------------------------------

/** fetch の body と同じ変換（NaN → null、undefinedのキーは消える）。 */
function overWire(draft: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
}

test("INT1-IP-13: 空欄の増員／減員はJSON変換後も項目名付きで拒否される", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  (viaUi.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange = parseNumberInput("");
  const wire = overWire(viaUi);
  assert.equal((wire.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange, null, "NaNがnull以外で届いている");
  const errors = validateDecisionDraftNumbers(wire as never);
  assert.ok(errors.length > 0, "JSON変換後に空欄の増減差分が通過している");
  assert.ok(errors.some((e) => e.includes("増員／減員")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-14: 空欄の設備投資申請額・優先度はJSON変換後も項目名付きで拒否される", () => {
  const { draft } = setup();
  for (const [key, word] of [
    ["requestedBudgetUsd", "申請額"],
    ["priority", "優先度"],
  ] as const) {
    const viaUi = editable(draft);
    (viaUi.capexDecision as Record<string, unknown>).newProjectProposals = [
      { projectType: "newFactoryConstruction", [key]: parseNumberInput("") },
    ];
    const wire = overWire(viaUi);
    const proposal = ((wire.capexDecision as Record<string, unknown>).newProjectProposals as Record<string, unknown>[])[0];
    assert.equal(proposal[key], null, `${key} が null 以外で届いている`);
    const errors = validateDecisionDraftNumbers(wire as never);
    assert.ok(errors.length > 0, `JSON変換後に空欄の ${key} が通過している`);
    assert.ok(errors.some((e) => e.includes(word)), `該当項目のエラーが無い: ${errors.join(" / ")}`);
  }
});

test("INT1-IP-15: 空欄の輸入リードタイムもJSON変換後に拒否される（同じ検証漏れの他項目）", () => {
  const { draft } = setup();
  const viaUi = editable(draft);
  (viaUi.importOrders as Record<string, unknown>[])[0].leadTimeTurns = parseNumberInput("");
  const errors = validateDecisionDraftNumbers(overWire(viaUi) as never);
  assert.ok(errors.length > 0, "JSON変換後に空欄のリードタイムが通過している");
  assert.ok(errors.some((e) => e.includes("リードタイム")), `該当項目のエラーが無い: ${errors.join(" / ")}`);
});

test("INT1-IP-16: 省略可能な項目の『省略』はJSON変換後も通る（意味を壊していない）", () => {
  const { draft } = setup();

  const withoutChange = editable(draft);
  delete (withoutChange.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange;
  assert.deepEqual(validateDecisionDraftNumbers(overWire(withoutChange) as never), [], "増減差分の省略が拒否されている");

  const withoutLeadTime = editable(draft);
  delete (withoutLeadTime.importOrders as Record<string, unknown>[])[0].leadTimeTurns;
  assert.deepEqual(validateDecisionDraftNumbers(overWire(withoutLeadTime) as never), [], "リードタイムの省略（標準を使う意思決定）が拒否されている");

  const withoutBudget = editable(draft);
  (withoutBudget.capexDecision as Record<string, unknown>).newProjectProposals = [{ projectType: "newFactoryConstruction" }];
  assert.deepEqual(validateDecisionDraftNumbers(overWire(withoutBudget) as never), [], "申請額の省略（標準予算を使う意思決定）が拒否されている");
});

test("INT1-IP-17: 明示的な0と正当な減員（負の増減）はJSON変換後も通る", () => {
  const { draft } = setup();
  for (const value of [0, -30]) {
    const viaUi = editable(draft);
    (viaUi.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange = value;
    assert.deepEqual(
      validateDecisionDraftNumbers(overWire(viaUi) as never),
      [],
      `増員／減員 = ${value} が無効と判定されている（0は正当、負値は減員として正当）`
    );
  }
  // 画面内（JSONを通らない）経路でも同じ。
  const inMemory = editable(draft);
  (inMemory.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange = -30;
  assert.deepEqual(validateDecisionDraftNumbers(inMemory as never), [], "画面内経路で正当な減員が拒否されている");
});

test("INT1-IP-18: 画面内の明示的なundefinedは従来どおり省略として扱う（buildInitialDraftが実際に作る形）", () => {
  const { draft } = setup();
  const inMemory = editable(draft);
  // JSON を通さない Console内PLAYER の確定経路では、キーが存在して値が undefined になりうる。
  (inMemory.importOrders as Record<string, unknown>[])[0].leadTimeTurns = undefined;
  assert.ok("leadTimeTurns" in (inMemory.importOrders as Record<string, unknown>[])[0], "キーが存在する前提が崩れている");
  assert.deepEqual(validateDecisionDraftNumbers(inMemory as never), [], "明示的なundefinedが拒否されている");
});
