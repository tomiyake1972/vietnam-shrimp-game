# ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール アーキテクチャ v0.1（Phase 4）

対象コード: `app/lib/v2/sales/`
関連ドキュメント: `docs/v2/CORE_ARCHITECTURE_v0.1.md`、`docs/v2/MARKET_PRICING_ARCHITECTURE_v0.1.md`、`docs/v2/SCENARIO_EVENT_ARCHITECTURE_v0.1.md`、`docs/v2/INDUSTRY_SIMULATOR_ARCHITECTURE_v0.1.md`

## 1. 本モジュールの責務・非責務

### 責務

- 5社（ベトナムの輸出会社という前提）それぞれの当期販売計画（希望量・提示価格調整額・営業人員配置・希望リードタイム）を表現する。
- 営業人員数から、市場カバレッジと処理能力（成約量の上限）を導出する。
- 市場×商品区分ごとに、5社の販売提案を同時に評価し、対象需要を上限として成約量を配分する。
- 成約結果から決定論的な契約IDを持つ契約を生成し、約定残（未履行数量・状態）を管理する。
- 実際の生産・出荷実績（Phase6が決める）を外部から受け取り、約定残へ適用する純粋関数を提供する。

### 非責務（本モジュールが絶対にしないこと）

- **国際基準価格・シナリオを変更しない。** Phase1（市場価格）・Phase2（シナリオ）・Phase3（業界シミュレーション）の計算式は一切変更・再実装しない。本モジュールはそれらの出力を読み取るだけ（`marketAdapter.ts`）。
- **売上・原価・売掛金・利益を計上しない。** `SalesContract`・`MarketProductAllocationResult`のどちらにも金額フィールドは一切存在しない（成約時点でPL/BS/CFへ計上しないという実装指示に対応、テストでも金額フィールドの不在を確認している）。
- **実際の出荷・生産を自動的に行わない。** `advanceSalesQuarter`は「販売計画→成約配分→契約生成」までしか行わない。履行（`applyFulfillments`）は呼び出し側が実際の出荷実績を渡して明示的に呼ぶ別ステップ。
- 画面・API・Redis保存には依存しない（Phase1〜3と同じ独立性の原則）。
- 顧客関係・品質・納期信頼性の変動ロジック、AI会社の販売判断、生成AIは実装しない。

## 2. 既存の型の再利用

| 概念 | 型 | 出典 |
|---|---|---|
| 数量 | `HosoEqTons` | `core/units.ts`（Phase0B） |
| 価格 | `UsdPerHosoEqKg` | `core/units.ts`（Phase0B） |
| スコア（品質・関係・信頼性） | `Score0to100` | `core/units.ts`（Phase0B、Phase1の`qualityScore`と同じ尺度） |
| 四半期 | `PeriodV2` | `core/period.ts`（Phase0B、`nextPeriod`で納期を導出） |
| 市場ID | `DemandMarketId`（`"CN"\|"US"\|"EU"\|"JP"\|"OTHER"`） | `market/types.ts`（Phase1） |
| 商品区分 | `Product`（`"hoso"\|"pd"\|"vap"`） | `market/types.ts`（Phase1） |
| 会社ID | `CompanyId`（= `string`のエイリアス） | `core/gameSession.ts`の`companyIds: readonly string[]`規約を踏襲。固定enumにはしない |

新しい市場ID・商品区分・数量単位は一切追加していない。丸め処理も既存の`roundHosoEqTons`/`roundUsdPerHosoEqKg`をそのまま使う。

## 3. 販売計画の入力構造

`CompanySalesPlanEntry`（1社×1市場×1商品区分×1四半期）:

```
{
  companyId, market, product,
  desiredQuantity: HosoEqTons,             // 販売希望量
  priceAdjustmentUsdPerHosoEqKg: number,   // Phase3基準価格に対する調整額（値引きは負値）
  salesForceHeadcount: number,             // 配置する営業人員（0以上の整数）
  desiredLeadTimeTurns?: number,           // 省略時は標準リードタイム（既定1＝翌四半期）
  customerRelationship?: Score0to100,      // 省略時は中立値（50）
  qualityReputation?: Score0to100,         // 省略時は中立値（50）
  deliveryReliability?: Score0to100,       // 省略時は中立値（50）
}
```

提示価格（askPrice） = `basePrice(product) + priceAdjustmentUsdPerHosoEqKg`。`priceAdjustmentUsdPerHosoEqKg`は0以上制約のある`UsdPerHosoEqKg`ではなく、値引き（負）を許すプレーンnumberとして保持し、合成後のaskPriceだけを検証・ブランド化する。

## 4. 営業人員の効果

`salesForce.ts`が、営業人員数から2つの値を導出する。どちらもMichaelis-Menten型の飽和曲線（`x/(x+k)`）で、次の3要件を同時に満たす。

- headcount=0でも「既存顧客による最低限の値」を残す（0にならない）
- headcount増加の効果は逓減する（追加1人あたりの伸びが徐々に減る）
- 上限は有限（無制限に増やしても青天井にならない）

```
coverageScore(headcount)      = baseline + (1 - baseline) * headcount / (headcount + coverageSaturationHeadcount)
processingCapacity(headcount) = baselineCapacityTons + capacityMaxIncrementTons * headcount / (headcount + capacitySaturationHeadcount)
```

`coverageScore`は成約競争力の一因子として使う（後述）。`processingCapacity`は成約量の上限の一因子（`min(desiredQuantity, processingCapacity)`）として使う。将来、営業人員の異動コスト・配置変更の遅延・市場経験による補正を追加する場合は、これら2関数の引数を増やすだけで拡張できる構造にしている（本Phaseでは未実装）。

## 5. 成約配分式と係数（`allocation.ts` / `parameters.ts`）

### 5.1 競争力ウェイト

各社の合成競争力ウェイトを、5つの正規化済み[0,1]因子の加重和として計算する（重みの合計は1.0を推奨、`SALES_PARAMETERS_V1.competitivenessWeights`）。

```
weight = w.price        * priceContribution
       + w.coverage      * coverageScore
       + w.relationship  * (customerRelationship / 100)
       + w.quality       * (qualityReputation / 100)
       + w.deliveryReliability * (deliveryReliability / 100)

priceScore        = exp(-priceSensitivity * (askPrice - basePrice) / basePrice)
priceContribution = clamp(priceScore, 0, priceScoreClampMax) / priceScoreClampMax
```

`priceSensitivity`（既定3.0）が大きいほど、基準価格からの乖離が競争力に強く影響する。askPriceがbasePriceを下回れば`priceScore`は1を超え（値引きが有利に働く）、上回れば1未満に近づく（トレードオフ）。

### 5.2 水位法（water-filling）による配分

市場×商品区分ごとに、5社＋「外部選択肢」（5社以外の供給者・非購入、`externalOptionWeight`で競争力を持つ仮想参加者）を1つの集合として扱い、対象需要（`targetDemand`）という固定予算を次のアルゴリズムで配分する。

1. 各参加者に上限（5社は`min(desiredQuantity, processingCapacity)`、外部選択肢は無制限）を設定する。
2. まだ上限に達していない参加者だけで、残り予算をウェイト比例で仮配分する。
3. 仮配分が上限を超える参加者は、上限ちょうどで打ち切り、予算から除外する。
4. 誰も打ち切られなくなるまで2〜3を繰り返す。

この方式は、実装指示の制約をすべて構造的に満たす。

- 全社合計成約量（＋外部選択肢）は対象需要（＝予算総額）を超えない
- 各社成約量は上限（販売希望量・処理能力）を超えない
- 配列の合計・比較のみで構成されているため、入力順（5社の並び順）に一切依存しない
- 上限に達した会社の未配分需要は、まだ達していない会社（＋外部選択肢）へ自動的に再配分される
- 外部選択肢が常に1参加者として競争するため、5社が必ず全需要を獲得するわけではない

### 5.3 成約単価

原則どおり、各社の提示価格（askPrice）をそのまま成約単価とする。市場全体の基準価格を再計算する処理は一切ない。askPriceは`basePrice`の`minAskPriceRatioOfBase`〜`maxAskPriceRatioOfBase`倍（既定0.5〜2.0倍）の範囲外だと`SalesValidationError`を投げる（最低価格・異常値の入力検証）。

## 6. Phase3価格との接続（`marketAdapter.ts`）

`deriveVietnamBasePrices(marketResult)`が、5社共通の基準価格（hoso/pd/vapそれぞれ）を、Phase3の`MarketQuarterResult`のベトナム（VN）価格・プレミアムからそのまま返す（再計算しない）。

対象需要（`deriveTargetDemand`）は、`MarketQuarterResult`が「市場×商品区分」の需要内訳を直接持たないため、Phase4固有の暫定前提として次の3段階で按分する（新しい価格・需給の経済ロジックは追加していない。既存の集計値を比率で分配しているだけ）。

1. ベトナムが世界需要のうち実際に獲得した数量 = `marketResult.hosoPrices.VN.allocatedDemand`（Phase1がすでに計算済み）
2. (1)を商品区分（hoso/pd/vap）へ、世界全体の商品構成比（`worldDemand`に対するhoso/pd/vapそれぞれの世界需要の比率）で按分する
3. (2)の各商品区分ぶんを、5市場へ、各市場の`priorPeriodConsumption`（`MarketQuarterInput`の生値、需要成長式は再計算しない）の構成比で按分する

これはPhase3の`assumptions.ts`と同じ位置づけの暫定前提であり、将来Phase1側に市場別・商品別の需要分解が実装されたら、このアダプターだけを置き換えればよい。

## 7. 契約・約定残の状態遷移（`contracts.ts` / `backlog.ts`）

契約ID: `` `SC-${成約四半期}-${市場}-${商品区分}-${会社ID}` ``（決定論的。成約配分が会社×市場×商品につき1件のため一意性が保証される）。

標準納期 = 成約四半期の翌四半期（`core/period.ts`の`nextPeriod`を1回適用）。希望リードタイムが指定されていれば`nextPeriod`を複数回適用する。

状態遷移:

```
open（未履行）
  → 履行が一部適用される → partiallyFulfilled（一部履行）
  → 履行で未履行数量が0になる → fulfilled（完了）
  → 納期を過ぎても未履行数量が残る（四半期末更新） → overdue（納期超過）
  → 明示的にキャンセル → cancelled（キャンセル）
```

`fulfilled`・`cancelled`は終端状態（それ以降の履行・キャンセルは`SalesValidationError`）。過剰履行（未履行数量を超える履行）は必ず拒否される。履行は「契約IDを明示」または「会社×市場×商品別のFIFO（`contractedPeriod`→`dueDate`→`contractId`の順で決定論的にソート）」のどちらでも指定できる。

## 8. 四半期ランナー（`runner.ts`）

Phase3の`industryLab/simulationRunner.ts`と同じ構造。

```
initializeSalesState(startPeriod) → SalesState（契約・履歴なし）
advanceSalesQuarter(state, { plans, marketResult, marketInput }) → SalesState
  // 販売計画→成約配分→契約生成のみ。履行は行わない。
runSalesQuartersForTesting(startPeriod, quarterInputs[]) → SalesState
  // 複数四半期を再現可能に実行するテスト用ランナー
```

履行実績の適用（`applyFulfillments`）・四半期末の契約状態更新（`updateContractStatusesForQuarterEnd`）は、`advanceSalesQuarter`から独立した別関数として提供する。Phase6が実際の生産・出荷実績を計算した後、呼び出し側が明示的に呼ぶ設計であり、`advanceSalesQuarter`がこれらを自動的に呼ぶことはない。

## 9. 暫定中立値・暫定前提の一覧

| 項目 | 扱い |
|---|---|
| 顧客関係・品質・納期信頼性が未接続の場合 | `SALES_PARAMETERS_V1.neutralScore`（50点、Score0to100の中央値）を使う |
| 対象需要（市場×商品区分別） | §6のとおり、Phase1出力の比率按分（Phase4固有の暫定アダプター） |
| 競争力の合成ウェイト・価格感度・営業人員の飽和曲線係数 | すべて`SALES_PARAMETERS_V1`に集約した「Phase4新規・要校正」の暫定値。ゲームバランス調整フェーズで再検討する前提（ChatGPT指示に具体的な数値指定はないため、要求された「効果の方向性」を満たす最小限の値を置いている） |
| 海外生産者の価格反応・営業人員の異動コスト | 未実装（Phase4の対象外） |

## 10. テスト

`app/lib/v2/sales/__tests__/`に6ファイル、合計60件のテストを追加した（既存287件と合わせて347件）。

- `salesForce.test.ts` — カバレッジ・処理能力の単調増加性、逓減性、baseline、上限漸近、入力検証。
- `marketAdapter.test.ts` — Phase3の実際の`runIndustrySimulation`出力を使い、基準価格がVNの値と一致すること、対象需要が市場別消費量の比率どおりに按分されること、副作用がないこと。
- `allocation.test.ts` — 全社合計が対象需要を超えないこと、個社上限（希望量・処理能力）、入力順不変性、価格↔数量トレードオフ、営業人員↔成約力トレードオフ（逓減込み）、無制限headcountでも需要超過しないこと、外部選択肢の存在、上限到達時の再配分、基準価格不変性、価格検証エラー、重複計画エラー。
- `contracts.test.ts` — 契約IDの決定論性・非重複性、標準納期・カスタムリードタイム、成約量0は契約を作らない、金額フィールドの不在。
- `backlog.test.ts` — 部分/完全履行、過剰履行拒否、完了/キャンセル済みへの履行拒否、FIFOの順序・繰り越し・対象外契約への非影響、四半期末のoverdue判定。
- `runner.test.ts` — Phase3の実出力を使った5社×5市場×3商品×複数四半期の完走、再現性（同一入力→完全一致）、Phase3データへの非破壊、履行が自動実行されないことの確認、金額フィールドの不在。

## 11. TypeScript・ESLint・ビルド

`npx tsc --noEmit`：0エラー。`npx eslint app/lib/v2 app/v2 scripts`：0エラー・0警告。`npm run build`：TypeScriptコンパイルは成功。ページデータ収集段階で既知の`/api/game/[gameCode]/admin/clone`（V1既存ルート、Redis環境変数未設定）が失敗するのは、Phase1〜3から一貫して報告している既存の環境問題であり、今回のブロッカーとはしていない。

## 12. 未実装項目（対象外・将来課題）

- プレイヤー用販売入力画面（Phase4は純粋ロジックのみ）
- Redis・API Route・Vercel設定
- 工場・生産・原料調達・在庫（Phase5〜6）
- 実際の出荷可能量の計算（Phase6）
- 品質・顧客信頼の変動ロジック（Phase7想定）
- 売上・原価・売掛金・PL/BS/CF（未計上）
- 営業人件費（異動コスト・人件費計算は将来、`salesForceHeadcount`を渡すだけで接続可能）
- AI会社の販売判断・生成AI

## 13. 今後Phase5・6と接続する際の接点

- `advanceSalesQuarter`の`SalesQuarterInput.plans`は、将来Phase5〜6のプレイヤー入力・AI会社の意思決定ロジックがそのまま生成すればよい形にしてある（本モジュールは生成元を一切問わない）。
- `applyFulfillments`は、Phase6が実際の生産・出荷可能量を計算した後、`FifoFulfillmentInstruction`（会社×市場×商品×数量）を渡すだけで接続できる。「原料や生産能力が足りず契約通りに出荷できない」という状況は、単に`quantity`を契約数量より少なく渡す（＝部分履行のまま据え置く）ことで自然に表現できる。
- `updateContractStatusesForQuarterEnd`により、出荷が間に合わなかった契約は自動的に`overdue`へ遷移するため、Phase6以降のペナルティ・信用スコア低下ロジックはこの状態を読むだけで実装できる。
- `salesForceHeadcount`は契約・配分結果の両方に保持されているため、将来の人件費計算モジュールはこの数値をそのまま参照すればよい。
