# SAI-GROW MASS Opportunity Architecture PRE-AUDIT

**監査のみ。`realisticShareOfProfitableOpportunity` / `maximumSupplierShare` /
MARKET_WEAK / Scenario のいずれも変更していない。**

base: `2244f18`（SAI-GROW-3C.1）。DS3 8seed / 3seed 実測。

## 0. 出発点（3D PRE-AUDITの再掲）

DS3 T32 で MASS は `realisticOpportunityTons ≈ 59,549t <= baselineTons 63,635t` となり
`MARKET_WEAK` で hold される。これが MASS の成長上限。

## 1. C-1 — 0.35 の起源

### 定義位置は **2か所**あり、どちらも 0.35

| parameter | 定義 | 意味 | 適用箇所 |
|-----------|------|------|---------|
| `SalesParameters.maximumSupplierShare` | `app/lib/v2/sales/parameters.ts:189` = **0.35** | 市場×商品区分×四半期ごとに、1社が対象需要から成約できる**engine上の最大比率** | `sales/allocation.ts::maximumSupplierShareFor`（実際の成約配分）、および `standardAi/decision/sales.ts::observableOpportunityCell`（AIの機会観測） |
| `CommercialAmbitionParameters.realisticShareOfProfitableOpportunity` | `vision/commercialAmbition.ts:85` = **0.35** | 「観測できる採算つき機会のうち、1社が現実的に狙ってよいと考える比率」 | `computeCommercialAmbition` の opportunity ceiling |

導入commit: `8d48668 feat(standard-ai): Vision駆動の商業成長（Commercial Ambition と未充足機会の分解）`（Phase 6）。

### 経済的意味と、実際に起きていること

`attainableProfitableTons` は既に **需要 × maximumSupplierShare(0.35)** の総和である
（`observableOpportunityCell` L112: `attainableDemand = observedDemand * salesParams.maximumSupplierShare`）。

そこへ Commercial Ambition が **さらに 0.35 を掛ける**:

```
realisticOpportunityTons = ( Σ 需要 × 0.35 ) × 0.35 = 需要 × 0.1225
```

`commercialAmbition.ts` のコメントはこれを意図的な二段構えと明記している——
「attainableProfitableTons は1社が取れる理論上限（各市場×商品の需要×maximumSupplierShare の総和）
であり、**全市場で同時に上限まで取れると考えるのは限定合理的でない**」。
すなわち「昔とりあえず置いた値」ではなく、**「全市場同時に上限は取れない」という
明示的な bounded rationality の主張**である。ただし 0.35 という数値自体に
校正の記録は無く、`maximumSupplierShare` と同じ値が偶然（あるいは慣習で）使われている。

* aggregate share か cell share か → **両方**。`maximumSupplierShare` は cell（市場×商品）単位、
  `realisticShareOfProfitableOpportunity` は aggregate 単位。
* 会社差 → **無い**。どちらも全社共通の定数。

## 2. C-2 — 5社の attainableProfitableTons が同一になる理由

DS3 T32 実測: 5社すべて **166,828t**（3seed平均、ratio 完全一致）。

`computeObservableCommercialOpportunity`（`standardAi/decision/sales.ts` L146-177）は
市場×商品セルを走査し、各セルで

```
observedDemand   = observation.markets[market].observedDemandByProduct[product]   ← 公開情報。全社同一
attainableDemand = observedDemand × maximumSupplierShare(0.35)                    ← 全社共通の定数
contributionPerKg = referencePrice − productEconomics.expectedProcessingCostUsdPerHosoEqKg[product]
isProfitable      = referencePrice が観測でき、かつ contributionPerKg > 0
attainableProfitableTons += attainableDemand（isProfitable のセルのみ）
```

会社差が入りうるのは **`expectedProcessingCostUsdPerHosoEqKg` だけ**であり、しかも
それは `isProfitable`（真偽）にしか影響しない。DS3では全社・全セルで
contribution が 5.2〜5.3 USD/kg と十分正のため、**すべてのセルが全社で profitable** になり、
数量は完全に同一になる。

**会社差が消えている箇所（＝一切入っていない要素）**:

| 要素 | 機会評価に入っているか |
|------|----------------------|
| market orientation | **入っていない**（別関数 `computeOrientationWeightedOpportunity` にのみ存在） |
| product orientation | **入っていない**（同上） |
| customer trust | 入っていない |
| quality / delivery reliability | 入っていない |
| price positioning | 入っていない（referencePrice は公開値） |
| sales capability（営業人員） | 入っていない（Commitment側で別途capされる） |
| strategic posture | 入っていない |
| product mix | 入っていない（全セルを無差別に合算） |

## 3. C-3 — orientationWeightedOpportunity を使う案の shadow 評価

### 実測: 現行パラメータでは **完全に無効**

DS3 T32（3seed平均）:

| 会社 | attainableProfitableTons | orientationWeightedOpportunityTons | 比 |
|------|-------------------------:|-----------------------------------:|----:|
| BAL / CONSV / JPQ / MASS / VAP | 166,828 | 166,828 | **1.000** |

理由: `StandardAiParameters` の既定が
`marketOrientationMultipliers: {}` / `productOrientationMultipliers: {}`（`parameters.ts` L360-361）
であり、`computeOrientationWeightedOpportunity`（`decision/sales.ts` L200-211）の
`combined = (marketOrientation[market] ?? 1) * (productOrientation[product] ?? 1)` が
全セルで 1.0 になる。さらに補正は `Math.max(0.7, Math.min(1.35, combined))` でクランプされるため、
**仮に profile で設定しても差は最大 ±35% にとどまる**。

### 3案の比較

| Option | 定義 | 現行パラメータでの結果 | 評価 |
|--------|------|----------------------|------|
| **O0（現行）** | `attainable × 0.35` | 全社 58,234t（T32・8seed） | 会社差ゼロ。MASSがbaselineに追い越される |
| **O1** | `orientationWeighted × 既存share` | **O0と完全に同一**（比1.000） | 現行パラメータでは無意味。差を出すには orientation multipliers を全社へ設定する必要があり、それでも最大 ±35% |
| **O2** | 市場×商品セルごとの supplier share を合算（GROW-2 の cell 単位式を再利用） | 未実測（実装が要るためshadow不可） | 会社差を出す唯一の構造的な道。customer trust / quality / delivery reliability / sales presence を cell share へ入れれば、engine の `maximumSupplierShareFor()`（既に「将来の拡張ポイント」とコメントされている）と一貫する |

**O1 は現行では採用に値しない。O2 は engine 側の `maximumSupplierShareFor()` 拡張と
セットで設計すべきであり、Standard AI 単独では完結しない。**

## 4. C-4 — 競争整合性（矛盾は無い）

DS3 T32 seed ds3-a 実測:

```
1社あたり attainableProfitableTons = 173,178t （= 観測需要 × 0.35）
→ 観測需要総量                     ≈ 494,794t
5社の realisticOpportunity 合計     = 304,780t  →  観測需要の 61.6%
```

**「各社が市場の35%を同時に取れる」という矛盾は生じていない。**
二段構えの 0.35×0.35 = 12.25% が5社で 61.3% になり、需要総量を超えない。
（engine の `maximumSupplierShare` は cell 単位の上限であり、5社合計 175% の
「主張」が可能だが、実際の配分は `sales/allocation.ts` が需要でクランプする。）

## 5. C-5 — share shadow sensitivity（0.35 / 0.40 / 0.45 / 0.50）

DS3 3seed（ds3-a/b/c）T32平均。**Vision は Case 0 のまま。**

| share | 会社 | ambition | sales | 生産 | worker | CAPEX | cash | debt | distress | backlog | overdue |
|------:|------|---------:|------:|-----:|-------:|------:|-----:|-----:|---------:|--------:|--------:|
| 0.35 | MASS | 63,600 | 34,387 | **53,565** | 19,888 | 90.8M | 504M | 0.0 | 1.3 | **61,348** | **17,891** |
| 0.40 | MASS | 67,665 | 35,138 | 53,583 | 19,885 | 90.8M | 503M | 0.0 | 1.3 | 64,049 | 18,311 |
| 0.45 | MASS | 70,101 | 35,609 | 53,585 | 19,886 | 90.8M | 503M | 0.0 | 1.3 | 65,889 | 18,442 |
| 0.50 | MASS | **70,101** | 35,609 | **53,585** | 19,886 | 90.8M | 503M | 0.0 | 1.3 | **65,889** | **18,442** |

他4社は 0.35→0.50 でほぼ不変（VAPは全水準で bit-identical、BAL/CONSV/JPQ は ±1%以内）。

### 読み取り

* MASS の **ambition は 63.6 → 70.1kt へ +10.2%** 上がる（0.45で飽和）。
* しかし **生産は 53,565 → 53,585t（+0.04%）で実質不変**。
* 代わりに **backlog +7.4%（61,348 → 65,889）**、**overdue +3.1%** と悪化する。
* cash / debt / distress / CAPEX / worker は不変。

**MASS は opportunity に制約されていない。capacity と execution に制約されている。**
share を上げると「取れる」と判断する量だけが増え、納品できない受注が積み上がる。

## 6. C-6 — Stop 判定

| 懸念 | 実測 | 判定 |
|------|------|------|
| MASS backlog 再爆発 | 61,348 → 65,889t（+7.4%）、overdue 17,891 → 18,442 | **該当** |
| 全社Ambitionが60kt超へ収束 | BAL 59.9 / CONSV 42.3 / JPQ 43.2 / VAP 31.2kt で不変 | 非該当 |
| BAL liquidity悪化 | debt 0.0M / distress 1.0 で不変 | 非該当 |
| CONSVが過剰成長 | ambition 42,333 → 42,267 で不変 | 非該当 |

**結論: 単純な share 増加は不採用。**
MASS の ambition だけが上がり、生産は増えず backlog / overdue が悪化する。
0.35 を上げることは MASS の問題の解決にならない。

## 7. 次に検討すべきこと（実装しない・#05判断事項）

1. **MASS の真の binding は capacity / execution である。** T32 で生産能力 66,797t に対し
   生産 53,330t、sales 33,155t、backlog 58,012t。opportunity を広げる前に
   「なぜ能力の80%しか回らないのか」「なぜ backlog を捌けないのか」の監査が要る。
2. **0.35 の二重適用**（`maximumSupplierShare` × `realisticShareOfProfitableOpportunity`）は
   意図的だが、同じ数値が2か所にあることは偶然であり、
   片方を動かすともう片方の意味が変わる。名前と意味の分離だけでも価値がある。
3. **Option O2（cell単位の会社別 supplier share）** は engine 側
   `sales/allocation.ts::maximumSupplierShareFor()`（既に将来拡張ポイントとコメント済み）
   と Standard AI の機会観測を同時に拡張する必要があり、**#04 スコープを含む**。
