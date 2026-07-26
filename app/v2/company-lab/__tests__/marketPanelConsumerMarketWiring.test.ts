// ShrimpX V2 — MarketPanel「消費国別・在庫循環」表示の配線回帰テスト
// （Phase 8F-1配線漏れの修正、fix/v2-consumer-market-ui-wiring）
//
// 【背景】Phase 8F-1で追加したconsumerMarketRecords（消費国別・在庫循環の確定結果）は、
// 本番のプレイヤー画面（play/[labId]/PlayerScreenClient.tsx）へは正しく配線されていたが、
// GM・開発者向け統合テスト画面（page.tsx）の<MarketPanel>呼び出し2箇所（自社表示・GM全社
// 表示）へ渡し忘れていた（実装漏れ）。本テストは、この種の「propが存在するのに渡し忘れる」
// 配線漏れを機械的に検知できるようにするための回帰テストである。
//
// 【このリポジトリにReactコンポーネントの描画テスト基盤（jsdom・testing-library等）が
// 存在しないことについて】package.jsonにはjest/vitest/testing-library/jsdomのいずれも
// 導入されておらず、既存テストはすべてnode:testでの純粋関数・エンジンロジックのテストに
// 限定されている。page.tsx（「初期化」→「1四半期進める」→タブ切替、という一連の操作を
// 経て初めてMarketPanelへ到達するクライアントコンポーネント）を実際にクリック操作込みで
// 描画・検証するには、新たにReact Testing Library等の導入とpage.tsx側のテスト容易化が
// 必要になり、これは「配線追加に限定する」という今回の修正スコープを超える大規模な
// リファクタリングになる。そのため、page.tsx自体のインタラクティブな描画テストは今回
// 追加しない（この判断と理由を完了報告に明記する）。
//
// 代わりに、以下の2段構えで実質的に同等の回帰保証を得る。
//   A. MarketPanel自体はReactの標準的な関数コンポーネント（"use client"指定なし、
//      内部で独自のuseState/useEffectを持たない、props→JSXの純粋な変換）であるため、
//      react-dom/serverのrenderToStaticMarkupだけで（jsdomもtesting-libraryも使わず）
//      実際のcompanyLab統合ランの本物のデータを渡して描画し、「データがある四半期では
//      表示される」「データが無い四半期では表示されない」「市場別の記録が正しく出る」
//      「NaN/Infinity/undefinedが出力に出ない」を直接検証する。
//   B. page.tsx・PlayerScreenClient.tsxの実ソースを読み、<MarketPanel>の呼び出し箇所を
//      すべて列挙したうえで、各呼び出しに`consumerMarketRecords=`が実際に渡されている
//      ことをソースレベルで検証する（今回まさに漏れていた配線そのものを機械チェックする）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarketPanel from "../components/MarketPanel";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";

// 2四半期だけの最小構成ラン（consumerMarketRecordsが実際に確定した本物のデータを得る
// 目的に限定し、実行時間を抑える。決定論的なので毎回同じ結果になる）。
function runMinimal(): ReturnType<typeof runCompanyLabWithAutoPolicyForAllCompanies> {
  const config: CompanyLabConfig = { scenarioId: "baseline-v0.1", mode: "canonical", seed: "mp-wiring-001", turns: 2 };
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

const shared = runMinimal();
const latestRecord = shared.history[shared.history.length - 1];

test("§B-1: MarketPanelを実際に呼び出している箇所は、page.tsx（2箇所）とPlayerScreenClient.tsx（1箇所）の合計3箇所のみである", () => {
  // 【監査目的】将来MarketPanelの呼び出し箇所が増減した場合に、この数の変化自体で
  // 気づけるようにする（新しい呼び出し箇所が追加されたのに配線チェックを更新し忘れる、
  // という事態を防ぐ）。
  const pageTsxPath = path.join(__dirname, "..", "page.tsx");
  const playerScreenClientPath = path.join(__dirname, "..", "play", "[labId]", "PlayerScreenClient.tsx");

  const pageTsxSource = readFileSync(pageTsxPath, "utf8");
  const playerScreenClientSource = readFileSync(playerScreenClientPath, "utf8");

  const countCalls = (source: string) => (source.match(/<MarketPanel\b/g) ?? []).length;

  const pageTsxCallCount = countCalls(pageTsxSource);
  const playerScreenClientCallCount = countCalls(playerScreenClientSource);

  assert.equal(pageTsxCallCount, 2, "page.tsx（統合テスト画面）の<MarketPanel>呼び出しは自社表示・GM全社表示の2箇所のはず");
  assert.equal(playerScreenClientCallCount, 1, "PlayerScreenClient.tsx（本番プレイヤー画面）の<MarketPanel>呼び出しは1箇所のはず");
});

test("§B-2: page.tsx・PlayerScreenClient.tsxの<MarketPanel>呼び出しは、すべてconsumerMarketRecordsを渡している", () => {
  const pageTsxPath = path.join(__dirname, "..", "page.tsx");
  const playerScreenClientPath = path.join(__dirname, "..", "play", "[labId]", "PlayerScreenClient.tsx");

  for (const [label, filePath] of [
    ["page.tsx", pageTsxPath],
    ["PlayerScreenClient.tsx", playerScreenClientPath],
  ] as const) {
    const source = readFileSync(filePath, "utf8");
    // <MarketPanel ... /> の各呼び出し（このコードベースの既存の書き方は常に自己終了タグ）を
    // 1つずつ切り出し、それぞれの内側にconsumerMarketRecords=が含まれることを確認する。
    const callBlocks = source.match(/<MarketPanel\b[\s\S]*?\/>/g) ?? [];
    assert.ok(callBlocks.length > 0, `${label}: <MarketPanel>の呼び出しが見つからない`);
    for (const [index, block] of callBlocks.entries()) {
      assert.ok(
        block.includes("consumerMarketRecords="),
        `${label}: ${index + 1}番目の<MarketPanel>呼び出しにconsumerMarketRecordsが渡されていない\n${block}`
      );
    }
  }
});

test("§A-1: 実データ（consumerMarketRecordsあり）を渡すと、消費国別・在庫循環の表が描画され、5市場すべての記録が出力に含まれる", () => {
  assert.ok(latestRecord.consumerMarketRecords, "companyLab統合ランがconsumerMarketRecordsを確定していること（前提条件）");

  const html = renderToStaticMarkup(
    React.createElement(MarketPanel, {
      marketResult: latestRecord.marketResult,
      globalReasonCodes: latestRecord.globalReasonCodes,
      consumerMarketRecords: latestRecord.consumerMarketRecords,
    })
  );

  assert.ok(html.includes("消費国別・在庫循環"), "「消費国別・在庫循環」の見出しが描画されていること");
  for (const market of Object.keys(DEMAND_MARKET_NAMES) as (keyof typeof DEMAND_MARKET_NAMES)[]) {
    assert.ok(html.includes(DEMAND_MARKET_NAMES[market]), `${market}（${DEMAND_MARKET_NAMES[market]}）の行が描画されていること`);
    assert.ok(html.includes(`（${market}）`), `${market}の市場コード表記が描画されていること`);
  }
});

test("§A-2: consumerMarketRecordsが無い（旧四半期相当）場合、消費国別・在庫循環の表自体が描画されない（エラーにもならない）", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarketPanel, {
      marketResult: latestRecord.marketResult,
      globalReasonCodes: latestRecord.globalReasonCodes,
      // consumerMarketRecordsを意図的に渡さない＝Phase 8F-1より前に保存された記録の再現
    })
  );

  assert.ok(!html.includes("消費国別・在庫循環"), "consumerMarketRecords未提供時は、この表の見出し自体が出ないこと（0埋め・捏造をしない）");
});

test("§A-3: consumerMarketRecordsが空配列の場合も、同様に表が描画されない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarketPanel, {
      marketResult: latestRecord.marketResult,
      globalReasonCodes: latestRecord.globalReasonCodes,
      consumerMarketRecords: [],
    })
  );

  assert.ok(!html.includes("消費国別・在庫循環"), "consumerMarketRecordsが空配列の場合も表が出ないこと");
});

test("§A-4: 描画結果にNaN・Infinity・undefinedという文字列がそのまま出力されない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarketPanel, {
      marketResult: latestRecord.marketResult,
      globalReasonCodes: latestRecord.globalReasonCodes,
      consumerMarketRecords: latestRecord.consumerMarketRecords,
      previousMarketResult: shared.history.length > 1 ? shared.history[shared.history.length - 2].marketResult : null,
      previousPeriodLabel: shared.history.length > 1 ? String(shared.history[shared.history.length - 2].period) : null,
    })
  );

  assert.ok(!html.includes("NaN"), "出力にNaNという文字列が含まれないこと");
  assert.ok(!html.includes("Infinity"), "出力にInfinityという文字列が含まれないこと");
  assert.ok(!html.includes("undefined"), "出力にundefinedという文字列が含まれないこと");
});
