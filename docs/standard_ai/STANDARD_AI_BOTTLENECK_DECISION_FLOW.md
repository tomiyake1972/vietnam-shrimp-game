# Standard AI 経営ボトルネック判定フロー

作成: Cowork #05（AI設定）／2026-08-05

## 1. 全体フロー（`policy.ts`の実際の呼び出し順序）

```
Observation構築（buildStandardAiObservation）
  ↓
Pressure Scores（computePressureScores）
  ↓
Sales Plans（buildStandardAiSalesPlans）─ 既存のsales/marketEffort.ts等を使用
  │   → desiredByProduct（理論販売機会）／realisticSalesByProduct（営業工数制約後）
  │   → salesWishByMarketProduct（制約適用前の市場×商品別希望量）
  ↓
Current Period Delivery Demand（buildCurrentPeriodDeliveryDemand）
  ↓
Production Requirement（productionRequirement.ts）
  → finalProductionRequirementByProduct
  ↓
Production Plans（buildStandardAiProductionPlans）
  ↓
Forward Unit Economics（buildStandardAiUnitEconomics）─ 診断専用、貢献利益
  ↓
Procurement / Labor / Financing / Capex（既存、変更なし）
  ↓
Situation Diagnosis（buildStandardAiSituationDiagnosis）
  → primaryConstraint / secondaryConstraint（sales_shortage, production_capacity_shortage/surplus,
     worker_shortage/surplus, raw_material_shortage, inventory_excess, none）
  → rawMaterialSupplyConstraintState（shortage/balanced/surplus/unknown）
  ↓
【新設】Sales Force Hiring Decision（buildStandardAiSalesForceHiringDecision）
  → salesWishByMarketProduct・finalProductionRequirementByProduct・
     totalEffectiveCapacityByProduct・unitEconomics・rawMaterialSupplyConstraintStateを入力
  → 1人ずつのmarginal economics評価（下記2章）
  → salesForceHireCount / salesForceLayoffCount
  ↓
Decision（CompanyDecisionInput）確定
```

## 2. Marginal Salesperson評価の意思決定木（1人ずつ、hire方向）

```
現在の営業人員数 h から h+1 を試す
  │
  ├─ incremental sales ≈ 0 ?
  │     Yes → 停止（A. profitable unserved opportunity消滅）
  │
  ├─ marginalContributionAfterSalesSalary <= 0 ?
  │     Yes → 停止（D. SALES_HIRING_NOT_ECONOMIC）
  │
  ├─ 新規生産が必要な増分 > 会社全体の生産余力合計 ?
  │     Yes → 停止（E. SALES_HIRING_BLOCKED_BY_PRODUCTION）
  │
  ├─ 新規生産が必要 かつ rawMaterialSupplyConstraintState == "shortage" ?
  │     Yes → 停止（G. SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY）
  │
  ├─ 現金の最低バッファ余力 - 累積追加給与 < 0 ?
  │     Yes → 停止（H. SALES_HIRING_BLOCKED_BY_LIQUIDITY）
  │
  └─ すべて通過 → この1人を受理し、h+1 → h+2 へ進む（安全上限まで）
```

減員方向（layoff）は、hireCount=0の場合のみ評価し、末尾1人のmarginal contributionが給与以下かつ既存FGが販売のボトルネックでない場合のみ、退職金（2四半期分の給与）を考慮した上で受理する。

## 3. 現行Situation Diagnosisとの関係（三宅さんご指示§3の対応状況）

既存の`situationDiagnosis.ts`（SAI-6.1、2026-08-02新設）は、既にshortage/surplusを1本のpressure scoreへ押し込まず、以下のカテゴリを独立に判定していた（新規実装ではなく、既存資産の確認）。

| カテゴリ | 状態の分離 | 本ファイルでの位置づけ |
|---|---|---|
| `sales_shortage` | 不足のみ（surplus概念なし） | 現状維持。§9で「sales_capacity_shortage」と「market_opportunity_shortage」への分割を提案したが、既存テスト資産への影響を避けるため今回は見送り |
| `production_capacity_shortage` / `production_capacity_surplus` | 両方 | 既存のまま利用 |
| `worker_shortage` / `worker_surplus` | 両方 | 既存のまま利用 |
| `raw_material_shortage`（真の供給制約のみ） | 不足のみ（surplus概念なし、既存市場データで十分と判断されている） | 既存のまま利用。`rawMaterialProcurementNeeded`（中立的事実）と`rawMaterialSupplyConstraintState`（真の制約、大半unknown）が既に分離されている |
| `inventory_excess` | 過剰のみ | 既存のまま利用 |
| `liquidity_shortage` | （primary/secondary候補には含めない設計） | 既存のまま。借入余力が未接続のため、現金バッファ不足だけでは資金制約と断定しない設計を維持 |

## 4. #04 / #05 分類（三宅さんご指示§20対応）

### #04（ゲームエンジン・パラメータ設計）

- 営業capacity式の半飽和点・パラメータ自体（現行10人/市場での飽和は非常に強い）
- 商品別営業工数係数（現行hoso1.0/pd1.2/vap3.0。三宅さんの新仕様案ではpd2.0）
- `SALES_FORCE_SEVERANCE_QUARTERS`（現在ローカル定数、共有パラメータとしてexport推奨）
- カバレッジ・競争力・市場競争が実質的に成約量へ効いていない（Test14実データで確認済み、`TEST14_TURN1_VS_TURN2_SALES_CAPACITY_DECOMPOSITION.md`参照）ことのゲームバランス上の是非

### #05（Standard AI・意思決定連動）

- 本ファイルで実装した営業採用/減員の意思決定ロジック自体
- `SALES_HIRING_BLOCKED_BY_PRODUCTION`の商品別精緻化（現行は会社全体合計での近似）
- Financial Capacity診断モジュールとの多四半期統合
- `situationDiagnosis.ts`の`sales_shortage`をcapacity/opportunityへ分割する設計変更（提案のみ、実装保留）
- Test14実データに対するshadow simulation実行（`StandardAiObservation`構築の完成、次回優先）
