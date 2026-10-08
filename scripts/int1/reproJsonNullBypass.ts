/**
 * 【INT-1 最終監査】Independent Player の JSON 送信で、空欄が検証を通過する問題の再現。
 *
 * 事実関係:
 *   app/v2/play/workspace/page.tsx は下書きを JSON.stringify して POST する。
 *   入力欄の空欄は NaN で下書きへ入るが、JSON では null になる。
 *   validateDecisionDraftNumbers の「省略可能な項目」は `!== null` で
 *   検証対象から外しているため、null になった空欄が検証を通過する。
 *
 * この script は修正前後の両方で動く（修正後は「拒否」側に倒れる）。
 * 対象は検証関数内で `!== null` を使っている 4 項目すべて。
 */
import { buildInitialDraft, validateDecisionDraftNumbers } from "../../app/v2/company-lab/decisionDraft";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";

const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-json-null", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
const baseDraft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);

/** 画面の入力セルが空欄に対して下書きへ入れる値（InputCells.parseNumberInput と同じ）。 */
const BLANK = Number.NaN;

function show(label: string, apply: (d: Record<string, unknown>) => void, expectWord: string): void {
  const withNaN = JSON.parse(JSON.stringify(baseDraft)) as Record<string, unknown>;
  apply(withNaN);
  const beforeWire = validateDecisionDraftNumbers(withNaN as never);

  // fetch の body と同じ経路を通す（NaN → null）。
  const overWire = JSON.parse(JSON.stringify(withNaN)) as Record<string, unknown>;
  const afterWire = validateDecisionDraftNumbers(overWire as never);

  console.log(`\n--- ${label}`);
  console.log(`    NaNのまま（Console内PLAYERの確定経路）   ${beforeWire.length > 0 ? `拒否: ${beforeWire.filter((e) => e.includes(expectWord)).join(" / ") || beforeWire.join(" / ")}` : "エラーなし（通過）"}`);
  console.log(`    JSON変換後（Independent Playerの提出経路） ${afterWire.length > 0 ? `拒否: ${afterWire.filter((e) => e.includes(expectWord)).join(" / ") || afterWire.join(" / ")}` : "エラーなし（通過）← 検証漏れ"}`);
}

console.log("# INT-1 最終監査: JSON送信時の空欄検証漏れの再現");
console.log("# 対象は validateDecisionDraftNumbers 内で `!== null` により検証を飛ばしている4項目。");
console.log("# 『JSON変換後』が『エラーなし（通過）』なら検証漏れ。");

show(
  "人員配置の増員／減員を空欄（workerAssignments[].regularHeadcountChange）",
  (d) => {
    (d.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange = BLANK;
  },
  "増員／減員"
);

show(
  "設備投資の申請額を空欄（capexDecision.newProjectProposals[].requestedBudgetUsd）",
  (d) => {
    const capex = d.capexDecision as Record<string, unknown>;
    capex.newProjectProposals = [{ projectType: "newFactoryConstruction", requestedBudgetUsd: BLANK }];
  },
  "申請額"
);

show(
  "設備投資の優先度を空欄（capexDecision.newProjectProposals[].priority）",
  (d) => {
    const capex = d.capexDecision as Record<string, unknown>;
    capex.newProjectProposals = [{ projectType: "newFactoryConstruction", priority: BLANK }];
  },
  "優先度"
);

show(
  "輸入発注のリードタイムを空欄（importOrders[].leadTimeTurns）",
  (d) => {
    (d.importOrders as Record<string, unknown>[])[0].leadTimeTurns = BLANK;
  },
  "リードタイム"
);

console.log("\n# 省略（キー自体が無い）は正当な意思決定なので、通過しなければならない。");
for (const [label, apply] of [
  ["増員／減員のキーを削除", (d: Record<string, unknown>) => { delete (d.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange; }],
  ["リードタイムのキーを削除（標準リードタイムを使う意思決定）", (d: Record<string, unknown>) => { delete (d.importOrders as Record<string, unknown>[])[0].leadTimeTurns; }],
  ["申請額なしの設備投資提案（標準予算を使う意思決定）", (d: Record<string, unknown>) => { (d.capexDecision as Record<string, unknown>).newProjectProposals = [{ projectType: "newFactoryConstruction" }]; }],
] as const) {
  const d = JSON.parse(JSON.stringify(baseDraft)) as Record<string, unknown>;
  apply(d);
  const wire = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  const errors = validateDecisionDraftNumbers(wire as never);
  console.log(`    ${label.padEnd(50)} ${errors.length === 0 ? "通過（正しい）" : `拒否: ${errors.join(" / ")} ← 省略を壊している`}`);
}

console.log("\n# 明示的な0と正当な減員（負の増減）は通過しなければならない。");
for (const [label, value] of [["明示的な0", 0], ["減員 -30（正当な負値）", -30]] as const) {
  const d = JSON.parse(JSON.stringify(baseDraft)) as Record<string, unknown>;
  (d.workerAssignments as Record<string, unknown>[])[0].regularHeadcountChange = value;
  const wire = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  const errors = validateDecisionDraftNumbers(wire as never);
  console.log(`    増員／減員 = ${String(label).padEnd(40)} ${errors.length === 0 ? "通過（正しい）" : `拒否: ${errors.join(" / ")} ← 正当な値を壊している`}`);
}
