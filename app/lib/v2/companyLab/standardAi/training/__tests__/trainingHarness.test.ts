// ShrimpX V2 — Standard AI Training Harness の自己検証テスト
//
// このテストが守っているのは「訓練ループの結論が意味を持つための前提」そのものである。
//   1. environmentFingerprint は Standard AI 実装を含まない
//      （＝AIだけを変えたBefore/After比較が「同じ世界での比較」だと言える根拠）。
//   2. ベンチマークは決定論的（同じseedなら同じ結果）。
//      これが壊れると Before/After の差が改善なのかノイズなのか区別できない。
//   3. ハーネスは Test15 の保存データに触れない（in-memoryのみで完結する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { computeEnvironmentFingerprint } from "../fingerprint";
import { BENCHMARK_PROFILES, runSingleSeed, seedsForProfile, benchmarkCompanyIds } from "../benchmark";
import { auditBenchmarkRows, summarizeFindings } from "../audit";
import { SALES_PARAMETERS_V1 } from "../../../../sales/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../../finance/parameters";

const AUDIT_OPTIONS = {
  maximumSupplierShare: SALES_PARAMETERS_V1.maximumSupplierShare,
  salesForceSalaryUsdPerQuarter: FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter,
};

test("fingerprint: 3層（mechanics / informationSet / standardAi）が別々の値として安定して算出できる", () => {
  const a = computeEnvironmentFingerprint();
  const b = computeEnvironmentFingerprint();
  assert.equal(a.gameMechanicsFingerprint, b.gameMechanicsFingerprint, "同一作業ツリーではメカニクスfingerprintは再現する");
  assert.equal(a.informationSetFingerprint, b.informationSetFingerprint, "同一作業ツリーでは情報公開層fingerprintは再現する");
  assert.equal(a.standardAiFingerprint, b.standardAiFingerprint, "同一作業ツリーではAI fingerprintは再現する");
  // 3層が互いに異なること（同じ値なら分離できていない）。
  const values = [a.gameMechanicsFingerprint, a.informationSetFingerprint, a.standardAiFingerprint];
  assert.equal(new Set(values).size, 3, "3層は別々のハッシュでなければ分離の意味がない");
  for (const v of values) assert.match(v, /^[0-9a-f]{16}$/);
  // 後方互換: environmentFingerprint は gameMechanicsFingerprint と同義。
  assert.equal(a.environmentFingerprint, a.gameMechanicsFingerprint);
});

test("fingerprint: メカニクスハッシュの対象にstandardAi配下（AI判断ロジック）が含まれない", () => {
  // fingerprint.ts自身の定義を読み、メカニクス対象にstandardAiを含めていないことを
  // 構造として固定する。情報公開層（INFORMATION_SET_SOURCE_FILES）はstandardAi配下の
  // observation.ts/types.tsを意図的に含むが、これはメカニクス側からは除外される。
  const source = fs.readFileSync(path.resolve(__dirname, "..", "fingerprint.ts"), "utf8");
  const dirsBlock = source.slice(
    source.indexOf("const ENVIRONMENT_SOURCE_DIRS"),
    source.indexOf("const INFORMATION_SET_SOURCE_FILES")
  );
  const filesBlock = source.slice(
    source.indexOf("const ENVIRONMENT_SOURCE_FILES"),
    source.indexOf("export interface EnvironmentFingerprint")
  );
  assert.ok(dirsBlock.length > 0 && filesBlock.length > 0, "対象定義ブロックが読み取れること");
  assert.ok(!dirsBlock.includes("standardAi"), "メカニクス対象ディレクトリにstandardAiを含めてはならない");
  assert.ok(!filesBlock.includes("standardAi"), "メカニクス対象ファイルにstandardAiを含めてはならない");
  // 情報公開層は、AI判断ロジック（decision/配下）を含んではならない。
  const infoBlock = source.slice(
    source.indexOf("const INFORMATION_SET_SOURCE_FILES"),
    source.indexOf("/** ディレクトリ単位ではなく個別に含めるゲームエンジンのファイル。 */")
  );
  assert.ok(infoBlock.length > 0);
  assert.ok(!infoBlock.includes("decision/"), "情報公開層にAIの判断ロジック（decision/配下）を含めてはならない");
});

test("benchmark: 同じseedを2回走らせると完全に同じ結果になる（決定論性）", () => {
  const profile = BENCHMARK_PROFILES.quick;
  const seed = seedsForProfile(profile)[0];
  const first = runSingleSeed(profile, seed);
  const second = runSingleSeed(profile, seed);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "同一seedの実行結果はバイト単位で一致する");
});

test("benchmark: 異なるseedでは結果が変わる（seedが実際に効いている）", () => {
  const profile = BENCHMARK_PROFILES.quick;
  const seeds = seedsForProfile(profile);
  assert.ok(seeds.length >= 2);
  const a = runSingleSeed(profile, seeds[0]);
  const b = runSingleSeed(profile, seeds[1]);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), "seedが違えば結果も違うはず");
});

test("benchmark: 5社×指定四半期ぶんの行が過不足なく記録される", () => {
  const profile = BENCHMARK_PROFILES.quick;
  const rows = runSingleSeed(profile, seedsForProfile(profile)[0]);
  const companies = benchmarkCompanyIds(profile);
  assert.equal(rows.length, companies.length * profile.quarters);
  for (const company of companies) {
    const turns = rows.filter((r) => r.companyId === company).map((r) => r.turn);
    assert.deepEqual(
      [...turns].sort((x, y) => x - y),
      Array.from({ length: profile.quarters }, (_, i) => i + 1),
      `${company}のturnが1..${profile.quarters}で揃っていること`
    );
  }
});

test("audit: findingsは決定論的で、集計の内訳が合計と一致する", () => {
  const profile = BENCHMARK_PROFILES.quick;
  const rows = runSingleSeed(profile, seedsForProfile(profile)[0]);
  const first = auditBenchmarkRows(rows, AUDIT_OPTIONS);
  const second = auditBenchmarkRows(rows, AUDIT_OPTIONS);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const summary = summarizeFindings(first);
  assert.equal(summary.total, first.length);
  const bySeverity = Object.values(summary.bySeverity).reduce((s, n) => s + n, 0);
  assert.equal(bySeverity, summary.total, "severity別の内訳合計はtotalと一致する");
  const byRule = Object.values(summary.byRule).reduce((s, n) => s + n, 0);
  assert.equal(byRule, summary.total, "rule別の内訳合計はtotalと一致する");

  // findingIdは一意（同じ指摘を二重計上していない）。
  const ids = new Set(first.map((f) => f.findingId));
  assert.equal(ids.size, first.length, "findingIdは一意でなければならない");
});

test("harness: ベンチマーク・監査モジュールはRedis/Repository/永続化層へ依存しない（Test15保存データに触れない）", () => {
  for (const file of ["benchmark.ts", "audit.ts", "fingerprint.ts"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    for (const line of imports) {
      assert.ok(!/redis/i.test(line), `${file}: Redisへ依存してはならない: ${line}`);
      assert.ok(!/[Rr]epository/.test(line), `${file}: Repositoryへ依存してはならない: ${line}`);
      // fingerprint.tsだけは persistence/types のバージョン定数（純粋な定数。
      // 保存データの読み書き機能を一切持たない）を、記録用のメタ情報として読む。
      // それ以外のモジュールは永続化層へ触れてはならない。
      if (file !== "fingerprint.ts") {
        assert.ok(!/persistence/.test(line), `${file}: 永続化層へ依存してはならない: ${line}`);
      } else {
        assert.ok(
          !/persistence/.test(line) || /persistence\/types/.test(line),
          `fingerprint.ts: persistence配下はtypes（バージョン定数）のみ参照してよい: ${line}`
        );
      }
    }
  }
});
