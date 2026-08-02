# ShrimpX V2 開発日誌

**対象期間：2026年8月2日**
**対象フェーズ：SAI-6.1（Situation Diagnosis）／SAI-6.2（Commercial Plan整理）／SAI-6.3（Current Period Delivery Demand層）**

## 0. 本日の到達点

Test14 Turn1の設計レポート（`docs/standard_ai/TEST14_TURN1_STANDARD_AI_REDESIGN_ANALYSIS.md`）で提示した新しい判断構造のうち、**SAI-6.1〜6.3のみ**を実装した。今回はあくまで準備フェーズであり、**Standard AIの最終意思決定（`productionPlans`・`domesticPurchasePlan`・`importOrders`・`aquacultureStockingPlans`・`workerAssignments`・`financingRequest`・`capexDecision`）は一切変更していない**（唯一の意図的な差は、営業人員の動的state参照修正§14による正当な差のみ）。

- branch: `feature/v2-sai6-1-3-diagnosis-delivery-demand`（`develop/v2` HEAD `083425a`から作成）
- `npm test` 全2116件成功（既存2106件 + 新規10件）
- `npx tsc --noEmit` エラー0
- `npm run lint` エラー0（既存の無関係な警告4件のみ）
- `npm run build`: TypeScriptのコンパイル・型検査までは成功。最終段のページデータ収集ステージのみ`STAGING_KV_REST_API_URL`未設定というサンドボックス環境固有の制約で失敗（コード上の問題ではない。過去のタスクと同一の既知の制約）

## 1. SAI-6.1: Situation Diagnosis（不足型／過剰型の6カテゴリ診断）

新設: `app/lib/v2/companyLab/standardAi/diagnosis/situationDiagnosis.ts`

営業・生産能力・Worker・原料・在庫・資金の6カテゴリを、それぞれ独立した比率として保持し、`shortage`（不足）／`balanced`（均衡）／`surplus`（余剰）／`unknown`（算出不能）の状態を判定する。単一の合成pressure scoreへは押し込まない。

### 1.1 診断式（実装値）

| カテゴリ | 指標 | 定式 | 閾値（`SITUATION_DIAGNOSIS_THRESHOLDS_V1`） |
|---|---|---|---|
| 営業 | Sales Fulfillment Ratio | `realisticSalesByProduct合計 / desiredByProduct合計` | shortage: <0.6 |
| 生産能力 | Production Load Ratio | `基本当期生産必要量合計 / 生産能力合計（ノミナル）` | shortage: >0.9／surplus: <0.5 |
| Worker | Worker Load Ratio | `理論必要Worker / 現在Worker（動的state）` | shortage: >1.05／surplus: <0.6 |
| 原料 | Raw Material Coverage Ratio | `(当期利用可能原料+当期確実に取得可能な原料) / 必要原料` | shortage: <1.0 |
| 在庫 | Inventory Excess Ratio | `期首完成品在庫 / 通常在庫目標` | surplus: >1.5 |
| 資金 | Liquidity Coverage Ratio | `現金 / 会社規模連動の最低現金バッファ` | shortage: <1.0 |

- 「基本当期生産必要量」はSAI-6.3の`currentPeriodDeliveryDemand`＋通常安全在庫目標－期首完成品在庫（下限0）で、**診断専用の並行計算**（既存の`decision/production.ts`は変更していない）。
- 「必要原料」は歩留まり1.0基準（既存procurement.tsと同じ前提）。
- 原料在庫は`growingAquaculture`（未収穫の養殖投入）を「当期利用可能」に含めず、`inTransitImport`は既存の`RawMaterialLot.availableFromPeriod`が当期以前のものだけを「当期確実に取得可能」として数える（`observation.ts`に`rawMaterialInTransitImportQuantity`・`rawMaterialGrowingAquacultureQuantity`・`rawMaterialCertainInboundThisPeriod`を新設。既存の`rawMaterialPipeline`は削除せず維持）。
- 生産能力の認識ギャップ（ノミナル vs 実効係数0.855＝baseUtilizationRate×equipmentAvailabilityRate）は、`capacityRecognitionGap`フィールドとdiagnostics（`PRODUCTION_CAPACITY_RECOGNITION_GAP`）で明示するのみで、Production Load Ratioの計算自体はノミナル値のまま（ゲーム側の能力定義・意思決定ロジックは変更していない）。

### 1.2 主要制約・第2制約（複合制約・上位2件方式）

6カテゴリのうち「shortage」または「surplus」と判定されたものを候補とし、各候補に閾値からの偏差スコアを付けて上位2件を`primaryConstraint`/`secondaryConstraint`とする（固定モードで排他分岐させる方式ではなく、複合制約が同時発生するケース（Test14 Turn1のような営業不足＋生産能力余剰＋Worker余剰）を自然に表現できる）。

### 1.3 Test14 Turn1（`baseline`シナリオBAL turn1）での実際の診断結果

実データから機械的に算出した値（人間案の数値はハードコードしていない）：

```
salesFulfillmentRatio:      0.225 (shortage)
productionLoadRatio:        0.572 (balanced, 余力あり)
workerLoadRatio:            0.495 (surplus)
rawMaterialCoverageRatio:   0.219 (shortage)
inventoryExcessRatio:       0     (balanced)
liquidityCoverageRatio:     0.967 (shortage、僅かに1未満)
primaryConstraint:          raw_material_shortage
secondaryConstraint:        sales_shortage
requiredWorker:             約2,968人（理論値。三宅さんの手計算3,102人相当と近い水準）
basicCurrentPeriodProductionRequirement合計: 約13,728t（人間案11,100tと同オーダー）
```

三宅さんの実装指示§13が明示した4項目（営業=強い制約／生産能力=余剰／Worker=余剰／在庫=大きな問題なし）はすべて期待どおりに診断された。原料（期首ロット3,000tのみで、必要量13,728tに対し薄い）についてはshortageと診断されたが、これは実際に三宅さんの人間案が国内買付8,500t・養殖投入1,000tを行った理由と整合する、正しい診断結果である（primaryConstraintがraw_material_shortageになったこと自体は診断ロジックの重み付けの結果であり、恣意的な調整は行っていない）。

## 2. SAI-6.2: Commercial Plan整理

### 2.1 `desiredByProduct`と`realisticSalesByProduct`の分離

`decision/sales.ts`の`SalesPlanResult`へ`realisticSalesByProduct`（営業人員配分後の`salesPlans`商品別合計）を新設。`desiredByProduct`（工場能力起点の理論希望量）にはコメントで「生産計画への入力として使ってはならない」ことを明示した。既存フィールドは削除・変更せず、破壊的変更を避けた。

### 2.2 営業人員の静的fixture参照を修正

`fixture.salesForceHeadcountTotal`（静的な基準値）を直接参照していた3箇所を、`ownState.salesForceHiringState.headcount`（動的な現在人数）を参照するように修正した。

- `standardAi/observation.ts:176`: `salesForceHeadcountTotal`フィールドの元をfixtureからownStateへ変更
- `standardAi/decision/sales.ts:342,369-370`: `observation.salesForceHeadcountTotal`（上記修正済みの動的値）を参照するよう変更
- `companyLab/autoPolicy.ts:356`: `ownState.salesForceHiringState.headcount`を直接参照するよう変更

turn1では静的値と動的値が一致するため既存挙動は変わらない（`npm test`全件成功で確認済み）。

### 2.3 この修正で表面化した既存テストの2件の期待値更新

- `standardAi/__tests__/salesEffort.test.ts`（7c・7d）: `fixture`だけをオーバーライドしても`ownState.salesForceHiringState.headcount`が追随しないため、「営業人員が少ない」状況を再現するテストのヘルパー`setupWithSalesForceHeadcount`を新設し、両方を一致させて上書きするよう修正。
- `companyLab/__tests__/runner.test.ts`（営業人員採用テスト）: 以前は静的参照バグにより、採用ブランチ(24人)でもturn2の市場配分に反映されず、SG&A差分が人件費（$48,000）のみに厳密一致していた。修正後は採用ぶんの営業capacityが実際に市場配分へ反映され、販売量増加に伴う変動費（sellingLogistics）ぶんSG&A差分がさらに増える（正しい挙動の改善）。厳密一致(`==`)を「少なくとも人件費ぶんは増える」という不等式(`>=`)へ変更し、コメントで理由を明記した。
- 減員テスト（同ファイル、営業人員減員テスト）内の、旧バグを前提にした説明コメントも実態に合わせて修正（該当のテスト自体・アサーションは変更不要だった）。

## 3. SAI-6.3: Current Period Delivery Demand層

新設: `app/lib/v2/companyLab/standardAi/diagnosis/currentPeriodDeliveryDemand.ts`

### 3.1 Standard AI内部の中間概念であることの明示

`currentPeriodDeliveryDemand`は**Standard AI内部の意思決定用中間概念としてのみ実装した**。ゲーム本体側（当期即納営業・次期納品営業・市場側の通常購買タイミング・スポット/緊急需要・契約データモデル・営業UI入力項目）を分離する実装は行っていない（それはCowork #04側の担当）。ゲーム側の新規フィールドは一切追加していない。

### 3.2 現行仕様での暫定計算（実データフロー確認済み）

`decision/sales.ts`の既存コメント（実装指示§販売）で、`salesPlans`が「新規に売り込みたい量」のみであり、既存契約の履行分を含まないことを確認した上で、二重加算を避ける形で以下を実装した。

```
currentPeriodDeliveryDemand.byProduct
  = realisticSalesByProduct（新規営業の当期即納分。現行仕様では全量）
  + outstandingContractByProduct（当期履行期限の既存契約。現行仕様では履行期限の
    区別が無いため、未履行契約残高の全額を暫定的に「当期履行期限」とみなす）
source: "CURRENT_SALES_PLAN_PROXY"
```

当期スポット・緊急需要は対応するゲーム側フィールドが存在しないため0として扱う。`source`フラグにより、この値が暫定推定であることを常に明示する。

### 3.3 将来の差し替え口

将来#04側で当期／次期納品区分が実装された場合、`buildCurrentPeriodDeliveryDemand`の内部計算だけを差し替えれば、Situation Diagnosis・将来のInventory & Production Plan（SAI-6.4）は型・関数シグネチャを変えずに済む設計にしている。

## 4. persistence・診断情報の永続化への影響

`StandardAiQuarterDiagnostics`（`policy.ts`）へ`situationDiagnosis`・`currentPeriodDeliveryDemand`を**optional**フィールドとして追加した。Phase A（`feature/v2-persist-standard-ai-proposal`）で永続化を始めた既存の`aiProposalDiagnostics`（`persistence/types.ts`）に、この変更より前に保存されたドラフトが存在する場合を想定し、`persistence/schema.ts`のshallow validatorはこの2フィールドを必須にしていない（後方互換）。新規生成される値では常に設定される。

## 5. 今回のスコープ外・未着手（SAI-6.4以降）

- **生産計画の実際の配線切り替え**（`policy.ts`の`buildStandardAiProductionPlans`への入力を`salesResult.desiredByProduct`から`currentPeriodDeliveryDemand`ベースの値へ切り替える）は今回一切行っていない。Test14 Turn1の生産22,100t問題は引き続き未修正（意図的。SAI-6.4の受入対象）。
- 診断結果をUI（AI提案文面等）へ表示する実装も今回は行っていない（SAI-6.7で予定）。
- 生産能力の実効係数0.855をどう扱うかは診断情報として明示したのみで、意思決定・診断の比率計算そのものには反映していない（三宅さんとの優先度判断待ち。設計レポート§19参照）。

## 6. Git状態

- `develop/v2`: `083425a`（変更なし）
- feature branch: `feature/v2-sai6-1-3-diagnosis-delivery-demand`（push予定。develop/v2へはまだマージしない）
- `test/sai6-manual-observation-2026-08-01`: 変更なし
- `main`: `3ae9485`（変更なし）
