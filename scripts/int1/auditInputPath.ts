/**
 * 【INT-1 §1】入力 → 下書き → 送信 → 保存 → 実行 の各段で値が無言に変わらないかの監査。
 *
 * 懸念: UIの入力セルが不正値を0へ丸めた後では、提出前の数値検証が
 *       「0という正当な値」として通してしまい検出不能になるのではないか。
 * 検査: 各段で同じ論理値が保たれるか／どこで変換が起きるかを実測して列挙する。
 *
 * 【監査後修正を反映】入力セルは空欄・不正値を0へ丸めず NaN にする。
 * JSONで送ると NaN は null になるため、受け取った値の欄には null が出る。
 * いずれの経路でも提出前検証が項目名を示して拒否することを、この出力で確認する。
 */
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo, advanceCompanyLabQuarter, generateAutoPolicyDecision } from "../../app/lib/v2/companyLab";
import { generateStandardAiDecision } from "../../app/lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft, validateDecisionDraftNumbers } from "../../app/v2/company-lab/decisionDraft";
import { validateSalesForceHiringDecision } from "../../app/lib/v2/companyLab/salesForceHiring";
import { parseNumberInput } from "../../app/v2/company-lab/components/InputCells";
import type { CompanyDecisionInput } from "../../app/lib/v2/companyLab/types";

const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-input-audit", turns: 6 });
const fixture = fixtures.find((f) => f.companyId === "BAL")!;
const ownState = buildCompanyOwnState(state, fixture);
const publicInfo = buildPublicMarketInfo(state);
const ai = generateStandardAiDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
const baseDraft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);

/** UIの NumberCell が実際に使う関数をそのまま呼ぶ（監査側で複製しない）。 */
const uiNumberCellRounds = parseNumberInput;

function row(stage: string, value: unknown): void {
  console.log(`    ${stage.padEnd(34)} ${JSON.stringify(value)}`);
}

function audit(label: string, rawTyped: string, apply: (d: Record<string, unknown>, v: number | string) => void, read: (d: unknown) => unknown): void {
  console.log(`\n--- ${label}（利用者が打った文字列: ${JSON.stringify(rawTyped)}）`);

  // (1) UI入力セル経由（丸められる）
  const viaUi = JSON.parse(JSON.stringify(baseDraft)) as Record<string, unknown>;
  const rounded = uiNumberCellRounds(rawTyped);
  apply(viaUi, rounded);
  row("UIセルが下書きへ入れる値", rounded);
  row("提出前検証（UI経由）", validateDecisionDraftNumbers(viaUi as never));
  const builtUi = buildDecisionInputFromDraft(viaUi as never, fixture, state.currentPeriod);
  row("送信→保存される値（UI経由）", read(builtUi));

  // (2) UIを経由しない直接送信（APIへ生の値をPOSTした場合）
  const viaApi = JSON.parse(JSON.stringify(baseDraft)) as Record<string, unknown>;
  const rawValue: number | string = Number.isNaN(Number(rawTyped)) ? rawTyped : Number(rawTyped);
  apply(viaApi, rawValue);
  row("APIへ直接送られた生の値", rawValue);
  const apiErrors = validateDecisionDraftNumbers(viaApi as never);
  row("提出前検証（API直送）", apiErrors);
  if (apiErrors.length === 0) {
    const builtApi = buildDecisionInputFromDraft(viaApi as never, fixture, state.currentPeriod);
    row("送信→保存される値（API直送）", read(builtApi));
  } else {
    row("送信→保存される値（API直送）", "拒否（保存されない）");
  }
}

console.log("# INT-1 §4: 入力→下書き→送信→保存→実行 の各段で値が無言に変わらないかの監査");
console.log("# UIセルは空欄・不正値を0や範囲内へ丸めない（監査後修正）。NaNのまま下書きへ入る。");
console.log("# どちらの経路でも提出前検証（validateDecisionDraftNumbers）が項目名を示して拒否する。");
console.log("# engine直前の buildDecisionInputFromDraft のサニタイズは変更していない（二重防御）。");

const sp = (d: Record<string, unknown>) => (d.salesPlans as Record<string, unknown>[])[0];
const wa = (d: Record<string, unknown>) => (d.workerAssignments as Record<string, unknown>[])[0];
const readSalesPlan = (dec: unknown) => {
  const plans = (dec as { salesPlans: { market: string; product: string; desiredQuantity: unknown }[] }).salesPlans;
  const p = plans.find((x) => x.market === "CN" && x.product === "hoso");
  return p === undefined ? "（この行は保存されなかった＝消えた）" : p.desiredQuantity;
};
const readHeadcount = (dec: unknown) => (dec as { workerAssignments: { regularHeadcount: unknown }[] }).workerAssignments[0]?.regularHeadcount;

audit("販売計画の数量に負数", "-5000", (d, v) => { sp(d).desiredQuantity = v; }, readSalesPlan);
audit("販売計画の数量に文字列", "abc", (d, v) => { sp(d).desiredQuantity = v; }, readSalesPlan);
audit("販売計画の数量を空欄", "", (d, v) => { sp(d).desiredQuantity = v; }, readSalesPlan);
audit("販売計画の数量に明示的な0（正当な値）", "0", (d, v) => { sp(d).desiredQuantity = v; }, readSalesPlan);
audit("人員配置の常用人数に負数", "-100", (d, v) => { wa(d).regularHeadcount = v; }, readHeadcount);
audit("人員配置の増員／減員を空欄", "", (d, v) => { wa(d).regularHeadcountChange = v; }, readHeadcount);
audit("残業率に範囲外の99", "99", (d, v) => { wa(d).overtimeRate = v; }, readHeadcount);
audit("残業率を空欄", "", (d, v) => { wa(d).overtimeRate = v; }, readHeadcount);

// 営業人員の採用上限超過（数値としては正当なので、数値検証ではなく専用検証が効く）
console.log(`\n--- 営業人員の採用上限超過（数値としては正当な値）`);
const headcount = ownState.salesForceHiringState.headcount;
const over = { ...JSON.parse(JSON.stringify(baseDraft)), salesForceHireCount: 999 } as Record<string, unknown>;
row("UIセルが下書きへ入れる値", 999);
row("数値検証（範囲チェック）", validateDecisionDraftNumbers(over as never));
row("営業人員検証（engine共有）", validateSalesForceHiringDecision({ hireCount: 999, layoffCount: 0, currentActiveHeadcount: headcount }));
const builtOver = buildDecisionInputFromDraft(over as never, fixture, state.currentPeriod);
row("buildDecisionInputFromDraft後", (builtOver as { salesForceHireCount?: number }).salesForceHireCount);
let engineResult = "成功";
try {
  const decisions = Object.fromEntries(
    fixtures.map((f) => [f.companyId, f.companyId === "BAL" ? builtOver : generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1)])
  ) as Record<string, CompanyDecisionInput>;
  advanceCompanyLabQuarter(state, fixtures, decisions);
} catch (e) {
  engineResult = `拒否 ${(e as Error).name}`;
}
row("engine実行（検証を通さず到達した場合）", engineResult);
