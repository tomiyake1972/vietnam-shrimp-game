// ShrimpX V2 — 会社ラボ API turnId導出テスト（Phase 8C-3A §6.5）

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTurnId, resolveInFlightTurnId, resolveNewDraftTurnId } from "../turnId";

test("deriveTurnId: 同じcurrentTurnからは常に同じturnIdが導出される（冪等性の基盤）", () => {
  assert.equal(deriveTurnId(1), deriveTurnId(1));
  assert.equal(deriveTurnId(5), "turn-5");
});

test("deriveTurnId: 異なるcurrentTurnからは異なるturnIdが導出される", () => {
  assert.notEqual(deriveTurnId(1), deriveTurnId(2));
});

test("deriveTurnId: 1未満・非整数は拒否する", () => {
  assert.throws(() => deriveTurnId(0));
  assert.throws(() => deriveTurnId(-1));
  assert.throws(() => deriveTurnId(1.5));
});

test("resolveNewDraftTurnId: 既存draftがあればそのturnIdをそのまま使う（currentTurnとは無関係）", () => {
  assert.equal(resolveNewDraftTurnId({ currentTurn: 3, existingDraftTurnId: "turn-1" }), "turn-1");
});

test("resolveNewDraftTurnId: 既存draftが無ければcurrentTurnから新規導出する", () => {
  assert.equal(resolveNewDraftTurnId({ currentTurn: 3, existingDraftTurnId: null }), "turn-3");
});

test("resolveInFlightTurnId: draftが存在すればそのturnIdを最優先する", () => {
  assert.equal(
    resolveInFlightTurnId({ currentTurn: 2, draftTurnId: "turn-1", lastProcessedTurnId: "turn-1" }),
    "turn-1"
  );
});

test("resolveInFlightTurnId: draft不在・lastProcessedTurnId存在時はlastProcessedTurnIdを使う（応答消失後の再送を正しく冪等判定へ導く、Phase 8C-3A実装中に発見した設計不備の修正の核心）", () => {
  // processQuarterのコミット成功後、draftは削除されcurrentTurnは次へ進む。
  // 応答が失われクライアントが再送すると、素朴にcurrentTurnから再導出すると
  // 別turn（turn-3、まだdraftすら無い）を誤って指してしまう。
  // lastProcessedTurnIdを優先することで、正しくturn-2（直近確定turn）を指す。
  assert.equal(
    resolveInFlightTurnId({ currentTurn: 3, draftTurnId: null, lastProcessedTurnId: "turn-2" }),
    "turn-2"
  );
});

test("resolveInFlightTurnId: draft・lastProcessedTurnIdどちらも無ければcurrentTurnから新規導出する（初回のturn 1のみ想定）", () => {
  assert.equal(resolveInFlightTurnId({ currentTurn: 1, draftTurnId: null, lastProcessedTurnId: null }), "turn-1");
});
