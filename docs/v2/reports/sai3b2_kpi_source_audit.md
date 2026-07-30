# SAI-3B-2 KPIデータ利用可能性調査

対象: `feature/v2-sai3b-excel-analysis`ブランチ（SAI-3B-1受入後、SAI-3B-2着手前の実装前調査）。
本調査は**読み取り専用**であり、この調査自体ではゲームエンジン・SAI-3A出力層・
Standard AIロジックのいずれも一切変更していない。

---

## 0. 調査方法

- SAI-3A出力層: `app/lib/v2/companyLab/standardAi/autoplay/schema.ts`（ログ型定義）・
  `buildLog.ts`（ゲームエンジンの内部状態からログオブジェクトを組み立てる処理）・
  `output.ts`（ログオブジェクトを実際に7ファイル（manifest.json・case-summary.csv・
  quarter-summary.csv・decision-trace.jsonl・adjustment-trace.csv・warnings.csv・
  run-summary.json）へ直列化する処理）を直接確認した。
- ゲームエンジン内部状態: `app/lib/v2/companyLab/types.ts`・`app/lib/v2/companyLab/
  runner.ts`・`app/lib/v2/finance/types.ts`・`app/lib/v2/financing/types.ts`・
  `app/lib/v2/production/types.ts`・`app/lib/v2/production/labor.ts`・
  `app/lib/v2/sales/types.ts`・`app/lib/v2/quality/types.ts`・`app/lib/v2/rawMaterials/
  types.ts`・`app/lib/v2/market/types.ts`・`app/lib/v2/turn/types.ts`を確認し、
  各KPIの元となる値が「エンジン内部に存在するか」「存在する場合、SAI-3Aログへ
  実際に書き出されているか」を突き合わせた。
- SAI-3B側（`app/lib/v2/companyLab/standardAi/sai3b/schema.ts`・`parse.ts`・
  `aggregate.ts`）とも突き合わせ、SAI-3B-1が「取得不能」として`MISSING_FIELD_NOTES`
  に記載した5項目が今回の調査結果と一致することを確認した。
- 本調査中、ゲームエンジン・SAI-3A出力層のコードは一切変更していない
  （読み取りのみ）。

## 0.1 用語整理（値の種類の区別）

今回の調査・今後の実装全体を通じて、以下の区別を厳密に用いる。

| 用語 | 意味 | 現在のログ上の名称（存在する場合） |
|---|---|---|
| **販売希望数量（wish）** | 営業工数制約を適用する**前**の、標準AIが本当に売りたかった数量 | `SalesQuantityTraceEntry.desiredQuantityBeforeEffortConstraint`（`decision-trace.jsonl`） |
| **営業制約調整後の販売計画数量（final planned）** | 営業工数制約を適用した**後**の、最終的に計画された数量。まだ「契約が成立した」わけではない | `SalesQuantityTraceEntry.finalPlannedQuantity`（`decision-trace.jsonl`） |
| **契約数量（contracted）** | 市場配分アルゴリズムにより実際に成約した数量（新規成約） | `CompanyAllocationEntry.allocatedQuantity` — **エンジン内部に存在するが、ログには一切出力されていない（後述§1・§4）** |
| **生産数量（production, actual）** | 生産能力・原料・労務制約を適用した**後**の実際の生産量 | `QuarterResultLog.productionQuantityByProduct` — **`buildLog.ts`では計算済みだが`output.ts`が出力していない（後述）** |
| **実際の販売数量（fulfilled）** | 契約のうち実際に履行（出荷）された数量 | `QuarterResultLog.fulfilledQuantityHosoEqTons` — **同上、計算済みだが未出力** |
| **HOSO換算数量** | HOSO(丸剥き)・PD・VAPなど商品形態の異なる数量を、HOSO相当のトン数へ換算した単位。物理重量そのものではない | ログの大半の数量列（`...HosoEqTons`）はこの単位 |
| **製品重量ベースの数量** | 商品ごとの実重量（HOSO換算していない生の商品重量） | 現在のログには存在しない。`productionQuantityByProduct`等は商品別内訳を持つが、単位はHOSO換算トンではなく商品別物理数量（後述の注記参照） |

**現時点のログでは、「販売希望数量」「営業制約調整後の販売計画数量」は取得できるが、
「契約数量」「実際の販売数量（履行数量）」は取得できない。** よって、SAI-3B-2の
グラフで販売数量を扱う場合、タイトル・凡例に必ず「最終計画販売数量」等の正確な
名称を用い、「販売実績」「契約数量」と表記してはならない。

---

## 1. 販売・市場関係

| KPI | 元データ（ファイル・型・列） | 対応キー | 単位 | 集計方法 | 分子/分母 | 状態 | 不足データ | 値種別 |
|---|---|---|---|---|---|---|---|---|
| 販売希望数量（制約前） | `decision-trace.jsonl`／`SalesQuantityTraceEntry.desiredQuantityBeforeEffortConstraint` | 会社×seed×quarter×市場×商品 | HOSO換算トン | 会社×quarter単位に市場×商品を合算 | — | **取得可能** | — | wish |
| 営業制約調整後の販売計画数量 | 同上／`.finalPlannedQuantity` | 同上 | HOSO換算トン | 同上 | — | **取得可能** | — | final（制約後計画） |
| 契約数量（新規成約） | エンジン内部: `CompanyAllocationEntry.allocatedQuantity`（`sales/types.ts:112-142`）。`CompanyQuarterRecord.salesRecord.allocations`に保持されるが、`buildLog.ts`は一切読み取っていない | 会社×seed×quarter×市場×商品 | HOSO換算トン | — | — | **取得不能** | `salesRecord.allocations`がSAI-3Aログのどのファイルにも出力されていない | actual（契約） |
| 実際の履行数量／未成約残／延滞 | エンジン内部: `CompanyQuarterSummary.fulfilledQuantity/outstandingQuantity/overdueQuantity`（`companyLab/types.ts:223-225`）。`QuarterResultLog.newContractedQuantityHosoEqTons/fulfilledQuantityHosoEqTons/outstandingQuantityHosoEqTons/overdueQuantityHosoEqTons`として**buildLog.tsでは計算済み**（`schema.ts:247-250`） | 会社×seed×quarter | HOSO換算トン | — | — | **取得不能（ただし計算済み）** | `output.ts`のquarter-summary.csvヘッダーに含まれていないため出力されていない | actual |
| 実際の生産数量（商品別・制約後） | エンジン内部: `CompanyQuarterSummary.hosoProduced/pdProduced/vapProduced`（`companyLab/types.ts:235-238`）。`QuarterResultLog.productionQuantityByProduct/salesQuantityByProduct`として**buildLog.tsでは計算済み**（`schema.ts:230-231`） | 会社×seed×quarter×商品 | 商品別物理数量 | — | — | **取得不能（ただし計算済み）** | 同上、`output.ts`未出力 | actual |
| 市場別・商品別単価（実際の成約価格） | エンジン内部: `CompanyAllocationEntry.askPrice`（`sales/types.ts:115`） | 会社×seed×quarter×市場×商品 | USD/HOSO換算kg | — | — | **取得不能** | `salesRecord.allocations`未出力（契約数量と同じ根本原因） | actual |
| 市場シェア（数量・売上高） | エンジン内部: `MarketProductAllocationResult.targetDemand`（市場全体需要）・`.companies[].allocatedQuantity`（自社成約量）・`.externalOptionQuantity`（5社以外への流出量）（`sales/types.ts:132-142`） | seed×quarter×市場×商品 | 数量シェア=無次元比率、売上高シェア=無次元比率 | 分子=自社の対象数量or売上高、分母=同一quarter・同一市場における全社合計（5社合計。`externalOptionQuantity`を含めるかは要検討） | 分子: 自社allocatedQuantity、分母: Σ(5社のallocatedQuantity) | **取得不能** | `salesRecord.allocations`未出力（同上） | actual |
| 販売機会損失（制約後計画 vs 実際成約の差） | 上記「営業制約調整後の販売計画数量」と「契約数量」の差分として導出可能 | 会社×seed×quarter×市場×商品 | HOSO換算トン | `finalPlannedQuantity − allocatedQuantity` | — | **取得不能**（差分の一方（契約数量）が未出力のため） | 同上 | 導出値（final − actual） |
| 顧客信用（市場別、四半期開始時点） | `decision-trace.jsonl`／`QuarterStartState.customerTrustByMarket` | 会社×seed×quarter×市場 | 無次元スコア | — | — | **取得可能（開始時点のみ）** | 四半期末時点の値は`QuarterResultLog.customerTrustByMarket`として計算済みだが`output.ts`未出力 | 実績（期首時点） |
| 配送信頼性（市場別、四半期開始時点） | `decision-trace.jsonl`／`QuarterStartState.deliveryReliabilityByMarket` | 同上 | 無次元スコア | — | — | **取得可能（開始時点のみ）** | 期末値は計算済みだが`output.ts`未出力 | 実績（期首時点） |
| 納期遵守率（オンタイム配送率） | エンジン内部: `CompanyQuarterSummary.onTimeDeliveryRate`（`companyLab/types.ts:260`） | 会社×seed×quarter | 無次元比率 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |

---

## 2. 生産関係

| KPI | 元データ | 対応キー | 単位 | 集計方法 | 分子/分母 | 状態 | 不足データ | 値種別 |
|---|---|---|---|---|---|---|---|---|
| 生産計画（AI提出案、制約前） | `decision-trace.jsonl`／`QuarterDecisionLog.wish.productionDesiredQuantityByProduct` | 会社×seed×quarter×商品 | 商品別物理数量 | — | — | **取得可能** | — | wish（AI提出案。標準AI内部の全調整前の値ではない点に注意） |
| 実際の生産数量（制約後） | 上表参照（`productionQuantityByProduct`、計算済み・未出力） | 会社×seed×quarter×商品 | 商品別物理数量 | — | — | **取得不能（ただし計算済み）** | `output.ts`未出力 | actual |
| 生産能力使用率（設備・労務） | エンジン内部: `CompanyQuarterSummary.equipmentUtilizationRate/laborUtilizationRate`（`companyLab/types.ts:244-245`） | 会社×seed×quarter | 無次元比率 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| ワーカー数（AI提出案） | `decision-trace.jsonl`／`workerRegularHeadcountTotal`/`workerTemporaryHeadcountTotal`/`workerOvertimeRateAvg` | 会社×seed×quarter | 人数／比率 | — | — | **取得可能** | — | wish |
| ワーカー数（実際の配属後） | エンジン内部: `ProductionAllocationEntry.labor.assignedRegularHeadcount/assignedTemporaryHeadcount/appliedOvertimeRate`（工場×商品単位、`production/types.ts:247-252`）。会社全体の比率集計は`CompanyLoadMetrics.overtimeRate/temporaryWorkerShare`（`production/types.ts:433-436`） | 会社×seed×quarter（比率のみ会社単位で存在。実人数は工場×商品単位の内訳のみ） | 比率／人数 | 会社単位の実人数集計は現状存在しないため、`productionAllocation.entries`を会社IDで絞り込み合算する必要がある | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 歩留まり（品質起因の歩留まり） | エンジン内部: `BatchQualityAdjustment.outcome.saleableRecoveryRatio`（`quality/types.ts:120,127-145`） | 会社×seed×quarter×バッチ | 無次元比率 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 歩留まり（物理変換係数） | エンジン内部: `production/parameters.ts`の静的パラメータ（`physicalYieldRatio`）。四半期ごとの実績値ではなく固定パラメータであり、`production/yieldConversion.ts`のコメントにも「この関数の戻り値はいずれの永続フィールドにも書き込まれない」と明記 | — | 無次元比率 | — | — | **構造的に取得不能（四半期実績としては存在しない）** | そもそも四半期ごとの実績値という概念がなく、静的パラメータのみ | パラメータ（実績ではない） |
| 生産未達（原料・設備・労務起因） | エンジン内部: `CompanyQuarterSummary.rawMaterialShortfall/equipmentShortfall/laborShortfall`（`companyLab/types.ts:240-242`） | 会社×seed×quarter | 物理数量 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 格下げ（ダウングレード）数量 | エンジン内部: `CompanyQuarterSummary.downgradeQuantity`。`QuarterResultLog.downgradeQuantityHosoEqTons`として計算済み（`schema.ts:235`） | 会社×seed×quarter | HOSO換算トン | — | — | **取得不能（ただし計算済み）** | `output.ts`未出力 | actual |
| 廃棄数量 | `quarter-summary.csv`／`discardQuantityHosoEqTons` | 会社×seed×quarter | HOSO換算トン | — | — | **取得可能** | — | actual |

---

## 3. 調達関係

| KPI | 元データ | 対応キー | 単位 | 集計方法 | 分子/分母 | 状態 | 不足データ | 値種別 |
|---|---|---|---|---|---|---|---|---|
| 国内買付・輸入・養殖の希望量 vs 資金制約後最終量 | `decision-trace.jsonl`／`QuarterDecisionLog.wish.{domesticPurchaseDesiredQuantity,importOrdersDesiredQuantity,aquacultureStockingDesiredQuantity}` vs `.final.{domesticPurchaseFinalQuantity,importOrdersFinalQuantity,importOrdersBlocked,aquacultureStockingFinalQuantity}` | 会社×seed×quarter | 物理数量 | — | — | **取得可能** | — | wish → final（資金制約後） |
| 資金制約の詳細（scaleRatio・不足額・必要現金・利用可能流動性） | エンジン内部: `ProcurementConstraintResult.scaleRatio/unmetDemandUsd/plannedCashNeedUsd/availableLiquidityUsd`（`financing/types.ts:200-209`） | 会社×seed×quarter | 比率／USD | — | — | **一部取得可能**（`scaleRatio`のみ`PROCUREMENT_CASH_CONSTRAINED`のadjustment-trace.csvに条件付きで記録される。他3項目は未出力） | `unmetDemandUsd`/`plannedCashNeedUsd`/`availableLiquidityUsd`が`buildLog.ts`で読み取られていない | adjusted（制約適用の詳細） |
| 国内買付単価 | エンジン内部: `CompanyQuarterSummary.domesticPurchasePrice`（`companyLab/types.ts:228`） | 会社×seed×quarter | USD/物理数量単位 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 輸入・養殖の単価 | ロットごとの単価（`RawMaterialLot.unitCost`）はエンジン内で一時変数としてのみ存在し、`CompanyQuarterRecord`には保持されない。期間平均は`ManufacturingCostBreakdown.importedRawMaterialCost/aquacultureRawMaterialCost`（$総額）÷数量（`importArrivedQuantity`/`aquacultureHarvestedQuantity`、いずれも`CompanyQuarterSummary`に存在）で近似可能 | 会社×seed×quarter | USD/物理数量単位（期間平均のみ、ロット別単価は不可） | 期間平均単価 = $総額 ÷ 数量 | 分子: $原料費、分母: 調達数量 | **期間平均のみ一部取得可能（要出力拡張）、ロット別単価は取得不能** | ロット別単価: `turnResult.newImportLots`/`harvestedLots`がエンジン内で四半期記録に保持されず破棄されている（**エンジン変更が必要**） | actual（期間平均） |
| 原料不足・過剰 | エンジン内部: `CompanyQuarterSummary.rawMaterialShortfall`（不足側）、`DomesticPurchaseAllocationResult.unallocatedSupply`／`VietnamDomesticResult.unsoldSupply/imbalance`（過剰側、`rawMaterials/types.ts:94`,`market/types.ts:222-224`） | 会社×seed×quarter | 物理数量 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 調達構成比（国内・輸入・養殖の内訳） | `decision-trace.jsonl`の最終量3項目から算出可能 | 会社×seed×quarter | 構成比（無次元） | 各調達源の最終量 ÷ 3源合計 | 分子: 各源の最終量、分母: 3源合計 | **取得可能**（既存データからの導出のみ） | — | final（導出値） |

---

## 4. 在庫・品質関係

| KPI | 元データ | 対応キー | 単位 | 集計方法 | 分子/分母 | 状態 | 不足データ | 値種別 |
|---|---|---|---|---|---|---|---|---|
| 原料在庫（期首・期末） | `quarter-summary.csv`／`startRawMaterialInventoryHosoEqTons`・`rawMaterialInventoryHosoEqTons` | 会社×seed×quarter | HOSO換算トン | — | — | **取得可能** | — | actual（期首・期末とも） |
| 完成品在庫（期首・期末） | `quarter-summary.csv`／`startFinishedGoodsInventoryHosoEqTons`・`finishedGoodsInventoryHosoEqTons` | 会社×seed×quarter | HOSO換算トン | — | — | **取得可能** | — | actual（期首・期末とも） |
| 仕掛品（WIP）在庫 | エンジン内に該当概念自体が存在しない（生産は`ProductionBatch`による瞬時変換モデルであり、仕掛中在庫という状態を持たない） | — | — | — | — | **構造的に取得不能（概念自体が存在しない）** | エンジン変更（新しい状態概念の追加）が必要。今回のSAI-3B-2では扱わない | — |
| 在庫回転（$ベース） | $在庫評価は`FinishedGoodsCostLedgerEntry.unitCost`等のロット別台帳にのみ存在し、SAI-3Aへは一切出力されていない。BS上の$評価額（`BalanceSheet.finishedGoodsInventory/rawMaterialInventory`）とCOGSから概算は可能 | 会社×seed×quarter | 回転率（無次元） | 分子=期間販売数量or COGS、分母=平均在庫（数量or$） | — | **取得不能（$ベース）／物理トンベースの近似は一部取得可能（要出力拡張）** | $評価額・COGSが未出力（後述） | actual |
| 廃棄数量（$評価額） | エンジン内部: `QualityLossBreakdown.qualityDiscardLoss`（`finance/types.ts:461-474`） | 会社×seed×quarter | USD | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない（物理数量は取得可能、$評価額のみ不可） | actual |
| 期限切れ（原料・完成品） | ロット単位の`status="expired"`はエンジン内の一時変数（`TurnOrchestratorResult.expiredLots`）としてのみ存在し、`CompanyQuarterRecord`には保持されない。$評価額（`QualityLossBreakdown.rawMaterialExpiryLoss/finishedGoodsWriteOffLoss`）は保持される | 会社×seed×quarter | 数量: 取得不能／$: 取得不能（未出力） | — | — | **$評価額は一部取得可能（要出力拡張）、数量・ロット別詳細はエンジン変更が必要** | 数量側は`expiredLots`がCompanyQuarterRecordに保持されていない | actual |
| 品質スコア（商品別、期首） | `decision-trace.jsonl`／`QuarterStartState.qualityScoreByProduct` | 会社×seed×quarter×商品 | 無次元スコア | — | — | **取得可能（期首のみ）** | 期末値は計算済みだが`output.ts`未出力 | actual（期首時点） |
| 品質損失（$、操業リスク、重大事故件数） | エンジン内部: `CompanyQuarterSummary.operationalRiskByProduct/majorIncidentCount/rampWarnings`、`CompanyFinancialQuarterResult.qualityLoss` | 会社×seed×quarter | 各種 | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 供給信頼性・市場信用 | §1「配送信頼性」「顧客信用」を参照（同一データ） | — | — | — | — | 上記参照 | 上記参照 | 上記参照 |

---

## 5. 財務関係

| KPI | 元データ | 対応キー | 単位 | 集計方法 | 分子/分母 | 状態 | 不足データ | 値種別 |
|---|---|---|---|---|---|---|---|---|
| 売上高・売上総利益・営業利益・純利益 | `quarter-summary.csv`／`netRevenueUsd`・`grossProfitUsd`・`operatingProfitUsd`・`netIncomeUsd` | 会社×seed×quarter | USD | — | — | **取得可能** | — | actual |
| 期末現金・短期/長期借入・融資余力 | `quarter-summary.csv`／`closingCashUsd`・`endingShortTermLoansUsd`・`endingLongTermLoansUsd`・`endingAvailableAdditionalCapacityUsd` | 会社×seed×quarter | USD | — | — | **取得可能** | — | actual（期末） |
| 営業・投資・財務キャッシュフロー（3区分） | エンジン内部: `CashFlowStatement.operatingCashFlow/investingCashFlow/financingCashFlow`（`finance/types.ts:441-446`）。`QuarterResultLog.operatingCashFlowUsd/investingCashFlowUsd/financingCashFlowUsd`として**buildLog.tsでは計算済み**（`schema.ts:222-224`） | 会社×seed×quarter | USD | — | — | **取得不能（ただし計算済み）** | `output.ts`のquarter-summary.csvヘッダーに含まれておらず未出力（3項目とも全く出力されていない、SAI-3B-1でも把握できていなかった欠落） | actual |
| 支払利息 | エンジン内部: `ProfitAndLossStatement.interestExpense`（`finance/types.ts:347`） | 会社×seed×quarter | USD | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| 融資余力の内訳（担保ベース・収益ベース・信用格付上限・拘束要因） | エンジン内部: `BorrowingCapacityResult.collateralBasedLimitUsd/earningsBasedLimitUsd/creditTierCapUsd/bindingConstraint`等（`financing/types.ts:122-146`） | 会社×seed×quarter | USD／要因ラベル | — | — | **取得不能**（合計値の`availableAdditionalCapacityUsd`のみ取得可能、内訳は不可） | `buildLog.ts`が内訳を一切読み取っていない | actual |
| 売掛金・買掛金（期首） | `decision-trace.jsonl`／`QuarterStartState.accountsReceivableUsd/accountsPayableUsd` | 会社×seed×quarter | USD | — | — | **取得可能（期首のみ）** | — | actual（期首時点） |
| 売掛金・買掛金（期末） | エンジン内部: `BalanceSheet.accountsReceivable/accountsPayable`（`finance/types.ts:365,379`）。四半期ごとに計算されているが`buildLog.ts`が一切読み取っていない | 会社×seed×quarter | USD | — | — | **取得不能（ただし計算済み）** | `fin.balanceSheet.accountsReceivable/accountsPayable`が`buildLog.ts`で未読み取り | actual（期末時点） |
| 総資産（ROA分母） | エンジン内部: `BalanceSheet.totalAssets`（`finance/types.ts:378`） | 会社×seed×quarter | USD | — | — | **取得不能** | `buildLog.ts`が一切読み取っていない | actual |
| ROA | 上記「純利益」（取得可能）と「総資産」（取得不能）から算出 | 会社×seed×quarter | 比率（％） | 期首・期末平均資産を使うか期末残高を使うかは要出力拡張後に決定 | 分子: 純利益、分母: 総資産（期首期末平均 or 期末、実装時に明記） | **取得不能**（分母が未出力のため） | 総資産が未出力 | 導出値 |
| 原価内訳（固定費/変動費、COGS明細） | エンジン内部: `ProfitAndLossStatement.costOfSales`（`CostOfSalesBreakdown`）、`ManufacturingCostBreakdown`、`fin.costRecords`（`finance/types.ts:288-325,478-524,125-144`） | 会社×seed×quarter | USD | — | — | **取得不能（合計のCOGSは`netRevenueUsd − grossProfitUsd`として導出可能。内訳は不可）** | 原価明細が`buildLog.ts`で読み取られていない（`salesForceSalary`のみ例外的に読み取られ`case-summary.csv`の`cumulativeSalesForceCostUsd`に使用） | actual |

---

## 6. default・信用関係（確認のみ・変更不要）

以下は現行ログで十分にカバーされており、追加調査は不要と確認した。

| KPI | 元データ | 状態 |
|---|---|---|
| default発生有無・初回turn | `quarter-summary.csv`／`case-summary.csv`の`paymentDefault*`列 | **取得可能** |
| UWフローズン有無・初回turn | 同上`underwritingFrozen*`列 | **取得可能** |
| 信用格付・信用スコア・財務健全性ティア（期首） | `decision-trace.jsonl`／`QuarterStartState.creditTier/creditScore0to100/financialHealthTier` | **取得可能（期首のみ）** |

---

## 7. まとめ：現在の7ファイルのみでP0グラフ（SAI-3B-2指示§3）が作成できるか

| P0グラフ | 判定 | 備考 |
|---|---|---|
| A. 会社別売上高推移 | **作成可能** | `netRevenueUsd`は既存ログで取得可能 |
| B. 会社別販売数量推移 | **作成可能（ただし「最終計画販売数量」と明記する）** | 契約数量・履行数量は取得不能。既存の`finalPlannedQuantity`を使い、「販売実績」と表示しない |
| C. 市場別シェア推移 | **現状のログでは作成不能** | 契約数量（`allocatedQuantity`）・市場全体需要（`targetDemand`）がいずれもログ未出力。§8の出力拡張提案を参照 |
| D. 売上総利益・利益率推移 | **作成可能** | `grossProfitUsd`/`operatingProfitUsd`/`netIncomeUsd`は既存ログで取得可能。利益率は売上高との比として導出 |
| E. 現金残高推移 | **作成可能** | `closingCashUsd`は既存ログで取得可能。defaultイベントとの重ね合わせも既存データで可能 |
| F. キャッシュフロー推移（3区分） | **現状のログでは作成不能** | `operatingCashFlowUsd`等3項目が計算済みだが未出力。§8の出力拡張提案を参照 |
| G. 借入金推移 | **一部作成可能** | 短期・長期借入金・融資余力（合計値）は取得可能。内訳（担保ベース等）・支払利息は取得不能 |
| H. 運転資金推移 | **一部作成可能** | 原料在庫・完成品在庫（期首/期末）は取得可能。売掛金は期首のみ、買掛金は期首のみ取得可能（期末は不可）、仕掛品在庫は概念自体が存在しない |

**C（市場別シェア）とF（キャッシュフロー3区分）は、現状のSAI-3A出力だけでは作成できない。**
H（運転資金）も売掛金・買掛金の期末値が欠けており、正確な運転資金増減の算出に制約がある。

---

## 8. 最小限の出力拡張案（提案のみ・未実装）

以下は、**ゲームエンジンの計算ロジック・Standard AIの意思決定ロジック・バランス
パラメータを一切変更せず**、SAI-3Aの出力層（ログの直列化コードのみ）に対して
追加的な出力拡張を行う場合の最小限の提案である。**現時点では未実装であり、
実施の可否は三宅さんの判断を仰ぐ。**

### 8.1 分類

1. **既に`buildLog.ts`で計算済みだが`output.ts`が出力していないだけの項目**
   （エンジンにもbuildLog.tsにも変更不要。`output.ts`のCSVヘッダー・直列化関数を
   広げるだけ）:
   - 実際の生産数量（商品別）・実際の契約/履行/未成約/延滞数量
   - 営業・投資・財務キャッシュフロー（3区分）
   - 格下げ数量
   - 顧客信用・配送信頼性・品質スコア（期末値。期首値は既存出力済み）
2. **`buildLog.ts`に1行程度の読み取りを追加するだけで済む項目**（エンジンには
   一切手を入れない。既存のレコード型から値を読むだけ）:
   - 設備・労務の稼働率、残業比率・臨時労働比率
   - 生産未達（原料・設備・労務起因）
   - 国内買付単価
   - 売掛金・買掛金の期末残高、総資産（ROA分母）
   - 支払利息
   - 融資余力の内訳
   - 品質損失（$・操業リスク・重大事故件数）
3. **新しい市場配分トレース（新規スキーマ追加。エンジン計算ロジックは無変更、
   既存の`record.salesRecord.allocations`を読み取るだけ）**:
   - 契約数量・成約単価・市場全体需要・5社以外への流出量 →
     市場シェア（C）・販売機会損失の算出に必要
4. **エンジン側の変更が必要（今回は行わない）**:
   - ロット別の輸入・養殖単価、期限切れロットの数量詳細（現在は一時変数として
     エンジン内で破棄されており、`CompanyQuarterRecord`に保持されていない）
   - 仕掛品（WIP）在庫という状態概念自体の追加

### 8.2 影響範囲の見積もり

上記1〜3はいずれも`app/lib/v2/companyLab/standardAi/autoplay/`配下（schema.ts・
buildLog.ts・output.ts）の追記のみで実現でき、ゲームエンジン本体
（`companyLab/runner.ts`本体のロジック・`finance/`・`production/`・`sales/`
配下の計算ロジック）・Standard AIの意思決定ロジック・バランスパラメータは
一切変更しない。ただし、SAI-3A自体は既にdevelop/v2へ統合済みのフェーズであり、
この拡張はSAI-3Bのブランチ上でSAI-3Aの出力層コードに追記することになる
（SAI-3B-1が読み取り専用だったのに対し、これは「ログを出力する側」への
追記である点が異なる）。

### 8.3 本ドキュメントでの結論

この出力拡張を実施するかどうかは、P0グラフのC（市場別シェア）・F（キャッシュ
フロー3区分）、およびH（運転資金の精度向上）に直結するため、実装着手前に
三宅さんに確認する。

---

## 9. 参照した主要ファイル一覧

- `app/lib/v2/companyLab/standardAi/autoplay/schema.ts`
- `app/lib/v2/companyLab/standardAi/autoplay/buildLog.ts`
- `app/lib/v2/companyLab/standardAi/autoplay/output.ts`
- `app/lib/v2/companyLab/standardAi/sai3b/schema.ts` / `parse.ts` / `aggregate.ts`
- `app/lib/v2/companyLab/types.ts`
- `app/lib/v2/companyLab/runner.ts`
- `app/lib/v2/finance/types.ts`
- `app/lib/v2/financing/types.ts`
- `app/lib/v2/production/types.ts` / `production/labor.ts` / `production/yieldConversion.ts`
- `app/lib/v2/sales/types.ts`
- `app/lib/v2/quality/types.ts`
- `app/lib/v2/rawMaterials/types.ts`
- `app/lib/v2/market/types.ts`
- `app/lib/v2/turn/types.ts`

本調査中、上記ファイルはすべて読み取りのみで、一切変更していない。
