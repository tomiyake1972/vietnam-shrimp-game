# 市場情報の遅行公開（Market Information Lag）設計

Batch 002 / branch `feature/v2-standard-ai-training-harness`

## 1. 思想

市場には真の現在需要が存在する。しかし**経営者はその値をリアルタイムでは知らない**。

プレイヤーとStandard AIは「約6か月前に確認された市場×商品別需要」を使って現在を判断し、価格・自社営業実績・在庫・競合動向から現在の市場を推測する。Standard AIに現在の真実を直接渡すのではなく、現実の経営者と同じように遅行する公開情報で意思決定させることが目的である。

## 2. True Demand と Observed Demand の分離

| | 定義 | 誰が見るか |
|---|---|---|
| **True Market Demand** | 当期の市場×商品別対象需要。市場配分・成約・価格形成はすべてこれで計算される | ゲームエンジンのみ |
| **Observed Market Demand** | 原則2四半期前の市場×商品別需要 | プレイヤー・Standard AI（同一の値） |

ゲーム内部の計算は一切変更していない。変更したのは「経営者が何を観測できるか」だけである。

## 3. True demand の保存元 — 市場エンジンの変更は不要だった

調査の結果、per market × product の真の需要は**すでに保存されていた**。

- `sales/runner.ts` の `advanceSalesQuarter` が `MarketProductAllocationResult.targetDemand` として市場×商品ごとの対象需要を `SalesQuarterRecord` へ保存している
- それが `CompanyQuarterRecord.salesRecord.allocations` として `CompanyLabState.history` に残る

したがって観測履歴の保存のために market engine の production code を変更する必要はなく、**この層は既存の履歴を読むだけ**で済んだ（§21 の停止条件には該当しない）。

**単位の意味**: `targetDemand` は「ベトナム産がその四半期にその市場×商品で獲得できる対象需要（HOSO換算トン）」であり、`sales/allocation.ts` が `shareCap = targetDemand × maximumSupplierShare` として使う値そのものである。したがって `観測需要 × maximumSupplierShare` はそのまま自社が取り得る上限の目安になる。

## 4. 2四半期lagの実装

`app/lib/v2/companyLab/marketDemandObservation.ts`

```
turn N の意思決定時点で state.history は turn1..N-1 を持つ
観測元 = history[history.length - MARKET_DEMAND_OBSERVATION_LAG_QUARTERS]
```

| 意思決定turn | 観測できる需要 | source |
|---|---|---|
| 1 | ゲーム開始時点の既知市場情報 | `INITIAL_MARKET_INFORMATION` |
| 2 | ゲーム開始時点の既知市場情報 | `INITIAL_MARKET_INFORMATION` |
| 3 | turn1実績 | `LAGGED_MARKET_RESULT` |
| 4 | turn2実績 | `LAGGED_MARKET_RESULT` |
| 5 | turn3実績 | `LAGGED_MARKET_RESULT` |

`MARKET_DEMAND_OBSERVATION_LAG_QUARTERS = 2` は明示的なパラメータとして持ち、`buildObservedMarketDemand(state, turn, lagQuarters)` は 1Q/3Q でも動作する（テストで固定）。今回は2Qで固定運用する。

**情報リーク防止**: この関数は history の末尾から LAG 個手前より新しい記録を一切参照しない。当期（turn N）の記録はそもそも history に存在しない。したがって現在の true demand も将来の需要も**構造的に**読めない。

## 5. Turn1・Turn2 の初期市場情報

新しい市場需要の数値は一切発明していない。使ったのは既存のシナリオ前史のみ。

```
初期観測需要[市場][商品]
  = prehistory.priorMarketConsumptionHosoEqTons[市場]     ← 既存（CN 380,000 / US 320,000 / EU 260,000 / JP 90,000 / OTHER 150,000）
  × (prehistory.countrySupplyHosoEqTons.VN / Σ国別供給)   ← 既存（450,000 / 2,000,000 = 0.225）
  × computeMarketProductMix(turn)[市場][商品]             ← 既存の商品構成比関数
```

**なぜベトナム供給シェアを掛けるか**: turn3以降に公開する observed demand は `targetDemand`（ベトナム産が獲得できる対象需要）である。前史消費量は世界の最終消費規模なので、そのまま並べると turn2→turn3 で単位の意味が変わる。前史のベトナム供給シェアを掛けることで同じ尺度に揃える。シェアは前史の既存値だけから算出しており、新しいパラメータは置いていない。

**精度の限界（正直に記す）**: この初期値は実測でturn1の実 targetDemand の約1.27倍になる（輸出可能比率・PD/VAP加工能力の効果を含まないため）。

| 市場 | 初期観測 | turn1の実 targetDemand | 比 |
|---|---|---|---|
| CN | 85,500 | 67,553 | 1.27 |
| US | 72,000 | 41,463 | 1.74 |
| EU | 58,500 | 32,750 | 1.79 |
| JP | 20,250 | 13,072 | 1.55 |
| OTHER | 33,750 | 20,050 | 1.68 |

市場間の相対的な大小関係は保たれているため配分判断には使えるが、絶対量としては過大側に出る。turn3への切り替わりで営業配置が振動しないかは実測で確認した（平滑化は入れていない。§17）。

## 6. プレイヤーUI

`app/v2/company-lab/components/OpeningInfoPanels.tsx` の `ObservedMarketDemandPanel`。

- 見出しは「市場規模（2四半期前（第Nターン）の実績）」／turn1・2は「市場規模（ゲーム開始時点の既知市場情報）」
- 5市場 × 3商品 + 合計の表
- 説明文で「約6か月遅れの市場情報です。現在の確定需要ではありません」を明示
- 末尾に「この数値は標準AI（他の4社）が見ている情報とまったく同じです」と明記
- 既定は折りたたみ（`defaultOpen={false}`）

## 7. Standard AI Observation

`MarketObservationEntry` を price-only から拡張（既存フィールドは維持）。

```ts
export interface MarketObservationEntry {
  readonly market: DemandMarketId;
  readonly referencePriceByProduct?: ProductAmount;   // 既存
  readonly observedDemandByProduct?: ProductAmount;   // 新規
}
```

`StandardAiObservation` に `marketDemandObservationLagQuarters` / `marketDemandSourceQuarter` / `marketDemandObservationSource` を追加。すべてオプショナルなので既存の diagnosis / explanation は壊れない。

## 8. Player と Standard AI の公平性

`buildStandardAiObservation` は `publicInfo.observedMarketDemand`（＝プレイヤー画面が受け取るのと同一のオブジェクト）から転記するだけである。AIだけが別経路で需要を読むことはできない。

テスト「5: プレイヤーUIとStandard AI Observationは同じ値を見る」が、5社すべて・3ターンぶんについて market × product 単位で一致を検証している。

## 9. Fingerprint の3層分離

情報公開ルールの変更は、経済世界の変更とは別に追跡する必要がある。

| 層 | 対象 | 意味 |
|---|---|---|
| `gameMechanicsFingerprint` | market/sales/rawMaterials/production/finance/financing/capex/quality/scenario/turn/core + companyLabのゲームルール（情報公開層を除く） | 経済世界の計算ルール |
| `informationSetFingerprint` | `marketDemandObservation.ts` / `domesticReferencePrice.ts` / `standardAi/observation.ts` / `standardAi/types.ts` | プレイヤー・AIが何を観測できるか |
| `standardAiFingerprint` | `standardAi/**`（training/ と情報公開層を除く） | AIの判断ロジック |

`environmentFingerprint` は後方互換のため `gameMechanicsFingerprint` の別名として残す。

**既知の限界**: `buildPublicMarketInfo` は `companyLab/runner.ts` の中にあり、ファイル単位のハッシュでは分離できないため runner.ts は gameMechanics 側に残る。したがって情報公開層だけを変えたつもりでも runner.ts を触れば gameMechanicsFingerprint は動く。

**経済計算が本当に変わっていないことの最終的な保証は fingerprint ではない。** 同じ意思決定列を新旧のエンジンへ流して結果ハッシュが一致することを直接確認しており（実測: 両方とも `6764e40ad66a01b923f71c7159ed380e`）、テスト「11: ゲームメカニクスの計算結果は、同じ意思決定なら変更前後で同一」がこれを固定している。`advanceCompanyLabQuarter` はそもそも `publicInfo` を引数に取らないため、観測情報がエンジンの計算へ入り込む経路は構造上存在しない。

## 10. 観測需要の内生性（重要な注意）

`targetDemand` の市場別按分ウェイトは `market/consumerInventory.ts` の `deriveMarketWeightsFromDesiredPurchase` により、消費地の希望購買量から決まる。希望購買量は消費地在庫の関数であり、消費地在庫は**5社が実際にその市場へ供給した量**の影響を受ける。

したがって **observed market demand は完全に外生ではなく、AI自身の販売行動の結果を部分的に含む**。AIがある市場から撤退すると、その市場の観測需要はさらに縮小し、撤退が自己強化される。

実測（seed `sai-train-standard-001`）:

| turn | EU（C03・JP集中時代） | EU（Batch 002） | JP（C03） | JP（Batch 002） |
|---|---|---|---|---|
| 1 | 32,750 | 32,750 | 13,072 | 13,072 |
| 8 | 25,045 | 25,390 | 13,686 | 7,823 |
| 16 | 9,794 | 7,529 | 7,780 | 1,752 |
| 32 | 7,225 | 1,029 | 3,951 | 161 |

EU・JPの縮小は**両方の版で起きている**（＝主因は既存の市場進化ダイナミクス）が、Batch 002 はそれを加速している。これは情報公開層の設計ではなくゲームメカニクス側の性質であり、`MANAGEMENT_JUDGMENT_REVIEW` / `ENVIRONMENT_ISSUE_CANDIDATE` として報告する（本Batchでは変更しない）。
