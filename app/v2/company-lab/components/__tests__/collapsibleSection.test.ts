// ShrimpX V2 — CollapsibleSectionのデフォルト開閉状態の回帰テスト
//
// プレイヤーからの要望「画面を開いたときに縦長になるので、各項目をデフォルトで
// 畳んだ状態にしてほしい」への対応（Phase 8G完了直後の追加要望）。
// defaultOpenを明示的に指定しない場合、既定でopen属性を持たない（＝畳まれた
// 状態）ことをrenderToStaticMarkupで確認する。native <details>のopen属性は
// 真偽値のHTML属性であり、renderToStaticMarkupは true のときのみ `open` 文字列を
// 出力し、false/undefinedのときは属性自体を出力しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CollapsibleSection from "../CollapsibleSection";

test("§1: defaultOpenを指定しない場合、既定で畳まれた状態（<details>にopen属性が付かない）になる", () => {
  const html = renderToStaticMarkup(
    React.createElement(CollapsibleSection, { title: "テスト見出し", tone: "input" }, "本文")
  );
  assert.ok(html.startsWith("<details "), "detailsタグで描画されること（前提条件）");
  assert.ok(!/<details[^>]*\bopen\b/.test(html), "open属性が付いていないこと（＝デフォルトで畳まれていること）");
});

test("§2: defaultOpen={false}を明示した場合も、畳まれた状態になる（既定値と同じ結果）", () => {
  const html = renderToStaticMarkup(
    React.createElement(CollapsibleSection, { title: "テスト見出し", tone: "input", defaultOpen: false }, "本文")
  );
  assert.ok(!/<details[^>]*\bopen\b/.test(html));
});

test("§3: defaultOpen={true}を明示した場合は、開いた状態（<details>にopen属性が付く）になる", () => {
  const html = renderToStaticMarkup(
    React.createElement(CollapsibleSection, { title: "テスト見出し", tone: "input", defaultOpen: true }, "本文")
  );
  assert.ok(/<details[^>]*\bopen\b/.test(html), "open属性が付いていること（明示的にtrueを指定した場合は開いた状態）");
});

test("§4: summaryRight（右端の要約情報）は、畳まれた状態でも常にHTMLへ出力される（畳んだままでも読めること）", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      CollapsibleSection,
      { title: "テスト見出し", tone: "input", summaryRight: "配分済み 18人 / 配分可能 18人" },
      "本文"
    )
  );
  assert.ok(html.includes("配分済み 18人 / 配分可能 18人"), "畳んだ状態でも要約情報がマークアップに含まれること");
});
