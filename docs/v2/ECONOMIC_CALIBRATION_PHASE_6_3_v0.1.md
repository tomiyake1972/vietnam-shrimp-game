# ShrimpX V2 — 経済尺度・価格下限・契約集計の是正 アーキテクチャ v0.1（Phase 6.3）

Phase 6.2の経済スケール診断で判明した問題群（成約量の累積表示、即時履行の計上漏れ、
HOSO換算と物理歩留まりの混同、国内原料価格の非現実的な下限張り付き、5社需要と国全体
供給の尺度不一致、調達能力100倍補正、国際HOSO価格の底打ち、PD/VAP最低受注水準の欠如）
への是正一式。対象ブランチは `feature/v2-production`（基点コミット `b7f4755`）。

## 1. 四半期成約・履行サマリーの修正（companyLab/runner.ts）

- `newContractedQuantity`・当期平均成約単価は、累積契約一覧（`turnResult.contracts`）
  ではなく **`turnResult.salesRecord.newContracts`**（当期新規契約のみ）から集計する。
- `fulfilledQuantity` は契約残高の前後差分ではなく、当期の実際の完成品充当実績
  **`productionRecord.fulfillmentPlan.usage`** から直接集計する。当期に新規成約し
  同一四半期中に即時履行された契約も必ず含まれ、会社別・契約別の履行量と全社合計が
  一致する（`fulfillmentPlan.usage` が契約ID・商品・ロットIDを保持している）。

## 2. HOSO換算と物理重量（production/parameters.ts・yieldConversion.ts）

契約・原料・設備能力・生産・完成品在庫・供給シグナルはすべてHOSO換算トンで管理する。

物理重量の暫定換算基準（`physicalYieldRatio`、参考値・非換算用）:

| 変換 | 物理歩留まり |
|---|---|
| HOSO原料100トン → 冷凍HOSO | 約100物理トン（= 1.00） |
| HOSO原料100トン → HLSO | 約60物理トン（= 0.60。商品enum未追加のため文書化のみ） |
| HOSO原料100トン → PD | 約54物理トン（= 0.54） |
| HOSO原料100トン → VAP | 一律の物理歩留まりを設定しない（仕様差が大きいため。主数量は投入HOSO換算量で管理） |

旧値（HOSO 0.92 / PD 0.80 / VAP 0.70）は廃止した。`saleableRecoveryRatio`（HOSO換算上の
真の回収率）は通常操業基準を全品 **1.00** とし、正常な頭・殻の除去ではHOSO換算量を
減らさない。品質不良・加工ミス・廃棄等の真の損失は、Phase 7からこの比率を通じて
変動させられる構造を維持している（テストで縮小時の必要原料量増加を確認済み）。
物理重量換算は表示・仕様変換の境界で一度だけ使用し（`calculatePhysicalOutputTons`・
`toPhysicalWeightPrice`）、契約・在庫のHOSO換算量へ再適用しない。

## 3. 国内原料の買付上限（market/vietnamRawMarket.ts）

国内原料価格とVN HOSO輸出価格はどちらもHOSO換算kgあたり価格である（型・仕様で確認）。
そのため旧式の物理歩留まり0.62（HLSO相当）の乗算を廃止し、次の式へ是正した。

```
processorBuyingCeiling = VN HOSO export price × hosoEqRecoveryRatio(基準1.00)
                       − processingAndExportCost − requiredMargin
```

`hosoEqRecoveryRatio` はHOSO換算上の真の回収率であり、一度だけ適用する
（シナリオ側フィールドも `hosoYieldRatio: 0.62` → `hosoEqRecoveryRatio: 1.0` へ改名・是正）。

## 4. 養殖農家の販売留保価格と数量調整（market/vietnamRawMarket.ts）

```
farmerReservationPrice = farmingCost + diseaseRiskAllowance + minimumFarmerMargin
                       = 1.90 + 0.15 + 0.20 = 2.25 USD/HOSO換算kg（暫定値・シナリオから変動可能）
```

- 買付上限 ≥ 留保価格: 価格は [留保価格, 買付上限] の範囲で需給により決まる。
  取引数量 = min(供給, 実効需要)。
- 買付上限 < 留保価格: 農家は留保価格未満で全量取引に応じない。価格ではなく
  **取引数量**を縮小して調整する（tradeRatio = clamp(1 − 乖離度×感応度)）。
  加工会社側に調達未達が発生し、未売却の潜在供給（`unsoldSupply`）は会社在庫へ
  自動計上されず、次期の池入れ・供給減少判断のシグナルとして結果に保持される。

`absolutePriceFloorUsdPerKg = 0.05` は数値エラー防止用バックストップとしてのみ残し、
通常の市場計算で到達する経済的下限には使用しない。baseline 32ターンの国内原料価格は
2.28〜2.93 USD/kg で推移し、$1/kg未満へは下落しない（テストで検証）。

## 5. 外部加工業者需要（companyLab/externalDemand.ts・turn/runner.ts）

5社の買付意向だけでベトナム国全体の加工需要を置き換えない。

```
国内価格形成用総買付意向 = 外部加工業者需要 + 5社の信認済み買付意向
```

- `turn/runner.ts` の `DomesticPurchaseIntentSource.companyPlans` へ
  `externalIntent`（オプショナル、未指定時は従来動作＝後方互換）を追加。
- 外部需要は固定数量ではなく、`calculateExternalProcessorIntent`（companyLab）で
  世界需要指数（需要市場の前期消費×景気指数の合計/基準1,200,000トン）と
  前期国内価格（価格弾力性0.4、安定化フィードバック）に決定論的に反応する。
  基準は 0.70 × 450,000（baselineの国内供給）= 315,000トン/四半期。
- 会社別配分の原資は「当期取引成立量 × 会社側意向比率」となり
  （`companyAvailableDomesticSupply`）、5社が買付を止めても業界需要はゼロにならない
  （テストで検証）。`maximumBuyerShare` の基準は市場全体の供給量のまま維持する
  （`shareCapReferenceSupply`）。
- 実測の5社シェアは総買付意向の約8〜18%。目安（20〜30%）より低めであり、
  国全体供給450,000トン/四半期に対する5社フィクスチャの規模が構造的に小さいことに
  よる（将来課題: Phase 8校正で会社規模または国内市場スケールの再設計を検討）。

## 6. 調達処理能力の再校正（rawMaterials/domesticPurchase.ts）

旧company-labの約100倍一律補正（経済的根拠なし・制約として一度も機能せず）を廃止し、
工場能力連動方式へ置き換えた。

```
調達能力 = 工場共通原料処理能力 × (0.5 + 1.2 × 人員/(人員+10))
```

| 会社 | 調達人員 | 工場共通能力 | 調達能力 | 比率 |
|---|---|---|---|---|
| BAL | 12 | 22,000 | 25,400 | 1.15 |
| MASS | 20 | 36,000 | 46,800 | 1.30 |
| JPQ | 10 | 16,000 | 17,600 | 1.10 |
| VAP | 10 | 18,000 | 19,800 | 1.10 |
| CONSV | 8 | 15,000 | 15,500 | 1.03 |

通常操業（国内買付は必要原料の5〜7.5割）では制約にならず、急増産・買い占めでは
制約になり、人員効果は残るが飽和する。工場能力情報が無い呼び出し
（industryLabの小規模テスト会社）は従来の絶対値カーブへフォールバックする。

## 7. 国内・輸入・養殖の調達構成（companyLab/autoPolicy.ts）

自動方針を「工場能力いっぱいの固定生産・在庫過剰で買付停止」から、
販売・約定残・在庫に連動した構成比ベースの調達へ再設計した。

| 会社 | 国内買付(目標) | 輸入 | 自社・契約養殖 | 実測(32ターン) |
|---|---|---|---|---|
| BAL | 60% | 15% | 25% | 51/14/35 |
| MASS | 75% | 15% | 10% | 70/15/15 |
| JPQ | 60% | 10% | 30% | 51/9/40 |
| VAP | 50% | 25% | 25% | 41/24/35 |
| CONSV | 70% | 10% | 20% | 64/9/26 |

- 原料在庫の目標は次期生産必要量の0.3〜0.5四半期分（アーキタイプ別）。
  在庫補正は減衰係数0.5で目標へ寄せ、下限（構成比ベース需要×0.2）により
  国内買付需要が一斉にゼロへ落ちない。32ターン後の在庫は各社1,200〜6,100トンで
  発散しない（テストで検証）。
- 養殖池入れは「構成比×必要原料量」から逆算し（旧: 能力×0.85固定）、
  自社養殖だけでの恒常的な完全自給を防ぐ。

## 8. 国際HOSO価格の底打ち修正（market/hosoPricing.ts）

原因追跡の結論（Phase 6.2診断のbaselineでIN・ID・VNが$0.50へ張り付く問題）:

1. **需要配分**: 固定シェア（EC45/IN25/VN18/ID12）が供給シェア（EC27/IN33/ID18/VN23）
   と恒常的に不一致で、IN・ID・VNに恒常的な負の需給不均衡が残る。
2. **前期価格フィードバック**: 価格式が「不均衡の水準」を「価格変化率」へ直結する
   積分器構造のため、恒常不均衡が毎四半期価格を削り続けて下限まで発散する
   （シナリオ自体が世界供給1.8M vs 需要1.2Mトン/四半期の恒常的供給過剰を持つ）。

価格式全体は書き直さず、最小限の3修正を加えた（`hosoPriceSelfCorrection`）:

- **(a) 価格応答的な需要配分**: share_i ∝ weight_i × exp(−2.0 × 相対価格乖離)。
  安い原産国へ需要が移り、価格下落が自己修正される（同品質国際商品の裁定の簡易表現）。
- **(b) コスト連動アンカーへの平均回帰**: 変化率へ −0.8 × (前期価格 − アンカー)/アンカー
  を加算（アンカー = initialHosoFobPrice × 養殖コスト指数）。恒常的需給圧力Pの下でも
  価格はアンカー比 P/回帰率 の有限なディスカウントへ収束する。
- **(c) 国別価格スプレッドの有限化**: 国別価格をグローバル基準価格（需要ウェイト平均）
  ±35%へクランプ（driver: `COUNTRY_PRICE_SPREAD_BOUNDED`）。

結果（baseline canonical 32ターン）: EC 4.23〜4.94 / IN 3.73〜4.34 / ID 3.63〜4.36 /
VN 3.81〜4.49 USD/kg。絶対下限$0.50への到達なし。疾病危機シナリオではVNが一時5.10まで
上昇し、イベント終了後に回復する（一時的な大幅変動は許容）。5社の行動は国際価格を
直接変更しない（既存テストで検証継続）。

## 9. PD/VAPの最低受注プレミアム（companyLab/premiumPolicy.ts・fixtures.ts・sales/）

会社×商品（PD/VAP）について次を区別する（フィクスチャの暫定値、Phase 8実原価へ交換可能）:

```
targetPremium            = expectedVariableProcessingCost + allocatedFixedCost
                         + sellingAndLogisticsCost + targetMargin
minimumAcceptablePremium = avoidableVariableProcessingCost
                         + incrementalSellingAndLogisticsCost + minimumContributionMargin
```

| 会社 | PD目標/最低 | VAP目標/最低 |
|---|---|---|
| BAL | 0.52 / 0.25 | 1.18 / 0.59 |
| MASS | 0.57 / 0.30 | 1.58 / 0.94（高コスト→先に退出） |
| JPQ | 0.51 / 0.23 | 1.28 / 0.66 |
| VAP | 0.53 / 0.26 | 0.99 / 0.47（効率的→受注継続） |
| CONSV | 0.56 / 0.28 | 1.33 / 0.70 |

- 市場プレミアム ≥ 目標: 通常受注。目標未満・最低以上: 縮小受注（係数0.4〜1.0）。
  最低未満: 販売提案を出さない（希望量0）。成立しない需要は未充足需要として残る。
- 受注を止めた商品は生産希望量も「販売希望＋約定残−完成品在庫」連動で減り、
  供給過剰時は「プレミアム低下 → 経済的下限 → 稼働率低下」の順で調整される。
- VAPの最低受注水準は全社でPDより高い（テストで検証）。
- プレミアム下限付近の配分は既存Phase4の非価格競争（顧客関係・品質・納期信頼性・
  営業カバレッジ、上限付き飽和型の価格効果）をそのまま使用。ブランド価値は独立
  パラメータとして実装しない（品質・納期・顧客関係を代理変数とする将来拡張点）。

### 契約時予想原価スナップショット

販売計画に `costExpectation`（契約時予想原料価格・予想加工費・最低受注価格）を添付し、
成約時に `SalesContract.costSnapshot`（上記＋契約時予想貢献利益 = 成約単価 −
予想原料価格 − 予想加工費）として保持する。契約後に実際の原料価格・残業・加工費が
上昇しても契約単価は自動改定しない（テストで検証）。

永続化スキーマは `CURRENT_PERSISTED_GAME_STATE_VERSION = 2` へ更新（オプショナル
フィールドの追加的変更。バージョン1の旧データはマイグレーション不要でそのまま読める。
ラウンドトリップ・後方互換テストを追加済み）。

## 10. Phase 8向けの原料費比率校正指標

**Minh Phu型の加工会社では、原料費が売上原価（COGS）の概ね60〜70%を占める**という
実務情報を、Phase 8（財務三表・原価計算）の校正指標として本文書に記録する。

Phase 6.3では財務三表を実装しないが、次の量を診断可能な形で区別して保持している:

| 量 | 所在 |
|---|---|
| 原料取得単価 | `RawMaterialLot.unitCost`・`DomesticPurchaseAllocationResult.marketPrice` |
| 商品別HOSO換算販売価格 | `SalesContract.unitPrice`・`MarketQuarterResult`のbasePrice/premium |
| 物理製品重量当たり販売価格 | `toPhysicalWeightPrice(hosoEqPrice, product)`（= HOSO換算単価 ÷ 物理歩留まり。例: PD $5.32/HOSO換算kg → $9.85/物理kg） |
| 物理歩留まり | `PRODUCTION_PARAMETERS_V1.yield.physicalYieldRatio`（HOSO 1.00 / PD 0.54 / HLSO 0.60文書値 / VAP 未定義） |
| 予想加工費 | `CompanyFixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg`・`ContractCostSnapshot.expectedProcessingCostUsdPerHosoEqKg` |
| 最低受注プレミアム | `minimumAcceptablePremium(fixture.productEconomics.premiumEconomics[product])`・`ContractCostSnapshot.minimumAcceptablePriceUsdPerHosoEqKg` |

校正の目安（Phase 8で検証）: 契約単価に対する原料費比率 =
expectedRawMaterialPrice / unitPrice。HOSO契約の例では 2.5 / 4.48 ≈ 56%、加工費込みの
売上原価比では (2.5) / (2.5 + 0.5) ≈ 83%（HOSO）〜 (2.5) / (2.5 + 1.2) ≈ 68%（VAP）と
なり、PD/VAPで60〜70%帯に近い。HOSO素材品はより高くなるのが自然であり、商品構成を
加味した加重平均で60〜70%へ収まるかをPhase 8の財務実装時に検証する。

## 11. 将来課題（Phase 6.3の対象外として残すもの）

- 5社シェアが総買付意向の8〜18%と目安（20〜30%）より低い（国全体供給450,000トン/四半期
  に対する5社フィクスチャの規模が構造的に小さい）。Phase 8校正で会社規模または
  国内市場スケールの再設計を検討する。
- シナリオデータの世界供給（1.8M）対世界需要（1.2M）の恒常的供給過剰は温存されている
  （価格側の自己修正で吸収）。シナリオ側の需給スケール再校正はPhase 2データの
  バランス調整として別途扱う。
- 農家留保価格の構成要素・外部需要の弾力性・プレミアム経済性の各数値はすべて
  暫定値（要校正）。
- 通常運転では全社の約定残・納期超過がほぼゼロになる（受注が需要制約で適正規模のため）。
  プレイヤーが過剰契約した場合に約定残・納期超過が増える機構自体は維持されている。
