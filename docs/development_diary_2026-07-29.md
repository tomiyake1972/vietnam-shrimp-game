# ShrimpX V2 開発日誌

**対象期間：2026年7月29日**
**対象フェーズ：Phase SAI-1.5 マージ前補完の追加対応、および develop/v2 へのマージ**

## 0. 本日の到達点

前日（2026-07-28）に実施したPhase SAI-1.5（マージ前受入修正）に対する三宅さんの追加ご指示5件に対応し、
`feature/v2-standard-ai-foundation-rebuild`ブランチへ追記・commit・push、続いて三宅さんの承認を得たうえで
**`develop/v2`へマージ・push済み**（マージコミット`da3a36d`、マージ元の最終コミット`b3f5b4f`）。

ゲームバランス・ゲームルール・standard AIの判断ロジック自体は本日の対応でも一切変更していない。本日の変更は
分析・レポート機能の拡張とドキュメントの訂正のみ。

## 1. 三宅さんご指示5件への対応

1. **Test B残差の原因確認（推測ではなく実証）**: 前日レポートでは「会社配列内の処理順によると考えられる」と
   推測のまま記載していたTest Bの残差（会社ごとに数百万USD程度の最終現金差）について、`report/decompose.ts`に
   `runTestBOrderSensitivity()`を新規実装（会社処理順序を正順・逆順・巡回シフトの3通りに変えてTest Bを
   再実行し、会社ID別の最終結果を突き合わせる自動テスト）。結果、5テンプレート×3通りの並び順すべてで
   同一会社IDの最終現金が完全一致し、**残差が会社配列内の処理順序（配列位置）には一切依存しないことを
   実証的に確認した**。実データの直接追跡により、真因は`quality/majorIncident.ts`（会社×工場×商品×ターン
   ごとに独立した乱数ストリームで重大品質事故を判定する既存モジュール）にあることを特定した。Test Bで5社の
   fixtureを統一すると事故発生確率（`operationalRisk.ts`が稼働率ストレス等から算出）は5社で同一になるが、
   事故が実際に発生するかの乱数抽選自体は会社IDに紐づいて独立しているため、「5社のうちどの1社が事故を
   引くか」が残差として現れる。市場配分・原料配分（いずれも会社IDでソート済み、または会社×工場が1:1のため
   競合自体が発生しない設計）には起因しないことも確認した。**ゲームルール自体の修正は行っていない
   （ご指示どおり原因確認のみ）。**
2. **Test Bの再定義**: 最終レポート・アーキテクチャ文書で、Test Bを「同一初期条件＋同一standard AI＋
   同一情報＋同一seed」というSAI-1の**主基準実験**として明記し、BAL/MASS/JPQ/VAP/CONSVの5テンプレートに
   よる実行は「標準初期条件候補の感度分析」として整理し直した（現時点ではいずれの会社の条件も最終的な
   標準条件としては決定していない）。
3. **Test Cの再定義**: 「生産ゼロ・新規契約なし」のTest Cを、通常の経営行動比較ではなく、**初期財務・
   固定費・ゲームルールのみによる耐久性テスト**として明記した。
4. **最終レポートのgit管理**: 三宅さんへ別途送付していた`sai1_5_final_report.md`を
   `docs/v2/reports/sai1_5_final_report.md`としてリポジトリへ格納。生成される`json/`・`csv/`・`html/`は
   引き続きgit管理外だが、再現コマンド（`npx tsx scripts/generateSai1Report.ts <出力先>`）と出力ファイル
   一覧はレポート本体の§15にそのまま維持している。
5. **§14.10と§15.5の食い違いの解消**: アーキテクチャ文書§14.10（Phase SAI-1完了時点の記載、「BAL・CONSVは
   健全」）と§15.5（Phase SAI-1.5の系統的な再検証）の内容が食い違っていた点を実データで検証。**standard AI
   配下ではCONSVも他の3社（MASS/VAP/JPQ）と同様にturn2で`paymentDefault`に陥ることを、複数シード
   （SAI-1本体のテストで使用したシードを含む）で確認した**（既存の`autoPolicy.ts`ではCONSVは今も健全であり、
   §14.10執筆時点はこの2つの方針の挙動を混同していたか、限られたシードでの簡易確認に基づく誤りだったと
   判断）。§14.10・development_diary_2026-07-28.md双方に訂正注記を追加し、使用シード・確認時点・訂正内容を
   明記した。最終レポート冒頭（§1結論）にも同種の旧記述（「BAL・CONSVは一貫して健全」）が残っていたため、
   マージ前に同様の訂正を行った（CONSVはturn2で`paymentDefault`を起こすが、借入余力を活かしてその後回復し、
   32Q時点でほぼ非負まで戻る点をMASS/VAP/JPQ（32Q時点でも大幅な現金不足が継続）との違いとして明記）。

## 2. テスト・回帰

- `report/__tests__/report.test.ts`：既存9件＋新規1件（`runTestBOrderSensitivity`）＝**10件、全件成功**。
- マージ前（`feature/v2-standard-ai-foundation-rebuild`）・マージ後（`develop/v2`）いずれの時点でも実施：
  `npm test`（**全1658件成功**）・`npx tsc --noEmit`（エラー0件）・`npm run lint`（エラー0件、既存の
  無関係ファイルの警告2件のみ）・`npx next build`（全ルート生成成功）。

## 3. マージ・push

- `feature/v2-standard-ai-foundation-rebuild`（`37b9dec`起点に本日2コミット追加、`0264424`→`b3f5b4f`）を
  push後、三宅さんの承認を得て`develop/v2`（マージ前`cd15bef`）へ`--no-ff`でマージ（マージコミット
  `da3a36d`）し、`origin/develop/v2`へpush済み。コンフリクトなし。
- `main`は本日も対象外・未変更。V1コードへの影響もなし。

## 4. 今後の申し送り（SAI-1.5時点）

- Test B（初期条件統一ハーネス）・複数seed分布・§9のTest B残差分析はSAI-2以降のバランス調整でそのまま
  再利用できる（アーキテクチャ文書§14.10・§15.5参照）。
- 最終レポート§12・§13で提示したゲームルール側・AI判断側の変更候補は、いずれも提案のみで未実装。
  三宅さんの方針確認後、SAI-2で対応する。

---

## 5. Phase SAI-2: 標準初期条件の設計と基準テスト（当日追記、develop/v2マージ後の同日中に着手）

三宅さんのご指示「SAI-2開始指示：標準初期条件の設計と基準テスト」に基づき、`develop/v2`（`83324eb`、
SAI-1.5マージ後）から新規ブランチ`feature/v2-sai2-standard-baseline`を作成し、既存5社のどれかをそのまま
標準とするのではなく、独立に設計した「標準初期条件（standard baseline）」を確立した。

### 5.1 実施内容

1. **既存5社の初期条件比較**: 工場能力・ワーカー・養殖能力・商品経済性・財務6項目・初期契約・品質信頼度・
   operational risk初期値等を全項目一覧化（`docs/v2/reports/sai2_standard_baseline_report.md` §2）。
2. **標準初期条件の候補設計（3案）**: 単純平均の機械的採用ではなく、内部整合性を確認したうえで設計した。
   - 候補1 balanced-trimmed（BALの操業条件＋財務余力を調整）
   - 候補2 five-company-blend（既存5社の単純平均。5×平均＝既存5社合計という性質を持つことを確認）
   - 候補3 moderate-pressure（候補2の操業条件＋財務のみ厳格化）
3. **候補別の8Q・32Q・12seed基準テスト**: 既存のTest Bハーネス（`decomposeHarness.ts`）を、既存5社の
   companyIdに紐づかない任意のfixtureテンプレートを扱えるよう汎用化（`buildUnifiedFixturesFromTemplate`・
   `initializeUnifiedCompanyLabFromTemplate`。既存Test Bの挙動は変更なし）し、`runStandardBaselineTest`・
   `runStandardBaselineMultiSeed`を新設して実行した。
4. **選定**: 候補1・候補2は12seedすべて・8Q/32Qいずれでも一度もpaymentDefaultが発生せず「安全すぎる」と
   判断。候補3は8Qで大半のseedが健全に推移しつつ一部seedで支払不能が発生し、32Qで約4割のseedが
   支払不能に至るという、seedによって結果が分かれる分布になり、standard AIの資金繰り・調達縮小・人員調整の
   判断が実際に機能する必要がある状況を再現した。**候補3「moderate-pressure」を標準初期条件として採用した。**
5. **実装**: `app/lib/v2/companyLab/standardAi/report/standardBaseline.ts`を新設し、3候補の定義・選定結果・
   選定済み標準初期条件を返す再利用可能なbuilder（`buildStandardBaselineFixture`等）を実装した。既存5社の
   会社特性（`fixtures.ts`）・standard AIの判断ロジック・ゲームルールは一切変更していない
   （`fixtures.ts`の内部ヘルパー関数を再利用のためexportした以外、既存コードへの変更はゼロ）。

### 5.2 テスト・回帰

- `standardBaseline.test.ts`（新規7件、全件成功）: 選定済み候補IDの実在確認、5社複製後の内部整合性、
  決定論性、moderate pressureという設計意図の恒久的な保証等。
- `npm test`（全件成功）・`npx tsc --noEmit`（エラー0件）・`npm run lint`（エラー0件）・`npx next build`
  （成功）。詳細な件数は本レポート作成時点のコミットログ参照。

### 5.3 commit・push

`feature/v2-sai2-standard-baseline`ブランチへcommit・push済み。**develop/v2へはまだマージしていない**
（実装指示どおり、標準条件を作って基準線を引くところまでが今回のスコープ）。

### 5.4 今後の申し送り

- SAI-3以降の一項目ずつの感度分析（現金・能力・固定費・在庫・市場方針等）は、選定した標準初期条件
  （moderate-pressure）を基準ケースとして、`standardBaseline.ts`の該当フィールドだけを差し替える形で
  実施できる。
- 候補2（five-company-blend）は既存5社合計の供給規模と厳密に整合する性質を持つため、操業条件側の
  純粋な感度分析用の別基準としても保持している。
- SAI-1.5で確認済みの品質事故システム（会社ID単位の独立乱数）に起因する会社間の残差は、標準初期条件でも
  同様に観測される（既知の残差であり、新たな不具合ではない）。
- 詳細はSAI-2レポート（`docs/v2/reports/sai2_standard_baseline_report.md`）参照。

---

## 6. SAI-2追加作業: 市場別営業配置・商品別営業工数の実装と再基準テスト（同日追加）

### 6.1 経緯

三宅さんより、候補3「moderate-pressure」を暫定基準として受け入れつつ、(a) 旧営業ルールではHOSO/PD/VAPの
営業負荷が実質同一である、(b) 候補3の32Q paymentDefault率がやや高い、の2点で「最終確定ではない」との
ご指摘。調査の結果、(a)は設計思想の欠如ではなく実装バグ（`CompanySalesPlanEntry.salesForceHeadcount`が
市場×商品の行単位で持たれ、`allocation.ts`が同じ人数を商品ごとに独立適用してしまう「幽霊能力」）と判明。

### 6.2 実装

- 営業工数係数（HOSO=1.0/PD=1.2/VAP=3.0）・市場単位の人員共有・`C(h)=200+4800h/(h+10)`制約を
  新規モジュール`sales/marketEffort.ts`として実装。`allocation.ts`自体は変更せず、事前パス方式＋
  数学的no-op証明（営業工数係数が全て1.0以上のため、事前パス後は行単位の旧上限が恒等的に非拘束）で
  「同じ制約の二重適用」を回避した。
- 標準AI（`standardAi/decision/sales.ts`）・旧5社AI（`autoPolicy.ts`）双方を、行単位の均等割りから
  市場単位の営業工数比例配分＋自己制約適用（意思決定と実結果の食い違い防止）へ書き換え。
- 新理由コード`SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`（会社ラボ）・
  `SALES_HEADCOUNT_INSUFFICIENT_TOTAL`/`VAP_MIX_INCREASES_SALES_EFFORT_NEED`（標準AI診断）を追加。
- UI（`DecisionEditor.tsx`）の営業人員入力を市場単位で同期する`syncMarketSalesForceHeadcount`を追加。

### 6.3 テスト

directive項目6の10要件すべてに対応する新規テスト18件を作成（`sales/__tests__/marketEffort.test.ts`11件、
`companyLab/standardAi/__tests__/salesEffort.test.ts`4件、`companyLab/persistence/__tests__/salesEffortRoundtrip.test.ts`3件）。
既存テストのうち、市場×商品の行ごとに異なる営業人員を割り当てていたテストヘルパー6ファイルを、
「市場内で人員数は一貫」という新制約に合わせて修正。既存5社アーキタイプ向けの回帰テスト2件
（`runner.test.ts`のVAP特化アーキタイプ、`destinationMarketPricing.test.ts`のBAL）は、営業工数制約による
新たな正当な信用degradeを理由コードで説明可能な場合は許容するよう更新。

### 6.4 候補3の再校正

旧営業人員16人のままでは12seed全てが即座にpaymentDefaultする極端な結果となったため、感度分析（非単調・
カオス的な応答を確認: 16→ほぼ100%、50→16.7%、55→約97%、80→33-50%、120→100%、200→100%）の上、
営業人員80人・現金2,000万USD・短期借入2,400万USD・長期借入3,300万USDへ再校正。8Qは狙いどおり
moderate（33-50%）になったが、32Qは完走seed（7/12、残り5seedは既存の浮動小数点許容誤差バグで実行不能）に
限っても57-100%とやや厳しい。詳細・トレース・申し送りは`docs/v2/reports/sai2_standard_baseline_report.md`
§10を参照。

### 6.5 検証・commit・push

`npm test`（全1683件成功）・`npx tsc --noEmit`（エラー0件）・`npm run lint`（エラー0件、既存の無関係な
warning2件のみ）・`npx next build`（成功）。`feature/v2-sai2-standard-baseline`ブランチへcommit・push済み。
**develop/v2へはマージしていない**（実装指示どおり）。

### 6.6 今後の申し送り

- 既存5社アーキタイプの営業人員総数は営業工数ルール導入前の値のまま。再校正が必要かはSAI-3以降の判断。
- `finance/quarterClose.ts`の`HEADCOUNT_EPSILON`許容誤差バグ（既存・無関係）は修正せず報告のみ。
- 営業人員総数に対するpaymentDefault率の非単調・カオス的な感度は未解明。SAI-3での追加調査を推奨。
