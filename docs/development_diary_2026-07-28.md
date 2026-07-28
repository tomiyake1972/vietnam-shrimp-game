# ShrimpX V2 開発日誌

**対象期間：2026年7月28日**
**対象フェーズ：(A) 緊急融資満期バグ修正＋調達構成（自社養殖依存）根本原因調査・修正 / (B) 商品別固定費配賦・労務費区分（経営分析Excel向け機能）の実装・Preview検証・develop/v2統合**

## 0. 本日の全体到達点

本日は並行する2つの作業を実施した。

- **A. `fix/v2-procurement-mix-after-emergency-maturity`ブランチ**（`develop/v2`の`89172e2`から分岐、
  4コミット、**develop/v2へは未マージ・push済みでレビュー待ち**）：緊急融資の満期計算バグ修正と、
  それによって可視化された調達構成（自社養殖依存）問題の根本原因調査・最小修正。
- **B. `feature/v2-product-fixed-cost-allocation`ブランチ**（同じく`89172e2`から分岐）：商品別固定費配賦・
  労務費区分のエンジン実装とExport DTO拡張、Preview環境での検証を経て、**本日develop/v2へマージ・push済み**
  （マージコミット`53f384a`）。

以下、A・Bそれぞれの詳細を記す。

---

## A. 緊急融資満期バグ修正 + 調達構成（自社養殖依存）根本原因調査・修正

対象ブランチ：`fix/v2-procurement-mix-after-emergency-maturity`（`89172e2`から分岐、4コミット、
`d83e8c2`→`a82bbcf`→`2c688bc`→`f8f8bbd`）。**develop/v2へは未マージ**（今回は対象外、承認待ち）。

### A-1. 緊急融資の満期バグ修正（`d83e8c2`）

`liquidityClose.ts`の緊急融資`LoanRecord`生成で、`maturityPeriod`に
`plan.underwriting.maturityPeriod ?? period`を使っていたバグを修正した。これは通常融資の審査結果
（否認時は`undefined`→実行四半期へフォールバック）を誤って流用しており、緊急融資が実行四半期内に
`bulletAtMaturity`の満期到来元本として扱われ、即座に延滞判定されうる欠陥だった。

修正：緊急融資自身の`params.emergencyLoan.termQuarters`から`addQuarters(period, termQuarters)`で
独立に満期を算出する（`bankUnderwriting.ts`/`initialPortfolio.ts`と同じ既存パターン）。通常融資が
承認・否認どちらでも同じ結果になることを回帰テスト（EM-4〜EM-6）で確認。既存の通常融資・返済・延滞処理
（FI/FH/EM-1〜3系列）は変更なし。

この修正により、全テストスイート実行で`runner.test.ts`の「調達構成A」テストが1件失敗するようになった。
これは本修正のリグレッションではなく、修正前は本バグ自体が原因で対象シナリオの1社（VAP）が全ターン
「支払不能・重大な資金制約」に誤分類され続けテストの検査対象から除外されていたために隠れていた、
自動方針（auto policy）側の高い自社養殖依存という別問題が、満期計算の是正により初めて可視化されたもの。

### A-2. 調達構成A回帰確認 + 自社養殖依存の根本原因調査（`a82bbcf`、実装なし）

「調達構成A」テストがVAPを正しく検査対象に含むこと（除外されないこと）を固定する回帰テストを追加。
「調達構成A」自体の閾値・除外条件・自動方針ロジックは変更していない。

seed mix-001・12ターンでVAP（archetype: vapSpecialist）を詳細にトレースし、根本原因を特定：

- VAPのarchetypeが目標とする調達構成比はdomestic:0.5/import:0.25/aquaculture:0.25
  （`autoPolicy.ts`の`ARCHETYPE_PROFILES.vapSpecialist`）。企業特性自体は高い自社養殖依存を意図していない。
- `generateAutoPolicyDecision`→`buildAquacultureStockingPlans`は会社の財務状態を受け取れないシグネチャで、
  常に`sourcingMix.aquaculture`基準の満額を計画する。
- `companyLab/runner.ts`のturnInput構築で、`domesticPurchasePlan`は資金制約後の`constrainedDecisions`を
  使うのに対し、`aquacultureStockingPlans`だけは無制約の`decisions`をそのまま使っていた（旧725行目）。
  輸入も`importOrdersBlocked`で二値遮断されるのに対し、自社養殖だけが資金制約の対象から完全に漏れていた。
- 結果、VAPが財務的に困窮した四半期（本シードでは実質ターン2からほぼ継続）では、国内買付が0近くまで
  絞られ輸入も止まる一方、自社養殖だけが計画どおり満額実行され続け、対象6ターン合計で自社養殖依存率が
  68.3%まで積み上がっていた。Phase 6.3が明示的に避けようとした「自社養殖だけの完全自給」を、
  Phase 8B-1の資金制約導入時に意図せず素通りさせていたと判定。

「輸入と同じ二値遮断を自社養殖の池入れにも適用する」という最小修正を試験的に適用したところ、同一シードの
別会社（MASS）で原料在庫が完全に枯渇し例外停止することを確認したため、この場では実装せず停止し、
比較案を別途報告する方針とした（既存仕様と係数だけで安全に修正できる範囲を超えるため）。

検証：`npx tsc --noEmit`（0 errors）／`npm test`（1610件中1609件成功、既知の「調達構成A」1件のみ失敗、
他は全て成功）／`npx eslint app/`（0 errors、既存の無関係な警告2件のみ）／`npm run build`（成功）。

### A-3. 契約充当消費の順序バグ修正（`2c688bc`）

原料調達が枯渇するなどして新規生産がほぼ止まり、既存の完成品在庫だけで古い契約を充当し続けるシナリオで、
`planContractFulfillment`が`lotsAfterProduction`（期限切れ処理前）を見て充当可能と判断した数量が、
`consumeFinishedGoods`の実行までの間に`applyFinishedGoodsExpiryForQuarterEnd`によって消えてしまい、
過剰消費拒否（`ProductionValidationError`）でシミュレーション全体が停止していた。

契約充当の実消費（`consumeFinishedGoods`）を四半期末の期限切れ処理より前に実行する順序へ修正し、
「期限切れは当四半期の契約充当が終わった後に残った未使用在庫にのみ適用される」という意図どおりの順序にした。
`finance/companyLabAdapter.ts`の関連ドキュメントコメントも参照スナップショットの変更に合わせて更新
（ロジック変更なし）。既存の在庫消費バリデーションは緩和していない。

検証：`npx tsc --noEmit`エラー0件。`npm test`1610件中1609件成功（既知の「調達構成A」1件のみ、Step 2で対応予定）。

### A-4. 自社養殖の池入れへの資金制約適用（`f8f8bbd`）

自社養殖の池入れ計画が資金制約を一切受けずに希望どおり実行されていたことが、VAPの自社養殖依存率68.3%の
直接原因と確定していたため、`companyLab/runner.ts`の`constrainedDecisions`構築で、国内買付を縮小するのと
同じ`constraint.scaleRatio`（`financing/liquidityClose.ts`が既に算出している既存の値）を自社養殖の
池入れ数量にもそのまま適用し、`turnInput`へも制約後の値を渡すよう変更した。新しい係数・下限フロアは
追加していない。資金制約が最大（scaleRatio=0）の場合は池入れゼロも許容し、輸入の二値遮断ロジック・
自社養殖の現金支出タイミングは変更していない。

この修正により「調達構成A」テストは成功するようになった。一方でbefore/after比較の結果、VAPが特定シード・
設定下で財務悪化スパイラルに入り、対象期間全体で「重大な資金制約」に分類される（＝調達構成Aの検査対象から
除外される）という、Step 1以前には見られなかった帰結が新たに生じたが、これは自動方針の別の不具合ではなく、
自社養殖への資金制約適用そのものが仕様どおり機能した結果（無制約だった自社養殖が実際の支払能力を超えて
生産・売上を水増ししていたことの是正）であることを確認し、対応方針についてユーザーと合意済み。

### A-5. 最終確認・状態

本日改めて`fix/v2-procurement-mix-after-emergency-maturity`をチェックアウトしてフルテストを実行し、
**1613件全てpass**を確認（当ブランチ最終コミット`f8f8bbd`時点）。working treeはclean。

**現状：4コミット全てpush済みだが、develop/v2へは未マージ。** マージの可否・タイミングは別途指示待ち。

---

## B. 商品別固定費配賦・労務費区分（経営分析Excel向け機能）

対象ブランチ：`feature/v2-product-fixed-cost-allocation`（`89172e2`から分岐）。**本日develop/v2へマージ・
push済み**（マージコミット`53f384a`）。

### B-1. 到達点

「商品別固定費配賦・労務費区分・経営分析Excelの変更」指示に基づき、エンジン実装・Export DTO拡張・Preview
環境での検証を行い、develop/v2へマージした。マージ後、以下を全て確認済み：

- `npm test`：**1614件全てpass**（既存1614件テストに、今回追加した`商品別固定費配賦FC-1〜FC-5`
  （`app/lib/v2/finance/__tests__/quarterClose.test.ts`）とパラメータ検証テスト（`parameters.test.ts`）を含む）
- `npx tsc --noEmit`：エラーなし
- `npm run lint`：0 errors（既存の無関係ファイルの警告2件のみ、今回の変更とは無関係）
- `npm run build`：正常終了（全ルート生成成功）

### B-2. 実装内容

- `app/lib/v2/finance/parameters.ts`：`FinanceParameters.managementAccounting.fixedCostAllocationCoefficientByProduct`
  を新設（HOSO 1.0 / PD 1.5 / VAP 2.4、既存の加工費単価$0.50/$0.75/$1.20比から導出）。ゲーム開始時点で固定し、
  途中変更・遡及適用はしない設計。財務会計（在庫評価・FIFOロット原価・COGS・PL/BS/CF）には一切使用しない
  管理会計専用パラメータであることをコメントで明記。
- `app/lib/v2/finance/quarterClose.ts`：`computeManagementAccountingProductFixedCostAllocation()`を新設し、
  `closeFinancialQuarter`内で`computeProductionCosting`の直後に呼び出す。常用労務費（productive分のみ）は
  実配属人数比（`actual`モード）または品質調整後数量比（`legacy`フォールバック）で配賦し、遊休労務費
  （idleLaborCost）はどの商品にも配賦しない。共通工場・設備固定費（factoryFixedCost + utilityFixedCost +
  depreciationCost）は加工度ウェイト付き数量（adjustedTons×係数）比で配賦する。
  `ContributionMarginReport.byProduct[].directFixedCost`（従来`usd(0)`固定）と`commonFixedCost`
  （従来`totalFixedCost`固定）をこの結果で置き換えた。財務会計側の計算式・変数は一切変更していない。
- `app/api/v2/exports/_lib/exportDto.ts`：Export DTOをv1.3へ追加拡張（既存の明示アローリスト方式を踏襲）。
  `manufacturingCost`・`qualityLoss`・`costRecords`・`contributionMargin`（`byProduct`/`directFixedCost`/
  `commonFixedCost`含む）・`absorptionVariableReconciliation`を四半期ごとに公開。`EXPORT_SCHEMA_VERSION`は
  1のまま（追加のみで後方互換）。

### B-3. Preview検証で判明した事実（重要）

Preview環境（`vietnam-shrimp-game-staging`、対象commit `1a94f4f`）へデプロイし、既存の実データラボ
「Test13」（BAL社、確定済みTurn1〜6）に対してExport機能を実行したところ、**全社・全Turnで`directFixedCost`
が0のまま**という結果になった。調査の結果、これはバグではなく、以下の理由による既知の仕様上の制約と判明：

- Test13のTurn1〜6は本機能のデプロイより**前**に確定済み（confirmed）であり、`CompanyFinancialQuarterResult`
  は確定時点でRedisへ凍結保存され（`app/lib/v2/companyLab/persistence/repository.ts`の
  `commitQuarterAtomically`）、Export APIは`loadHistoryEntry`
  （`app/lib/v2/companyLab/persistence/readOnlyRepository.ts:34,52`）で保存済みレコードをそのまま返すのみで、
  `closeFinancialQuarter`の再実行は一切行わない（`app/api/v2/exports/_lib/handlers.ts:65/98/122`で確認）。
- 従って、確定済み過去Turnのexportは新ロジックの実行結果を反映しない。新ロジックの実データでの見え方を
  確認するには、本機能デプロイ**後**に新規Turnを確定する必要がある。
- Test13のTurn7（現在進行中・未確定）の実績（actuals）はまだ市場・生産シミュレーションが実行されておらず
  （`process-quarter` API内で初めて計算されRedisへ確定保存される仕様）、直前状態（`prev`
  ＝明細付きCompanyFinanceState）もRedis内部にのみ存在し既存の読み取り専用APIには露出していないため、
  Redis認証情報を用いることも、市場・生産シミュレーションをここで大規模に再実装することもせず、
  **Test13の実データ再現にはこだわらない方針**へ切り替えた（ユーザー承認済み）。

### B-4. 補足検証：現実的なダミーデータによる単発オフライン実行

本番コードに組み込まない使い捨てスクリプト（`scratch/verify-fc-realistic.ts`、検証後に削除・未コミット、
Redis書き込みなし）で、Test13 Turn6確定データの実Export値に規模感を合わせたダミーデータ
（HOSO/PD/VAP 3商品、常用労働者6,000人、工場固定費120万・ユーティリティ固定費25万など）を用いて
`closeFinancialQuarter`を1回だけ実行し、以下を確認した：

- HOSO/PD/VAP別`directFixedCost`：225万 / 369万 / 238万（非ゼロで意味のある値）
- Σ`directFixedCost` + `commonFixedCost` = `totalFixedCost`：831万+328万=1,159万で完全一致（diff=0）
- productive labor（390万）のみが商品へ配賦され、idle labor（210万）はどの商品にも配賦されない
- 生産あり・当期販売ゼロの商品（VAP）も`byProduct`から欠落しない
- 配賦係数を一律1.0へ変更しても、PL/BS/CF/製造原価内訳/品質損失/コスト記録/利益差異調整/次期財務状態は
  完全に不変（`JSON.stringify`比較で一致）。変わるのは`byProduct`内訳と`commonFixedCost`の「表示」のみ
- `undefined`/`NaN`/`Infinity`：新機能に起因するものは0件（検出された2件は既存仕様――売上ゼロ時の
  `contributionMarginRatio`が意図的に`undefined`になる既存分岐であり、JSON化時にキー自体省略されるため
  実Export JSON/ZIPには現れない。実際、Test13の実Export JSON全6Turn×全5社の再帰スキャンでも0件だった）

この単発実行結果とユニットテスト（FC-1〜FC-5、特に財務会計不変性を証明するFC-5）を受入根拠として、
本機能の技術検証は合格と判断した。

### B-5. develop/v2統合

- マージコミット：`53f384a`（`feature/v2-product-fixed-cost-allocation`の`1a94f4f`を`develop/v2`
  （`89172e2`）へ`--no-ff`でマージ、コンフリクトなし）
- マージ後の`npm test`／`tsc --noEmit`／`npm run lint`／`npm run build`は全て成功（本節冒頭参照）

---

## 残課題・申し送り

- **A（調達構成）**：`fix/v2-procurement-mix-after-emergency-maturity`はpush済み・1613件全pass確認済みだが
  develop/v2へは未マージ。マージ可否は別途判断が必要。
- **B（商品別固定費配賦）**：Test13での「経営分析上の実データの見え方」は、通常プレイでTurn7を確定した際に
  改めて確認する（本機能デプロイ後に初めて新ロジックで計算されるため）。検証用の複製機能・管理画面・Redis
  直接操作は実装していない（方針通り、今回は見送り）。
