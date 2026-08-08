# Test15 JP19 問題の root cause 分析

「営業人員の約半分が最小市場である日本へ配分される」現象について、**過去の報告書からの引用ではなく、現行の production code と Training Harness の実測から**確認した結果。

## 1. 現象の再現（実測）

Training Harness baseline（`environmentFingerprint=aabcadf67e6f4444`）で再現した。

BAL, turn 2, seed `sai-train-standard-001`:

| 市場 | 営業人員 | 当該四半期の市場需要 |
|---|---|---|
| **JP** | **9人（50%）** | **9,395 t（最小）** |
| CN | 3人 | 49,535 t（最大） |
| US | 2人 | 36,049 t |
| EU | 2人 | 26,608 t |
| OTHER | 2人 | 16,637 t |

監査ルール A01 は 1,600 company-quarter 中 **1,550件（97%）** で発火した。特定ターン・特定会社の異常ではなく、**全社・ほぼ全期間で恒常的に起きている構造的挙動**である。

## 2. 直接原因（現行コード）

`app/lib/v2/companyLab/standardAi/decision/sales.ts:285-291`

```ts
markets.forEach((market, idx) => {
  const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
  const desiredQuantity = totalDesired * weight;
  if (desiredQuantity <= EPSILON) return;
  desiredByMarketProduct.get(market)![product] = desiredQuantity;
});
```

- `markets` = `pressures.marketPriceRanking`
- `marketPriceRanking` は `pressures.ts:94-95` で、各市場の `referencePriceByProduct` の**商品横断合計だけ**を降順ソートしたもの
- 首位市場に固定で 50%、残りに均等配分

営業人員は、この市場別希望販売量から導かれる営業工数需要に応じて `allocateHeadcountAcrossMarkets` で配分される。したがって **「単価が最も高い市場」が自動的に「営業人員の半分を投じる市場」になる。** 日本は単価が高く規模が小さいため、この規則の下では必ず選ばれる。

規模を見ていないので、「その市場が営業人員9人ぶんの販売量を吸収できるか」は判断に入っていない。

## 3. より深い原因 — 観測構造上、市場規模が存在しない

これは係数の誤りではない。**Standard AI は市場の大きさを観測する手段を持たない。**

`app/lib/v2/companyLab/standardAi/types.ts`:

```ts
export interface MarketObservationEntry {
  readonly market: DemandMarketId;
  /** 前期実績の商品別参照価格（USD/HOSO換算kg）。前期実績が無い場合はundefined。 */
  readonly referencePriceByProduct?: ProductAmount;
}
```

上流を辿ると:

- `PublicMarketInfo`（`companyLab/types.ts:288`）が持つのは `lastMarketResult` / `vietnamDomesticPriorPrice` / `productLifecycleOutlook`（市場内の**商品構成比**）/ `productSupplyPressureOutlook`（商品別の需給比）
- `MarketQuarterResult`（`market/types.ts`）が持つ数量は `worldSupply` / `worldDemand` の**世界合計のみ**。国別 HOSO 価格・PD/VAP プレミアム・ベトナム国内清算結果はあるが、**CN/US/EU/JP/OTHER 別の需要数量は出力自体に存在しない**
- 市場別の需要規模に相当する `DemandMarketInput.priorPeriodConsumption` は市場エンジンの**入力**であり、出力として公開されていない

`diagnosis/marketOpportunity.ts` は既にこの限界を認識していて、`targetDemandTons` を恒常的に `null` として返し、理由を明文化している（同ファイル冒頭コメント）。今回の実測はその記述が現行コードでも正しいことを裏付けた。

**したがって A01 が検出しているのは「AIが見えていたのに間違えた」ではなく「AIには構造的に見えていない」である。** 監査ルール A01 が使う市場需要量は、ハーネスがシミュレーション内部から直接読んだ値（AIの観測境界の外）である。

## 4. 修正方針の選択肢（判断を仰ぐ）

Cycle 1 では **修正していない**。どれを選ぶかは経営判断とゲーム設計判断の両方に触れるため。

### 選択肢1: 自社の実績から市場規模を学習する（AI側のみ・観測境界を変えない）

`ownState.contracts` は `market` / `contractedPeriod` / `originalQuantity` を持つので、自社が各市場で過去に実際に成約できた量は観測できる。これを「その市場で自社が吸収できると実証された規模」の下限推定として使い、価格ランキングと組み合わせて配分重みを作る。

- 利点: ゲーム環境に一切触れない。自己修正的（過大配分した市場は実績が伸びず、自動的に重みが下がる）
- 欠点: 実績は過去の配分の結果でもあるため、探索項（ε）を入れないと初期の偏りが固定化しうる。turn1-2 は実績が無く従来挙動へフォールバックが必要

### 選択肢2: 市場別需要量を公開情報として観測へ配線する（**ゲーム環境の変更**）

`MarketQuarterResult` に市場別需要量を出力し、`PublicMarketInfo` 経由で観測へ渡す。

- 利点: 根本的。現実のプレイヤーは市場調査で市場規模を知り得るため、ゲームデザインとしても自然
- 欠点: **これはゲーム環境側の変更であり、今回の指示で明確に禁止されている範囲に入る。** 実施の可否は #04 / 三宅さんの判断事項

### 選択肢3: 現状維持

日本市場への集中を「単価重視の経営方針」として意図的に許容する。

- 利点: 変更なし
- 欠点: 全社・全期間で同一の集中が起きており、5社の経営性格の差として説明できない

## 5. Claude Code の見解

**選択肢1を推奨する。** ゲーム環境に触れずに実装でき、AI側の欠陥（「規模を無視して価格だけで50%を投じる」）を、観測できる情報の範囲で正す。

ただし、選択肢1でも「どれだけ集中するか」は経営哲学に属する（監査ルール B_STRATEGIC_MARKET_CONCENTRATION が該当）。実装する場合も、集中度そのものを Claude Code が決めるのではなく、パラメータとして外に出し、値の決定は判断を仰ぐべきと考える。

選択肢2が本来望ましい形だと考えるが、**ゲーム環境の変更に当たるため実施せず、判断を仰ぐ。**
