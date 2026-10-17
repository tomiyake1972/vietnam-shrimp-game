// ShrimpX V2 — COMP-1: 保存リクエスト本文の圧縮、の検証
//
// 【この修正の範囲】GM Console の保存で、request body を gzip 圧縮して送り、
// サーバー側で展開する。保存形式（Redis上の正規キーに完全なJSONを置く）は不変。
// 差分追記・保存タイミングのまとめ・受講者提出経路の変更は含まない。
//
// 【このテスト群が守る因果】送り方を圧縮したことで次が起きてはいけない。
//   A. 展開後の内容が、圧縮しないで送ったときと変わる
//   B. 圧縮を知らないクライアント（CompressionStream が無い環境・旧版）からの
//      保存が通らなくなる
//   C. 壊れた本文・偽のヘッダが、中身の検証をすり抜けて保存へ進む

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { parseJsonBody } from "../../../../../api/v2/simulation-runs/_lib/context";
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
  isGzipBodyEncoding,
} from "../persistence/partBodyEncoding";

const URL_ = "https://example.test/api/v2/simulation-runs";

/** 実クライアントと同じ形の保存本文（パート1つぶん）。 */
function samplePartBody() {
  return {
    simulationRunId: "comp1-run",
    revision: 7,
    part: "dataset",
    value: { schemaVersion: 3, turns: [1, 2, 3], rows: Array.from({ length: 50 }, (_, i) => ({ turn: i, companyId: "BAL", revenue: i * 1000 })) },
    expectedBaseRevision: 6,
    writeToken: "token-1",
  };
}

function gzipRequest(body: unknown): NextRequest {
  const compressed = gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
  return new NextRequest(URL_, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", [SIMULATION_RUN_BODY_ENCODING_HEADER]: SIMULATION_RUN_BODY_ENCODING_GZIP },
    body: compressed,
  });
}

function plainRequest(body: unknown): NextRequest {
  return new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("COMP-1: gzip で送った本文は、圧縮せずに送ったときと同じオブジェクトとして読まれる", async () => {
  const body = samplePartBody();
  const fromGzip = await parseJsonBody(gzipRequest(body));
  const fromPlain = await parseJsonBody(plainRequest(body));
  assert.deepEqual(fromGzip, body, "gzip 本文の展開結果が元の本文と一致しない");
  assert.deepEqual(fromGzip, fromPlain, "gzip 経路と素のJSON経路で結果が違う");
});

test("COMP-2: 後方互換 — ヘッダが無ければ従来どおり素の JSON として読む", async () => {
  const body = { manifestOnly: true, persistenceRevision: 9 };
  assert.deepEqual(await parseJsonBody(plainRequest(body)), body);
});

test("COMP-3: ヘッダが gzip なのに本文が gzip でなければ undefined を返す（素通ししない）", async () => {
  const broken = new NextRequest(URL_, {
    method: "POST",
    headers: { [SIMULATION_RUN_BODY_ENCODING_HEADER]: SIMULATION_RUN_BODY_ENCODING_GZIP },
    body: Buffer.from("これはgzipではない", "utf8"),
  });
  assert.equal(await parseJsonBody(broken), undefined, "壊れた gzip 本文が undefined 以外になった");
});

test("COMP-4: gzip 以外のヘッダ値は素の JSON として扱う", async () => {
  const body = { simulationRunId: "comp1-run", revision: 1 };
  const labelled = new NextRequest(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", [SIMULATION_RUN_BODY_ENCODING_HEADER]: "br" },
    body: JSON.stringify(body),
  });
  assert.deepEqual(await parseJsonBody(labelled), body, "未知のエンコーディング指定で素のJSONが読めなくなった");
});

test("COMP-5: ヘッダ値の判定は前後の空白・大文字小文字を吸収し、それ以外は false", () => {
  assert.equal(isGzipBodyEncoding("gzip"), true);
  assert.equal(isGzipBodyEncoding(" GZIP "), true);
  assert.equal(isGzipBodyEncoding("Gzip"), true);
  assert.equal(isGzipBodyEncoding("br"), false);
  assert.equal(isGzipBodyEncoding(""), false);
  assert.equal(isGzipBodyEncoding(null), false);
  assert.equal(isGzipBodyEncoding(undefined), false);
  assert.equal(isGzipBodyEncoding("gzip, br"), false, "複数指定は受け付けない（曖昧な解釈をしない）");
});

test("COMP-6: 大きな本文でも往復で内容が変わらない", async () => {
  const big = {
    simulationRunId: "comp1-run",
    revision: 32,
    part: "dataset",
    value: {
      schemaVersion: 3,
      turns: Array.from({ length: 32 }, (_, i) => i + 1),
      rows: Array.from({ length: 20000 }, (_, i) => ({ turn: (i % 32) + 1, companyId: ["BAL", "MASS", "JPQ", "VAP", "CONSV"][i % 5], value: i * 1.5 })),
    },
    expectedBaseRevision: 31,
    writeToken: "token-big",
  };
  assert.deepEqual(await parseJsonBody(gzipRequest(big)), big);
});
