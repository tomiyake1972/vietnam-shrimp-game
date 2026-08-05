# Test15前 標準経営AI（#05） 現状能力監査

作成: Cowork #05（AI設定）／2026-08-05
対象ブランチ: `feature/v2-sai-salesforce-bottleneck-hiring`（HEAD `3d45c5f`）
方針: 本ドキュメントは新規AI設計ではない。実装済みコードの呼び出しグラフを実際に追跡した、事実の棚卸しである。

## 0. 分類基準

- **A（実使用）**: `standardAi/policy.ts`の`generateStandardAiDecisionWithDiagnostics`から到達可能で、かつその決定が`app/api/v2/company-labs/_lib/decisionsProvider.ts`→`companyLab/runner.ts`の実ターン処理で永続化状態に反映される。
- **B（診断専用）**: 計算されdiagnostics/entriesへ出力されるが、いずれの決定関数もその値を読んで挙動を変えていない。
- **C（未接続）**: コードは存在し動作しうるが、実経路（policy.ts起点）のどこからも呼ばれていない（テストや別ツールのみが参照）。
- **D**: 未実装。

## 1. 実経路の確認（CRITICAL LEAD の解決）

`app/api/v2/company-labs/_lib/decisionsProvider.ts`は`generateStandardAiDecision`（`standardAi/policy.ts`）を呼んでおり、これが実APIルートの意思決定提供元であることをコードで確認した（同ファイル冒頭コメントに「暫定自動方針(autoPolicy.ts)から、実際に評価対象となる標準経営AI(standardAi/policy.ts)へ切り替えた」と明記）。

`companyLab/runner.ts`は`d.salesForceHireCount`/`d.salesForceLayoffCount`（1470〜1478行目、739・747〜749行目）を実際に集計し、当期の営業人員総数へ加減算している。これはコード上明確である。

一方、このセッションが以前実行した`scripts/sai3aAutoplay.ts`（`standardAi/autoplay/runCase.ts`）は`salesForceHireCount`/`salesForceLayoffCount`/`salesForceHiringResult`のいずれも参照しておらず（grep結果0件）、`salesForceHeadcountTotal`を固定値のまま5社×全ターン通して使い続ける。これはSAI-3Aハーネス固有の実装漏れであり、Standard AI本体（policy.ts）の欠陥ではない。

**今回、実経路そのものを検証するため**、`scripts/v2CompanySimulate.ts --provider standardAi`（`companyLab/cli/runCli.ts`経由で`runCompanyLabWithAutoPolicyForAllCompanies`＋`runner.ts`を実際に呼ぶ、Redis非依存の純粋関数実行）で8Qを再実行した（seed: `test15-audit-real-001`、baseline・canonical）。結果、BAL/JPQ/VAP/CONSVいずれも営業人員総数がターンごとに変化した（例: BAL 18→18→27→36→45→54→63→72、CONSVも同様に10→40）。MASSのみ資金制約（`SALES_HIRING_BLOCKED_BY_LIQUIDITY`相当）で22人のまま推移した。

**結論**: `standardAi/policy.ts`の営業採用/減員決定は、実本番経路（`runner.ts`経由）で確実に永続化状態へ反映されている。SAI-3Aオートプレイの「80人で完全固定」という結果は、**SAI-3Aハーネス固有の計測ツール上のアーティファクトであり、本番挙動ではない**。この点はTEST15_STANDARD_AI_8Q_16Q_BEHAVIOR.mdで詳述する。

## 2. §5 ブランチ状態

- 現在ブランチ`feature/v2-sai-salesforce-bottleneck-hiring`（HEAD `3d45c5f`）は、他の主要な#05系ローカルブランチ（`feature/v2-sai6-1-3-diagnosis-delivery-demand`・`feature/v2-sai6-4-inventory-production-plan`・`feature/v2-sales-staff-hiring-forward-port`・`feature/v2-standard-ai-capacity-observation-wiring`・`feature/v2-standard-ai-unit-economics-shadow-allocation`・`feature/v2-ai-explanation-client-progress-ui`）の**厳密な子孫**であることを`git merge-base`で確認した（各ブランチのHEADとmerge-baseが完全一致）。
- `feature/v2-standard-ai-turn1-redesign-analysis`と`feature/v2-persist-standard-ai-proposal`の2つは現在ブランチと分岐しており（merge-base ≠ HEAD）、未統合の別系統。今回のスコープ外（porting候補としては扱わない）。
- `origin/develop/v2`からの未push差分は24コミット（`git log origin/develop/v2..HEAD --oneline | wc -l`で実測。三宅さんご指示の「約30」とは若干差異があるが、実測値を正とする）。
- `git push`は`remote: access denied by the git proxy`（403）で失敗。既知の制約であり新規問題ではない。

## 3. §7 Sales（`decision/sales.ts`, `decision/salesForceHiring.ts`）

| 機能 | 分類 | 備考 |
|---|---|---|
| 市場選択・商品選択・希望数量 | A | `buildStandardAiSalesPlans`が全市場×全商品を評価し`decision.salesPlans`に直結。 |
| 価格設定 | A | `minimumAcceptablePrice`算出＋`finishedGoodsExcessRatioByProduct`（在庫過剰時の値引き圧力）を反映。 |
| 市場×商品配分・営業工数制約 | A | `salesEffortWeightedQuantity`等で営業人員の処理能力上限を適用（`SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY`）。 |
| 営業人員採用/減員（`salesForceHireCount`/`salesForceLayoffCount`） | **A（確認済み）** | `salesForceHiring.ts`が算定し、`policy.ts`が`decision`へ直結。§1のとおり本番経路で永続化される。 |
| Market Opportunity診断の実利用 | B/C混在 | `targetScale.ts`内の`marketOpportunityDirection`（簡易トレンド判定）のみ実際に使用（A相当だが軽量）。`diagnosis/marketOpportunity.ts`の`buildStandardAiMarketOpportunity`本体は`businessScaleProfile.ts`（後述、C）経由でしか参照されず、policy.ts本体からは未到達＝**C**。 |
| Shadow Sales Allocation | **C** | `diagnosis/shadowSalesAllocation.ts`の`buildShadowSalesAllocationComparison`は`businessScaleProfile.ts`からのみ参照され、`businessScaleProfile.ts`自体も`businessScaleScenarios.ts`（テスト専用の分析ツール）以外からは未到達。policy.tsへの経路なし。 |
| サプライヤーシェア上限（35%）の認識 | **D（AI側は非認識）** | `decision/sales.ts`にシェア上限に関する参照は無い。35%上限はダウンストリームの`sales/allocation.ts`側でのみ機械的に enforced されており、Standard AI自身はこの制約を織り込んだ意思決定（例: 上限に近づいたら他市場へ配分を振り替える等）を行っていない。三宅さんご指示により変更対象外・現状把握のみ。 |
| 期首FG在庫の販売判断への反映 | A（間接） | `pressures.finishedGoodsExcessRatioByProduct`経由で価格・数量調整に反映。ただし在庫の直接参照ではなく圧力スコア経由。 |
| 貢献利益/Unit Economicsの販売判断への反映 | A（限定的） | `forwardUnitEconomics.ts`の`buildStandardAiUnitEconomics`は**営業採用/減員判断**（`salesForceHiring.ts`）にのみ使われる。販売数量・価格そのもの（`sales.ts`）は独立したロジックであり、Unit Economicsを直接参照していない。 |
| Strategic Intent / Target Scaleの接続 | A | `targetScaleResult.targetScaleBand`は`salesForceHiring.ts`・`targetCapability.ts`へ実際に渡され、`SALES_CAPACITY_BELOW_TARGET_SCALE`等の診断→採用判断に使われる。「旧い営業capacity前提のまま」ではなく、現行の（Michaelis-Menten型飽和曲線を含む）営業capacity式を直接参照して算定している（`STANDARD_AI_8Q_SIMULATION_TARGET_SCALE_2026-08-05.md`参照）。 |

## 4. §8 Production（`decision/production.ts`, `diagnosis/currentPeriodDeliveryDemand.ts`, `diagnosis/productionRequirement.ts`）

| 機能 | 分類 | 備考 |
|---|---|---|
| 当期納品需要（SAI-6.3） | **A** | `buildCurrentPeriodDeliveryDemand`の結果が`computeEligibleCurrentPeriodDemand`経由で`finalProductionRequirementByProduct`に直結し、`buildStandardAiProductionPlans`の入力になる。診断専用ではなく実際の生産計画入力そのもの。 |
| 期首FG在庫・正常在庫目標（SAI-6.1/6.2） | **A** | `computeNormalInventoryTargetByProduct`＋`observation.finishedGoodsByProduct`が`computeBasicCurrentPeriodProductionRequirement`の入力。 |
| 生産必要量（SAI-6.4） | **A** | 上記の結果として`finalProductionRequirementByProduct`が生産計画の実入力。 |
| 戦略的先行生産 | D（未発火） | コード上のフックはあるが、今回のスコープでは常に0（`strategicProductionAdjustmentByProduct`省略時のデフォルト）。 |
| 生産優先順位・契約履行 | A | `production.ts`内で契約充足を優先するロジックあり。 |
| 能力不足時の対応・安全在庫 | A | 生産計画側で能力・原料制約を反映。 |
| 原料不足による生産抑制 | A | `RAW_MATERIAL_SHORTAGE`等のreasonCodeが実測で頻発（16Q・5社で110件）しており、実際に生産計画が原料制約を受けている。 |

SAI-6.1〜6.4の診断層は「診断専用の並行計算」というコメントが随所にあるが、実際には**当期納品需要・生産必要量の算出そのものが本番の生産計画入力として使われており**、単なるBではなくAである。この点は三宅さんご指示§21「SAI-6.1〜6.4診断層を破棄しない」の根拠として重要。

## 5. §9 Worker/Labor（`decision/labor.ts`, `companyLab/workforce.ts`）

| 機能 | 分類 | 備考 |
|---|---|---|
| 常用雇用/解雇（`HIRING_FOR_SUSTAINED_SHORTAGE`/`HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS`） | **A** | `runner.ts`へ実際に反映され、8Q/16Q実測でも常用人数が変動（後述）。 |
| 臨時ワーカー・残業 | A | `computeRequiredRegularHeadcount`が臨時ワーカー相当分を控除する形で組み込まれている。 |
| 必要人数算定 | A | `workforce.ts`の`computeRequiredRegularHeadcount`が生産計画から逆算。 |
| 商品別労務係数（HOSO/PD/VAP別の労務負荷） | **D（単一係数のみ）** | `computeRequiredRegularHeadcount`は`params.labor.regularEfficiencyPerHeadTons`という**単一の効率値**を全商品に適用しており、pd_laborが導入した`laborIntensityCoefficient`（HOSO 1.0/PD 1.8/VAP 3.0等）のような商品別係数は存在しない。コードで確認済み（`workforce.ts` 225〜245行目付近）。三宅さんご指示どおり、これはP0候補として§17-19で扱う（Test15でPD/VAP機能が稼働する前提のため）。 |
| 労働力不足と生産の連動 | A | `laborShortfall`が実際に生産計画へフィードバックされる（`companySummaries`に`laborShortfall`実測あり）。 |

**注記**: ゲーム環境側の労務パラメータ・エンジンは今回一切変更していない（三宅さんご指示§23-24の制約）。

## 6. §10 Raw Material（`decision/procurement.ts`）

| 機能 | 分類 | 備考 |
|---|---|---|
| 養殖・国内買付・輸入 | A | `buildStandardAiProcurementPlan`が3経路すべてを生成し`decision`に直結。 |
| 必要原料量の算出 | A | 生産計画から歩留まり1.0基準で逆算。 |
| 期首原料在庫の考慮 | A | 「在庫＋確定入荷見込みで足りるなら過剰発注しない」ロジックがコメント・実装双方で確認できる。 |
| 原料不足の診断 | A | `RAW_MATERIAL_SHORTAGE`等の実測多数。 |
| 現金圧力下の調達抑制 | A（自己抑制型） | `financing/liquidityClose.tsの事後的制約とは別に、AI自身が過大な希望を出さないようにする一次的な自制」とコード内コメントに明記。ただし`diagnosis/financialCapacity.ts`（後述C）は使っておらず、`pressures`経由の簡易指標のみを参照。 |
| 過剰発注抑制・在庫連動 | A | `PROCUREMENT_REDUCED_FOR_EXCESS`が実測44件（16Q・5社）。 |

## 7. §11 Investment（`decision/capex.ts`）— 優先確認事項

現行#05のcapexは**HOSO/PDライン増設・VAPライン増設・共通前処理能力増設の4種類の汎用ライン拡張のみ**であり、以下はいずれも**D（未実装）**である。

- 工場新設（$22M・3Qコンストラクション・4工場上限等、pd_laborの`newFactoryConstruction`相当） — D
- PD機械化投資（$2.5M/工場・脱人員化率33.33%上限等、pd_laborの`pdMechanization.ts`相当） — D
- VAP商品開発投資（4段階$0〜$500k、VAPケイパビリティスコア） — D
- 市場進化投資（`marketEvolutionInvestment.ts`相当） — D

capex.tsの判断ロジック自体（1.今期実測ボトルネック 2.一時的でない不足 3.在庫非過剰 4.現金バッファ安全マージン 5.借入余力 6.重複投資防止）は健全であり、`cashAndBorrowingSafe`が現金・借入圧力ゲートを実際にチェックしている（**A**、財務ゲート接続確認済み）。三宅さんご指示どおり、今回はこれらの実装は行わない（porting候補として§20-22へ）。

## 8. §12 Finance（`diagnosis/financialCapacity.ts`ほか）

- **重要な訂正**: `salesForceHiring.ts`の`SALES_HIRING_BLOCKED_BY_LIQUIDITY`ゲートは、`diagnosis/financialCapacity.ts`の`buildStandardAiFinancialCapacity`を呼んでいる**わけではない**。実際は`observation.cashUsd - pressures.targetMinimumCashUsd`という`pressures.ts`由来の簡易な流動性余力計算を直接参照している（`salesForceHiring.ts` 276行目）。これは**A（実経済ゲート）**だが、`diagnosis/financialCapacity.ts`というモジュール自体は経由していない。
- `diagnosis/financialCapacity.ts`（`buildStandardAiFinancialCapacity`、二分探索で「規模→現金結果」を評価する関数）は、`diagnosis/businessScaleProfile.ts`からのみ呼ばれており、`businessScaleProfile.ts`自体が`businessScaleScenarios.ts`（テスト専用スクリプト）経由でしか参照されない。**policy.tsへの経路が無い＝C（未接続）**。「診断専用」ですらなく、実行時の診断出力にも現れない。
- `decision/capex.ts`は独自に`cashAndBorrowingSafe`（現金・借入圧力チェック）を実装しており、これは**A**。
- `decision/procurement.ts`もpressures経由で自己抑制するため**A**。
- `decision/production.ts`は直接的な現金参照が無い（生産計画自体は現金ゲートを持たない。原料調達側で間接的に制約される）。

## 9. §13 Strategic/Diagnosis 一覧

| モジュール | 分類 | 理由 |
|---|---|---|
| Situation Diagnosis（`situationDiagnosis.ts`） | A（一部）/ B（大部分） | `rawMaterialSupplyConstraintState`のみ`salesForceHiring.ts`へ実接続。残りの5カテゴリ診断は`entries`へ出力されるのみでdecisionには使われない＝診断専用。 |
| Production Requirement（`productionRequirement.ts`） | A | §4参照。生産計画の実入力。 |
| Forward Unit Economics（`forwardUnitEconomics.ts`） | A | 営業採用判断へ実接続。 |
| Market Opportunity（`marketOpportunity.ts`） | C | §3参照。 |
| Shadow Sales Allocation（`shadowSalesAllocation.ts`） | C | §3参照。 |
| Financial Capacity（`financialCapacity.ts`） | C | §8参照。 |
| Strategic Intent（`strategicIntent.ts`） | A | `STANDARD_AI_STRATEGIC_INTENT_V1`（全社共通のBALANCED_GROWTH）が`targetScale.ts`へ実際に渡される。 |
| Target Scale（`targetScale.ts`） | A | §3・§7参照。 |
| Target Capability（`targetCapability.ts`） | A | `hasNearTermCapexUnderConstruction`が`salesForceHiring.ts`へ実接続。 |
| Target Sales Force（`salesForceHiring.ts`が実質これを兼ねる） | A | 上記のとおり。 |
| Business Scale Profile（`businessScaleProfile.ts`） | **C** | policy.tsから未到達。テスト・分析専用ツール（`businessScaleScenarios.ts`）でのみ使用。 |
| Bottleneck Flow / Reason Codes（`reasonCodes.ts`） | A | 全ドメインから利用される横断的な診断出力の型定義。 |

## 10. §14 Claude Explanation

- `app/lib/v2/companyLab/aiExplanation/buildExplanationContext.ts`は、`standardAi/`配下のいずれのファイルからも参照されておらず（grep確認）、`runner.ts`からも参照されていない。決定コアとClaude Explanationは**アーキテクチャ上完全に分離されている**ことをコードで確認した（三宅さんご指示の前提を再確認しただけで、新規変更なし）。
- 既知のスキーマ不整合について、本セッションのリポジトリ内検索（`docs/`・関連テストファイル）では、現時点で明示的にオープンな「schema mismatch」課題を記録したドキュメントは見つからなかった。過去セッションの`fix/v2-ai-explanation-claude-timeout-retry`・`feature/v2-ai-explanation-output-slimdown`ブランチ名から、タイムアウト・出力肥大化への対応が行われた形跡はあるが、これらは決定コアとは独立した経路の課題であり、Test15開始の可否には影響しない（§14の要求どおり、今回は実LLM呼び出しでの再検証は行っていない）。
