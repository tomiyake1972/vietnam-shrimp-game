# ShrimpX V2 — 工場・ワーカー・HOSO/PD/VAP生産・完成品在庫・契約履行モジュール アーキテクチャ v0.1（Phase 6）

## 1. 本モジュールの責務・非責務

`app/lib/v2/production/` は、「原料を持っているだけでは製品にならない」構造を実装する。工場設備・ワーカー・商品別能力・原料在庫の4つがそろって初めて生産でき、完成品を四半期ごとに契約へ充当する。UI・Redis・API・生成AIから完全に独立した純粋関数群であり、`app/lib/v2/turn/`（ターン・オーケストレーター）へは本Phaseでは接続しない（既存オーケストレーターの公開契約を書き換えない。将来のPhaseで接続アダプターを追加する前提）。

対象外（本Phaseでは扱わない）: 工場建設・設備投資・能力増設・減価償却（Phase8）、資金制約、人件費・製造原価・在庫評価の会計計上、品質・顧客信頼の変動、違約金・顧客離反、AI会社の生産判断、プレイヤー画面・API・Redis配線、排他制御、Phase7以降のロジック、V1コード、`develop/v2`へのマージ。

## 2. 再利用した既存の型・関数

| 既存モジュール | 再利用したもの |
|---|---|
| `core/units.ts` | `HosoEqTons`・`UsdPerHosoEqKg`・`UsdM`・`Ratio`・各スマートコンストラクタ・`round*`関数。新しい数量単位は追加していない。 |
| `core/period.ts` | `PeriodV2`・`nextPeriod`・`toYearQuarter`（原料ロットの経過期間算出に使用）。 |
| `market/types.ts` | `Product`（"hoso"\|"pd"\|"vap"）・`CountryId`・`CountrySupplyInput`（PD/VAP供給シグナルの接続先）。 |
| `market/productPremium.ts` | `calculateProductPremium`のロジック自体は一切呼び出し・重複実装せず、その入力（`CountrySupplyInput.pdProcessingCapacity`/`vapProcessingCapacity`）を差し替えるだけのアダプターを追加した。 |
| `sales/types.ts` | `CompanyId`・`SalesContract`・`ExplicitFulfillmentInstruction`。 |
| `sales/backlog.ts` | `applyFulfillments`・`updateContractStatusesForQuarterEnd`（契約状態遷移はこれらの既存関数をそのまま呼び出す。本Phaseは契約状態を直接書き換えない）。 |
| `rawMaterials/types.ts` | `RawMaterialLot`・`RawMaterialSource`・`RawMaterialConsumptionInstruction`。特にRawMaterialLot型は「Phase6向けインターフェース」として既にPhase5側で用意されていたセクション（§7）をそのまま利用した。 |
| `rawMaterials/inventory.ts` | `consumeRawMaterials`（FIFO消費エンジン）を直接呼び出す。原料側の独自FIFO実装は持たない（§5.2参照）。 |
| `rawMaterials/waterFill.ts` | `waterFillAllocate`（水位法配分）をそのまま呼び出し、優先順位階層ごとの比例配分に使う。 |
| `sales/parameters.ts` / `rawMaterials/parameters.ts` | 「係数を1ファイルへ集約する」パターンをそのまま踏襲し、`production/parameters.ts`を新設した。 |

新しい会社ID・商品区分・産地・Period型は一切追加していない。

## 3. 工場能力モデル（`types.ts`・`capacity.ts`）

`Factory`は、工場ID・会社ID・稼働状態（`"active"|"idle"|"suspended"`）に加え、5つの能力プールを持つ。共通原料処理能力（全商品が共有）、HOSO/PD/VAP専用加工能力、冷凍・包装能力（全商品が共有）。すべてHOSO換算トンで管理する。

**単位についての設計判断（暫定・要校正）**: 5つの能力プールはすべて「その四半期に生産できる完成品のHOSO換算トン」を単位とする（原料消費トンではない）。原料と完成品はいずれもHosoEqTonsという同じ基盤を共有しているため、歩留まり（yieldRatio）は「原料消費量→完成品数量」の変換で一度だけ適用し、能力側の単位換算では歩留まりを二度適用しない。これは仕様が明記していない箇所への実装判断であり、Phase8以降の校正フェーズで見直す余地がある。

`calculateFactoryEffectiveCapacity(factory)`は、各能力プールへ`baseUtilizationRate`（基準稼働率）×`equipmentAvailabilityRate`（設備利用可能率）を適用した有効能力を返す。`status !== "active"`の工場は全プールが0になる（idle/suspendedの工場は生産に参加しない）。設備増設・工場建設・減価償却は一切行わず、外部から与えられた`Factory`の名目能力をそのまま使う。

## 4. 労働能力式（`types.ts`・`labor.ts`）

`WorkerAssignment`は工場・会社ごとに、正社員・常用ワーカー人数（`regularHeadcount`）、臨時ワーカー人数（`temporaryHeadcount`）、商品別技能水準（`skills`）、残業率（`overtimeRate`）、欠勤・稼働可能率（`attendanceRate`）を持つ。将来の採用・退職・教育中の状態を表せる`lifecycleStatus`フィールドを持つが、本Phaseでは`"active"`のみを使う。

`calculateEffectiveLaborCapacity(assignment, factoryCapacity, overtimeRateOverride?, params)`の算出式（商品ごと）:

```
raw = (regularHeadcount × regularEfficiencyPerHeadTons + temporaryHeadcount × temporaryEfficiencyPerHeadTons)
      × attendanceRate × skillLevel(product) × (1 + min(overtimeRate, overtimeRateCap) × overtimeEfficiencyFactor)
effectiveLaborCapacity(product) = min(raw, factoryCapacity[product])
```

- `regularEfficiencyPerHeadTons > temporaryEfficiencyPerHeadTons`（常用ワーカーの方が1人あたり効率が高い、暫定値）。
- 残業率は`overtimeRateCap`（暫定0.3）でクリップする。残業を無限に増やしても能力は上限を超えない。
- `min(raw, factoryCapacity[product])`により、人員増加の効果は当該商品の専用設備能力を超えない。
- スキルのない商品（`skills`に該当エントリが無い）は`skillLevel=0`扱いとなり、有効労働能力は0になる。人員が0でも同様に0（設備能力があっても生産できない、労働不足の表面化）。
- 人件費（USD）は一切算出しない。記録すべき数量（配置人数・臨時ワーカー比率）のみを出力する。

労働は「複数商品間で奪い合う共有プール」としては扱わず、商品ごとに独立したケイパビリティ上限として計算する設計判断を取った（§「単位についての設計判断」と同じく、仕様が明記していない箇所への実装判断。将来より精緻な「共有労働時間プール」モデルへ拡張する余地がある）。

## 5. 生産制約の解決順序（`allocation.ts`・`priorityAllocation.ts`）

`allocateProductionPlans(plans, factories, workerAssignments, rawMaterialLots, period, params)`は、次の順序で制約を適用する。

1. **原料（会社単位の共有プール）**: 会社が保有する`status="available"`原料ロットの合計を予算とし、その会社の全計画（工場・商品を横断）へ優先順位階層で配分する。
2. **工場共通処理能力（工場単位の共有プール）**: 段階1の結果を候補量とし、工場の有効共通処理能力を予算に、その工場の全計画へ優先順位階層で配分する。
3. **冷凍・包装能力（工場単位の共有プール）**: 同様に工場単位で配分する。
4. **商品別設備能力（工場×商品単位の専用プール）**: HOSO/PD/VAPそれぞれの専用能力を予算に、同一工場・同一商品の計画間で配分する（通常は1計画のみだが、複数計画が競合する場合も対応する）。
5. **有効労働能力**: 商品ごとに独立したケイパビリティ上限として`min()`を取る（共有プールとしての優先順位配分は行わない。§4参照）。

各段階は`priorityAllocation.ts`の`allocateByPriorityTiers`（`priority`昇順の階層ごとに`rawMaterials/waterFill.ts`の`waterFillAllocate`で比例配分）を使う。`waterFillAllocate`の実装は入力配列の順序に一切依存しない（合計・比較がすべて順序非依存の演算）ため、同順位の計画間の配分は入力順に依存しない決定論的な結果になる。

生産できなかった量（`shortfallQuantity`）とその理由（`shortfallReasons`、5種類: `rawMaterialShortage`/`commonCapacityShortage`/`packagingCapacityShortage`/`productCapacityShortage`/`laborShortage`）は、各段階の候補量が直前の段階より減少したかどうかを比較して判定し、複数該当しうる形で出力する。

## 6. 商品別歩留まり・数量保存（`allocation.ts`・`batches.ts`）

`production/parameters.ts`の`yield.baseYieldRatio`に、商品別の基準歩留まり（暫定値: HOSO 0.92、PD 0.80、VAP 0.70）を集約している。歩留まりの適用は次の1箇所のみで、二重適用は発生しない。

- 希望量→必要原料量の逆算（配分計算時）: `rawMaterialRequired = desiredQuantity / yieldRatio`
- 最終配分量→必要原料量の順算（バッチ生成時）: `requiredRawMaterialQuantity = allocatedQuantity / yieldRatio`

`buildProductionBatches`は、`rawMaterials/inventory.ts`の`consumeRawMaterials`をそのまま呼び出して原料を実消費し、呼び出し前後の`remainingQuantity`の差分から消費内訳（`rawMaterialConsumed`）を復元する（独自のFIFO実装を持たない）。`rawMaterialLotSelector`（産地・調達源による絞り込み）が指定された場合のみ、対象ロットを一時的に部分配列へ切り出して`consumeRawMaterials`へ渡し、結果を元の配列へマージし直す。

数量保存: `原料消費量（rawMaterialConsumedTotal） = 完成品数量（finishedGoodsQuantity） + 加工損失（processingLoss）`。実際に消費できた原料量（原料不足で計画量より少なくなりうる）に基づいて完成品数量を再計算するため、原料が不足した場合でも保存則は常に成立する。

## 7. 原料・完成品の数量保存

- 原料ロット: `consumeRawMaterials`（既存Phase5関数）が過剰消費を例外で拒否し、`remainingQuantity`のみを減少させる（`originalQuantity`は不変）。複数の生産計画が同一会社の原料を取り合う場合は、`(companyId, priority昇順, factoryId, product, 元のplans配列インデックス)`の順で決定論的に実消費を行う（優先度が高い計画から先に在庫を引き当てる）。
- 完成品ロット: `finishedGoods.ts`の`consumeFinishedGoods`が、`rawMaterials/inventory.ts`の`consumeRawMaterials`と同じ設計（会社×商品単位、FIFO＝`availableFromPeriod→producedPeriod→lotId`順、過剰消費拒否、数量保存）で実装されている（ロットの形が異なるため独自実装だが、アルゴリズムは同一）。`remainingQuantity`が0になると`status="allocated"`へ遷移する。
- 四半期末の期限切れ処理（`applyFinishedGoodsExpiryForQuarterEnd`）は、`status="available"`かつ`expiryPeriod`を過ぎたロットを`"expired"`へ遷移させるのみで、`remainingQuantity`は保持する（廃棄損の会計計上はPhase8）。

## 8. 契約履行（`fulfillment.ts`）

`planContractFulfillment(contracts, finishedGoodsLots)`は、完成品在庫（`status="available"`）を、約定残の中で納期の早い契約から順に割り当てる計画を立てる純粋関数。同一納期では契約ID順（入力順に依存しない）。会社と商品が一致する完成品だけを使用する（市場・原産国は今回は制約としない設計判断。将来Phaseで拡張できる構造）。

`sales/backlog.ts`の`FifoFulfillmentInstruction`はmarketも必須とするため、本Phaseの「商品一致のみを必須条件とする」要件（market横断でのFIFO）には使えない。そのため、`planContractFulfillment`は契約ID指定の`ExplicitFulfillmentInstruction`へ変換して出力し、**Phase4の既存状態遷移関数`applyFulfillments`をそのまま呼び出す**（契約状態を本モジュール自身が直接書き換えることは一切しない）。完成品ロットの実消費は、同じ関数が返す`finishedGoodsConsumption`（会社×商品単位の集計量）を`consumeFinishedGoods`へ渡すことで行う（両者は同一のFIFO順序ルールを使うため整合する）。履行量と使用完成品ロットの内訳は`usage`として追跡する。

## 9. PD/VAPプレミアムへの接続（`supplySignal.ts`）

`market/productPremium.ts`の`calculateProductPremium`は、`CountrySupplyInput.pdProcessingCapacity`/`vapProcessingCapacity`を「当該国のPD/VAP加工能力（外生的なシナリオ入力）」として扱う。本モジュールはこの2フィールドを、5社の実際の供給計画・実績で置き換えるアダプターを提供する。`calculateProductPremium`・HOSO国際基準価格（`hosoPricing.ts`）のロジック自体は一切変更・重複実装しない。

- `aggregateProductionSupplySignals(signals, companyCountry, product)`: 5社の`ProductionSupplySignalInput`（`plannedQuantity`＝供給計画、`actualQuantity`＝供給実績を区別）を、会社→産地マッピングを使って産地（国）単位に集計する。
- `applySupplySignalToCountrySupply(countrySupply, signals, product, useActual)`: 集計結果を`CountrySupplyInput`へ適用する。`useActual=false`なら`plannedCapacity`（当期価格形成用）、`true`なら`actualCapacity`（次期フィードバック用）を使う。原則として当期価格形成には供給計画を、次期へのフィードバックには実績を使う。
- 会社行動（供給シグナル）が存在しない産地は、`preserveExistingWhenNoSignal`（既定true）によりPhase3の既存前提（暫定シナリオ入力）をそのまま残す。
- 能力があるだけで全量供給した扱いにはしない。`plannedQuantity`と`actualQuantity`を明確に区別する型・関数シグネチャとした。
- HOSO国際基準価格（`hosoFobPrice`等、`CountrySupplyInput`の他フィールド）には一切触れない。テスト（`supplySignal.test.ts`）で、供給シグナル適用前後でHOSO価格が完全に不変であることを確認している。

## 10. 操業負荷指標（`loadMetrics.ts`）

Phase7（品質・信用の変動を扱う想定）へ渡すため、工場・会社別に次を出力する。設備稼働率、労働稼働率、残業率、臨時ワーカー比率、商品構成の複雑度（生産商品数に基づく正規化指標）、原料ロットの平均経過期間（四半期数の加重平均）、生産未達率、加工損失率。会社単位の指標は、その会社の全工場の指標を完成品数量で加重平均して集計する。本Phase自身はこれらの指標から品質・信用を一切変化させない（集計・出力のみ）。

## 11. 四半期ランナー（`runner.ts`）

`rawMaterials/runner.ts`と同じ構造（`initializeX`/`advanceX`/複数四半期テスト用ランナー）を踏襲する。`advanceProductionQuarter`は次を1四半期分まとめて行う。

```
生産計画の制約配分（allocateProductionPlans）
  → 原料在庫のFIFO消費・生産バッチ生成（buildProductionBatches）
  → 完成品ロット生成（createFinishedGoodsLots）
  → 完成品の契約充当計画（planContractFulfillment）
  → 完成品の期限切れ処理（applyFinishedGoodsExpiryForQuarterEnd）
  → PD/VAP供給シグナル集計（aggregateProductionSupplySignals）
  → 操業負荷指標集計（calculateAllFactoryLoadMetrics / calculateCompanyLoadMetrics）
```

契約への実際の適用（`applyFulfillments`呼び出し）・完成品ロットの実消費（`consumeFinishedGoods`呼び出し）は、Phase5の`consumeRawMaterials`と同様、`advanceProductionQuarter`自身は行わない別ステップとする（呼び出し側が`fulfillmentPlan`を見て明示的に呼ぶ設計。`sales/index.ts`の既存コメントと同じ「実際の反映は呼び出し側の責務」という規約を踏襲する）。

本モジュールは`app/lib/v2/turn/`を一切importしない、完全に独立したモジュールである。将来の接続イメージ（`index.ts`のコメントに記載）:

```ts
let productionState = initializeProductionState(INITIAL_PERIOD_V2);
const { state, updatedRawMaterialLots } = advanceProductionQuarter(
  productionState, quarterInput, contracts, rawMaterialLots, supplySignals
);
const updatedContracts = applyFulfillments(contracts, state.history[state.history.length - 1].fulfillmentPlan.explicitInstructions);
const updatedFinishedGoodsLots = consumeFinishedGoods(state.finishedGoodsLots, plan.finishedGoodsConsumption);
productionState = state;
```

## 12. 暫定係数と要校正項目（`production/parameters.ts`）

すべて「Phase6新規・要校正」の暫定値であり、ゲームバランス調整フェーズで再検討する前提。

- `yield.baseYieldRatio`（HOSO 0.92 / PD 0.80 / VAP 0.70）: 商品別の基準歩留まり。
- `labor.regularEfficiencyPerHeadTons`（6）/ `temporaryEfficiencyPerHeadTons`（3.5）: ワーカー1人あたりの基準有効生産能力。
- `labor.overtimeRateCap`（0.3）/ `overtimeEfficiencyFactor`（0.5）: 残業の上限・効果係数。
- `cost.baseProcessingCostUsdPerTon`（HOSO 350 / PD 520 / VAP 780）・`hosoEqKgPerTon`（1000）: 記録用の基準加工費・原料取得原価算出のためのトン→kg換算係数（非会計計上）。
- `finishedGoods.defaultShelfLifeTurns`（4四半期）: 完成品ロットの標準使用期限。
- `capacity.epsilon`（1e-6）: 制約判定の許容誤差。
- `supplySignal.preserveExistingWhenNoSignal`（true）: シグナル欠如時のフォールバック方針。

## 13. テスト・TypeScript・ESLint・build

- 新規テスト: `app/lib/v2/production/__tests__/`に9ファイル・61件を追加（`capacity.test.ts` 4件、`labor.test.ts` 7件、`allocation.test.ts` 13件、`batches.test.ts` 7件、`finishedGoods.test.ts` 7件、`fulfillment.test.ts` 8件、`supplySignal.test.ts` 5件、`loadMetrics.test.ts` 6件、`runner.test.ts` 4件）。既存499件と合わせて**560件全てpass**。
- `npx tsc --noEmit`: 0エラー。
- `npx eslint app/lib/v2 app/v2 scripts`: 0エラー・0警告。
- `npm run build`: TypeScriptコンパイルは成功。ページデータ収集段階の既知の`/api/game/[gameCode]/admin/clone`エラー（`app/lib/redis.ts`の環境変数必須チェックが原因、本Phaseの変更とは無関係）以外の新規エラーは発生していない。

## 14. 対象外・将来課題

- 実際の設備投資・工場建設・能力増設・減価償却（Phase8）。
- 人件費・製造原価・在庫評価の会計計上（`rawMaterialCost`・`baseProcessingCost`はPhase8へ渡せる記録情報として保持するのみ）。
- 品質・顧客信頼の変動（操業負荷指標はPhase7へ出力するが、本Phase自身は品質・信用を一切変化させない）。
- 労働を「複数商品間で奪い合う共有プール」として扱うより精緻なモデル（本Phaseでは商品ごとに独立したケイパビリティ上限として計算）。
- Phase5のターン・オーケストレーター（`app/lib/v2/turn/`）への実際の接続（本Phaseでは意図的に接続しない。次のPhaseでの課題）。
- V2 API・UI・決定提出画面・認証・WebSocket・Redis配線。
- `develop/v2`へのマージ・PR作成。
