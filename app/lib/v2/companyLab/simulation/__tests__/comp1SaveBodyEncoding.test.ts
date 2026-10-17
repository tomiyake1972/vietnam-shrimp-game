// ShrimpX V2 — COMP-1 / COMP-2: 保存リクエスト本文の圧縮と、サーバー側のサイズ上限
//
// 【この修正の範囲】GM Console の保存で request body を gzip 圧縮して送り（COMP-1）、
// サーバー側で展開後サイズの上限を強制する（COMP-2）。保存形式（Redis上の正規キーに
// 完全なJSONを置く）は不変。REUSE-1・CAS・PLAYER提出経路は触っていない。
//
// 【このテスト群が守る因果】
//   A. 展開後の内容が、圧縮しないで送ったときと変わってはいけない
//   B. 圧縮を知らないクライアントからの保存が通らなくなってはいけない
//   C. 圧縮本文が小さくても、展開でメモリを好きなだけ使わせてはいけない
//      （実測で 101,941 B の gzip が 104,857,600 B へ展開できる＝1029:1）
//   D. 拒否した保存が、既存の正本を1バイトでも変えてはいけない
//   E. 拒否を「保存成功」として返してはいけない

// 【環境変数は import より先に設定する】route 経由のテスト（COMP-10）で、
// プロセス内 in-memory repository と staging 認証を使うため。
process.env.V2_API_E2E_IN_MEMORY = "1";
process.env.STAGING_ADMIN_TOKEN = "comp2-test-token";

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { parseJsonBody } from "../../../../../api/v2/simulation-runs/_lib/context";
import { POST } from "../../../../../api/v2/simulation-runs/route";
import { GET as GET_RUN } from "../../../../../api/v2/simulation-runs/[simulationRunId]/route";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
  SIMULATION_RUN_INVALID_REQUEST_BODY,
  SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES,
  SIMULATION_RUN_REQUEST_BODY_TOO_LARGE,
  isGzipBodyEncoding,
} from "../persistence/partBodyEncoding";

const URL_ = "https://example.test/api/v2/simulation-runs";
const AUTH = { authorization: `Bearer ${process.env.STAGING_ADMIN_TOKEN}` };
const LIMIT = SIMULATION_RUN_MAX_DECOMPRESSED_BODY_BYTES;
const SAVED_AT = "2026-10-17T00:00:00.000Z";

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
  return gzipRequestFromBuffer(gzipSync(Buffer.from(JSON.stringify(body), "utf8")));
}

function gzipRequestFromBuffer(compressed: Buffer): NextRequest {
  return new NextRequest(URL_, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", [SIMULATION_RUN_BODY_ENCODING_HEADER]: SIMULATION_RUN_BODY_ENCODING_GZIP, ...AUTH },
    // 【型】BodyInit は ArrayBufferView を受け付ける。Buffer をそのまま渡す。
    body: compressed as unknown as BodyInit,
  });
}

function plainRequest(body: unknown): NextRequest {
  return plainRequestFromText(JSON.stringify(body));
}

function plainRequestFromText(text: string): NextRequest {
  return new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: text });
}

function okValue(parsed: Awaited<ReturnType<typeof parseJsonBody>>): unknown {
  assert.equal(parsed.ok, true, `読み取りが失敗した: ${JSON.stringify(parsed)}`);
  return (parsed as { ok: true; value: unknown }).value;
}

/** 展開すると指定バイト数ちょうどになる JSON を作って gzip する。 */
function gzipJsonOfSize(totalBytes: number): Buffer {
  const prefix = '{"part":"dataset","filler":"';
  const suffix = '"}';
  const fillerLength = totalBytes - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(suffix, "utf8");
  assert.ok(fillerLength > 0, "要求サイズが小さすぎる");
  const json = `${prefix}${"a".repeat(fillerLength)}${suffix}`;
  assert.equal(Buffer.byteLength(json, "utf8"), totalBytes, "狙ったバイト数になっていない");
  return gzipSync(Buffer.from(json, "utf8"));
}

// --- COMP-1: 往復と後方互換 ------------------------------------------------

test("COMP-1: gzip で送った本文は、圧縮せずに送ったときと同じオブジェクトとして読まれる", async () => {
  const body = samplePartBody();
  const fromGzip = okValue(await parseJsonBody(gzipRequest(body)));
  const fromPlain = okValue(await parseJsonBody(plainRequest(body)));
  assert.deepEqual(fromGzip, body, "gzip 本文の展開結果が元の本文と一致しない");
  assert.deepEqual(fromGzip, fromPlain, "gzip 経路と素のJSON経路で結果が違う");
});

test("COMP-2: 後方互換 — ヘッダが無ければ従来どおり素の JSON として読む", async () => {
  const body = { manifestOnly: true, persistenceRevision: 9 };
  assert.deepEqual(okValue(await parseJsonBody(plainRequest(body))), body);
});

test("COMP-3: 壊れた gzip は理由つきで拒否され、保存へ進まない", async () => {
  const broken = gzipRequestFromBuffer(Buffer.from("これはgzipではない", "utf8"));
  const parsed = await parseJsonBody(broken);
  assert.equal(parsed.ok, false, "壊れた gzip 本文が成功として読まれた");
  assert.equal((parsed as { code: string }).code, SIMULATION_RUN_INVALID_REQUEST_BODY);
  assert.match((parsed as { message: string }).message, /保存は行っていません/);
});

test("COMP-3b: gzip の途中で切れた本文も拒否される", async () => {
  const full = gzipSync(Buffer.from(JSON.stringify(samplePartBody()), "utf8"));
  const parsed = await parseJsonBody(gzipRequestFromBuffer(full.subarray(0, Math.floor(full.byteLength / 2))));
  assert.equal(parsed.ok, false, "途中で切れた gzip 本文が成功として読まれた");
  assert.equal((parsed as { code: string }).code, SIMULATION_RUN_INVALID_REQUEST_BODY);
});

test("COMP-4: gzip 以外のヘッダ値は素の JSON として扱う", async () => {
  const body = { simulationRunId: "comp1-run", revision: 1 };
  const labelled = new NextRequest(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", [SIMULATION_RUN_BODY_ENCODING_HEADER]: "br", ...AUTH },
    body: JSON.stringify(body),
  });
  assert.deepEqual(okValue(await parseJsonBody(labelled)), body);
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

test("COMP-6: 実データ相当の大きな本文でも往復で内容が変わらない", async () => {
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
  assert.deepEqual(okValue(await parseJsonBody(gzipRequest(big))), big);
});

// --- COMP-2: 展開後サイズの上限 --------------------------------------------

test("COMP-7: 圧縮本文は小さくても、展開後が上限を超えれば展開を途中で止めて拒否する", async () => {
  // 100MB のゼロは約100KBまで縮む（増幅率 約1000:1）。
  const bomb = gzipSync(Buffer.alloc(100 * 1024 * 1024));
  assert.ok(bomb.byteLength < 1024 * 1024, `前提が崩れている: 圧縮後が ${bomb.byteLength} B`);

  const heapBefore = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  const parsed = await parseJsonBody(gzipRequestFromBuffer(bomb));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

  assert.equal(parsed.ok, false, "展開後が上限を超える本文が成功として読まれた");
  assert.equal((parsed as { code: string }).code, SIMULATION_RUN_REQUEST_BODY_TOO_LARGE);
  assert.match((parsed as { message: string }).message, /保存は行っていません/);

  /**
   * 【補助的な確認。これ自体は証明ではない】
   * 「展開を途中で止めている」ことの直接の根拠は、zlib が上限に達した時点で
   * ERR_BUFFER_TOO_LARGE を投げる（＝残りを展開しない）ことであり、上の
   * assert がそれを見ている。
   *
   * 以下の heap と時間の検査は、その裏取りとしての目安にすぎない。
   * heap の増減は GC のタイミングに左右され、展開中の中間バッファや zlib が
   * 使う外部メモリは heapUsed に現れないため、これだけでは展開処理全体の
   * メモリ使用量を証明できない。あくまで「100MB を展開しきった形跡が無い」
   * ことの弱い確認として置いている。閾値は実測（8.2ms / heap +0.2MB）に
   * 対して十分に緩く取る。
   */
  assert.ok(heapGrowth < 40 * 1024 * 1024, `展開しきっている疑い: heap が ${(heapGrowth / 1024 / 1024).toFixed(1)} MB 増えた`);
  assert.ok(elapsedMs < 2000, `展開しきっている疑い: ${elapsedMs.toFixed(0)} ms かかった`);
});

test("COMP-8: 境界値 — 展開後が上限ちょうどなら通し、1バイト超えたら拒否する", async () => {
  const atLimit = await parseJsonBody(gzipRequestFromBuffer(gzipJsonOfSize(LIMIT)));
  assert.equal(atLimit.ok, true, `上限ちょうどの本文が拒否された: ${JSON.stringify(atLimit)}`);

  const overLimit = await parseJsonBody(gzipRequestFromBuffer(gzipJsonOfSize(LIMIT + 1)));
  assert.equal(overLimit.ok, false, "上限を1バイト超えた本文が通った");
  assert.equal((overLimit as { code: string }).code, SIMULATION_RUN_REQUEST_BODY_TOO_LARGE);
});

test("COMP-9: 正常な32Turn相当（実測最大 3,988,940 B）は上限に余裕を持って収まる", async () => {
  const MEASURED_MAX = 3_988_940;
  assert.ok(MEASURED_MAX < LIMIT, "上限が実測最大を下回っている");
  const parsed = await parseJsonBody(gzipRequestFromBuffer(gzipJsonOfSize(MEASURED_MAX)));
  assert.equal(parsed.ok, true, `正常サイズの本文が拒否された: ${JSON.stringify(parsed)}`);
  assert.ok(LIMIT / MEASURED_MAX >= 2, `実測最大に対する余裕が2倍未満: ${(LIMIT / MEASURED_MAX).toFixed(2)} 倍`);
});

test("COMP-10: 未圧縮の旧経路にも上限が効き、JSON として解釈する前に拒否する", async () => {
  const over = "x".repeat(LIMIT + 1);
  const parsed = await parseJsonBody(plainRequestFromText(over));
  assert.equal(parsed.ok, false, "未圧縮で上限を超えた本文が通った");
  assert.equal((parsed as { code: string }).code, SIMULATION_RUN_REQUEST_BODY_TOO_LARGE);
  // JSON として壊れている本文だが、上限超過として弾かれる（＝parse前に検査している）。
  assert.match((parsed as { message: string }).message, new RegExp(String(LIMIT + 1)));

  const justUnder = plainRequestFromText(JSON.stringify({ part: "dataset", filler: "y".repeat(1024) }));
  assert.equal((await parseJsonBody(justUnder)).ok, true, "上限以下の未圧縮本文が拒否された");
});

// --- COMP-2: 拒否が正本を変えないこと（実ルート経由） ----------------------

test("COMP-11: 拒否された保存は既存の正本を変えず、成功として返さない", async () => {
  const runId = "comp2-route-run";
  const token = "comp2-write-token";

  function runMetadata(completedTurns: number) {
    return {
      simulationRunId: runId,
      scenarioId: "baseline",
      scenarioVersion: "v1",
      seed: "seed",
      gameParameterVersion: "v1",
      standardAiVersion: "v1",
      strategyProfileVersion: "v1",
      startingTurn: 1,
      requestedTurns: 32,
      completedTurns,
      startedAt: SAVED_AT,
      completedAt: null,
      stopReason: "running" as const,
      errorMessage: null,
    };
  }

  // 1. 正常な保存で revision 1 を公開する（dataset / resume / pack → manifest commit）。
  const attempt = { expectedBaseRevision: 0, writeToken: token };
  for (const [part, value] of [
    ["dataset", { schemaVersion: "simulationAnalytics-v1", turns: [1], marker: "original-dataset" }],
    ["resume", { marker: "original-resume" }],
    ["pack", { companyTurns: [{ turn: 1 }], worldTurns: [{ turn: 1 }] }],
  ] as const) {
    const res = await POST(plainRequest({ simulationRunId: runId, revision: 1, part, value, ...attempt }));
    assert.equal(res.status, 200, `${part} の保存が失敗した: ${JSON.stringify(await res.json())}`);
  }
  const commit = await POST(
    plainRequest({
      manifestOnly: true,
      run: runMetadata(1),
      savedAt: SAVED_AT,
      persistenceRevision: 1,
      hasResumePayload: true,
      hasPackCapture: true,
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      ...attempt,
    })
  );
  assert.equal(commit.status, 200, `manifest commit が失敗した: ${JSON.stringify(await commit.json())}`);

  async function loadRun(): Promise<unknown> {
    const res = await GET_RUN(new NextRequest(`${URL_}/${runId}`, { headers: AUTH }), {
      params: Promise.resolve({ simulationRunId: runId }),
    });
    assert.equal(res.status, 200, "保存した Run を読み戻せない");
    return res.json();
  }

  const before = JSON.stringify(await loadRun());
  assert.match(before, /original-dataset/, "前提が崩れている: 正本に最初の内容が入っていない");

  // 2. 展開後が上限を超える保存を、同じ Run・次の revision 宛てに送る。
  const bombBody = Buffer.concat([
    Buffer.from(`{"simulationRunId":"${runId}","revision":2,"part":"dataset","expectedBaseRevision":1,"writeToken":"${token}","value":"`, "utf8"),
    Buffer.alloc(100 * 1024 * 1024, 0x61),
    Buffer.from('"}', "utf8"),
  ]);
  const rejected = await POST(gzipRequestFromBuffer(gzipSync(bombBody)));

  assert.equal(rejected.status, 413, `上限超過が 413 で返っていない（${rejected.status}）`);
  const rejectedBody = (await rejected.json()) as { error?: { code?: string; message?: string } };
  assert.equal(rejectedBody.error?.code, SIMULATION_RUN_REQUEST_BODY_TOO_LARGE);
  assert.match(String(rejectedBody.error?.message), /保存は行っていません/);
  assert.ok(!("ok" in rejectedBody), "拒否なのに成功を示す応答になっている");

  // 3. 正本が1バイトも変わっていないこと。
  const after = JSON.stringify(await loadRun());
  assert.equal(after, before, "拒否された保存で既存の正本が変わっている");

  // 4. 未圧縮の上限超過でも同じこと。
  const rejectedPlain = await POST(plainRequestFromText("z".repeat(LIMIT + 1)));
  assert.equal(rejectedPlain.status, 413, "未圧縮の上限超過が 413 で返っていない");
  assert.equal(JSON.stringify(await loadRun()), before, "未圧縮の拒否で既存の正本が変わっている");
});
