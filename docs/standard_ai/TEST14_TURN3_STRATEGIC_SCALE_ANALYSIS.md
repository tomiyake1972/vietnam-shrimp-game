# Test14 Turn3 Strategic Scale分析

作成: Cowork #05（AI設定）／2026-08-05

## 1. スコープと制約（最初に明記）

前回報告（`TEST14_TURN3_STANDARD_AI_ANALYSIS.md`§1）と同じ制約が今回も残っている。**Test14 Turn3の実際の状態に対して、新設の`buildStandardAiSalesForceHiringDecision`・`computeTargetScaleBand`・`computeTargetCapability`をこのセッション内では実行していない。** 理由も同じで、`StandardAiObservation`（約90フィールド）をTest14のライブ状態（Export JSON）から欠落なく正確に再構築するマッピング作業が、今回のStrategic Intent/Target Scale実装作業と並行して完結しなかったためである。この点は複数回のセッションにわたって持ち越されており、**次回セッションの最優先タスク**として改めて明記する。

以下は、既知のTurn3実データ（BAL、三宅さんご提示・過去分析より）と、新設モジュールの計算式を手動で適用した**分析的な推計**である。実際のコード実行結果ではない。

## 2. Turn3開始状態（既知の実データ）

- FG inventory 約9,366t
- raw inventory 約3,038t
- cash 約$47.6M
- debt 約$48.0M
- backlog 0
- 現在の営業人員 38人
- 共通前処理・凍結capex under construction

## 3. Strategic Intent（推計）

Standard AI共通の`BALANCED_GROWTH_STRATEGIC_INTENT_V1`をそのまま適用する（会社別性格は今回未実装のため、BALも含め全社共通）。

## 4. Target Scale Band（推計、計算式の適用のみ）

```
currentSustainableScaleTons = 現在の実効生産能力（totalEffectiveCapacityByProduct合計）
Target Scale Band = currentSustainableScaleTons × {min:1.0, preferred:1.15, max:1.35}
```

**BAL社のTurn3時点での実効生産能力の正確な値は、本セッションでは未取得**（§1の制約により、Observationを実際に構築していないため）。したがって具体的なトン数の算出は次回、Observation再構築完了後に本文書を更新する形で追記する。

## 5. Target Sales Force（推計、定性的判定のみ）

正確な必要人数の算出には上記Target Scale Band（トン数）と、既存の`sales/marketEffort.ts`の`allocateHeadcountAcrossMarkets`・`computeMarketSalesEffort`を用いた探索計算が必要であり、いずれも実データでの実行が前提となる。今回はこれも未実施である。

**定性的な観察**: 9,366tという大きなFG在庫は、過去の生産が販売能力（旧capacity仕様下での実現可能販売量）を上回っていたことを示唆する。現在の38人という営業人員が、Target Scale（実効生産能力ベースで算定される、旧仕様よりも新しい#04仕様のもとでの値）に対して不足・適正・過剰のいずれであるかは、#04の新capacity仕様の実装完了とObservation再構築の両方が完了して初めて確定できる。三宅さんご指示§25の「Strategic ScaleとCurrent Operating Requirementを完全に分ける」という設計方針自体は、`salesForceHiring.ts`・`targetScale.ts`の実装（Target Sales VolumeとProduction Requirementを独立変数として扱う構造）に既に反映されている。

## 6. Turn3 Operational Decisionとの分離（三宅さんご指示§25、設計としては実装済み）

Strategic Target ScaleとCurrent Operating Requirementは、コード構造として既に分離されている。`salesForceHiring.ts`は`targetSalesVolumeTons`（Target Scaleベース）を営業採用の上限としてのみ使い、当期の生産計画（`finalProductionRequirementByProduct`）自体は一切書き換えない。当期のoperational decision（生産）は、引き続き既存の`productionRequirement.ts`（opening inventory → 現実的販売量 → 通常在庫目標 → 生産必要量の順）がそのまま計算する。したがって、「Target Scaleが20,000tだから今期20,000t新規生産する」という誤った連動は、設計上発生しない。この分離自体は8Qシミュレーション（`baseline`シナリオ、実データではない）で実証済みである。

## 7. 未解決事項（次回優先、繰り返しになるが重要）

1. `StandardAiObservation`をTest14の実際のExport JSONから構築するマッピングコードの作成（最優先。複数セッションにわたり持ち越されている）。
2. 上記完了後、本文書のTarget Scale Band・Target Sales Force・不足/適正/過剰判定を実際のコード実行で確定させる。
3. 4Q Capacity Projection（`STANDARD_AI_CAPACITY_PLANNING_4Q.md`§2で未実装と明記した複数四半期projectionテーブル）の実装。
