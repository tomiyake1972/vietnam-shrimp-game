// ShrimpX V2 — INT-1 §2A: 商品別受注残の導線
//
// 【調査結果（修正前）】情報そのものは欠落していなかった。
//   ・市場×商品別の受注残テーブルは OpeningCompanyStatePanel（Decision→情報 画面）に既にあった。
//   ・ただし販売数量・生産数量を決める SALES / PRODUCTION 画面からは参照できず、
//     さらに既存テーブルには納期超過の分離が無かった。
//   → 導線の問題であり、集計は既存SSoTを再利用すれば足りる。
//
// 【このテストが固定する契約】
//   集計は aiManagementMeeting/backlogSemantics.ts の computeBacklogSemantics
//   （既存SSoT）だけを使う。画面側で再集計・再分類・しきい値判定をしない。
//   「受注残」と「完成品在庫」を別の量として扱う。
//   納期未到来（将来納期）を納期超過として扱わない。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab, advanceCompanyLabQuarter, generateAutoPolicyDecision } from "../../../lib/v2/companyLab";
import { computeBacklogSemantics } from "../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { toYearQuarter } from "../../../lib/v2/core/period";
import { unwrapUnit } from "../../../lib/v2/core/units";
import type { CompanyLabState } from "../../../lib/v2/companyLab/types";

const PLAYER = "BAL";

function runTurns(turns: number) {
  const { state: initial, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "int1-backlog", turns: turns + 2 });
  let state: CompanyLabState = initial;
  for (let i = 0; i < turns; i += 1) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions = Object.fromEntries(
      fixtures.map((f) => [f.companyId, generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)])
    );
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }
  const fixture = fixtures.find((f) => f.companyId === PLAYER)!;
  return { state, fixtures, fixture, ownState: buildCompanyOwnState(state, fixture) };
}

test("INT1-BL-1: 商品別受注残が既存SSoT（computeBacklogSemantics）から得られ、HOSO/PD/VAPに分解される", () => {
  const { state, ownState } = runTurns(3);
  const yq = toYearQuarter(state.currentPeriod);
  const backlog = computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);

  assert.ok(backlog.totalTons > 0, "受注残が0のためこのテストが空振りしている（前提が崩れた）");
  assert.ok(backlog.byProduct.length > 0, "商品別の内訳が空");
  for (const p of backlog.byProduct) {
    assert.ok(["hoso", "pd", "vap"].includes(p.product), `未知の商品区分: ${p.product}`);
    // 3区分の合計が商品合計と一致する（画面側で別計算しないことの根拠）。
    assert.ok(
      Math.abs(p.totalTons - (p.overdueTons + p.dueThisTurnTons + p.healthyForwardTons)) < 1e-6,
      `${p.product}: 納期区分の合計が総量と一致しない`
    );
    assert.ok(p.overdueTons >= 0 && p.dueThisTurnTons >= 0 && p.healthyForwardTons >= 0, `${p.product}: 負の数量`);
  }
  // 商品別の総和が会社合計と一致する。
  const sum = backlog.byProduct.reduce((s, p) => s + p.totalTons, 0);
  assert.ok(Math.abs(sum - backlog.totalTons) < 1e-6, "商品別の総和が会社合計と一致しない");
});

test("INT1-BL-2: 将来納期だけの受注残を納期超過として扱わない（backlog != overdue）", () => {
  const { state, ownState } = runTurns(1);
  const yq = toYearQuarter(state.currentPeriod);
  const backlog = computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);
  for (const p of backlog.byProduct) {
    if (p.overdueTons === 0 && p.dueThisTurnTons === 0 && p.totalTons > 0) {
      assert.equal(p.status, "FUTURE_DUE", `${p.product}: 納期未到来のみなのに status が FUTURE_DUE でない（${p.status}）`);
    }
    if (p.overdueTons === 0) {
      assert.notEqual(p.status, "OVERDUE", `${p.product}: 納期超過0なのに OVERDUE と分類されている`);
    }
  }
});

test("INT1-BL-3: 受注残と完成品在庫は別の量として扱う（混同しない）", () => {
  const { state, ownState } = runTurns(3);
  const yq = toYearQuarter(state.currentPeriod);
  const backlog = computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);
  const finishedGoods = ownState.finishedGoodsLots.reduce((s, l) => s + (unwrapUnit(l.remainingQuantity) as number), 0);
  // 同一の値ではないこと（同じ値を使い回していれば、どちらかが誤り）。
  assert.notEqual(
    Math.round(backlog.totalTons),
    Math.round(finishedGoods),
    "受注残と完成品在庫が同じ値になっている（別の量として扱えていない疑い）"
  );
});

test("INT1-BL-4: 画面側は再集計せず、既存SSoTの値をそのまま表示する（実装の静的確認）", () => {
  const root = path.resolve(__dirname, "../../..", "..");
  const panelRaw = fs.readFileSync(path.join(root, "app/v2/company-lab/components/BacklogByProductPanel.tsx"), "utf8");
  /** コメント（根拠の記述）を除いた実コードだけを見る。コメントに語が出るのは問題ではない。 */
  const panelCode = panelRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // 契約配列から自前で集計・分類していないこと（集計は既存SSoTのみ）。
  for (const forbidden of ["dueDate", "periodIndex", "outstandingQuantity", "SalesContract"]) {
    assert.ok(!panelCode.includes(forbidden), `画面側で受注残を再集計している疑い: ${forbidden}`);
  }
  // 警告生成をしていないこと（在庫・納期で充足できる分を無視した警告を作らない）。
  for (const forbidden of ["不足しています", "超過しています", "注意してください"]) {
    assert.ok(!panelCode.includes(forbidden), `画面側で警告を作っている: ${forbidden}`);
  }
  // 両方の意思決定画面へ配線されていること。
  const sales = fs.readFileSync(path.join(root, "app/v2/company-lab/components/decisionStudio/SalesPlanningScreen.tsx"), "utf8");
  const production = fs.readFileSync(path.join(root, "app/v2/company-lab/components/decisionStudio/ProductionPlanningScreen.tsx"), "utf8");
  const studio = fs.readFileSync(path.join(root, "app/v2/company-lab/components/decisionStudio/DecisionStudio.tsx"), "utf8");
  assert.ok(sales.includes("BacklogByProductPanel"), "SALES画面へ配線されていない");
  assert.ok(production.includes("BacklogByProductPanel"), "PRODUCTION画面へ配線されていない");
  assert.ok(studio.includes("computeBacklogSemantics"), "DecisionStudio が既存SSoTを呼んでいない");
  assert.ok(studio.includes("backlogSemantics={backlogSemantics}"), "両画面へ同じ値を渡していない");
});
