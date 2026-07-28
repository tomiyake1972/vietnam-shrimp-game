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

## 残課題・申し送り（当初版）

- **A（調達構成）**：`fix/v2-procurement-mix-after-emergency-maturity`はpush済み・1613件全pass確認済みだが
  develop/v2へは未マージ。マージ可否は別途判断が必要。
- **B（商品別固定費配賦）**：Test13での「経営分析上の実データの見え方」は、通常プレイでTurn7を確定した際に
  改めて確認する（本機能デプロイ後に初めて新ロジックで計算されるため）。検証用の複製機能・管理画面・Redis
  直接操作は実装していない（方針通り、今回は見送り）。

---

## C. ブランチAのdevelop/v2統合 ＋ 原料不足時実生産量縮小の設計確認（当セッション追記）

### C-1. ブランチAの統合

`fix/v2-procurement-mix-after-emergency-maturity`（`89172e2`から分岐、`d83e8c2→a82bbcf→2c688bc→f8f8bbd`の
4コミット、5ファイル・401行差分）を、develop/v2（`8f3a5bd`）へ`--no-ff`でマージした（コンフリクトなし）。
マージ後の検証：

- `npx tsc --noEmit`：エラー0件
- `npm test`：**1621件全てpass**（既存1614件 + 本ブランチ由来のEM-4〜EM-6等の回帰テスト追加分）
- `npx eslint`：0 errors（既存の無関係な警告2件のみ、他セクション記載の警告と同一）
- `npm run build`：成功（ローカル検証ではステージング用KV環境変数(`STAGING_KV_REST_API_URL`等)が未設定の
  ため`/api/game/[gameCode]/admin/clone`のpage data収集で失敗するが、これはマージ前の`8f3a5bd`単体でも
  同一に再現する既存のローカル環境依存の問題であり、本マージによる回帰ではないことを、マージ前コミットを
  別worktreeでチェックアウトして同条件でビルドし確認した。ダミー値を設定すれば正常にビルド完了する。

### C-2. 「原料不足時の実生産量自動縮小」の設計確認

三宅さんからの実装依頼（計画生産量と実生産量の区別、利用可能原料・生産優先順位・商品別必要原料に基づく
実生産量縮小、原料消費・完成品入庫・労務・製造原価・在庫・財務の実績整合、計画未達量と理由の記録、
原料不足でシミュレーション全体を停止させないこと）について、既存コードを調査した結果、**要求内容は
Phase 6（`production/allocation.ts`・`production/batches.ts`）ですでに実装済み**であることを確認した。

- `allocation.ts`：原料在庫（会社単位の共有プール）→工場共通処理能力→冷凍包装能力→商品別設備能力→
  労働力の5段階で、`priority`（生産優先順位）に基づく水位法配分（`priorityAllocation.ts`）により実生産量
  （`allocatedQuantity`）を計画量（`desiredQuantity`）から縮小する。各段階の縮小理由を
  `shortfallReasons`（`rawMaterialShortage`等）として記録する。
- `batches.ts`：実際に消費できた原料量（`clippedRequired = min(requiredRaw, 在庫実量)`）に基づいて
  完成品数量を再計算するため、原料不足時も例外を投げず数量が縮小されるのみで、シミュレーション全体を
  停止させない。
- `finance/companyLabAdapter.ts`：財務側は`batch.finishedGoodsQuantity`（実績値）を使用しており、
  計画値ではなく実績と整合している（労務・製造原価・在庫・財務が実生産量ベース）。
- `api/v2/exports/_lib/dto/operationsDto.ts`（§5-6・§5-7）：`ExportProductionBatch`・
  `ExportProductionAllocationEntry`として`desiredQuantity`・`allocatedQuantity`・`shortfallQuantity`・
  `shortfallReasons`がすでにExport DTOへ許可項目化・公開済み（経営分析Excelで計画未達量・理由を確認可能）。

このため、当セッションでの新規コード実装は行っていない。三宅さんとの確認の結果、既存実装のレビュー・
固定シードでの複数ターン・複数社シミュレーションによる不変条件検証を優先する方針とした。

### C-3. 固定シードによる完走・再現性・不変条件検証

`scripts/v2CompanySimulate.ts`（シナリオ`baseline`・`canonical`モード、シード`shrimpx-invariant-check-001`、
5社（`BAL`/`MASS`/`JPQ`/`VAP`/`CONSV`）、`--format json`）を用いて、12ターン・32ターンをそれぞれ2回ずつ実行：

- **完走**：12ターン・32ターンともに例外停止なく完走（原料不足シナリオを含め、シミュレーション全体が
  止まる状況は発生しなかった）
- **再現性**：同一設定・同一シードでの2回の実行結果は、JSON出力が完全に一致（`diff`でバイト単位一致）
- **不変条件**（全ターン・全社・全生産配分エントリ・全バッチ・全財務結果を対象に検証）：
  - `allocatedQuantity <= desiredQuantity`（実生産量が計画を超えない）
  - `shortfallQuantity == desiredQuantity - allocatedQuantity`（誤差1e-2以内）
  - `shortfallQuantity > 0`の場合は必ず`shortfallReasons`が1件以上記録されている
  - バッチの原料消費と完成品・加工ロスの質量保存（`finishedGoodsQuantity + processingLoss ==
    rawMaterialConsumedTotal`、誤差1e-2以内）
  - 貸借対照表の恒等式（`totalAssets == totalLiabilities + totalEquity`、誤差1USD-M以内）
  - `NaN`・`Infinity`の出現：0件
  - 上記いずれも12ターン・32ターンの両方で違反0件

以上より、develop/v2（本セッションでのブランチA統合後）は、原料不足時の実生産量縮小・計画未達量記録の
要求仕様を既存実装で満たしており、複数社・複数ターンの継続実行でも財務・生産・在庫の整合性が崩れないことを
確認した。

V1（`main`ブランチ・`v1-maintenance`ブランチ）には一切変更を加えていない。

## 残課題・申し送り（当セッション時点）

- **A（調達構成）**：develop/v2へ統合完了（本節C-1参照）。
- **B（商品別固定費配賦）**：Test13 Turn7確定時の実データ確認は引き続き未実施（次回セッションの申し送り事項）。
- **原料不足時の実生産量縮小**：新規実装は不要と判断（既存実装で要件を充足）。将来、生産優先順位の
  ユーザー向けUI表示や、Export以外の画面（GM分析ブック等）への計画未達理由の可視化が必要になった場合は
  別途要望として扱う。

## D. SAI-1 標準AIラボ基盤の実装（`feature/v2-standard-ai-foundation`）

`develop/v2`（`cd15bef`）から分岐し、5社共通・決定論的ルールベースの「標準AI」
（強い経営AI・個性を持つ競合AIではなく、ゲームバランス検証用の標準テストプレイヤー）を
`app/lib/v2/companyLab/standardAi/`配下に実装した。会社ID・アーキタイプによる分岐は一切行わず、
会社間の違いはfixture/ownStateの実データにのみ由来する。

### D-1. 実装内容

- `standardAi/types.ts`：判断理由コード（`StandardAiReasonCode`、17種）・診断情報・設定
  （`StandardAiConfig`）の型定義
- `standardAi/config.ts`：5社共通の既定設定`DEFAULT_STANDARD_AI_CONFIG_V1`（唯一のインスタンス）
- `standardAi/observation.ts`：fixture/ownState/publicInfoから観測情報を組み立てる純粋関数
  （既存の`decisionHelpers.ts`のみを使用し、新規の集計ロジックは追加していない）
- `standardAi/policy.ts`：判断ロジック本体`computeStandardAiDecision`。完成品在庫過剰・原料不足・
  Worker不足（生産優先→残業→臨時増員の順）・現金不足（必要最小限の借入・調達抑制）・既存契約履行優先・
  設備投資は常に見送り、の各原則を実装し、判断理由を`StandardAiReasonEntry`として記録する
- `standardAi/provider.ts`：`CompanyDecisionProvider`への接続点（`generateStandardAiDecision`）と、
  診断情報を蓄積する版（`createStandardAiDecisionProviderWithDiagnostics`）
- `cli/{types,argParser,runCli}.ts`：`--ai auto-policy|standard-ai`フラグを追加（既定値は
  `auto-policy`のため既存の手動プレイ・既存CLI呼び出しへの影響なし）
- 事前作業として、`autoPolicy.ts`から共通集計ロジックを`decisionHelpers.ts`へ抽出（挙動変更なし。
  抽出のたびに全テスト・tsc・lintで無変更を確認済み）

### D-2. 検証結果

- 単体テスト8件・統合テスト7件を新規作成し、全て合格：決定性（同一入力→同一意思決定）、
  全5社について意思決定の全フィールドが有効（NaN/Infinity/負数なし）、会社ID/アーキタイプの
  入れ替えで判断内容が変わらないこと、完成品在庫過剰/原料不足/現金不足それぞれに対する反応、
  設備投資は常に有効な空決定、5×8ターン・5×32ターンの完走・再現性・生産配分の不変条件
- 全体テストスイート：1636/1636件合格（既存1621件は無変更、新規15件）
- `npx tsc --noEmit`：エラー0件
- `npm run lint`：エラー0件（既存の無関係な警告2件のみ、新規追加分なし）
- CLI実機実行（`--ai standard-ai`）：シード`sai1-8turn-run1`で5×8ターン、シード`sai1-32turn-run1`で
  5×32ターンをそれぞれ2回実行し、JSON出力が完全にバイト一致（再現性確認）。既存の不変条件チェック
  スクリプト（生産配分・バッチ質量保存・NaN/Infinity）は両方とも0件違反

### D-3. 発見事項（財務エンジン既存コードの既知事象）

検証中、標準AIの「正常時は前四半期から大きく動かさない」原則（常用人数を維持する）が、原料不足で
実生産が計画を大きく下回る状況と組み合わさると、非常に大きな遊休労務費（idleLaborCost）を生むことを
確認した。この状態で、財務エンジン（`finance/quarterClose.ts`、本ブランチでは変更していない既存コード）
の`cashFlow.directIndirectDifference`（直接法/間接法キャッシュフローの差異。従来から存在するが恒常的に
0になる保証のないフィールド）が非ゼロになり、その差がcashへ乗って翌期以降へ繰り越されるため、貸借対照表の
資産合計と負債・資本合計の間に累積的な乖離（`balanceDifference`）が生じることを発見した。

- 同一シードで`autoPolicy.ts`（既存の暫定自動方針）を実行した場合はこの乖離は発生しない
  （標準AIの「維持型」判断が誘発した既存エンジンの潜在的な事象であり、標準AI自体の新規バグではない）
- シミュレーションの完走・NaN/Infinity無し・再現性には影響しない（貸借対照表の内部整合性のみの問題）
- 統合テスト（`standardAi/__tests__/integration.test.ts`）では、この乖離が
  `cashFlow.directIndirectDifference`の累積のみで説明できることを検証しており、原因不明の
  未知の誤差ではないことを確認済み
- 根本原因の修正（財務エンジンのidleLaborCostに関する直接法/間接法キャッシュフロー整合性）は
  SAI-1のスコープ外（既存の財務モジュールへの大規模な手当てが必要）と判断し、SAI-2への申し送り事項とする

### D-4. 32ターン実行での観察（正常だが注視すべき挙動）

5×32ターンの実行では、5社中3社（MASS/JPQ/VAP）が、原料不足・低い契約履行率・厳しい与信制約が重なり、
ターン20前後までに現金が数億円規模の赤字へ落ち込み、設備稼働率・労働稼働率が0%に張り付く「実質的な
経営破綻」状態に至った（BAL/CONSVの2社は健全に推移）。これはプログラムエラー・未定義状態ではなく、
「会社が経営危機に陥ること自体は失敗ではない」という完了基準の想定内の挙動だが、標準AIが常用人数を
一切減らさないため、稼働率0%の状態が回復せず固定費・遊休労務費が累積し続ける点は、SAI-2での
改善候補（例：稼働率が複数四半期継続して極端に低い場合の常用人数調整ルールの追加）として記録する。

### D-5. ブランチ・コミット

- ブランチ：`feature/v2-standard-ai-foundation`（`develop/v2`の`cd15bef`から分岐）
- コミット：`9f64418`・`a6616cd`（decisionHelpers.ts抽出）、`072ef6a`（SAI-1本体実装）
- V1（`main`・`v1-maintenance`）には一切変更を加えていない
