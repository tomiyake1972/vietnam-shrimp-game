// ShrimpX V2 — 管理者画面「分析データをエクスポート」ダウンロードroute メソッド境界テスト
//
// 【必須テスト】ゲームデータの作成・更新・削除・初期化・復元機能を持たせない。
// route.tsはGETハンドラーしか定義していない（実装コード自体が存在しない）ため、
// Next.jsのルーティング機構が自動的に405 Method Not Allowedを返す。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as exportDownloadRoute from "../[labId]/[turn]/route";

const HTTP_METHOD_EXPORT_NAMES = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

test("admin/export-download/[labId]/[turn]/route.ts: GETだけがexportされており、書き込み系メソッドは一切exportされていない", () => {
  const mod = exportDownloadRoute as unknown as Record<string, unknown>;
  assert.equal(typeof mod.GET, "function", "GETをexportしているべき");
  for (const methodName of HTTP_METHOD_EXPORT_NAMES) {
    assert.equal(mod[methodName], undefined, `${methodName} をexportしてはならない`);
  }
});
