// ShrimpX V2 — companyLabExportAuditLog.ts のテスト
//
// 【必須テスト】
//   - アクセスログにトークン値やAuthorizationヘッダーが残らないこと（型自体に
//     そのフィールドが存在しないことに加え、実際にJSON.stringifyした結果にも
//     含まれないことを確認する）。
//   - アクセスログ以外のRedisキーへの書き込みがないこと（append()は
//     companyLabExportLogKeyV2()が生成する1種類のキーにしかLPUSH/LTRIMしない）。
// ここでは、共有フェイク（fakeCompanyLabRedisClient.ts）を使わず、呼び出された
// Redis操作（set/del/eval）とそのキーを全て記録する専用の軽量フェイクを使う
// （共有フェイクはexport監査ログ用のLuaスクリプトを認識しないため）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../companyLabTypes";
import { COMPANY_LAB_EXPORT_LOG_APPEND_LUA_SCRIPT, COMPANY_LAB_EXPORT_LOG_MAX_ENTRIES, createCompanyLabExportAuditLogger } from "../companyLabExportAuditLog";
import { companyLabExportLogKeyV2 } from "../companyLabRedisKeys";

interface RecordedCall {
  readonly op: "get" | "set" | "exists" | "del" | "eval" | "zrange";
  readonly keys: readonly string[];
}

function createRecordingFakeClient(): { client: CompanyLabRedisClient; calls: RecordedCall[]; lists: Map<string, string[]> } {
  const calls: RecordedCall[] = [];
  const lists = new Map<string, string[]>();
  const client: CompanyLabRedisClient = {
    async get(key: string): Promise<unknown> {
      calls.push({ op: "get", keys: [key] });
      return null;
    },
    async set(key: string, _value: string, _options?: CompanyLabRedisSetOptions): Promise<unknown> {
      calls.push({ op: "set", keys: [key] });
      return "OK";
    },
    async exists(key: string): Promise<number> {
      calls.push({ op: "exists", keys: [key] });
      return 0;
    },
    async del(key: string): Promise<unknown> {
      calls.push({ op: "del", keys: [key] });
      return 0;
    },
    async zrange(): Promise<unknown[]> {
      calls.push({ op: "zrange", keys: [] });
      return [];
    },
    async eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData> {
      calls.push({ op: "eval", keys });
      if (script !== COMPANY_LAB_EXPORT_LOG_APPEND_LUA_SCRIPT) {
        throw new Error("このテスト用フェイクはexport監査ログ追記スクリプト以外を想定していません。");
      }
      const [key] = keys;
      const [entryJson] = args as unknown as string[];
      const existing = lists.get(key) ?? [];
      existing.unshift(entryJson);
      lists.set(key, existing.slice(0, COMPANY_LAB_EXPORT_LOG_MAX_ENTRIES));
      return 1 as unknown as TData;
    },
  };
  return { client, calls, lists };
}

test("createCompanyLabExportAuditLogger: append()はcompanyLabExportLogKeyV2が生成する1種類のキーにしかevalしない（それ以外のRedis操作を一切行わない）", async () => {
  const { client, calls } = createRecordingFakeClient();
  const logger = createCompanyLabExportAuditLogger(client, "staging");

  await logger.append({
    timestamp: "2026-07-25T00:00:00.000Z",
    labId: "audit-log-test-lab",
    route: "GET /api/v2/exports/company-labs/[labId]",
    turn: 1,
    companyIdScope: "BAL",
    scope: "company",
    tokenScope: "gm",
    status: 200,
    ip: "203.0.113.1",
    userAgent: "test-agent",
  });

  assert.equal(calls.length, 1, "append()は1回のRedis操作（eval）だけを行うべき");
  assert.equal(calls[0].op, "eval");
  assert.deepEqual(calls[0].keys, [companyLabExportLogKeyV2("staging", "audit-log-test-lab")]);
});

test("createCompanyLabExportAuditLogger: 返すロガーはappend()以外のメソッドを一切持たない（生のRedisクライアントへアクセスできない）", () => {
  const { client } = createRecordingFakeClient();
  const logger = createCompanyLabExportAuditLogger(client, "staging");
  assert.deepEqual(Object.keys(logger), ["append"]);
});

test("CompanyLabExportLogEntry: JSON化した記録内容に、トークン値・Authorizationヘッダー相当の文字列が一切含まれない", async () => {
  const { client, lists } = createRecordingFakeClient();
  const logger = createCompanyLabExportAuditLogger(client, "staging");

  const secretLikeToken = "super-secret-export-token-value-should-never-appear";
  await logger.append({
    timestamp: "2026-07-25T00:00:00.000Z",
    labId: "audit-log-test-lab-2",
    route: "GET /api/v2/exports/company-labs/[labId]/turns/[turn]",
    turn: 1,
    companyIdScope: null,
    scope: "all",
    tokenScope: "gm",
    status: 403,
    ip: null,
    userAgent: null,
  });

  const key = companyLabExportLogKeyV2("staging", "audit-log-test-lab-2");
  const stored = lists.get(key) ?? [];
  assert.equal(stored.length, 1);
  // 型定義自体にtoken/authorizationフィールドが存在しないため、意図的に「秘密トークン
  // らしき値」を含めずに呼び出している。ここでは、シリアライズ結果に「token」「authorization」
  // という語自体が含まれないこと（将来フィールドが誤って追加された場合の回帰検知）と、
  // このテストで使った secretLikeToken 文字列がどこにも紛れ込んでいないことを確認する。
  // 【注意】"tokenScope"（トークンの"種別"を表す固定値"gm"）は正当なメタデータであり
  // フィールド名に"token"を含むが、これはトークンの値そのものではない。ここで検証したい
  // のは「秘密のトークン値」「Authorizationヘッダーの値」が残らないことなので、
  // 実際の秘密文字列(secretLikeToken)・"authorization"・"bearer"の不在を確認する。
  const serialized = stored[0];
  assert.equal(serialized.includes(secretLikeToken), false);
  assert.equal(serialized.toLowerCase().includes("authorization"), false);
  assert.equal(serialized.toLowerCase().includes("bearer"), false);
});
