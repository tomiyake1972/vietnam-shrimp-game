# Business Scale Profile 設計・実装まとめ（第1段階）

2026-08-04 Cowork #05（AI設定）実施

## 0. 位置づけ

本文書は`MISSION_VISION_BUSINESS_SCALE_DESIGN_PROPOSAL.md`で合意した7段階の**第1段階（Business Scale Profile、診断専用）**の実装記録である。本番Standard AIのsales/production/procurement/labor/financing/capex決定は一切変更していない（`decision/*.ts`のいずれも本モジュールをimportしていないことをテストで構造的に確認済み）。

## 1. 設計思想（三宅さんの指示§0を実装でどう守ったか）

`Business Scale = min(5軸)`のような単一値へは一切潰していない。`BusinessScaleProfile.axes`は5軸を独立した配列として保持し、集約用のフィールド（`compositeScale`等）自体を型に存在させていない。これはテスト（`businessScaleProfile.test.ts`「Business Scale Profileは単一の合成値を一切出さない」）で、型のキー一覧に禁止フィールドが存在しないことまで含めて確認している。

## 2. 型設計（`app/lib/v2/companyLab/standardAi/diagnosis/businessScaleProfile.ts`）

- `BusinessScaleAxis` = "sales" | "production" | "labor" | "rawMaterial" | "finance"
- `ScaleConfidence` = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"
- `ConstraintFlexibility` = "HARD_CURRENT_PERIOD" | "ADJUSTABLE_NEXT_PERIOD" | "EXPANDABLE_WITH_CAPEX" | "EXPANDABLE_WITH_FINANCING" | "UNCERTAIN"
- `ExpansionOption` { flexibility, leadTimeQuarters（既存ルールから取得できない場合はnull）, description }
- `SupportedScaleEstimate`（軸1件ぶん） { axis, supportedScaleTons（求められない場合はnull）, confidence, limitingReason, constraintFlexibility, expansionOptions, source, dataQuality }
- `BusinessScaleProfile` { companyId, period, axes（5件）, salesDetail, productionDetail, rawMaterialDetail, financeDetail }

## 3. Sales-supported Scale

`shadowSalesAllocation.ts`の`buildShadowSalesAllocationComparison`（volume-oriented）を再利用し、現在の営業人員数を最適配分した場合の上限（`salesForceSupportedScaleTons`）を求める。これと会社全体の商品別理論上限（`decision/sales.ts`の`desiredByProduct`、診断専用の理論値）の小さい方を`currentObservableCeilingTons`とし、これを`supportedScaleTons`として採用する。**市場別絶対需要（`demandSupportedScaleTons`）は常にnull**（Phase F-4で確定分類済みの構造的な観測不能性を継承）。`confidence`は真の需要が不明であることを反映してMEDIUM（HIGHにしない）。

## 4. Production-supported Scale

名目能力（`totalCapacityByProduct`）は参考情報としてのみ保持し、supported scaleには使わない。実効能力（`totalEffectiveCapacityByProduct`・`totalEffectiveCommonProcessingCapacity`・`totalEffectiveFreezingPackagingCapacity`）だけを使用する。指定した商品ミックス前提（省略時は現在の販売計画から推定）のもとで、共通前処理・凍結包装・各商品専用ラインのうち最も厳しい制約（shared bottleneck）を`sharedBottleneckSupportedScaleTons`として算定する。ミックスが変われば結果も変わることを`mixSensitivityNote`で明示する。

## 5. Labor-supported Scale

`production/labor.ts`の`requiredHeadcountForQuantity`（既存の逆算関数）をそのまま使用し、新しい労務式は作っていない。商品ミックス前提のもとで、1トンあたり必要人数の加重合計を求め、現在の正社員人数から逆算する。Worker Model比較文書（`WORKER_MODEL_COMPARISON_FOR_04.md`）で指摘したVAP労務係数の現実性への疑問（#04 pending）は、ここでは**ゲームルール上の値としてそのまま使用**しており、混同しないよう`dataQuality.note`で明示している。

## 6. Raw-material-supported Scale

期首在庫＋当期確実な入荷（`rawMaterialAvailable + rawMaterialCertainInboundThisPeriod`）のみを`certainSecuredRawTons`とする。市場全体の前期不動在庫（`vietnamDomesticPriorMarket.unsoldSupply`）は`publicMarketIndicatedSurplusTons`として別に保持するが、これを会社固有の購入可能量へ変換しない。`companySpecificPurchasableCapTons`は**恒常的にnull**。

**実装上の留意点（今回判明した限界）**: turn2（前期の市場公開結果がまだ無い、または在庫パイプラインがまだ立ち上がっていない期）では`certainSecuredRawTons`がほぼ0になり、Rawが常にbindingになりがちであることが5社回帰（`TEST14_TURN2_BUSINESS_SCALE_SCENARIOS.md`および`BUSINESS_SCALE_OBSERVATION_GAPS_AND_04_HANDOFF.md`参照）で確認された。これは「調達を毎期新規に決める」というゲームの運転資金型ビジネスモデル自体の性質であり、モジュールの計算誤りではないが、この軸が「典型的に持続可能な原料規模」ではなく「保守的な下限」を表している点は明示すべきである。

## 7. Finance-supported Scale

`financialCapacity.ts`の`buildStandardAiFinancialCapacity`（既存の「規模→現金結果」を返す純関数）に対し、二分探索の純関数ラッパー（`maxScaleWhere`）を1枚被せて、逆方向（現金制約→支えられる規模）を求める。**cash-negativeとbelow-target-bufferを明確に区別**し、`supportedScaleTons`にはより保守的な方（`supportedScaleTonsWithinTargetBuffer`）を採用する。追加借入可能額（`availableBorrowingHeadroomUsd`）が未配線の場合はnullのまま（近似しない）。

## 8. Constraint Flexibility / Lead Time

新しいリードタイム規則は発明していない。既存ルールからそのまま読み取れる範囲のみを使用: Sales/Labor=ADJUSTABLE_NEXT_PERIOD・leadTimeQuarters=1（既存の`regularHeadcountAdjustmentDamping`相当の漸進調整）、Production=EXPANDABLE_WITH_CAPEX（`capex/parameters.ts`の`standardConstructionQuarters`+`postCompletionReadinessQuarters`、具体的な四半期数はテンプレート依存のためleadTimeQuarters自体はnullのまま、descriptionで言及）、Finance=EXPANDABLE_WITH_FINANCING（借入可能額が観測されていればleadTimeQuarters=0、未配線ならnull）、RawMaterial=UNCERTAIN（拡張余地の大きさを診断できないため）。

## 9. テスト・品質ゲート

新規テスト14件（`businessScaleProfile.test.ts`）+ 4件（`businessScaleScenarios.test.ts`）。全2194件（既存2190+新規18）pass、`npx tsc --noEmit`クリーン、lintは既存無関係警告4件のみ。decision/*.tsからのimport不在をソース走査で確認済み。副作用のない純関数であること（呼び出し前後で本番のsales/production plansが変化しないこと）も確認済み。
