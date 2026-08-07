// ShrimpX V2 — Phase SAI-3B-1: runCli.ts の結合テスト（fsは注入したフェイクのみ使用）

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { runSai3bExcelCli } from "../runCli";
import { Sai3bCliIo } from "../types";
import { buildFixtureRunFiles } from "../../__tests__/testFixtures";

function makeFakeIo(dirFiles: Readonly<Record<string, Record<string, string>>>): Sai3bCliIo {
  return {
    readFile: (path: string) => {
      for (const [dir, files] of Object.entries(dirFiles)) {
        if (path.startsWith(`${dir}/`)) {
          const fileName = path.slice(dir.length + 1);
          return files[fileName];
        }
      }
      return undefined;
    },
  };
}

// SAI-3B-2 §12検証で発見した回帰: 以前はloadRunFromDirがSAI3A_REQUIRED_RUN_FILES
// のみを読み込んでおり、実際のrunディレクトリにmarket-allocation-trace.csvが
// 存在していても、CLI経由では常に「見つかりません」警告になり、市場シェア推移
// 等が常に「作成不能」扱いになってしまっていた。実runでの再現テスト。
test("runSai3bExcelCli: market-allocation-trace.csvを含む実runディレクトリでは、読み込み警告が出ず市場シェアデータが取得できる", async () => {
  const files = buildFixtureRunFiles({ runId: "r1", headcount: 80, quarters: 2, cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }] });
  const io = makeFakeIo({ "artifacts/sai3a/r1": files });
  const result = await runSai3bExcelCli(["--input", "artifacts/sai3a/r1", "--output", "artifacts/sai3b/out.xlsx"], io, {
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /market-allocation-trace\.csvが見つかりません/);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.xlsxBuffer! as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("市場シェア推移")!;
  assert.ok(ws);
  const allText = ws
    .getSheetValues()
    .flat()
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  assert.doesNotMatch(allText, /現時点の出力データでは作成不能/, "実際にmarket-allocation-trace.csvがあるのに作成不能扱いになっている");
});

test("runSai3bExcelCli: --helpは使用方法を返しexitCode=0", async () => {
  const io = makeFakeIo({});
  const result = await runSai3bExcelCli(["--help"], io, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /sai3bExcel\.ts/);
});

test("runSai3bExcelCli: 単一runから正しいxlsxバッファを生成する", async () => {
  const files = buildFixtureRunFiles({ runId: "r1", headcount: 80, quarters: 2, cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }] });
  const io = makeFakeIo({ "artifacts/sai3a/r1": files });
  const result = await runSai3bExcelCli(["--input", "artifacts/sai3a/r1", "--output", "artifacts/sai3b/out.xlsx"], io, {
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.xlsxBuffer);
  assert.equal(result.outputPath, "artifacts/sai3b/out.xlsx");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.xlsxBuffer! as unknown as ExcelJS.Buffer);
  assert.ok(wb.getWorksheet("全体サマリー"));
  assert.ok(wb.getWorksheet("README"));
});

test("runSai3bExcelCli: 必須ファイル欠落時はexitCode=1で分かりやすいエラーを返す", async () => {
  const files = buildFixtureRunFiles({ runId: "r1", headcount: 80, quarters: 2, cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }] });
  delete (files as Record<string, string | undefined>)["case-summary.csv"];
  const io = makeFakeIo({ "artifacts/sai3a/r1": files });
  const result = await runSai3bExcelCli(["--input", "artifacts/sai3a/r1", "--output", "out.xlsx"], io, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /case-summary\.csv/);
});

test("runSai3bExcelCli: 存在しない入力ディレクトリはexitCode=1", async () => {
  const io = makeFakeIo({});
  const result = await runSai3bExcelCli(["--input", "artifacts/sai3a/does-not-exist", "--output", "out.xlsx"], io, {
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.exitCode, 1);
});

test("runSai3bExcelCli: 複数runで共通seedが皆無の場合は比較不可としてexitCode=1", async () => {
  const filesA = buildFixtureRunFiles({ runId: "rA", headcount: 80, quarters: 2, cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }] });
  const filesB = buildFixtureRunFiles({ runId: "rB", headcount: 85, quarters: 2, cases: [{ seed: "s2", companyId: "BAL", quarters: 2, headcount: 85 }] });
  const io = makeFakeIo({ "artifacts/sai3a/a": filesA, "artifacts/sai3a/b": filesB });
  const result = await runSai3bExcelCli(
    ["--input", "artifacts/sai3a/a", "--input", "artifacts/sai3a/b", "--output", "out.xlsx"],
    io,
    { generatedAtIso: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /比較条件が不整合/);
});

test("runSai3bExcelCli: 80/85/90人比較（共通seed・会社あり）は成功しヘッドカウント比較シートを含む", async () => {
  const mk = (runId: string, hc: number) =>
    buildFixtureRunFiles({ runId, headcount: hc, quarters: 2, cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: hc, defaultAtTurn: hc === 85 ? 1 : undefined }] });
  const io = makeFakeIo({
    "artifacts/sai3a/h80": mk("h80", 80),
    "artifacts/sai3a/h85": mk("h85", 85),
    "artifacts/sai3a/h90": mk("h90", 90),
  });
  const result = await runSai3bExcelCli(
    ["--input", "artifacts/sai3a/h80", "--input", "artifacts/sai3a/h85", "--input", "artifacts/sai3a/h90", "--output", "artifacts/sai3b/cmp.xlsx"],
    io,
    { generatedAtIso: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.xlsxBuffer! as unknown as ExcelJS.Buffer);
  assert.ok(wb.getWorksheet("80_85_90人比較"));
});
