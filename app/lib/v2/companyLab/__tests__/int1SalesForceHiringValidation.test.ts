// ShrimpX V2 — INT-1 §3: 営業人員の無効入力で進行が止まる経路を閉じる
//
// 【再現した事象（修正前・実測）】baseline / BAL / 現員60人・上限18人
//   採用19人を提出 → 受理され confirmedPlayerDecisions へ保存される
//   GM が Turn を進める → runner.ts が CompanyLabError で停止
//     「営業人員の採用は1四半期あたり18人までです…入力値は19人でした」
//   PLAYER が同じTurnへ正しい値で再提出 → DUPLICATE_SUBMIT で拒否
//   ＝そのTurnが進められず、PLAYER 自身では直せない。
//
// 【修正】提出・確定の前に validateSalesForceHiringDecision で拒否する。
// 判定は runner.ts と同じ computeMaxSalesHiresPerQuarter を使う共有関数であり、
// UI へ上限式を別実装していない。engine 側の throw は変更していない。
//
// 【このテストの主眼】検証関数と engine の判定が一致すること（乖離の防止）。
// 「上限はこの値のはず」とテスト側で数値を書かず、engine を実際に動かして
// throw する/しないを観測し、検証関数の結果と突き合わせる。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  generateAutoPolicyDecision,
  initializeCompanyLab,
} from "..";
import { computeMaxSalesHiresPerQuarter, validateSalesForceHiringDecision } from "../salesForceHiring";
import type { CompanyDecisionInput } from "../types";

const PLAYER = "BAL";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-hire-validation", turns: 6 });
  const publicInfo = buildPublicMarketInfo(state);
  const base = Object.fromEntries(
    fixtures.map((f) => [f.companyId, generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)])
  ) as Record<string, CompanyDecisionInput>;
  const fixture = fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(state, fixture);
  return { state, fixtures, base, ownState };
}

/** engine が実際に拒否するか（throwするか）を観測する。 */
function engineRejects(hireCount: number, layoffCount: number): boolean {
  const { state, fixtures, base } = setup();
  const decisions: Record<string, CompanyDecisionInput> = {
    ...base,
    [PLAYER]: { ...base[PLAYER], salesForceHireCount: hireCount, salesForceLayoffCount: layoffCount },
  };
  try {
    advanceCompanyLabQuarter(state, fixtures, decisions);
    return false;
  } catch {
    return true;
  }
}

test("INT1-SFH-1: 検証関数の判定が engine の判定と一致する（採用人数を上限の前後で走査）", () => {
  const { ownState } = setup();
  const headcount = ownState.salesForceHiringState.headcount;
  const limit = computeMaxSalesHiresPerQuarter(headcount);
  assert.ok(limit > 1, `上限が小さすぎて走査にならない（limit=${limit}）`);

  for (const hire of [0, 1, limit - 1, limit, limit + 1, limit + 5, limit * 10]) {
    const validatorRejects = validateSalesForceHiringDecision({ hireCount: hire, layoffCount: 0, currentActiveHeadcount: headcount }).length > 0;
    const engine = engineRejects(hire, 0);
    assert.equal(
      validatorRejects,
      engine,
      `採用${hire}人（現員${headcount}人・上限${limit}人）で判定が食い違っている: 検証関数=${validatorRejects} engine=${engine}`
    );
  }
});

test("INT1-SFH-2: 採用と減員の同時入力も engine と同じく拒否する", () => {
  const { ownState } = setup();
  const headcount = ownState.salesForceHiringState.headcount;
  for (const [hire, layoff] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [3, 2],
  ] as const) {
    const validatorRejects = validateSalesForceHiringDecision({ hireCount: hire, layoffCount: layoff, currentActiveHeadcount: headcount }).length > 0;
    const engine = engineRejects(hire, layoff);
    assert.equal(validatorRejects, engine, `採用${hire}/減員${layoff}で判定が食い違っている: 検証関数=${validatorRejects} engine=${engine}`);
  }
});

test("INT1-SFH-3: 上限式を二重に持たない（検証関数もUIも engine と同じ関数を使う）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(__dirname, "../../../../..");
  const validatorSrc = fs.readFileSync(path.join(root, "app/lib/v2/companyLab/salesForceHiring.ts"), "utf8");
  // 検証関数は computeMaxSalesHiresPerQuarter を呼ぶ（独自の係数計算をしない）。
  const fnBody = validatorSrc.slice(validatorSrc.indexOf("export function validateSalesForceHiringDecision"));
  assert.ok(fnBody.includes("computeMaxSalesHiresPerQuarter("), "検証関数が共有の上限関数を使っていない");

  for (const rel of [
    "app/v2/company-lab/decisionStudioViewModel.ts",
    "app/lib/v2/player/submit.ts",
    "app/v2/management/player/PlayerWorkspace.tsx",
  ]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // 0.3 や 3 を直接書いた上限式をUI/サーバ側に持っていないこと。
    assert.ok(!/Math\.ceil\([^)]*0\.3/.test(code), `${rel}: 上限式を別実装している疑い`);
    assert.ok(
      code.includes("computeMaxSalesHiresPerQuarter") || code.includes("validateSalesForceHiringDecision"),
      `${rel}: 共有関数を経由していない`
    );
  }
});

test("INT1-SFH-4: 上限内の入力は拒否しない（正常系を壊していない）", () => {
  const { ownState } = setup();
  const headcount = ownState.salesForceHiringState.headcount;
  const limit = computeMaxSalesHiresPerQuarter(headcount);
  assert.deepEqual(validateSalesForceHiringDecision({ hireCount: limit, layoffCount: 0, currentActiveHeadcount: headcount }), []);
  assert.deepEqual(validateSalesForceHiringDecision({ hireCount: 0, layoffCount: 0, currentActiveHeadcount: headcount }), []);
  assert.deepEqual(validateSalesForceHiringDecision({ hireCount: undefined, layoffCount: undefined, currentActiveHeadcount: headcount }), []);
  // 減員には上限を掛けない（既存ルール）。
  assert.deepEqual(validateSalesForceHiringDecision({ hireCount: 0, layoffCount: headcount, currentActiveHeadcount: headcount }), []);
});
