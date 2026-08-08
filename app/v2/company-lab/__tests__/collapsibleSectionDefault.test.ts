// ShrimpX V2 — 折りたたみセクションの既定状態の回帰テスト
//
// 【固定したいこと（2026-08-08 プレイヤー要望）】
// 画面を開いた直後は、意思決定編集の各セクションがたたまれていること。
// turn5時点で意思決定編集のセクションは13個あり、全部開いていると
// 「どこに何があるか」を一覧できないほど縦に長くなる。
//
// 【なぜソースを読む形式なのか】このリポジトリはDOMレンダラを持たない
// （node:test + tsx のみでブラウザを起動しない）。既存のUI検証と同じく、
// コンポーネントのソース上の構造を機械的に検査する。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function readComponent(...segments: string[]): string {
  return fs.readFileSync(path.resolve(__dirname, "..", ...segments), "utf8");
}

test("【既定は閉じている】CollapsibleSectionのdefaultOpen未指定時はopen=false", () => {
  const source = readComponent("components", "CollapsibleSection.tsx");
  assert.ok(
    /open=\{props\.defaultOpen \?\? false\}/.test(source),
    "defaultOpen未指定のセクションは閉じた状態で描画されること（?? true に戻っていないこと）"
  );
});

test("【意思決定編集】DecisionEditorのセクションはdefaultOpenを指定せず、既定（閉）に従う", () => {
  const source = readComponent("components", "DecisionEditor.tsx");
  // 意思決定編集側で defaultOpen={true} を明示すると、既定を閉じても開いたままになる。
  assert.ok(
    !/defaultOpen=\{true\}/.test(source) && !/defaultOpen(?!=)/.test(source.replace(/defaultOpen=\{false\}/g, "")),
    "DecisionEditorがdefaultOpenでセクションを開いていないこと"
  );
  // 画面に出ている主要セクションが、いずれもCollapsibleSection経由であること。
  for (const testId of [
    "capex-section",
    "sales-plan-section",
    "domestic-purchase-section",
    "import-section",
    "production-plan-section",
    "worker-assignment-section",
    "financing-section",
  ]) {
    assert.ok(source.includes(`testId="${testId}"`), `${testId} がCollapsibleSectionとして存在すること`);
  }
});

test("【たたんでも状態が読める】主要セクションは見出し行に要約（summaryRight）を持つ", () => {
  // たたむのが既定になるため、閉じたままでも各セクションの状態が分かる必要がある。
  const source = readComponent("components", "DecisionEditor.tsx");
  const summaryCount = (source.match(/summaryRight=/g) ?? []).length;
  assert.ok(summaryCount >= 6, `見出し行の要約が十分にあること（実際=${summaryCount}件）`);
});

test("【凡例】折りたたみが既定であることが画面の凡例に書かれている", () => {
  const source = readComponent("components", "CollapsibleSection.tsx");
  assert.ok(source.includes("各セクションは折りたたまれています"), "凡例が既定の状態を説明していること");
});
