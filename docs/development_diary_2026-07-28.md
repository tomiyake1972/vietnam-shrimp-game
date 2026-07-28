# ShrimpX V2 開発日誌

**対象期間：2026年7月28日**
**対象フェーズ：商品別固定費配賦・労務費区分（経営分析Excel向け機能）の実装・Preview検証・develop/v2統合**

## 1. 到達点

「商品別固定費配賦・労務費区分・経営分析Excelの変更」指示に基づき、`feature/v2-product-fixed-cost-allocation`
ブランチ（`develop/v2`の`89172e2`から分岐）でエンジン実装・Export DTO拡張・Preview環境での検証を行い、
本日`develop/v2`へマージした（マージコミット`53f384a`）。マージ後、以下を全て確認済み：

- `npm test`：**1614件全てpass**（既存1614件テストに、今回追加した`商品別固定費配賦FC-1〜FC-5`
  （`app/lib/v2/finance/__tests__/quarterClose.test.ts`）とパラメータ検証テスト（`parameters.test.ts`）を含む）
- `npx tsc --noEmit`：エラーなし
- `npm run lint`：0 errors（既存の無関係ファイルの警告2件のみ、今回の変更とは無関係）
- `npm run build`：正常終了（全ルート生成成功）

## 2. 実装内容

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

## 3. Preview検証で判明した事実（重要）

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

## 4. 補足検証：現実的なダミーデータによる単発オフライン実行

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

## 5. develop/v2統合

- マージコミット：`53f384a`（`feature/v2-product-fixed-cost-allocation`の`1a94f4f`を`develop/v2`
  （`89172e2`）へ`--no-ff`でマージ、コンフリクトなし）
- マージ後の`npm test`／`tsc --noEmit`／`npm run lint`／`npm run build`は全て成功（本日誌1節参照）

## 6. 残課題・申し送り

- Test13での「経営分析上の実データの見え方」は、通常プレイでTurn7を確定した際に改めて確認する
  （本機能デプロイ後に初めて新ロジックで計算されるため）。
- 検証用の複製機能・管理画面・Redis直接操作は実装していない（方針通り、今回は見送り）。
