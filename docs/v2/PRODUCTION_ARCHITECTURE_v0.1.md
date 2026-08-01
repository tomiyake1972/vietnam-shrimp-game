# ShrimpX V2 — 工場・ワーカー・HOSO/PD/VAP生産・完成品在庫・契約履行モジュール アーキテクチャ v0.1（Phase 6、Phase 6.1で経済ロジックを修正）

## 0. Phase 6.1 修正の要約（本節を最初に読むこと）

Phase 6初版には、マージ前に必ず修正すべき2つの根本的な経済ロジックの欠陥があった。以下のようにPhase 6.1で修正し、`feature/v2-production`ブランチへ反映済み（マージ・Phase7着手はまだ行っていない）。

**欠陥1（歩留まりの二重適用）**: 契約・原料・完成品在庫・能力・供給シグナルはすべてHOSO換算トンという「共通単位」で管理されている。ところが初版は、この共通単位に対して「殻・頭の除去等による物理的重量減少」の比率（物理歩留まり、例: PD 0.80）をそのまま乗じており、原料100 HOSO換算トンからPD完成品を作ると「80 HOSO換算トン」に減ってしまっていた。しかしPDの物理重量80トンは、HOSO換算し直せばもとの100トンとほぼ同等の価値であり、物理的な重量減少をHOSO換算量の「加工損失」として二重に計上してしまう誤りだった。Phase 6.1では、参考値としての`physicalYieldRatio`（物理重量換算専用、HOSO換算量計算には一切使わない）と、真の回収率としての`saleableRecoveryRatio`（規格外品・破損・廃棄等によりHOSO換算ベースでも失われる、1に近い真の歩留まり。暫定値 HOSO 0.98 / PD 0.97 / VAP 0.95）を分離した。HOSO換算量の計算に使うのは`saleableRecoveryRatio`のみである。

**欠陥2（ワーカーの重複計上）**: 初版は労働能力を商品ごとに独立したケイパビリティ上限として計算しており、同じ工場の同じ100人が、HOSO・PD・VAPの3商品すべてで独立に「100人ぶんの労働能力」として計上されてしまっていた。Phase 6.1では、常用・臨時ワーカーそれぞれを工場単位の有限な共有プールとして扱い、商品間の奪い合いを原料・設備と同じ優先順位階層＋水位法で解決するよう修正した（詳細は§4）。

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

**単位についての設計判断（Phase 6.1で確定）**: 5つの能力プールのうち、`commonProcessingCapacity`（工場共通処理能力）は「原料投入側」のHOSO換算トンを単位とする。原料の受け入れ・下処理という工程自体が原料投入量に対して制約されるため、完成品側の単位で管理すると`saleableRecoveryRatio`の適用順序が曖昧になり、歩留まりの二重適用を招く（Phase 6初版の欠陥1の一因）。一方、`hosoCapacity`/`pdCapacity`/`vapCapacity`（商品別加工能力）・`freezingPackagingCapacity`（冷凍・包装能力）は、いずれも「その四半期に生産できる完成品のHOSO換算トン」を単位とする（従来どおり）。歩留まり（`saleableRecoveryRatio`）は、`commonProcessingCapacity`による原料投入側の制約を経た後に一度だけ適用し、それ以降のいずれの能力プールでも歩留まりを再適用しない（§5・§6参照）。

`calculateFactoryEffectiveCapacity(factory)`は、各能力プールへ`baseUtilizationRate`（基準稼働率）×`equipmentAvailabilityRate`（設備利用可能率）を適用した有効能力を返す。`status !== "active"`の工場は全プールが0になる（idle/suspendedの工場は生産に参加しない）。設備増設・工場建設・減価償却は一切行わず、外部から与えられた`Factory`の名目能力をそのまま使う。

## 4. 労働能力式・共有ワーカープール（`types.ts`・`labor.ts`、Phase 6.1で共有プール化）

`WorkerAssignment`は工場・会社ごとに、正社員・常用ワーカー人数（`regularHeadcount`）、臨時ワーカー人数（`temporaryHeadcount`）、商品別技能水準（`skills`）、残業率（`overtimeRate`）、欠勤・稼働可能率（`attendanceRate`）を持つ。将来の採用・退職・教育中の状態を表せる`lifecycleStatus`フィールドを持つが、本Phaseでは`"active"`のみを使う。この`regularHeadcount`/`temporaryHeadcount`は工場に配置された実人数であり、複数商品へ独立に「使い回せる」数量ではない。

**Phase 6.1修正: ワーカーは工場単位の有限な共有プール**。初版は商品ごとに独立したケイパビリティ上限として労働能力を計算しており、同じ工場の同じ人数がHOSO・PD・VAPそれぞれで独立に「フル人数ぶんの労働能力」として計上されてしまう欠陥があった（100人の工場で3商品を同時生産すると、合計300人ぶんの労働能力が生まれてしまう）。Phase 6.1では`labor.ts`の`allocateWorkersToPlans(demands, assignments, factoryCapacities, params)`が、常用・臨時それぞれについて工場単位の実配置人数を予算とした優先順位階層＋水位法配分（`priorityAllocation.ts`の`allocateByPriorityTiers`、`rawMaterials/waterFill.ts`の水位法を再利用）を行い、商品間の奪い合いを解決する。

配分の手順:

1. 各生産計画（demand）について、労働以外の制約（原料・工場共通処理能力・冷凍包装能力・商品別設備能力）を経た後の候補完成品量（`candidateQuantity`）を、常用のみ・臨時のみでそれぞれ満たすために必要な人数（`headcountDemand`）へ逆算する: `headcountDemand = candidateQuantity × laborIntensityCoefficientByProduct[product] / (efficiencyPerHead × attendanceRate × skillLevel(product) × overtimeMultiplier)`。
2. 常用ワーカーの`headcountDemand`群を、その工場の`regularHeadcount`を予算として優先順位階層配分する。臨時ワーカーも`temporaryHeadcount`を予算として**別々に**同様の配分を行う（常用・臨時は別予算として独立に数量保存される。同じ人を両方でカウントしない）。
3. 各計画の実際に配分された常用・臨時人数から、`calculateLaborCapacityFromAssignedHeadcount`（低レベル計算式、旧`calculateEffectiveLaborCapacity`相当）で有効労働能力を算出する:

```
raw = (assignedRegularHeadcount × regularEfficiencyPerHeadTons + assignedTemporaryHeadcount × temporaryEfficiencyPerHeadTons)
      × attendanceRate × skillLevel(product) × (1 + min(overtimeRate, overtimeRateCap) × overtimeEfficiencyFactor)
effective = raw / laborIntensityCoefficientByProduct[product]
laborCapacity(product) = min(effective, factoryCapacity[product])
```

- `regularEfficiencyPerHeadTons > temporaryEfficiencyPerHeadTons`（常用ワーカーの方が1人あたり効率が高い、暫定値）。どちらも商品非依存の基礎値である。
- **【2026-08-01追加】`laborIntensityCoefficientByProduct`（HOSO=1.0・PD=1.2・VAP=3.0）** は「同じHOSO換算数量を処理するときの労務負荷の相対比」を表す除数で、商品非依存の基礎効率をここで初めて商品ごとに割り引く。歩留まり係数・固定費配賦係数・営業工数係数とは別系統であり、混同しないこと（詳細は`docs/kb/ShrimpX_03_パラメータ仕様書.md`§5.3参照）。
- 残業率は`overtimeRateCap`（暫定0.3）でクリップする。残業を無限に増やしても能力は上限を超えない。
- `min(effective, factoryCapacity[product])`により、人員増加の効果は当該商品の専用設備能力を超えない。
- スキルのない商品（`skills`に該当エントリが無い）は`skillLevel=0`扱いとなり、有効労働能力は0になる。人員が0でも同様に0（設備能力があっても生産できない、労働不足の表面化）。
- 人件費（USD）は一切算出しない。記録すべき数量（配置人数・臨時ワーカー比率）のみを出力する。

出力（`WorkerAllocationEntry`）は、各生産計画の実配分後の常用・臨時人数（`assignedRegularHeadcount`/`assignedTemporaryHeadcount`）・適用後残業率・有効労働能力を持つ。工場単位の集計（`FactoryWorkerAllocationSummary`）として、未配分の常用・臨時人数（`unassignedRegularHeadcount`/`unassignedTemporaryHeadcount`）も出力する。「配分済み合計＋未配分＝配置人数」の保存則は常用・臨時それぞれ独立に成立する（`labor.test.ts`・`allocation.test.ts`・`runner.test.ts`で検証）。同順位の計画間の配分は、水位法の順序非依存性により入力順に依存しない。

## 5. 生産制約の解決順序（`allocation.ts`・`priorityAllocation.ts`）

`allocateProductionPlans(plans, factories, workerAssignments, rawMaterialLots, period, params)`は、次の順序で制約を適用する（Phase 6.1で段階2・5の単位・配分方式を修正）。

1. **原料（会社単位の共有プール、原料HOSO換算量）**: 会社が保有する`status="available"`原料ロットの合計を予算とし、その会社の全計画（工場・商品を横断）へ優先順位階層で配分する。
2. **工場共通処理能力（工場単位の共有プール、原料投入HOSO換算量）**: 段階1で配分された「原料側」の数量をそのまま候補・重みとし、工場の有効共通処理能力（原料投入側の上限）を予算に優先順位階層で配分する。ここまでは一貫して原料側の単位で完結させ、`saleableRecoveryRatio`による完成品HOSO換算量への変換は、段階1・2を通過した後、この段階の最後で初めて一度だけ行う（歩留まりの適用箇所はここのみ。§6参照）。
3. **冷凍・包装能力（工場単位の共有プール、完成品HOSO換算量）**: 段階2で完成品側へ変換済みの数量を、工場単位で配分する。
4. **商品別設備能力（工場×商品単位の専用プール、完成品HOSO換算量）**: HOSO/PD/VAPそれぞれの専用能力を予算に、同一工場・同一商品の計画間で配分する（通常は1計画のみだが、複数計画が競合する場合も対応する）。
5. **有効労働能力（工場単位の共有ワーカープール）**: `labor.ts`の`allocateWorkersToPlans`が、段階4を経た候補完成品量を基に、常用・臨時ワーカーそれぞれ工場単位の実配置人数を予算とした優先順位階層配分で、商品間の奪い合いを解決する（§4参照。Phase 6.1修正）。

各段階は`priorityAllocation.ts`の`allocateByPriorityTiers`（`priority`昇順の階層ごとに`rawMaterials/waterFill.ts`の`waterFillAllocate`で比例配分）を使う。`waterFillAllocate`の実装は入力配列の順序に一切依存しない（合計・比較がすべて順序非依存の演算）ため、同順位の計画間の配分は入力順に依存しない決定論的な結果になる。

生産できなかった量（`shortfallQuantity`）とその理由（`shortfallReasons`、5種類: `rawMaterialShortage`/`commonCapacityShortage`/`packagingCapacityShortage`/`productCapacityShortage`/`laborShortage`）は、各段階の候補量が直前の段階より減少したかどうかを比較して判定し、複数該当しうる形で出力する。

## 6. 商品別歩留まり・数量保存（`allocation.ts`・`batches.ts`・`yieldConversion.ts`、Phase 6.1で歩留まりモデルを修正）

**Phase 6.1修正: 2種類の歩留まりを分離した。**

- `physicalYieldRatio`（`production/parameters.ts`。旧値をそのまま引き継いだ参考値: HOSO 0.92 / PD 0.80 / VAP 0.70。要校正）: 殻・頭の除去等による**物理的重量**の減少比率。原料HOSO換算量から製品の物理重量（トン）を求める参考換算専用の値であり、HOSO換算数量（契約・在庫・能力等）の計算には一切使わない。`yieldConversion.ts`の`calculatePhysicalOutputTons(rawMaterialConsumedHosoEqTons, product)`という純粋関数としてのみ提供し、`allocation.ts`/`batches.ts`のいずれからも呼び出されない（永続状態へも persist しない、参考情報として必要になったときに呼び出す設計）。
- `saleableRecoveryRatio`（暫定値: HOSO 0.98 / PD 0.97 / VAP 0.95。要校正）: 規格外品・破損・廃棄等により、**HOSO換算ベースでも失われる真の回収率**。1に近い値になる。HOSO換算量の計算（原料消費量↔完成品数量の変換）に使うのはこの比率のみであり、`allocation.ts`の全段階・`batches.ts`を通じて歩留まりの適用箇所は次の1回のみで、二重適用は発生しない。

```
saleableFinishedHosoEq = rawConsumedHosoEq × saleableRecoveryRatio
trueProcessingLossHosoEq = rawConsumedHosoEq - saleableFinishedHosoEq
```

- 希望量→必要原料量の逆算（配分計算時）: `rawMaterialRequired = desiredQuantity / saleableRecoveryRatio`
- 最終配分量→必要原料量の順算（バッチ生成時）: `requiredRawMaterialQuantity = allocatedQuantity / saleableRecoveryRatio`

**具体例（原料100 HOSO換算トンからPD/VAPを生産する場合）**: 原料100トン(HOSO換算)を工場共通処理能力の制約なくすべて投入できたとすると、PD完成品(HOSO換算)は`100 × 0.97 ≈ 97トン`（真の加工損失 約3トン）になる。物理歩留まり0.80をそのまま乗じた「80 HOSO換算トン」にはならない（それは初版の欠陥そのものであり、PDの物理重量80トンをHOSO換算し直せばもとの100トンとほぼ同等になるはずの価値を、二重に目減りさせてしまっていた）。同様にVAP完成品(HOSO換算)は`100 × 0.95 = 95トン`になる。物理重量（例えばPDなら`100 × 0.92(=hosoの物理歩留まり ※参考) × ...`のような物理換算値）が必要な場合は、`calculatePhysicalOutputTons`を別途呼び出して参考値として得る（HOSO換算側の数量とは独立に扱う）。

`buildProductionBatches`は、`rawMaterials/inventory.ts`の`consumeRawMaterials`をそのまま呼び出して原料を実消費し、呼び出し前後の`remainingQuantity`の差分から消費内訳（`rawMaterialConsumed`）を復元する（独自のFIFO実装を持たない）。`rawMaterialLotSelector`（産地・調達源による絞り込み）が指定された場合のみ、対象ロットを一時的に部分配列へ切り出して`consumeRawMaterials`へ渡し、結果を元の配列へマージし直す。

数量保存: `原料消費量（rawMaterialConsumedTotal） = 販売可能完成品数量（finishedGoodsQuantity） + 真の加工損失（processingLoss）`。実際に消費できた原料量（原料不足で計画量より少なくなりうる）に基づいて完成品数量を再計算するため、原料が不足した場合でも保存則は常に成立する。ここで使う比率は、`allocation.ts`が`saleableRecoveryRatio`から導出した`allocatedQuantity/requiredRawMaterialQuantity`をそのまま使い、`batches.ts`が別の歩留まり（物理歩留まり等）を再適用することは一切ない。

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

- `yield.physicalYieldRatio`（HOSO 0.92 / PD 0.80 / VAP 0.70）: 商品別の物理重量歩留まり（参考値のみ。HOSO換算数量計算には使わない。§6参照）。
- `yield.saleableRecoveryRatio`（HOSO 0.98 / PD 0.97 / VAP 0.95）: 商品別の真の販売可能回収率（HOSO換算量の計算に使う唯一の比率。§6参照）。
- `labor.regularEfficiencyPerHeadTons`（6）/ `temporaryEfficiencyPerHeadTons`（3.5）: ワーカー1人あたりの基準有効生産能力（商品非依存の基礎値）。
- `labor.laborIntensityCoefficientByProduct`（HOSO 1.0 / PD 1.2 / VAP 3.0、2026-08-01追加）: 商品別労務負荷係数。基礎有効生産能力を商品ごとに割り引く除数。詳細は§4・§14参照。
- `labor.overtimeRateCap`（0.3）/ `overtimeEfficiencyFactor`（0.5）: 残業の上限・効果係数。
- `cost.baseProcessingCostUsdPerTon`（HOSO 350 / PD 520 / VAP 780）・`hosoEqKgPerTon`（1000）: 記録用の基準加工費・原料取得原価算出のためのトン→kg換算係数（非会計計上）。
- `finishedGoods.defaultShelfLifeTurns`（4四半期）: 完成品ロットの標準使用期限。
- `capacity.epsilon`（1e-6）: 制約判定の許容誤差。
- `supplySignal.preserveExistingWhenNoSignal`（true）: シグナル欠如時のフォールバック方針。

## 13. テスト・TypeScript・ESLint・build

- Phase 6初版のテスト: `app/lib/v2/production/__tests__/`に9ファイル・61件（`capacity.test.ts` 4件、`labor.test.ts`、`allocation.test.ts`、`batches.test.ts`、`finishedGoods.test.ts` 7件、`fulfillment.test.ts` 8件、`supplySignal.test.ts` 5件、`loadMetrics.test.ts`、`runner.test.ts`）。
- Phase 6.1での更新: `labor.test.ts`（旧`calculateEffectiveLaborCapacity`/`effectiveLaborCapacityForProduct`のテストを、新API`allocateWorkersToPlans`/`calculateLaborCapacityFromAssignedHeadcount`のテストへ全面書き換え。共有プールの保存則・優先順位・入力順非依存性・工場をまたぐ入出力対応順序を検証するテストを追加）、`allocation.test.ts`（工場単位ワーカー共有プールの合計超過なし・常用/臨時別々保存・原料投入側での共通処理能力制約のテストを追加）、`batches.test.ts`（旧`baseYieldRatio`を前提にしていた「HOSO換算と歩留まりを二重適用しない」テストを`saleableRecoveryRatio`基準へ修正し、原料100トンからPD/VAPを生産する具体例のテストを追加）、`loadMetrics.test.ts`（`calculateAllFactoryLoadMetrics`のシグネチャ変更に追従）、`runner.test.ts`（四半期ランナー全体を通した工場単位ワーカー共有プールの保存則テストを追加）。旧仕様（物理歩留まりをHOSO換算完成品へ直接乗じる前提）を固定していたテストは、正しい単位定義に合わせてすべて修正した。
- 合計テスト数: 既存499件（Phase1-5）＋Phase6.1時点のProduction関連73件（capacity 4・labor 14・allocation 16・batches 8・finishedGoods 7・fulfillment 8・supplySignal 5・loadMetrics 6・runner 5）＝**572件全てpass**（`npm test`で確認）。
- `npx tsc --noEmit`: 0エラー。
- `npx eslint app/lib/v2 app/v2 scripts`: 0エラー・0警告。
- `npm run build`: TypeScriptコンパイルは成功。ページデータ収集段階の既知の`/api/game/[gameCode]/admin/clone`エラー（`app/lib/redis.ts`の環境変数必須チェックが原因、Phase6.1の変更とは無関係。Phase6初版でも同一の既知エラー）以外の新規エラーは発生していない。

## 14. 対象外・将来課題

- **設備（機械化）と労働力の代替関係（2026-07-23、プレイヤーからの設計提案。未実装・未確定）**
  現行モデルでは、`hosoCapacity`/`pdCapacity`/`vapCapacity`は「商品専用の設備能力」として固定の絶対上限を表し、Stage 5の労働力配分（`labor.ts`）はこの上限を超えられない（人員をいくら増やしても、その商品の設備上限がハードキャップになる）。
  プレイヤーからの提案は次の通り：
  1. 該当商品の専用ライン（`hosoLineExpansion`/`pdLineExpansion`/`vapLineExpansion`等のCapex投資）を建設していない状態では、HOSO/PD/VAP間の生産配分は「機械の上限」に縛られず、労働力主体で柔軟に決められるべきである（人手による工程なので、どの商品を作るかは人員配置次第）。
  2. 専用ラインを建設した後も、その機械能力はあくまで「機械を使った場合の上限」であり、人員を大量投入すれば機械を介さない人力生産で機械能力を超えて生産できる余地を残すべきである。
  3. 上記の背景として、労働コストが極端に低下するマクロ経済ショック（例：ベトナムで経済危機が起き失業者が増え実質賃金が下落する等の`SCENARIO_EVENT_ARCHITECTURE_v0.1.md`的なイベント）が起きた場合、機械化後の工場であっても人手中心の大量生産に戻ることが経済合理的になり得る、という将来シナリオを想定している。
  4. プレイヤー自身も、工場内での「設備経由の生産量」と「人力経由の生産量」の配分方法（どちらを優先するか、両者がどう合算されるか）は別途設計が必要であると認識しており、実装時期が来たら専用モジュールとして切り出す想定で合意している。

  検討時に整理すべき論点（未確定）：
  - 商品ごとに「専用ラインが存在するか（Capex投資済みか）」を状態として持ち、存在しない場合は`hoso/pd/vapCapacity`を絶対上限として使わず、Stage 5の労働力プールから直接商品別に配分する経路に切り替える必要がある。
  - 専用ライン建設後は、(a)機械経由の生産量（`hoso/pd/vapCapacity`を上限とし、労働力消費が少ない、または専用の少人数オペレーターのみで足りる）と、(b)人力経由の追加生産量（労働力プールを消費し、機械能力を超えて積み増せる）の二経路を合算するモデルへの拡張が必要。
  - 商品ごとの「人力のみでの生産効率」（1人当たり生産可能トン数）は、現行の`regularEfficiencyPerHeadTons`(6t)/`temporaryEfficiencyPerHeadTons`(3.5t)のような画一係数ではなく、商品別に別途定義する必要がある可能性が高い（VAPはHOSOより人力あたりの複雑度・労働集約度が高いと想定されるため。`baseProcessingCostUsdPerTon`がhoso=350/pd=520/vap=780と商品ごとに異なる設定と整合させる）。
    **【2026-08-01追記】本項目のうち「商品別の労務負荷差」自体は、ブランチ`feature/v2-product-labor-intensity`で`ProductionParameters.labor.laborIntensityCoefficientByProduct`（HOSO:PD:VAP = 1.0:1.2:3.0）として実装済み（詳細は本書§4・`docs/kb/ShrimpX_03_パラメータ仕様書.md`§5.3参照）。ただし、上記1〜4で提案されている「設備能力上限を超えて人力で積み増せる」という設備・労働力の代替関係そのものは引き続き未実装・未確定であり、本節の課題として残る。**
  - 原料投入側の`commonProcessingCapacity`（Stage 2、原料の物理的な受入・脱穀処理能力）は、この柔軟性の対象外（真の設備上限）として維持するか、これも将来的に労働力代替の対象に含めるかは要検討。
  - 労働コスト低下シナリオ（ベトナム経済危機等）は`rawMaterials`/`scenarioEvent`側の既存の賃金・雇用パラメータとの連携が必要（本書の対象外、`SCENARIO_EVENT_ARCHITECTURE_v0.1.md`側の課題）。

- 実際の設備投資・工場建設・能力増設・減価償却（Phase8）。
- 人件費・製造原価・在庫評価の会計計上（`rawMaterialCost`・`baseProcessingCost`はPhase8へ渡せる記録情報として保持するのみ）。
- 品質・顧客信頼の変動（操業負荷指標はPhase7へ出力するが、本Phase自身は品質・信用を一切変化させない）。
- 正社員の採用・退職・教育（`WorkerAssignment.lifecycleStatus`は将来Phaseのための予約フィールドで、本Phaseでは`"active"`のみを扱う）。
- 労働・製造原価の会計計上、工場の資本投資判断。
- `physicalYieldRatio`（物理重量歩留まり）・`saleableRecoveryRatio`（真の販売可能回収率）とも暫定値であり、要校正（ゲームバランス調整フェーズで再検討する前提）。
- Phase5のターン・オーケストレーター（`app/lib/v2/turn/`）への実際の接続（本Phaseでは意図的に接続しない。次のPhaseでの課題）。
- V2 API・UI・決定提出画面・認証・WebSocket・Redis配線。
- `develop/v2`へのマージ・PR作成（Phase 6.1は`feature/v2-production`ブランチへのコミット・pushまでで停止し、マージは行わない）。
