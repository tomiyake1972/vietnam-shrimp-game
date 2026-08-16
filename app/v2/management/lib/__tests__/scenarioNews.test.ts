// Management Console のシナリオNews取得のテスト
//
// 検証の主眼:
//  1. 未来の記事を絶対に出さない
//  2. 開発用の内部メタデータが公開データに含まれない
//  3. News を持たないシナリオ・存在しないシナリオで壊れない
//  4. Dynamic Scenario 1 の T6（疾病予兆）で複数記事が読める

import test from "node:test";
import assert from "node:assert/strict";

import { resolveNewsTurn, selectScenarioNewsForTurn } from "../scenarioNews";
import { DYNAMIC_SCENARIO_1 } from "../../../../lib/v2/scenario/definitions/dynamicScenario1";
import { BASELINE_SCENARIO } from "../../../../lib/v2/scenario/definitions/baseline";

const DS1 = DYNAMIC_SCENARIO_1.scenarioId;

// ---------------------------------------------------------------------
// 対象ターンの決定
// ---------------------------------------------------------------------

test("resolveNewsTurn: 実行中セッションがあればシナリオの現在ターンを使う", () => {
  assert.equal(resolveNewsTurn({ scenarioCurrentTurn: 6, completedTurns: 5 }), 6);
});

test("resolveNewsTurn: セッションが無ければ最後に完了したターンを使う", () => {
  assert.equal(resolveNewsTurn({ scenarioCurrentTurn: null, completedTurns: 12 }), 12);
});

test("resolveNewsTurn: 1ターンも完了していなければ turn 1 を返す", () => {
  assert.equal(resolveNewsTurn({ scenarioCurrentTurn: null, completedTurns: 0 }), 1);
});

// ---------------------------------------------------------------------
// 未来の記事を出さない
// ---------------------------------------------------------------------

test("未来のNewsを決して返さない（全32ターン）", () => {
  for (let turn = 1; turn <= DYNAMIC_SCENARIO_1.durationTurns; turn++) {
    const feed = selectScenarioNewsForTurn(DS1, turn);
    for (const r of feed.releases) {
      assert.ok(r.availableFromTurn <= turn, `turn ${turn} で未来の記事 ${r.informationId}（T${r.availableFromTurn}）が返った`);
    }
  }
});

test("ターンが進むほど読める記事が増える（減らない）", () => {
  let previous = 0;
  for (let turn = 1; turn <= DYNAMIC_SCENARIO_1.durationTurns; turn++) {
    const count = selectScenarioNewsForTurn(DS1, turn).releases.length;
    assert.ok(count >= previous, `turn ${turn} で記事数が減った（${previous} → ${count}）`);
    previous = count;
  }
  assert.ok(previous > 0);
});

test("durationTurns を超えるターンを渡しても最終ターンへ丸められる", () => {
  const feed = selectScenarioNewsForTurn(DS1, 999);
  assert.equal(feed.turn, DYNAMIC_SCENARIO_1.durationTurns);
  for (const r of feed.releases) assert.ok(r.availableFromTurn <= DYNAMIC_SCENARIO_1.durationTurns);
});

test("0以下のターンを渡しても turn 1 として扱う", () => {
  assert.equal(selectScenarioNewsForTurn(DS1, 0).turn, 1);
  assert.equal(selectScenarioNewsForTurn(DS1, -5).turn, 1);
});

// ---------------------------------------------------------------------
// T6（疾病予兆）の確認
// ---------------------------------------------------------------------

test("T6 で疾病予兆を含む複数の記事が読める", () => {
  const feed = selectScenarioNewsForTurn(DS1, 6);
  assert.equal(feed.scenarioNotFound, false);

  const t6 = feed.releases.filter((r) => r.availableFromTurn === 6);
  assert.ok(t6.length >= 3, `T6 の記事が少なすぎる: ${t6.length}件`);

  const diseaseRumor = t6.find((r) => r.informationId === "ds1-t6-disease-rumor");
  assert.ok(diseaseRumor, "疾病予兆の記事が含まれていない");
  assert.equal(diseaseRumor.isRumor, true, "疾病予兆が噂として扱われていない");
  assert.ok(diseaseRumor.body !== undefined && diseaseRumor.body.length > 100, "本文が読める分量で入っていない");
  // 予兆記事は「まだ国内が安い」と読めることが判断材料として重要。
  assert.ok(diseaseRumor.body.includes("輸入原料より安い"), "現時点の相場状況が本文に含まれていない");

  // T7 のショック確報は T6 では絶対に読めない。
  assert.ok(!feed.releases.some((r) => r.informationId === "ds1-t7-shock"), "T6 で T7 の確報が漏れている");
});

test("T7 になって初めてショックの確報が読める", () => {
  const t6 = selectScenarioNewsForTurn(DS1, 6);
  const t7 = selectScenarioNewsForTurn(DS1, 7);
  assert.ok(!t6.releases.some((r) => r.informationId === "ds1-t7-shock"));
  assert.ok(t7.releases.some((r) => r.informationId === "ds1-t7-shock"));
});

// ---------------------------------------------------------------------
// 内部メタデータの非公開
// ---------------------------------------------------------------------

test("開発用の内部メタデータが公開データに含まれない", () => {
  const feed = selectScenarioNewsForTurn(DS1, DYNAMIC_SCENARIO_1.durationTurns);
  assert.ok(feed.releases.length > 0);
  for (const r of feed.releases) {
    const keys = Object.keys(r);
    for (const leaked of [
      "signalClass",
      "scale",
      "market",
      "product",
      "origin",
      "scenarioRelevance",
      "futureEffectTurn",
      "hiddenImportance",
      "internalModifier",
    ]) {
      assert.ok(!keys.includes(leaked), `${r.informationId}: ${leaked} が公開データに含まれている`);
    }
    // ゲーム終了後の真実は情報公開エンジンが除去する。
    assert.equal(r.postGameTruth, undefined, `${r.informationId}: postGameTruth が残っている`);
    // GM 専用情報は standard レベルでは返らない。
    assert.notEqual(r.informationLevel, "gm", `${r.informationId}: GM専用情報が混ざっている`);
  }
});

// ---------------------------------------------------------------------
// News を持たない／存在しないシナリオ
// ---------------------------------------------------------------------

test("既存シナリオでも壊れない（baseline は自分のNewsを返す）", () => {
  const feed = selectScenarioNewsForTurn(BASELINE_SCENARIO.scenarioId, 12);
  assert.equal(feed.scenarioNotFound, false);
  for (const r of feed.releases) {
    assert.ok(r.availableFromTurn <= 12);
    assert.notEqual(r.informationLevel, "gm");
  }
});

test("短縮形のシナリオIDでも解決できる", () => {
  const feed = selectScenarioNewsForTurn("baseline", 12);
  assert.equal(feed.scenarioNotFound, false);
});

test("存在しないシナリオIDでは例外を投げず scenarioNotFound を返す", () => {
  const feed = selectScenarioNewsForTurn("no-such-scenario", 5);
  assert.equal(feed.scenarioNotFound, true);
  assert.deepEqual(feed.releases, []);
});

// ---------------------------------------------------------------------
// 並び順
// ---------------------------------------------------------------------

test("新しい記事が先頭に来る（同一ターンでは確報が先）", () => {
  const feed = selectScenarioNewsForTurn(DS1, 8);
  for (let i = 1; i < feed.releases.length; i++) {
    const prev = feed.releases[i - 1];
    const cur = feed.releases[i];
    assert.ok(prev.availableFromTurn >= cur.availableFromTurn, "ターンの降順になっていない");
    if (prev.availableFromTurn === cur.availableFromTurn) {
      assert.ok(Number(prev.isRumor) <= Number(cur.isRumor), "同一ターンで確報より噂が先に来ている");
    }
  }
});
