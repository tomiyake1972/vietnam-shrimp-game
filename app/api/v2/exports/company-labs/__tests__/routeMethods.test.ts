// ShrimpX V2 — 読み取り専用エクスポートAPI route.ts メソッド境界テスト
//
// 【必須テスト(4)】POST/PUT/PATCH/DELETEでデータの取得・変更ができないこと。
// 各route.tsはGETハンドラーしか定義していない（実装コード自体が存在しない）ため、
// Next.jsのルーティング機構が自動的に405 Method Not Allowedを返す。本テストは、
// HTTPサーバーを起動せず、route.tsモジュールを直接importして「GET以外のHTTPメソッド
// 名のexportが一切存在しない」ことを直接確認する（実装コードの不在を型・モジュール
// レベルで保証する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as labIndexRoute from "../[labId]/route";
import * as allCompaniesTurnRoute from "../[labId]/turns/[turn]/route";
import * as companyTurnRoute from "../[labId]/turns/[turn]/companies/[companyId]/route";
import * as marketTurnRoute from "../[labId]/turns/[turn]/market/route";

const HTTP_METHOD_EXPORT_NAMES = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

const ROUTE_MODULES: readonly { readonly name: string; readonly mod: Record<string, unknown> }[] = [
  { name: "company-labs/[labId]/route.ts", mod: labIndexRoute },
  { name: "company-labs/[labId]/turns/[turn]/route.ts", mod: allCompaniesTurnRoute },
  { name: "company-labs/[labId]/turns/[turn]/companies/[companyId]/route.ts", mod: companyTurnRoute },
  { name: "company-labs/[labId]/turns/[turn]/market/route.ts", mod: marketTurnRoute },
];

for (const { name, mod } of ROUTE_MODULES) {
  test(`${name}: GETだけがexportされており、POST/PUT/PATCH/DELETE等の書き込み系メソッドは一切exportされていない`, () => {
    assert.equal(typeof mod.GET, "function", `${name} はGETをexportしているべき`);
    for (const methodName of HTTP_METHOD_EXPORT_NAMES) {
      assert.equal(mod[methodName], undefined, `${name} は ${methodName} をexportしてはならない`);
    }
  });
}
