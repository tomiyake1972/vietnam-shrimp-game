# Unit Economics 実装前調査メモ（Phase H・2026-08-02）

Cowork #05（AI設定）作成。SAI-6.4完成後、Unit Economics本体の実装にはまだ着手せず、実装に必要な既存コードを調査した結果をまとめる。設計文書（`docs/standard_ai/TEST14_TURN1_STANDARD_AI_REDESIGN_ANALYSIS.md` §17.5.1）で示した「既存を最大限再利用する」方針の裏付け調査であり、本メモ自体もproduction codeの実装ではない。

## 1. 既存の事後（backward-looking）Full Cost / Contribution Margin計算式

- `app/lib/v2/finance/types.ts`の`ContributionMarginReport`（同ファイル557〜606行付近）が、四半期決算後の完全なP&L相当の内訳を持つ。`grossRevenue`〜`totalVariableCost`〜`contributionMargin`〜`totalFixedCost`〜`managementOperatingProfit`（`contributionMargin - totalFixedCost`として定義）まで一式が揃っている。
- 商品別・市場別の内訳は`byProduct: readonly ContributionMarginByDimension[]`／`byMarket: readonly ContributionMarginByDimension[]`として保持される。`ContributionMarginByDimension`（同ファイル533〜554行付近）は`grossRevenue`〜`contributionMargin`〜`directFixedCost`を持つ。
- 商品別の`directFixedCost`は、`quarterClose.ts`の`computeManagementAccountingProductFixedCostAllocation`（594〜654行付近、非export）が、当該四半期の実際の生産トン数・人員配分（`actuals.batches`）と、既に確定した`ManufacturingCostBreakdown`を入力に、`params.managementAccounting.fixedCostAllocationCoefficientByProduct`という配賦係数で配分する。**完全に事後計算**であり、既に確定した四半期の実績を後から仕分けるロジックである。

## 2. 既存の事後Contribution Margin計算式

上記と同じ`ContributionMarginReport`の`contributionMargin`（`netRevenue - totalVariableCost`相当）がそのまま該当する。商品別内訳も`ContributionMarginByDimension.contributionMargin`として既に存在する。新規のContribution Margin計算式を作る必要はない。

## 3. forward `PlanCostExpectation`との差

`decision/sales.ts`の`buildCostExpectation`が返す`PlanCostExpectation`（`sales/types.ts`170〜177行付近）は、`expectedRawMaterialPriceUsdPerHosoEqKg`・`expectedProcessingCostUsdPerHosoEqKg`・`minimumAcceptablePriceUsdPerHosoEqKg`の3項目のみを持つ、**事前（forward-looking）**の簡易版である。

決定的な差は次の2点。

1. `minimumAcceptablePriceUsdPerHosoEqKg`は「原料費＋加工費＝下限価格」という、**Full-Cost/Contribution Marginのどちらでもない第3の式**（固定費配賦を一切含まない、純粋な変動費フロア）である。HOSOでは`expectedRawPrice + expectedProcessingCost`、PD/VAPでは「HOSO国際基準価格＋商品プレミアム」という別ルールで計算されており、いずれも`ContributionMarginReport`の固定費配賦とは接続していない。
2. `PlanCostExpectation`は商品の**コスト側**しか持たない。販売価格（sell price）の事前予測値を一切持たず、実際の価格は`observation.markets[...].referencePriceByProduct`（前四半期実績の参照価格）に対する調整比率（`priceAdjustmentRatioByProduct`）で決まる。つまりStandard AIは現在、「将来のこの四半期でいくらで売れるか」を自分では予測していない。

## 4. Full-cost affordable raw priceの事前計算に不足するinput

Full-cost affordable raw price = 想定売価 − 加工費 − 商品別固定費配賦（forward版） という式になるが、以下の2つが現行コードに存在しない。

- **forward売価予測**: 上記3-(2)の通り、当期またはNクォーター先の想定売価を予測する仕組みが無い。`referencePriceByProduct`はあくまで前期実績であり、これをforward予測として転用してよいかは経営判断（三宅さんが今回別途「Standard AIは価格を完全に見えている」という前提を置いた§17.5.3の情報視認性の議論と関連する）。
- **forward固定費配賦率**: `computeManagementAccountingProductFixedCostAllocation`は当該四半期の実績生産量・実績コストブレークダウンを入力に取る事後計算であり、「今から立てる生産計画に対して、1kgあたり固定費配賦をいくらと見積もるべきか」というforward版のレート化がされていない。直近四半期の配賦結果（USD/kg換算）を暫定レートとして流用することはできるが、その暫定運用ルール自体はまだ設計・実装されていない。

## 5. Contribution-margin affordable raw priceの事前計算に不足するinput

Contribution-margin affordable raw price = 想定売価 − 加工費（固定費配賦を含めない） という式になるため、Full-Cost版より必要inputは1つ少ない（固定費配賦が不要）。したがって不足するのは「4」のうちforward売価予測のみである。加工費側は既存の`fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg`をそのまま使えばよく、これは既にforward値として存在する。

## 6. 市場×商品で評価できる項目 / 商品単位でしか評価できない項目

- **商品単位でしか評価できない**: `directFixedCost`（市場別配分は既存コードで常に0、実装されていない。§4章のギャップと同一）。`fixedCostAllocationCoefficientByProduct`も商品別の係数のみ。
- **市場×商品で評価できる**: 売価（`referencePriceByProduct`が市場×商品の粒度で既に存在する）。加工費（`expectedProcessingCostUsdPerHosoEqKg`は商品別だが、市場をまたいで同一値を使う前提であれば市場×商品でも評価できる）。したがって、Unit Economics層を市場別に細分化する場合、「売価は市場別、固定費配賦は商品別のまま」という非対称な粒度になる点を設計時に踏まえる必要がある。

## 7. 既存会計と二重計算を避ける再利用方法（推奨実装方針）

1. **固定費配賦レートのforward化**: 新しい事後会計を作らず、直近四半期の`computeManagementAccountingProductFixedCostAllocation`の結果を「1kgあたり配賦レート」（＝配賦額÷実績生産トン数）に変換し、次四半期の暫定固定費配賦レートとして流用する薄いアダプタ関数を1つ追加するだけで済む（既存の事後計算そのものは変更しない）。
2. **forward売価予測**: 今回は「Standard AIは価格を完全に見えている」という前提（設計文書§17.5.3）に基づき、`observation.markets[...].referencePriceByProduct`（前期実績）を暫定的なforward売価予測として採用し、`deliveryDemandSource`と同様の「暫定proxyである」ことを明示するフラグを持たせる設計にすれば、新しい価格予測モデルを作らずに済む。
3. **Full-cost / Contribution-margin affordable raw priceの計算そのもの**: 上記1・2で得たforward売価・forward加工費・forward固定費配賦レートを使い、`Full-cost affordable raw price = 売価 − 加工費 − 固定費配賦レート`／`Contribution-margin affordable raw price = 売価 − 加工費`という2本の一次式を新設するだけでよい。`ContributionMarginReport`本体・`computeManagementAccountingProductFixedCostAllocation`本体・`buildCostExpectation`本体はいずれも変更不要（読み取り専用の新規アダプタ層を1つ追加するだけ）。

## 8. 次実装の推奨構造（着手時の参考。今回は実装しない）

```
directions:
  forwardFixedCostAllocationRatePerKg = 直近四半期のcomputeManagementAccountingProductFixedCostAllocation結果を
                                          実績生産トン数で割った暫定レート（フラグ: PROXY_FROM_LAST_QUARTER）
  forwardSellPrice = observation.markets[...].referencePriceByProduct（フラグ: PROXY_FROM_LAST_QUARTER_MARKET_PRICE）
  fullCostAffordableRawPrice = forwardSellPrice - expectedProcessingCostUsdPerHosoEqKg - forwardFixedCostAllocationRatePerKg
  contributionMarginAffordableRawPrice = forwardSellPrice - expectedProcessingCostUsdPerHosoEqKg
  # 大小関係の保証（設計文書§17.5.1で訂正済み）:
  #   fullCostAffordableRawPrice <= contributionMarginAffordableRawPrice （常に成立するはず。テストで保証する）
```

新設が必要なのは上記の薄いアダプタ関数群のみであり、`ContributionMarginReport`・`computeManagementAccountingProductFixedCostAllocation`・`PlanCostExpectation`・`buildCostExpectation`のいずれも変更しない。市場別の直接固定費配賦（§4・§6のギャップ）は、今回のスコープでは商品別の粒度のまま進め、将来必要になった時点で別途拡張する。
