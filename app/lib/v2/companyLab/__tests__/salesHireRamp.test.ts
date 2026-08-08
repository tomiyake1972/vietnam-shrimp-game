// ShrimpX V2 — 営業組織の増員速度制約（ゲーム共通ルール）の回帰テスト
//
// 【固定したいこと】
//   ・上限式 max(3, ceil(現在の稼働営業人員 × 30%)) が指示どおりの値を返すこと
//   ・減員には上限を掛けないこと
//   ・人間プレイヤーとStandard AIが同一の関数を使うこと（Single Source of Truth）
//   ・旧「静的な会社規模 × 50%」ガバナーが二重適用されないこと

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  MIN_SALES_HIRES_PER_QUARTER,
  SALES_HIRE_RAMP_RATIO,
  applySalesHireRampLimit,
  computeEffectiveSalesForceLayoffCount,
  computeMaxSalesHiresPerQuarter,
} from "../salesForceHiring";

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(__dirname, "..", ...segments), "utf8");
}

// --- H1〜H6: 指示に明記された6例をそのまま固定する ---
test("【H1-H6】増員上限 = max(3, ceil(現在人員 × 30%))", () => {
  const cases: readonly (readonly [number, number])[] = [
    [5, 3],
    [10, 3],
    [20, 6],
    [30, 9],
    [40, 12],
    [74, 23],
  ];
  for (const [headcount, expected] of cases) {
    assert.equal(computeMaxSalesHiresPerQuarter(headcount), expected, `${headcount}人 → 最大+${expected}人`);
  }
});

test("【定数】比率30%・下限3人が定義として固定されている", () => {
  assert.equal(SALES_HIRE_RAMP_RATIO, 0.3);
  assert.equal(MIN_SALES_HIRES_PER_QUARTER, 3);
});

test("【端数】ceilで切り上げる（切り下げて成長を余計に縛らない）", () => {
  // 19 × 0.3 = 5.7 → ceil 6。roundなら6、floorなら5になる。ceilであることを固定する。
  assert.equal(computeMaxSalesHiresPerQuarter(19), 6);
  // 11 × 0.3 = 3.3 → ceil 4（floorなら3で下限と区別できない）。
  assert.equal(computeMaxSalesHiresPerQuarter(11), 4);
});

test("【異常入力】負・小数・NaN・0でも下限3人を返し、例外を投げない", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(computeMaxSalesHiresPerQuarter(bad), MIN_SALES_HIRES_PER_QUARTER, `入力=${bad}`);
  }
});

test("【Economic → Ramp → Actual】希望採用数を上限で頭打ちし、超過分は繰り越しとして返す", () => {
  // 経済合理性が18人を希望、現在30人 → 上限9人 → 実際9人・繰り越し9人。
  const r = applySalesHireRampLimit(30, 18);
  assert.deepEqual(r, { actualHireCount: 9, limit: 9, deferredCount: 9 });

  // 希望が上限未満ならそのまま通る（上限は上限であって目標ではない）。
  const small = applySalesHireRampLimit(30, 4);
  assert.deepEqual(small, { actualHireCount: 4, limit: 9, deferredCount: 0 });
});

// --- H7: 減員に30%制限は無い ---
test("【H7】減員には30%上限が無く、現在人員まで任意に減らせる", () => {
  // 40人から40人全員の減員を要求しても、上限12人へは丸められない。
  assert.equal(computeEffectiveSalesForceLayoffCount(40, 40), 40);
  assert.equal(computeEffectiveSalesForceLayoffCount(40, 30), 30);
  // 現在人員を超える分だけは頭打ちされる（0人未満にならない、という既存ルール）。
  assert.equal(computeEffectiveSalesForceLayoffCount(40, 100), 40);
});

// --- H8/H9: 同一の制約をPlayerとStandard AIが使う ---
test("【H8】人間プレイヤーの入力にも同じ関数が適用される（runner.ts）", () => {
  const runner = readRepoFile("runner.ts");
  assert.ok(runner.includes("computeMaxSalesHiresPerQuarter"), "runnerが共通関数を使っていること");
  assert.ok(
    /営業人員の採用は1四半期あたり\$\{hireLimit\}人までです/.test(runner),
    "上限超過をプレイヤーへ説明つきで拒否すること"
  );
});

test("【H9】Standard AIも同じ共通関数を使い、式を再実装していない", () => {
  const ai = readRepoFile("standardAi", "decision", "salesForceHiring.ts");
  assert.ok(ai.includes("applySalesHireRampLimit"), "Standard AIが共通関数を使っていること");
  // Standard AI側に比率や下限を直書きしていないこと（Single Source of Truth）。
  assert.ok(!/0\.3\s*\)/.test(ai.replace(/\/\*[\s\S]*?\*\//g, "")), "比率をStandard AI側へ直書きしていないこと");
});

// --- H10: 旧9人ガバナーが二重適用されない ---
test("【H10】旧「静的な会社規模 × 50%」ガバナーが残っていない（二重制限しない）", () => {
  const ai = readRepoFile("standardAi", "decision", "salesForceHiring.ts");
  assert.ok(!ai.includes("quarterlyGovernorCap"), "旧ガバナー関数が消えていること");
  assert.ok(!ai.includes("MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR"), "旧定数が消えていること");
  assert.ok(!ai.includes("MAX_HIRE_PER_QUARTER_RELATIVE_RATIO"), "旧定数が消えていること");
  assert.ok(!ai.includes("deferredByQuarterlyGovernor"), "旧フラグ名が消えていること");
  // 旧表現「静的な会社規模ガバナー」をユーザー向け文言に残さない（指示E）。
  assert.ok(!/静的な会社規模基準の\$\{governorCap\}人/.test(ai), "旧ガバナー表現が消えていること");
});

// --- E: 採用判断のdiagnostics ---
test("【E】採用診断に economicallyDesired / organizationalLimit / actual / deferred が記録される", () => {
  const ai = readRepoFile("standardAi", "decision", "salesForceHiring.ts");
  for (const key of [
    "economicallyDesiredHireCount",
    "organizationalHireLimit",
    "actualHireCount",
    "deferredByOrganizationalRamp",
  ]) {
    assert.ok(ai.includes(key), `${key} が診断へ記録されること`);
  }
});

// --- B4: Player UIが同じ制約を、意味とともに表示する ---
test("【H8b】UIが共通関数から上限を出し、理由つきで表示する", () => {
  const editor = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "v2", "company-lab", "components", "DecisionEditor.tsx"),
    "utf8"
  );
  assert.ok(editor.includes("computeMaxSalesHiresPerQuarter"), "UIも共通関数を使うこと（式を再実装しない）");
  assert.ok(editor.includes("営業組織の受入能力上、今期の増員上限は"), "上限を自然な日本語で説明すること");
  assert.ok(editor.includes('data-testid="sales-hire-ramp-limit"'), "上限表示にtestidがあること");
  assert.ok(editor.includes('data-testid="sales-hire-ramp-exceeded"'), "超過警告にtestidがあること");
  // 「max +23」だけの機械的な表示になっていないこと。
  assert.ok(editor.includes("追いつきません"), "なぜ上限があるのかを書くこと（数値だけの表示にしない）");
});
