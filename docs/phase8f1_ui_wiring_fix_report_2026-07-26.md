# Phase 8F-1 UI配線漏れ修正 完了報告

作成日：2026年7月26日
対象ブランチ：`fix/v2-consumer-market-ui-wiring`（`develop/v2` HEAD `0943325` から分岐。まだ`develop/v2`へはマージしていません）

---

## 1. 実際に変更したファイルと行

| ファイル | 内容 |
|---|---|
| `app/v2/company-lab/page.tsx` | 363行目・374行目に `consumerMarketRecords={displayedRecord.consumerMarketRecords}` を1行ずつ追加（自社表示用の`<MarketPanel>`呼び出しと、GM全社表示用の`<MarketPanel>`呼び出しの各1箇所ずつ） |
| `app/v2/company-lab/__tests__/marketPanelConsumerMarketWiring.test.ts`（新規） | 回帰テスト6件（詳細は3章） |

`MarketPanel.tsx`本体、消費国在庫モデル（`consumerInventory.ts`）、価格形成ロジックには一切手を加えていません。差分は合計2ファイル・152行追加のみです。

---

## 2. `MarketPanel`の全呼び出し箇所の確認結果

リポジトリ全体（`app/`以下）を検索し、`<MarketPanel`という実際のJSX呼び出しを含むファイルを洗い出しました（コメント中の文字列一致は除外）。

| 呼び出し元ファイル | 箇所数 | どの画面か | `consumerMarketRecords`を渡しているか |
|---|---|---|---|
| `app/v2/company-lab/page.tsx` | 2箇所（自社表示・GM全社表示） | GM・開発者向け統合テスト画面（`/v2/company-lab`） | **修正前：渡していなかった → 修正後：両方とも渡している** |
| `app/v2/company-lab/play/[labId]/PlayerScreenClient.tsx` | 1箇所 | 本番のプレイヤー画面（`/v2/company-lab/play/[labId]`） | 元から渡している（Phase 8F-1時点で配線済み） |

`app/v2/company-lab/components/financial/FinancialResultsSection.tsx`にも"MarketPanel"という文字列がありますが、これはコメント内の言及のみで、実際の呼び出しはありません。他にリポジトリ内で`MarketPanel`を実際に呼び出している箇所は見つかりませんでした。

---

## 3. 追加・変更したテスト

新規ファイル`marketPanelConsumerMarketWiring.test.ts`に6件追加しました（全件成功）。

| テストID | 内容 |
|---|---|
| §B-1 | `MarketPanel`の実際の呼び出し箇所が、page.tsx（2箇所）・PlayerScreenClient.tsx（1箇所）の合計3箇所のみであることをソースから機械的に確認 |
| §B-2 | 上記すべての呼び出しが`consumerMarketRecords=`を実際に渡していることをソースから機械的に確認（今回まさに漏れていた配線そのものを検知する） |
| §A-1 | 実際のcompanyLab統合ラン（2四半期）の本物のデータを`react-dom/server`の`renderToStaticMarkup`で描画し、「消費国別・在庫循環」の見出しと5市場すべての行が出力に含まれることを確認 |
| §A-2 | `consumerMarketRecords`を渡さない場合（旧四半期相当）、表の見出し自体が出力されないことを確認 |
| §A-3 | `consumerMarketRecords`が空配列の場合も同様に出力されないことを確認 |
| §A-4 | 描画結果に`NaN`・`Infinity`・`undefined`という文字列がそのまま出力されないことを確認 |

**page.tsx自体のクリック操作込みの描画テストを追加しなかった理由**：このリポジトリには、Reactコンポーネントを実際に描画してクリック等の操作をシミュレートするテスト基盤（jsdom・React Testing Library等）が一切導入されていません（package.jsonにも存在しません）。page.tsxは「初期化」→「1四半期進める」→タブ切替、という一連の操作を経て初めて`MarketPanel`へ到達するクライアントコンポーネントであり、これをテストするには新たにテスト基盤を導入し、page.tsx側もテストしやすい構造へ手を入れる必要があります。これは「配線追加に限定する」という今回の修正スコープを明らかに超える規模になるため、指示に従い独断でのリファクタリングは行いませんでした。

代わりに、`MarketPanel`自体が`"use client"`指定のない・独自の状態を持たない純粋な関数コンポーネントであることを利用し、`react-dom/server`だけ（新規依存ライブラリ不要）で実際のエンジン出力を描画し、表示内容そのものを検証する方式（§A-1〜§A-4）と、「配線が実際に渡っているか」をソースレベルで機械的に検知する方式（§B-1・§B-2）を組み合わせることで、今回の不具合の再発を検知できる、規模相応の回帰テストとしました。

---

## 4. 旧四半期の後方互換確認

- 自動テスト§A-2・§A-3で、`consumerMarketRecords`が未提供・空配列の場合に表自体が出ないこと（0埋め・捏造をしないこと）をエラーなく確認済みです。
- 今回のPreview環境は`develop/v2`統合後の最新コードで新規に四半期を実行したものであり、実際に「Phase 8F-1より前に保存された、この項目が存在しない古いデータ」を画面上でクリックして再現することはできませんでした（この環境ではエンジン自体が最初の四半期からこの項目を計算するため）。この観点の実地確認は自動テスト（§A-2・§A-3）と、Phase 8F-1完了報告に記載済みの永続化層テスト（`isConsumerMarketStateEmpty`・`restoreConsumerMarketStateFromHistory`等）に基づくものであり、実機での「本物の旧セーブデータ」でのクリック確認ではない点は正直に申告します。

---

## 5. 統合テスト画面（`/v2/company-lab`）での表示結果

Preview環境で「初期化」→「8ターン一括実行（全社自動方針）」→「結果」タブを操作し、実際に確認しました。

- **自社表示（BAL）**：「消費国別・在庫循環（消費・在庫・購買）」の表が表示され、CN/US/EU/JP/OTHERの5市場すべてで、期首在庫・実消費・希望購買・実購買・期末在庫・在庫月数・目標月数・購買圧力指数・局面が表示されることを確認（スクリーンショット1枚目）。
- **GM全社表示**：同じ表が同一内容で表示されることを確認（市場情報は全社共通の公開情報のため一致するのが正しい挙動です。スクリーンショット2枚目）。
- 表示内容に`NaN`・`Infinity`・`undefined`は一切現れていません。
- この8四半期のランでは、5市場すべてが「在庫逼迫」局面（期末在庫0トン）になっていました。これは世界全体の供給がやや不足気味な`baseline-v0.1`シナリオの既存の性質（Phase 8F-1完了報告でも報告済み）であり、今回のUI配線修正やモデル自体の不具合ではありません。

**画面の見やすさについて**：表は既存の他3つの表（消費国別参照価格・産地国別FOB価格・基礎指標）と同じ様式（横スクロール可能なテーブル、既存の`panelStyles`相当のクラス）で統一されており、著しく見づらいという印象は受けませんでした。強いて挙げれば、9列という列数のため、狭い画面幅では横スクロールバーが必要になります（スクリーンショットにも表示されています）が、これは既存の他の表と同じ挙動であり、今回新たに導入した問題ではないため、UIの独自再設計は行っていません。

---

## 6. 本番プレイヤー画面（`/v2/company-lab/play/[labId]`）での表示結果

**この画面の実機確認は完了できませんでした。** `/v2/company-lab/play/new`へアクセスすると、スタッフ用の管理トークン（`STAGING_ADMIN_TOKEN`）を要求するログイン画面（`/v2/company-lab/play/login`）へ転送されました。このトークンは`docs/staging_environment.md`にも明記されているとおり、パスワードと同等の秘密情報として扱うべきものであり、私はこの値を持っておらず、チャットでの共有をお願いすることも避けました。そのため、このトークンが必要な画面のクリック確認はできていません。

この画面についての根拠は、以下の間接的な検証にとどまります。

- ソースコード上、Phase 8F-1時点から一貫して`consumerMarketRecords`が`viewModel.ts`→`PlayerScreenClient.tsx`→`MarketPanel`へ正しく配線されていることを確認済み（今回の修正でも変更していません）。
- `MarketPanel`コンポーネント自体は、統合テスト画面・本番プレイヤー画面のどちらから呼ばれても同一のコンポーネントであり、§A-1〜§A-4のテストで実際のエンジン出力を使った描画確認をしているため、コンポーネント自体の表示ロジックが機能することは実データで検証済みです。
- 5. の統合テスト画面での実機確認により、「エンジン→consumerMarketRecords→MarketPanel」という同じデータの流れが実際のブラウザ上で問題なく機能することを確認済みです。

もし三宅さんご自身で管理トークンをお持ちであれば、`https://vietnam-shrimp-game-staging-git-fix-v2-consumer-013c62-tomiyake.vercel.app/v2/company-lab/play/new`からテストラボを1件作成し、意思決定を提出→四半期処理を実行した上で、「市場情報」パネルに同じ表が表示されることをご確認いただくことをお勧めします。

---

## 7. Preview URLと対象コミット

```
Preview URL: https://vietnam-shrimp-game-staging-git-fix-v2-consumer-013c62-tomiyake.vercel.app
対象コミット: e896354b71ee65bac28152c2f89fdd85e7a67df1（fix/v2-consumer-market-ui-wiring HEAD）
デプロイ先: Vercelプロジェクト「vietnam-shrimp-game-staging」（APP_ENV=staging）
```

---

## 8. 全検証結果

| 項目 | 結果 |
|---|---|
| TypeScript（`tsc --noEmit`） | エラー0件 |
| ESLint | エラー0件（既存の無関係な警告2件のみ） |
| 関連テスト（`marketPanelConsumerMarketWiring.test.ts`） | 6件・全件成功 |
| 全テスト（`npm test`） | **1586件・全件成功**（Phase 8F-1完了報告時点の1580件＋今回の6件） |
| production build（`npm run build`） | 成功（全ルート正常にコンパイル） |
| 統合テスト画面（`/v2/company-lab`）の実機確認 | 完了（5章参照） |
| 本番プレイヤー画面（`/v2/company-lab/play/[labId]`）の実機確認 | **未完了**（管理トークン未保有のため。6章参照） |

---

## 9. 修正ブランチ・コミット・状態

```
修正ブランチ名: fix/v2-consumer-market-ui-wiring
最終コミットSHA: e896354b71ee65bac28152c2f89fdd85e7a67df1
ローカルHEAD: e896354b71ee65bac28152c2f89fdd85e7a67df1
リモート(origin)HEAD: e896354b71ee65bac28152c2f89fdd85e7a67df1（一致）
作業ツリー: クリーン（未コミットの変更なし）
```

`develop/v2`へはマージしていません。既存ブランチ（`develop/v2`・`feature/v2-consumer-market-inventory`・`feature/v2-export-download-ui`・`feature/v2-post-test-redesign-8d`・`main`）は1つも削除していません。既存ゲームデータ・Redisデータ・既存セーブデータのリセットや、productionへのデプロイは一切行っていません。

---

## 10. 三宅さんへのお願い

本番プレイヤー画面（`/v2/company-lab/play/[labId]`）の実機確認だけが完了していません。管理トークンをお持ちの環境で、上記Preview URLから一度ご確認いただけますでしょうか。もし何か表示上の問題が見つかった場合は、都度ご報告ください。
