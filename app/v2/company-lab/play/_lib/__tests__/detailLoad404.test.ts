// ShrimpX V2 — COMPANYLAB-DETAIL-LOAD-404-1
//
// 「一覧には出るのに詳細だけ Not Found」という実 Redis 事象の再現・回帰と、
// エラー分類（内部エラーを 404 の裏へ隠さない）の固定。
//
// 【production 相当の経路】in-memory Repository ではなく、
//   fake Redis client（実 Upstash 契約と同一の CompanyLabRedisClient）
//   → redisRepository（実装本体）
//   → codec（encode / decode）→ persistence/schema の検証
// を通す。in-memory Repository は decode / schema 検証を通らないため、
// この不具合クラスの再現には使えない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCompanyLabRedisClient } from "../../../../../lib/v2/redis/__tests__/fakeCompanyLabRedisClient";
import { createCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/redisRepository";
import { CompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabApiDependencies } from "../../../../../api/v2/company-labs/_lib/dependencies";
import { handleCreateLab, handleListLabs } from "../../../../../api/v2/company-labs/_lib/handlers";
import type { CompanyLabSummaryDto } from "../../../../../api/v2/company-labs/_lib/responseDto";
import { loadPlayerScreenViewModel } from "../viewModel";
import { decodeLabIdRouteParam } from "../labIdRouteParam";
import {
  CompanyLabNotFoundError,
  CompanyLabRepositoryError,
  CompanyLabSerializationError,
} from "../../../../../lib/v2/companyLab/persistence/errors";

const NOW = "2026-08-30T00:00:00.000Z";

function makeDeps(): { deps: CompanyLabApiDependencies; repository: CompanyLabStateRepository } {
  const client = createFakeCompanyLabRedisClient();
  const repository = createCompanyLabStateRepository({ client, appEnv: "staging" });
  const service = createCompanyLabQuarterFlowService({ repository });
  return { deps: { repository, service }, repository };
}

function createBody(labId: string, extra: Record<string, unknown> = {}) {
  return { labId, scenarioId: "baseline", mode: "canonical", seed: "detail-load", turns: 32, playerCompanyId: "BAL", ...extra };
}

/**
 * 一覧の「再開」リンク（encodeURIComponent）→ 実際のルートパラメータ → 画面側の復元、を模す。
 *
 * 【重要】Next.js（App Router・実測 16.2.10）は動的セグメントを **percent-encoded のまま**
 * ページへ渡す。したがって「encodeURIComponent したものを decodeURIComponent し直す」だけの
 * 模擬では本不具合を再現できない（実際にこの模擬で見落とし、ブラウザE2Eで初めて再現した）。
 * ここでは
 *   リンク生成 = encodeURIComponent → params で受け取る値 = その生の文字列
 *   → 画面側の復元 = decodeLabIdRouteParam
 * という実際の経路をそのまま再現する。
 */
const routeParamFor = (labId: string): string => encodeURIComponent(labId);
const throughUrl = (labId: string): string => decodeLabIdRouteParam(routeParamFor(labId));

async function createAndList(deps: CompanyLabApiDependencies, labId: string, extra: Record<string, unknown> = {}) {
  const created = await handleCreateLab(deps, createBody(labId, extra), NOW);
  assert.equal(created.status, 201, `create 失敗: ${JSON.stringify(created.body)}`);
  const list = await handleListLabs(deps);
  assert.equal(list.status, 200);
  const labs = (list.body as { labs: CompanyLabSummaryDto[] }).labs;
  return { created, labs };
}

// =====================================================================

test("DETAIL-LOAD-1: createLab → 一覧に表示 → 詳細ロード成功", async () => {
  const { deps } = makeDeps();
  const labId = "lab-detail-1";
  const { labs } = await createAndList(deps, labId);
  assert.equal(labs.length, 1);
  assert.equal(labs[0].labId, labId);
  const result = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(result.kind, "ok", `詳細が ok でない: ${JSON.stringify(result)}`);
});

const ID_CASES: Array<[string, string]> = [
  ["DETAIL-LOAD-2: ASCII labId", "lab-ascii-2026"],
  ["DETAIL-LOAD-3: 日本語 labId", "テストラボ"],
];
for (const [name, labId] of ID_CASES) {
  test(`${name}（一覧・URL往復・詳細のすべてで同一 labId）`, async () => {
    const { deps } = makeDeps();
    const { labs } = await createAndList(deps, labId);
    assert.equal(labs[0].labId, labId, "一覧 DTO の labId が保存値と違う");
    const fromUrl = throughUrl(labs[0].labId);
    assert.equal(fromUrl, labId, "URL encode → decode で labId が変化した");
    assert.equal((await loadPlayerScreenViewModel(deps, fromUrl)).kind, "ok");
  });
}

test("DETAIL-LOAD-3b: 空白入り labId（ASCII / 日本語）も詳細ロード成功", async () => {
  for (const labId of ["20260830 test pricemodel", "20260830　テストプレイ", "8月18日", "9/18"]) {
    const { deps } = makeDeps();
    const { labs } = await createAndList(deps, labId);
    const fromUrl = throughUrl(labs[0].labId);
    assert.equal(fromUrl, labId, `URL 往復で変化: ${JSON.stringify(labId)} -> ${JSON.stringify(fromUrl)}`);
    assert.equal((await loadPlayerScreenViewModel(deps, fromUrl)).kind, "ok", `labId=${JSON.stringify(labId)} の詳細が ok でない`);
  }
});

test("DETAIL-LOAD-4: 作成直後の redirect 先 labId でそのまま詳細を開ける", async () => {
  const { deps } = makeDeps();
  const labId = "lab-redirect-4";
  const { created } = await createAndList(deps, labId);
  // actions.ts は created.labId を encodeURIComponent して redirect する。
  const redirectedTo = throughUrl((created.body as { lab: CompanyLabSummaryDto }).lab.labId);
  assert.equal(redirectedTo, labId);
  assert.equal((await loadPlayerScreenViewModel(deps, redirectedTo)).kind, "ok");
});

test("DETAIL-LOAD-5: 一覧「再開」リンク経由でも詳細ロード成功", async () => {
  const { deps } = makeDeps();
  const labId = "lab-resume-5";
  const { labs } = await createAndList(deps, labId);
  assert.equal((await loadPlayerScreenViewModel(deps, throughUrl(labs[0].labId))).kind, "ok");
});

test("DETAIL-LOAD-6: 実 persisted codec roundtrip（decode / schema 検証）を通る", async () => {
  const { deps, repository } = makeDeps();
  const labId = "lab-codec-6";
  await createAndList(deps, labId);
  // redisRepository.loadCurrentState は decodeCompanyLabPersistedStateFromStored を必ず通る。
  const stored = await repository.loadCurrentState(labId);
  assert.equal(stored.schemaVersion, 8);
  assert.equal(stored.playerCompanyId, "BAL");
  assert.ok(
    stored.fixtures.some((f) => f.companyId === stored.playerCompanyId),
    "playerCompanyId が fixtures に存在しない（詳細画面の fixture 探索が失敗する条件）"
  );
  assert.equal((await loadPlayerScreenViewModel(deps, labId)).kind, "ok");
});

test("DETAIL-LOAD-7: salesModelId=tiered-v200-candidate-v1 でも詳細ロード成功・値が保持される", async () => {
  const { deps, repository } = makeDeps();
  const labId = "lab-tiered-7";
  await createAndList(deps, labId, { salesModelId: "tiered-v200-candidate-v1" });
  assert.equal((await repository.loadCurrentState(labId)).config.salesModelId, "tiered-v200-candidate-v1");
  const result = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" ? result.viewModel.salesModelId : undefined, "tiered-v200-candidate-v1");
});

test("DETAIL-LOAD-8: salesModelId なし（legacy）でも詳細ロード成功", async () => {
  const { deps } = makeDeps();
  const labId = "lab-legacy-8";
  await createAndList(deps, labId);
  const result = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" ? result.viewModel.salesModelId : "x", undefined);
});

test("DETAIL-LOAD-9: Scenario requiredCapabilities（DS1）付きでも詳細ロード成功", async () => {
  const { deps, repository } = makeDeps();
  const labId = "lab-ds1-9";
  await createAndList(deps, labId, { scenarioId: "dynamic-scenario-1" });
  const stored = await repository.loadCurrentState(labId);
  assert.equal(stored.config.sai5?.productLifecycle, true);
  assert.equal(stored.config.sai5?.salesBaseAccumulation, true);
  assert.equal((await loadPlayerScreenViewModel(deps, labId)).kind, "ok");
});

test("DETAIL-LOAD-10: 本当に存在しない labId だけが notFound", async () => {
  const { deps, repository } = makeDeps();
  await createAndList(deps, "lab-exists-10");
  await assert.rejects(() => repository.loadCurrentState("lab-missing-10"), CompanyLabNotFoundError);
  assert.equal((await loadPlayerScreenViewModel(deps, "lab-missing-10")).kind, "notFound");
  assert.equal((await loadPlayerScreenViewModel(deps, "lab-exists-10")).kind, "ok");
});

test("DETAIL-LOAD-11: schema / decode / repository エラーを notFound へ誤分類しない", async () => {
  const { deps } = makeDeps();
  const labId = "lab-classify-11";
  await createAndList(deps, labId);

  // (a) decode 失敗（保存データの破損）→ persistedStateInvalid
  const brokenDecode: CompanyLabApiDependencies = {
    ...deps,
    repository: {
      ...deps.repository,
      loadCurrentState: async () => {
        throw new CompanyLabSerializationError("保存されていた会社ラボ状態のdecodeに失敗しました（テスト）");
      },
    },
  };
  const decodeResult = await loadPlayerScreenViewModel(brokenDecode, labId);
  assert.equal(decodeResult.kind, "error", "decode 失敗が notFound へ潰されている");
  assert.equal(decodeResult.kind === "error" ? decodeResult.reason : "", "persistedStateInvalid");

  // (b) Redis 読み取り失敗 → repositoryUnavailable
  const brokenRedis: CompanyLabApiDependencies = {
    ...deps,
    repository: {
      ...deps.repository,
      loadCurrentState: async () => {
        throw new CompanyLabRepositoryError("Redisからの読み込みに失敗しました（テスト）");
      },
    },
  };
  const redisResult = await loadPlayerScreenViewModel(brokenRedis, labId);
  assert.equal(redisResult.kind, "error", "Redis 障害が notFound へ潰されている");
  assert.equal(redisResult.kind === "error" ? redisResult.reason : "", "repositoryUnavailable");

  // (c) playerCompanyId に対応する fixture が無い → playerFixtureMissing（notFound ではない）
  const stored = await deps.repository.loadCurrentState(labId);
  const brokenFixtures: CompanyLabApiDependencies = {
    ...deps,
    repository: { ...deps.repository, loadCurrentState: async () => ({ ...stored, fixtures: [] }) },
  };
  const fixtureResult = await loadPlayerScreenViewModel(brokenFixtures, labId);
  assert.equal(fixtureResult.kind, "error", "fixture 不整合が notFound へ潰されている");
  assert.equal(fixtureResult.kind === "error" ? fixtureResult.reason : "", "playerFixtureMissing");

  // (d) draft / 直近履歴の読み取り失敗も notFound にしない（以前は未捕捉のクラッシュ）
  const brokenDraft: CompanyLabApiDependencies = {
    ...deps,
    repository: {
      ...deps.repository,
      loadDraft: async () => {
        throw new CompanyLabRepositoryError("Redisからのdraft読み込みに失敗しました（テスト）");
      },
    },
  };
  const draftResult = await loadPlayerScreenViewModel(brokenDraft, labId);
  assert.equal(draftResult.kind, "error");
  assert.equal(draftResult.kind === "error" ? draftResult.reason : "", "repositoryUnavailable");

  // (e) 存在しない labId は従来どおり notFound のまま
  assert.equal((await loadPlayerScreenViewModel(deps, "lab-really-missing-11")).kind, "notFound");
});

test("DETAIL-LOAD-12: percent-encoded のままの labId は復元しないと開けない（本不具合の回帰ガード）", async () => {
  for (const labId of ["20260830 test pricemodel", "20260830　テストプレイ", "テストラボ"]) {
    const { deps } = makeDeps();
    await createAndList(deps, labId);
    const rawParam = routeParamFor(labId);
    assert.notEqual(rawParam, labId, `${JSON.stringify(labId)} は encodeURIComponent で変化するはず`);
    // 修正前の挙動: params の生値をそのまま Repository へ渡すと「見つからない」になる。
    assert.equal((await loadPlayerScreenViewModel(deps, rawParam)).kind, "notFound");
    // 修正後: 復元してから渡せば開ける。
    assert.equal((await loadPlayerScreenViewModel(deps, decodeLabIdRouteParam(rawParam))).kind, "ok");
  }
});

test("DETAIL-LOAD-13: decodeLabIdRouteParam は encodeURIComponent の逆変換であり、不正な encoding でも例外を投げない", () => {
  for (const labId of ["Test12", "lab-46v0dd", "20260830 test pricemodel", "20260830　テストプレイ", "8月18日", "100% 達成", "a+b", "a&b=c"]) {
    assert.equal(decodeLabIdRouteParam(encodeURIComponent(labId)), labId, `往復しない: ${JSON.stringify(labId)}`);
  }
  // 不正な percent-encoding（手書きURL等）は例外にせず、受け取った値をそのまま返す。
  assert.equal(decodeLabIdRouteParam("100%"), "100%");
  assert.equal(decodeLabIdRouteParam("%E3%81"), "%E3%81");
});
