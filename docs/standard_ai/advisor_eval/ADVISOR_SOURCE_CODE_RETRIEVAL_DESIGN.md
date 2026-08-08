# 相談役AI ソースコードRetrieval 設計と実装（品質強化Batch 1・§9〜§11）

作成日: 2026-08-08
実装ブランチ: `feature/v2-management-advisor-ai-mvp`
結論: **Option A（軽量MVP）を実装した**（設計のみに留めず、動く形で入れた）

---

## 1. なぜ必要だったか

相談役AIの `sourcePolicy` は次を宣言していた。

> 情報源の優先順位: (1) 現行実装コード / GitHub上の正式文書
> (authority=CURRENT_IMPLEMENTATION, FORMAL)、(2) 作業資料（WORKING）、(3) 過去の資料（HISTORICAL）

ところが MVP では **コードを一切参照していなかった**。
`docCatalog.ts` の分類規則にも `CURRENT_IMPLEMENTATION` を返す規則が1つも無く、
実際に到達しうる最高authorityは `FORMAL`（docs配下のmarkdown）だった。

つまり相談役AIは、**最上位の情報源が空のまま「現行実装では〜」と語れる状態**だった。
これは次の2点で直接の品質問題になる。

- **根拠追跡可能性**（優先順位3）… 「現行実装では」の出所を辿れない
- **ハルシネーション耐性**（優先順位4）… 文書が古い／存在しない論点で、実装を推測で語れてしまう

docs は「なぜそうしたか」（設計意図・経緯）には強いが、
「**今どうなっているか**」の一次情報ではない。ゲームの仕様質問の多くは後者である。

---

## 2. 選択肢の比較

| | Option A: 軽量MVP | Option B: 設計のみ |
|---|---|---|
| 品質への効果 | 最上位の情報源が実際に埋まる | 変わらない（穴が残る） |
| 追加依存 | なし（既存のキーワード検索を corpus 差し替えで再利用） | なし |
| 追加インフラ | なし（vector DB・embedding・外部SaaSを追加しない＝§11遵守） | なし |
| prompt増加 | 上限3件×1,200文字＝約4KB（構造的に固定） | なし |
| 実装量 | 1ファイル新規＋retrieval に関数1つ | 0 |
| リスク | corpusのメモリ（約1.8MB）、Vercelへの同梱設定漏れ | なし |

**Option A を選んだ理由**: 今回のBatchは品質最優先であり、
「最上位の情報源が空」という穴は速度・コストで正当化できる種類のものではない。
かつ Option A は新しい依存・新しいインフラを1つも増やさずに閉じる。
§11 が禁じている「勝手に大規模indexerを導入する」には該当しない。

---

## 3. 実装

### 3.1 対象範囲（whitelist）

`app/lib/v2/companyLab/advisorAi/knowledge/sourceCodeStore.ts` の
`SOURCE_CODE_WHITELIST`:

```
app/lib/v2/sales
app/lib/v2/production
app/lib/v2/rawMaterials
app/lib/v2/finance
app/lib/v2/financing
app/lib/v2/capex
app/lib/v2/market
app/lib/v2/quality
app/lib/v2/turn
app/lib/v2/companyLab/standardAi
```

除外: `__tests__` / `*.test.ts` / `cli` / `scripts`。
テストは仕様の根拠にならず、検索結果を汚すだけである。
UI（`app/v2`）・APIルートも入れていない（仕様の質問の答えにならない）。

**実測**: 151ファイル / 1,986 chunks / 約1.80MB。docs（2.3MB）より小さい。

### 3.2 chunk化

構文解析はしない（パーサ依存を増やさない）。
インデント0の宣言行（`export function` / `const` / `interface` / `type` / `class` / `enum`）を境界にする。

**宣言直前の連続コメント行は、次のchunk側へ移す。**
このリポジトリは設計意図・単位・禁止事項を宣言直前の日本語ブロックコメントに書く規約であり、
コメントを切り離すと「なぜそうなっているか」が失われて、引く価値が大きく落ちる。

1 chunk 上限 1,200文字（docs側と同値）。

### 3.3 メタデータ

| 項目 | 値 | 理由 |
|---|---|---|
| `documentType` | `SOURCE_CODE` | docCatalogの分類規則の対象外。sourceCodeStoreが直接付ける |
| `authority` | `CURRENT_IMPLEMENTATION` | sourcePolicyが定める最上位 |
| `sourceType` | `FORMAL_SPEC` | 既存のsourceTags語彙に「コード」が無いため、正式仕様として扱う |
| `documentDate` | `null` | mtimeはgit cloneの時刻であり更新日ではない。コードは常に「現在」なので日付を持たせない |

### 3.4 検索

`retrieval.getCurrentImplementation(topic)` は
`searchDevelopmentDocs` に corpus を差し替えて呼ぶだけ。
**検索アルゴリズムも依存関係も1つも増えていない。**

既定 limit = 3（docsの6より小さい）。コードは1件が長く情報密度も違うため、
promptへ入る量を構造的に絞る（§10「コード全文を大量送信しない」）。

### 3.5 いつ引くか

`questionRouting.planRetrieval` の `includeCurrentImplementation`。
仕様・設計・「なぜ」系（`needsDocs`）のときだけ true。
経営相談（PL・資金・ボトルネック）では **引かない**。
コードは経営相談の答えにならず、promptを太らせるだけである（§22）。

### 3.6 promptでの扱い

`<C2_current_implementation>` という独立ブロックとして渡す。
`<C_formal_specification>`（文書）とも `<D_development_knowledge>`（経緯）とも混ぜない。
順序も 現行実装 → 開発記録 の優先度順にしてある。

読み込めなかった場合は「実装コードを参照できませんでした」と伝え、
**現行実装の挙動を断定してはいけない**と明示する（黙って推測で埋めさせない）。

### 3.7 Vercelでの可用性

`.ts` のソースはビルド後のFunctionに残らない。
`next.config.ts` の `outputFileTracingIncludes` へ whitelist と同じディレクトリを追加した。

**あわせて発見した既存の不具合**: これまで `outputFileTracingIncludes` は
advisor の **APIルートにしか** 設定されていなかった。
しかし UI は Server Action（`askAdvisorAction`）経由で相談役AIを呼んでおり、
Server Action は **ページのFunction** の中で実行される。
つまり本番では `/v2/company-lab/play/[labId]` 側に docs/ が同梱されておらず、
実際にUIから使ったときには開発記録を読めていなかった可能性が高い。
今回、両方のルートに設定した。

---

## 4. 既知の限界（今回は直していない）

1. **検索精度**。キーワードbigram一致であり、意味検索ではない。
   実測では「営業人員の販売能力はどう決まるの？」→ `standardAi/decision/sales.ts` が1位と
   妥当だったが、「設備投資のリードタイムは？」では `capex/` が上位に来なかった。
   語彙のずれ（質問語とコード内語彙）が原因であり、改善するなら
   ファイル名・ディレクトリ名への一致重みを上げるのが次の一手（vector DBは不要）。
2. **メモリ**。docs（2.3MB）とコード（1.8MB）の2 corpus をプロセス内に保持する。
   Functionのメモリ上限に対しては小さいが、増え続ける場合は上限（`MAX_TOTAL_BYTES`）で頭打ちにしてある。
3. **関数単位より粗い**。長い関数は1,200文字で機械的に切られるため、
   1 chunkが関数の途中で終わることがある。
4. **whitelistの手動同期**。`SOURCE_CODE_WHITELIST` と `next.config.ts` の
   リストは手で一致させる必要がある。片方だけ増やすと、ローカルでは動いて本番で読めない。
