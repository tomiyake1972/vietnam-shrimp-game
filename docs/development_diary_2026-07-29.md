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

---

## 7. SAI-2最終化追加作業: 32Q完走修正と営業人数感度の原因分解（同日追加）

### 7.1 経緯

三宅さんより、§6の営業工数ルール実装は受け入れるが標準初期条件はまだ最終確定しない、として
4点の追加指示。(1) finance/quarterClose.tsの浮動小数点許容誤差バグを修正、(2) 32Q・12seedを
全て完走させる、(3) 営業人数感度を「カオス」で済ませず原因分解する、(4) 営業人員80人の妥当性を
感度分析の結果から選び直す。ゲームルール（営業工数係数・市場別配置・能力式・0人でも200t基礎能力）
は維持し、能力式の再設計が必要と判断した場合は変更せず代替案を報告する、という制約付き。

### 7.2 浮動小数点許容誤差バグの修正

根本原因: production/labor.tsのassignedRegularHeadcountが商品×工場別に独立してMath.round(x*1e6)/1e6
で丸められており、finance/quarterClose.ts側で丸め後の値を再合計する際、バッチ数に比例して丸め誤差が
蓄積する（旧HEADCOUNT_EPSILON=1e-6固定はこれを考慮していなかった）。単純な許容値の底上げではなく、
「バッチ数×丸め単位/2（丸め誤差の理論上限）＋会社規模×微小な相対誤差」という、誤差の発生源に対応した
headcountBudgetTolerance()へ置換。境界値・明らかな不整合の両方を検証する新規テスト4件を追加し、
全67件成功。

### 7.3 32Q全完走の確認

修正後、候補3（当時の営業人員80人）で12seed×32Q×5社＝全60社ケースが例外なく完走することを確認。
修正前は12seed中5seedが実行不能だった。

### 7.4 営業人数感度の原因分解

directive指定の9点に90/93/95/110を追加した13点で、同一12seed・同一初期条件（営業人員のみ変化）を
完全再実行（全点で例外なし）。四半期ごとのトレースにより、「カオス」ではなく次の2つの構造的メカニズムで
説明できることを特定した。
(1) 営業人員が不足すると営業工数換算能力が慢性的に需要へ届かず、四半期を追うごとに自己資本が緩やかに
    目減りする（32Qでは複利的に効く）。
(2) 自己資本・信用区分がfinancing/borrowingCapacity.tsのunderwritingFrozen条件
    （creditTier=E／重大延滞／債務超過）を一度でも超えると、以後32Q以内に回復した例が一件もない
    「復帰不能な吸収状態」に陥り、生産・販売がゼロに落ち込み固定費だけが発生し続ける。
非単調に見える集計統計は、この単一の閾値通過が32四半期のどこかで起きるか否かという離散的な分岐現象の
集計であり、遷移帯（80〜95人）では8Q発生率が90人の40.0%から93人の0.0%へわずか3人差で崖状に変化する
ことも確認した。

### 7.5 営業人員80人の再評価と90人への変更

累計営業利益で見ると80人は90〜120人（特に100人）に劣後しており、経験的な最適点ではなかったと判断。
90人へ改めた（8Qのmoderateさをほぼ維持しつつ、累計収益性・32Qの深刻度でわずかに優れる）。能力式
（C(h)=200+4800h/(h+10)）自体は100人以降で明確な限界収益逓減を示しており再設計は不要と判断。
非単調性の主因はunderwritingFrozen吸収状態にあることを特定したため、能力式ではなくこちらの代替案
（段階的復帰パス・凍結中の最小操業維持等）を変更せず報告するに留めた。財務条件（現金）だけの調整も
同様に非単調（$25Mが$20Mより悪化するケースを確認）であり、容易な解決策ではないことも確認した。

### 7.6 候補3の最終判定

**「8Q基準としてのみ確定可能」と判定。** 32Qは13点いずれも「moderate」の基準（57-100%は不適格）を
満たす営業人員が見つからなかったため、32Qとしての最終確定は見送り、underwritingFrozenまわりの設計
変更の要否について三宅さんのご判断を仰ぐこととした。詳細は
`docs/v2/reports/sai2_standard_baseline_report.md`§11を参照。

### 7.7 検証・commit・push

`npm test`（全1687件成功）・`npx tsc --noEmit`（エラー0件）・`npm run lint`（エラー0件、既存の
無関係なwarning2件のみ）・`npx next build`（成功）。`feature/v2-sai2-standard-baseline`ブランチへ
commit・push済み。**develop/v2へはまだマージしていない**。

## 8. SAI-2最終訂正: 8Q標準営業人数の再判定とレポート整合（同日追加）

### 8.1 経緯

三宅さんより、§7.5で「90人は80人より累計収益性で明確に優れる」とした結論が、§7.4/report §11.3.1
自身のデータ（90人: 32Q累計営業利益-$23.9M・現金平均-$10.9M、80人: 同+$10.0M・+$5.0M）と矛盾している
との指摘。§6〜§7の他の成果（営業工数ルール実装・浮動小数点許容誤差修正・32Q全60ケース完走・13点感度
分析・underwritingFrozen構造の特定・全1687テスト成功・32Qを今回確定せず別課題とする判断）はすべて
維持したまま、この一点のみを再検証・再判定するよう指示があった。

### 8.2 矛盾の原因

report §11.3.1の表・集計方法（12seed×5社・全60ケース、フィルタなし）自体は再検証の結果正しいことを
確認した。誤りは表の数値ではなく、レポート執筆時の統合段階にあった。90人は32Q発生率が80人より低い
（63.3% vs 81.7%）という一点のみを見て「優れる」と判断し、同じ表にある累計営業利益・現金平均という
より直接的な収益性指標を照合しなかった、統合（narrative）段階での判断ミスと特定した。

### 8.3 8Q基準での80/85/90人再比較

directive指示に基づき、候補3の操業・財務条件を固定し営業人員のみ80/85/90人で振った8Q限定シミュレー
ション（12seed×5社=60ケース）を実施。結果、**85人は8Q発生率が全60ケース・全5社で例外なく100%となる
異常値**であり除外。80人と90人は8Q発生率がほぼ同水準（36.7% vs 40.0%）だが、80人が8Q累計粗利
（$27.7M vs $25.6M）・8Q累計営業利益（$8.2M vs $5.4M）でもわずかに優れ、32Qでも明確に優れる。90人
固有の優位性はturn8時点の追加融資余力（$6.0M vs $3.4M）のみに留まった。営業工数制約の量的な効果
（scaleFactor）は80〜90人いずれでも縮小率0.01%未満と僅少であることも併せて確認した。

### 8.4 最終判定

**営業人員を90人から80人へ差し戻した。** 単にdefault率を目標値に合わせるための選択ではなく、8Q・32Q
双方の収益性・現金指標を総合した結果である。85人は8Qでの過酷さ（(c)基準抵触）により明確に不適格として
除外。32Qは80人でも81.7%と「57-100%は不適格」の基準に抵触するため、引き続き未確定のまま8Q基準として
のみ確定し、underwritingFrozenまわりの設計変更の要否について三宅さんのご判断を仰ぐ課題として維持する。

### 8.5 `underwritingFrozen`記述の訂正（財務ルール自体は変更せず）

§7.4で「復帰不能な吸収状態」と表現した`underwritingFrozen`は、実際には`creditTier`・`severeArrears`・
`insolvent`から四半期ごとに再計算される値であり（`liquidityClose.ts`の延滞カウンタも非延滞四半期で
リセットされる設計）、ゲームルールが恒久的な解除不可を規定しているわけではない。正確には「信用悪化に
より融資余力がゼロとなり、その後の操業停止と固定費流出によって、自力では解除条件へ戻れない事実上の
吸収状態」（自己強化ループによる実質的な帰結）である。財務ルール自体は今回変更せず、32Q標準条件の
設計課題として申し送る。

### 8.6 変更ファイルと検証

`standardBaseline.ts`（`salesForceHeadcountTotal`を90→80へ差し戻し、label/description/rationale/
コメントを更新）・`sai2_standard_baseline_report.md`（§11.3.2/§11.4/§11.5/§11.6/§11.7に訂正注記を
追加、旧記述は削除せず維持、§11.10〜§11.12を新設）・本日誌§8を追加。検証結果は
`sai2_standard_baseline_report.md` §11.12参照。`feature/v2-sai2-standard-baseline`ブランチへ
commit・push。**develop/v2へはまだマージしていない**。

## 9. SAI-2受入・develop/v2統合（同日追加）

### 9.1 経緯

三宅さんよりコミット`4928593`（§8の最終訂正）を受入と判定。統合前にVercel本番プロジェクトの
デプロイfailureの原因判定、`develop/v2`への統合、次フェーズ申し送り事項の記録を指示された。

### 9.2 Vercel本番（`vietnam-shrimp-game`）failureの原因判定

`vietnam-shrimp-game`（本番プロジェクト）のビルドログを確認した結果、エラーは
`Error: [redis] 環境変数 "STAGING_KV_REST_API_URL" が設定されていません（appEnvironment="staging"）`
であり、TypeScriptのコンパイル自体（`Finished TypeScript in 11.6s`）は成功していた。

このプロジェクトのデプロイ履歴を遡って確認したところ、**同一コードでも`vietnam-shrimp-game-staging`
プロジェクトでは成功（READY）し、`vietnam-shrimp-game`プロジェクトでは同じコミットが失敗（ERROR）する**
という組み合わせが、develop/v2の既存コミット（例: `83324eb`・`da3a36d`）や、SAI-2着手より何週間も前の
無関係な過去のfeatureブランチ（`feature/v2-8g-remaining`等）を含め、確認できた範囲すべてで一貫していた。
一方、`main`ブランチ（target=production、コミット`3ae9485`）のデプロイは`READY`（`live`状態）であり、
本番として実際に稼働しているのはこちらである。

**判定: SAI-2とは無関係な、既存のVercelプロジェクト設定上のギャップである。** `vietnam-shrimp-game`
プロジェクトのPreview（非productionターゲット）ビルドは、appEnvironment判定が"staging"に解決される
一方、`STAGING_KV_REST_API_URL`という環境変数がこのプロジェクトには設定されていない（おそらく
`vietnam-shrimp-game-staging`プロジェクト側にのみ設定されている）ため、`main`以外のブランチをこの
プロジェクトへpushするたびに毎回同一の理由で失敗する。SAI-2のコード変更がこの失敗を新たに発生させた
ものではなく、また実際の本番稼働（`main`・target=production）には影響しないため、**SAI-2の範囲では
修正不要と判断した**（プロジェクト設定自体の是非は別途のインフラ課題として、必要であれば三宅さんの
ご判断を仰ぐ）。

### 9.3 develop/v2への統合

`develop/v2`（`83324eb`）は`feature/v2-sai2-standard-baseline`（`4928593`）の祖先だったため、
**fast-forwardで統合**（`git merge --ff-only`）。新たなマージコミットは作成されず、`develop/v2`は
そのまま`4928593`を指す。`main`は変更していない（`3ae9485`のまま）。

統合後、`develop/v2`上で全検証を再実行: `npm test`（1687件成功）・`npx tsc --noEmit`（エラー0件）・
`npm run lint`（エラー0件、既存の無関係な警告2件のみ）・`npx next build`（成功）。stagingデプロイ
（`vietnam-shrimp-game-staging`、`develop/v2`ブランチ、コミット`4928593`）が`READY`になったことを
確認した。

### 9.4 次フェーズへの申し送り（SAI-2を止めず、別課題として記録）

以下2点は今回のSAI-2の範囲では確定・実装せず、次フェーズの課題として切り出す。

1. **営業人員85人だけが8Q paymentDefault率100%になる離散的分岐の原因**: §11.10.2で発見した異常値
   だが、原因は現時点で未特定であり、**「underwritingFrozen吸収状態が原因」と断定しない**。
   `paymentDefaultBy8Q`は「8Q中に一度でも延滞ストリークが発生したか」を示す履歴フラグであり、
   turn8時点で財務健全に回復しているケース（例: 85人・BAL/seed001はturn8時点でcash=$3.2M・
   cumOp=$6.2Mといずれも黒字）も含むため、この統計だけでは根本原因を特定できない。85人固有で
   何が起きているのかの原因分解は別課題とする。
2. **standard AIの事前調整前希望量と調整後計画量の比較による、営業工数制約の実質的な経営判断への
   影響測定**: §11.10.2ではscaleFactor（発火した市場のみの実測倍率）が0.01%未満と僅少であることを
   確認したが、これはあくまで発火した市場の事後倍率であり、standard AI自身が事前に自己調整する前の
   「希望量」との差分は未計測である。事前希望量と調整後計画量を明示的に比較し、営業工数制約が実際に
   どの程度の量を切り詰めているかを定量測定することを、次フェーズの課題として記録する。

### 9.5 統合後の状態

- `develop/v2`: `4928593`（fast-forward、新規マージコミットなし）
- `main`: `3ae9485`のまま変更なし
- `feature/v2-sai2-standard-baseline`: `4928593`のまま維持（削除していない）
- stagingデプロイ: `develop/v2`ブランチのプレビュー（コミット`4928593`）が`READY`
- 本番（`main`、target=production）: 引き続き`3ae9485`のまま`READY`（本統合による影響なし）

## 10. SAI-3A: 標準AI自動テストプレイ・判断記録基盤（同日追加）

### 10.1 経緯

`develop/v2`（`5c1d62e`）を起点に`feature/v2-sai3a-autoplay-logging`を作成し、標準AIを
テストプレイヤーとして5社×複数seedで自動運転し、「四半期開始時状態→事前希望案→
調整過程→最終意思決定→四半期結果」を構造化ログとして記録する再利用可能な実行基盤を
構築した。詳細は`docs/v2/reports/sai3a_autoplay_logging_report.md`を参照。Excel分析
ブック自体（SAI-3B）・Vercel自動運転ボタン・ゲームバランス評価・標準AIの大幅改造は
今回のスコープ外。

### 10.2 実装の要点

既存の実行系（`report/decomposeHarness.ts`のハーネス・`policy.ts`の
`createStandardAiProvider`・`companyLab/runner.ts`の`procurementConstraint`・
`sales/marketEffort.ts`の営業工数計算・既存2種類のreason code registry）を一切
重複実装せず、新規モジュール`companyLab/standardAi/autoplay/`配下で「読み取って
詰め直すだけ」の純粋関数群として構築した。既存コードへの変更は、AIが内部で
計算しながら外部へ返していなかった「営業工数制約前の希望販売数量」を追加で
公開する2ファイルへの非破壊的な追加（`sales.ts`の`SalesWishEntry`、`policy.ts`の
`salesWishByMarketProduct`）のみで、他は新規ファイルのみ。

実装過程で、営業工数換算能力・使用量を会社全体人員から単純計算すると、市場別の
基礎能力フロアの積み上げ効果により使用率が100%を大きく超える不自然な値になる
実装ミスを発見し、実際の市場別配分から正しく再計算する方式へ修正した
（レポート§8.1）。

### 10.3 標準実行（5社×12seed×8Q、営業人員80人）の結果

完了60/60ケース、`paymentDefault`発生率48.3%、`underwritingFrozen`到達率0%。
希望数量に対し最終計画数量は約49.9%少なく、営業工数換算での使用率はちょうど
100%（標準AIが常に能力上限まで販売計画を組んでいることと整合）。詳細はレポート
§9参照。

### 10.4 営業人員80/85/90人比較による、SAI-2申し送り事項（85人だけ8Q
`paymentDefault`率100%）の再診断

同一12seed・同一5社・8Qで比較した結果、80人48.3%・85人**96.7%**・90人43.3%と、
85人だけが突出して高い傾向は新しいデータでも強く再現したが、旧SAI-2調査時の
「ちょうど100%」は再現しなかった（60件中58件）。`underwritingFrozen`到達率は
80/85/90いずれも0%であり、**`underwritingFrozen`が原因ではないことを確認した**
（三宅さんの指示どおり、原因と断定する特別扱い・85人だけを正常に見せる個別補正は
一切行っていない）。直接的な引き金は、該当四半期の期末現金が実際にマイナスへ
落ち込むこと（80・90人では同じ四半期で$0に留まる）で、その背景として生産商品
ミックス（HOSO/PD/VAP）がheadcountに対して単調ではなく閾値的に切り替わる現象を
観測したが、根本原因の確定には標準AIの生産・営業優先度ロジックの詳細解析が必要で
あり、候補メカニズムとして報告するに留める（今回は特定・修正しない）。詳細は
レポート§10参照。

### 10.5 テスト・検証

新規テスト32件（同一seed再現性・異なるseedでの変化・ログ件数・希望と最終決定の
区別・調整ログの内部整合性・営業工数制約のトレース可能性・最終決定ログと
runner入力の一致・四半期結果ログと実結果の一致・default発生後のログ非欠落・
バッチのエラー隔離・schema version保持・出力の再読み込み可能性）すべて成功。
既存テストを含む全体スイート`npm test` 1,719/1,719件成功（既存1,687件は無変更で
成功、新規32件を追加）。`tsc --noEmit`・`lint`・`next build`いずれも成功。

### 10.6 状態

- `feature/v2-sai3a-autoplay-logging`（`develop/v2`の`5c1d62e`起点）へcommit・push。
- **`develop/v2`へはまだマージしていない**（三宅さんの指示どおり）。
- `main`は無変更。


## 11. SAI-3A受入・develop/v2統合（同日追加）

### 11.1 受入判定

三宅さんより、commit `34dd865`（`feature/v2-sai3a-autoplay-logging`のtip、SAI-3A
「標準AI自動テストプレイ・判断記録基盤」一式）について、以下すべてを含め完成・
受入と判定するとの指示があった: 標準AIによる5社・複数seedの自動運転／8Q・32Qおよび
会社・seed・営業人数の実行時指定／状態→希望→調整→最終決定→結果の構造化ログ／
市場別・商品別の営業工数制約前後トレース／runner入力および四半期結果との整合／
ケース単位のエラー隔離／JSON・CSV・JSONL出力／schema versionと再現条件の保存／
サンプルfixtureと設計文書／32件の新規テスト／全1719テスト・tsc・lint・build成功／
85人異常分岐の診断結果。

### 11.2 develop/v2への統合

`develop/v2`（統合直前`5c1d62e`）が`feature/v2-sai3a-autoplay-logging`（`34dd865`）の
祖先であることを`git merge-base --is-ancestor`で確認したうえで、`git merge --ff-only`
によりfast-forward統合した（マージコミットは生成されず、`develop/v2`は`5c1d62e`から
`34dd865`へ直接前進）。`main`は一切操作しておらず、統合前後を通じて`3ae9485`のまま
不変である。

### 11.3 統合後の全検証

`develop/v2`（`34dd865`）上で以下をすべて再実行し、成功を確認した。

- `npx tsc --noEmit`: エラー0件。
- `npm test`: 1,719 / 1,719件成功（既存1,687件＋SAI-3A新規32件、失敗0件）。
- `npm run lint`: エラー0件。既知の無関係な警告2件（`app/lib/v2/redis/__tests__/
  companyLabExportAuditLog.test.ts`内の`'_value'`・`'_options'`未使用引数、SAI-3A
  以前から存在する既知事象で今回のスコープ外のため未対応）のみ。
- `npx next build`: 成功、全ルート生成。

### 11.4 デプロイ確認

`develop/v2`へのpushにより自動トリガーされたデプロイを確認した。

- **staging**（Vercelプロジェクト`vietnam-shrimp-game-staging`）:
  デプロイ`dpl_8Kgd5KamEEYp59v9W67Z7VmgENqd`が`READY`（成功）。
- **本番Vercelプロジェクト**（`vietnam-shrimp-game`）側のPreviewビルド
  （デプロイ`dpl_4tmMjhuPYQyAZ5kUPwQq6KQPchVt`、`develop/v2`ブランチ・commit
  `34dd865`）は`ERROR`。ビルドログを実際に取得して確認した結果、エラーは
  `Error: [redis] 環境変数 "STAGING_KV_REST_API_URL" が設定されていません
  （appEnvironment="staging"）。...`であり、これはSAI-2統合時（§9.2）に
  確認済みの、本番プロジェクトに`STAGING_KV_REST_API_URL`環境変数が設定されて
  おらず全Previewビルド（`main`以外の全ブランチ）が失敗する既知の設定ギャップと
  完全に一致するテキストであった。同プロジェクトの過去デプロイ履歴（SAI-1.5・
  SAI-2・SAI-3A期間の全コミット）を確認したところ、`main`以外は例外なく同じ
  パターンで`ERROR`であり、今回のSAI-3A統合固有の新規リグレッションではない
  ことを確認した。三宅さんのご指示（「前回確認済みの同一原因であれば修正不要」）
  どおり、本件は修正不要と判断した。本番の実運用対象は引き続き`main`
  （target=production、commit `3ae9485`のままREADY）であり、影響を受けない。

### 11.5 SAI-3Bへの申し送り事項（三宅さんのご指示を明記）

1. 販売の`desiredQuantityBeforeEffortConstraint`は、本当の営業工数制約前希望量
   である。
2. 調達の`wish`はAI提出希望量であり、資金制約後の`final`と比較できる。
3. 生産・労務・財務の`wish`はAI提出計画であり、必ずしも標準AI内部の全調整前の
   値ではない。
4. 数値化できない標準AI診断はreason codeのみであり、存在しないbefore/afterを
   捏造しない。
5. SAI-3BのExcelでは、1〜4をすべて同じ「制約前希望量」と表示しない
   （ドメインごとに意味論が異なるため、列見出し・注記を分ける）。
6. 85人異常分岐は未解決課題として残し、個別補正しない。
7. SAI-3Bでは営業人数80・85・90の比較を可視化できる構造にする
   （`--headcount`引数による独立run-idはすでに実施済みで対応可能）。

詳細な技術的根拠は`docs/v2/reports/sai3a_autoplay_logging_report.md`§11
（11.1〜11.8）に展開・記録済み。

### 11.6 最終状態

- `develop/v2` = `34dd865`（`origin/develop/v2`とも一致、push済み）。
- `main` = `3ae9485`（`origin/main`とも一致）、本統合を通じて完全に無変更。
- `feature/v2-sai3a-autoplay-logging`ブランチは削除せず保持。
- SAI-3Bの実装は、三宅さんの指示どおり本セッションでは着手していない
  （本節はSAI-3A統合完了の記録のみ）。

## 12. SAI-3B-1: Excel経営分析ブック第1版（同日追加）

`feature/v2-sai3b-excel-analysis`ブランチ（`develop/v2`の`b1733e1`起点）で、
SAI-3Aの出力を人間が分析できるExcelブックへ変換する基盤を実装した。`main`・
`develop/v2`は一切操作していない（今回はfeatureブランチへのcommit/pushのみ、
マージなし）。

- 新規実装は`app/lib/v2/companyLab/standardAi/sai3b/`配下と
  `scripts/sai3bExcel.ts`のみ。ゲームエンジン・標準AIロジックは無変更。
- Excelライブラリは既存依存の`exceljs`をそのまま採用（新規npm依存なし）。
  exceljsがネイティブグラフ非対応のため、既存依存の`jszip`を使い、生成後の
  xlsxへOOXMLグラフパーツを手書きで後注入する`chartInjector.ts`を実装し、
  `openpyxl`・`soffice --headless`（LibreOffice実変換）で破損なきことを
  事前検証済み。
- 18シート構成（README/全体サマリー/グラフ/会社別業績/四半期業績/販売分析/
  調達_生産_在庫/営業能力分析/営業能力_市場別/計画調整分析/
  Default_信用_警告/ReasonCode集計/80_85_90人比較（複数run時のみ）/
  四半期判断トレース/Raw_Case・Quarter・Decision・Adjustment・Warnings）。
- 希望/最終の意味論をドメインごとに区別（販売＝制約前希望vs工数調整後最終、
  調達＝AI希望vs資金制約後最終、生産・労務・財務＝AI提出計画（全調整前では
  ない）、数値化できない診断＝reason codeのみ）し、README・列見出しに明記。
  非搭載ログ項目5件（実際の生産量・実際の販売数量・売掛買掛の期末残高・
  市場別工数換算能力・商品別利益内訳）は捏造せずREADMEに明記。
- 新規テスト63件（parse/loadRun/compareRuns/reasonCodeCatalog/aggregate/
  buildAnalysis/CLI引数解析/CLI結合/writeWorkbook/chartInjector）すべて成功。
  プロジェクト全体テスト1,782件（既存1,719＋新規63）全成功、`tsc`・`lint`・
  `next build`すべて成功。
- 既存のSAI-3A実run4本（12 seed×5社×8Q、80/85/90人）を再利用し、実物2ブック
  を生成: `artifacts/sai3b/standard-h80.xlsx`（約19.7MB、1run）、
  `artifacts/sai3b/headcount-80-85-90-comparison.xlsx`（約69.9MB、3run）。
  どちらも元CSVからの独立再計算とのクロスチェック（default率・総売上・総
  粗利益・「85人だけdefault」フラグの内訳）が完全一致し、LibreOffice実変換・
  グラフオブジェクト解析でも破損・文字化けなしを確認。
- 85人問題の追加診断: headcountごとのdefault率は80人=48.3%・
  **85人=96.7%**・90人=43.3%と非単調であることを実データで再確認。80人・
  90人ではdefaultせず85人だけdefaultする会社×seedの組が17件見つかり
  （独立再計算でも同数・同一内訳）、いずれも初回default発動は第6四半期
  （turn=6）で一致。ただし根本原因（なぜ85人だけ非連続に悪化するか）は
  標準AI・ゲームエンジン側の挙動であり、SAI-3Bのスコープ外として断定して
  いない（三宅さんのご指示どおり85人専用の補正は行っていない）。
- 詳細は`docs/v2/reports/sai3b_excel_analysis_report.md`に記録。SAI-3B-2では
  三宅さん・ChatGPTでの実物レビュー後、シート構成・グラフ・GM分析ブックとの
  関係を改良する予定。
