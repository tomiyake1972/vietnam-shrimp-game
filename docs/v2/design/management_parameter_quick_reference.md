# 営業・市場基礎パラメータ早見表（management quick reference）

三宅さんovernight指示 Part F への対応。ChatGPT/Claude/三宅さんの間で共有する
「営業・市場」ドメインの基礎パラメータのクイックリファレンス。

**原則：本番コード（`app/lib/v2/**`）が唯一の正（source of truth）。**
パラメータ仕様書（`docs/kb/ShrimpX_03_パラメータ仕様書.md`）やゲームマニュアル
（`docs/kb/ShrimpX_02_ゲームマニュアル.md`）と本番値が食い違う場合は、
**古い方のドキュメントを黙って上書きせず**、「文書記載値」「現行本番値」
「状態（一致/不一致）」を並記する（三宅さん指示の通り）。

配置場所：`docs/v2/design/management_parameter_quick_reference.md`
（`docs/v2/reference/`は本セッション確認時点で未作成のディレクトリのため、
既存の`docs/v2/design/`配下の他の設計文書と同じ場所に置いた。将来
`docs/v2/reference/`が正式に作られる場合は移設を検討。）

---

## 【営業人員】

| パラメータ | 文書記載値 | 現行本番値 | 単位 | 状態 | ソースファイル | 経済的意味 |
|---|---|---|---|---|---|---|
| 初期営業人員数 | 会社ごとに異なる（10〜22名、下記参照） | 同左（会社A〜Eそれぞれ18/22/14/14/10） | 名 | 一致 | `app/lib/v2/companyLab/fixtures.ts:166,197,229,260,291`（`salesForceHeadcountTotal`） | ゲーム開始時点の各社の営業体制規模。単一の固定値ではなく会社ごとに異なる初期条件 |
| 1人あたり給与 | $8,000/四半期（`ShrimpX_03_パラメータ仕様書.md:802`） | $8,000/四半期 | USD/人/四半期 | **一致** | `app/lib/v2/finance/parameters.ts:154`（`salesForceSalaryUsdPerQuarter`） | 営業人員の基本人件費。年換算$32,000/人 |
| 採用コスト | 該当項目なし | **本番コードに実装なし**（`salesForceHiring.ts`ヘッダで意図的未実装と明記） | - | - | `app/lib/v2/sales/salesForceHiring.ts` | 現状、営業人員を増員しても採用コストは発生しない |
| 減員・退職金 | （仕様書に個別記載なし） | `layoffCount × 2四半期分 × 8,000` | USD/人（一時金） | 本番のみ実装 | `app/lib/v2/finance/quarterClose.ts:940-945`（`salesForceSeveranceCost`） | 減員を決定した四半期に一時金として計上 |
| P&L計上項目 | SG&A | SG&A（`sgaTotal`の一部、`salesForceCost`） | - | 一致 | `app/lib/v2/finance/quarterClose.ts:934,948` | `operatingProfit`を直接押し下げる |

**「$1.20M/年」についての付記**：三宅さんが記憶されている「営業人員コスト$1.20M/年」に
対応する項目は、現行コード・現行ドキュメントいずれにも見つからなかった。詳細な調査結果は
`docs/v2/design/market_share_soft_constraint_design.md` Part Eを参照。見つかった唯一の
$1,200,000という数字は、無関係な製造部門の工場固定費（`factoryFixedCostUsdPerQuarter`、
四半期額）であった可能性が高い。

## 【営業効果】

| パラメータ | 文書記載値 | 現行本番値 | 単位 | 状態 | ソースファイル | 経済的意味 |
|---|---|---|---|---|---|---|
| coverage式 | `baseline + (1-baseline)×h/(h+k)`（`ShrimpX_03_パラメータ仕様書.md`§3.1と一致） | 同左 | - | 一致 | `app/lib/v2/sales/salesForce.ts:salesCoverageScore()` | 営業人員数→市場カバレッジ率（0〜1）のMichaelis-Menten型飽和曲線 |
| coverage baseline（`baselineCoverageAtZeroHeadcount`） | 0.15 | 0.15 | - | 一致 | `app/lib/v2/sales/parameters.ts:106` | headcount=0でも15%のカバレッジが残る |
| coverage半飽和点（`coverageSaturationHeadcount`） | 6 | 6 | 名 | 一致 | `app/lib/v2/sales/parameters.ts:107` | headcount=6でbaselineと上限の中間値に到達 |
| processingCapacity式 | `baseline + increment×h/(h+k)` | 同左 | - | 一致 | `app/lib/v2/sales/salesForce.ts:processingCapacity()` | 営業人員数→処理可能数量（トン）の飽和曲線 |
| capacity baseline（`baselineCapacityTons`） | 200 | 200 | トン | 一致 | `app/lib/v2/sales/parameters.ts:108` | headcount=0でも200トンの処理能力 |
| capacity最大増分（`capacityMaxIncrementTons`） | 4,800 | 4,800 | トン | 一致 | `app/lib/v2/sales/parameters.ts:109` | headcount→∞での処理能力上限は200+4,800=5,000トン |
| capacity半飽和点（`capacitySaturationHeadcount`） | 10 | 10 | 名 | 一致 | `app/lib/v2/sales/parameters.ts:110` | headcount=10で中間値に到達（非常に早く飽和） |

## 【市場】

| パラメータ | 文書記載値 | 現行本番値 | 単位 | 状態 | ソースファイル | 経済的意味 |
|---|---|---|---|---|---|---|
| targetDemand定義 | market×product単位（世界需要ではない） | 同左 | HosoEqTons | 一致 | `app/lib/v2/sales/marketAdapter.ts:deriveTargetDemand()` | VN獲得需要を(a)商品構成比→(b)市場別消費比で按分した、成約配分の予算上限 |
| maximumSupplierShare | 35% | 0.35 | 比率 | 一致 | `app/lib/v2/sales/parameters.ts:132` | 個社の配分上限＝targetDemand×0.35（構造的ハード天井、本ドキュメントA-3で数値実証済み） |
| shareCap式 | `targetDemand × maximumSupplierShare` | 同左 | HosoEqTons | 一致 | `app/lib/v2/sales/allocation.ts:257` | 個社capの3項目のうちの1つ |
| externalOptionWeight | （仕様書に個別記載なし） | 0.35 | 比率 | 本番のみ | `app/lib/v2/sales/parameters.ts:134` | 「非購買・他産地」オプションが水位法予算の一部を吸収する重み |
| approvedAllocationCap | （会社ごとの承認枠、外部入力） | 同左 | HosoEqTons、任意 | 一致 | `app/lib/v2/sales/types.ts` | 個社capの3項目のうちの1つ（未指定時は無制限＝Infinity） |
| 配分方式 | 水位法（waterfilling） | `waterFillAllocate()` | - | 一致 | `app/lib/v2/sales/allocation.ts` | 予算をウェイト比例配分、cap到達社をクリップして残余を再配分、反復上限=参加者数+5 |

## 【財務への接続】

| パラメータ | 文書記載値 | 現行本番値 | 単位 | 状態 | ソースファイル | 経済的意味 |
|---|---|---|---|---|---|---|
| 営業人員→SG&A | `8,000×headcount + 7,000×調達人員 + 800,000 + 100×販売トン数`（`ShrimpX_03_パラメータ仕様書.md:808`） | 同左（`sgaTotal = salesForceCost + salesForceSeveranceCost + procurementCost + adminFixed + sellingLogistics`） | USD | 一致 | `app/lib/v2/finance/quarterClose.ts:934-948` | SG&A合計の構成式 |
| adminFixedUsdPerQuarter | 800,000 | 800,000 | USD/四半期 | 一致 | `app/lib/v2/finance/parameters.ts:158` | 管理部門固定費 |
| sellingLogisticsUsdPerTon | 100 | 100 | USD/トン | 一致 | `app/lib/v2/finance/parameters.ts:159` | 販売物流費（販売数量に比例） |
| procurementSalaryUsdPerQuarter | 7,000 | 7,000 | USD/人/四半期 | 一致 | `app/lib/v2/finance/parameters.ts:157` | 調達人員給与 |
| 成約→収益 | 成約数量×価格 | 同左 | USD | 一致 | `app/lib/v2/sales/contracts.ts`ほか | 成約（`allocatedQuantity`）が収益に転換 |
| リードタイム | 1四半期（標準） | `standardLeadTimeTurns = 1` | 四半期 | 一致 | `app/lib/v2/sales/parameters.ts:138`、`app/lib/v2/sales/contracts.ts:55` | 当期T成約→T+1期納品（`desiredLeadTimeTurns`指定時はそちらを優先） |
| 売掛金・キャッシュフロー | （既存財務モジュール、本ラウンド対象外） | `app/lib/v2/finance/*` | - | - | - | リードタイムの1期ラグが売掛金回収タイミングに反映される（詳細は財務モジュール側のドキュメント参照、本ラウンドでは変更・再調査していない） |

（参考：製造部門の関連固定費。営業人員コストとは無関係だが、Part E の
「$1.20M/年」混同調査の対照値として記載）

| パラメータ | 現行本番値 | 単位 | ソースファイル |
|---|---|---|---|
| factoryFixedCostUsdPerQuarter | 1,200,000 | USD/四半期 | `app/lib/v2/finance/parameters.ts:148` |
| factoryUtilityFixedUsdPerQuarter | 250,000 | USD/四半期 | `app/lib/v2/finance/parameters.ts` |
| factoryUtilityVariableUsdPerTon | 25 | USD/トン | `app/lib/v2/finance/parameters.ts` |

## 【生産・労務】（2026-08-05 Test15読み込みラウンドで追加、`/tmp/pd_labor` HEAD `5f1fa87`で確認）

| パラメータ | 現行本番値 | 単位 | ソースファイル | 経済的意味 |
|---|---|---|---|---|
| 商品別労働集約度係数（機械化前） | HOSO:PD:VAP = 1.0 : **1.8** : 3.0 | 係数 | `app/lib/v2/production/parameters.ts:166-169`（`labor.laborIntensityCoefficient`） | 同じ人数でHOSOを基準にPD/VAPは処理量が少ない（人手がより多く必要）ことを表す。コード内コメントに「要校正」注記あり |
| 商品別労働集約度係数（機械化後・完全成熟） | HOSO:PD:VAP = 1.0 : 1.2 : **2.6** | 係数 | `app/lib/v2/production/parameters.ts:172-175`（`labor.mechanizedLaborIntensityCoefficient`） | PD省人化投資が完全に成熟した工場での到達値 |
| 唯一の変換関数 | `resolveLaborIntensityCoefficient(product, mechanizationLevel, params)` | - | `app/lib/v2/production/labor.ts:70-82` | 生産実行（`allocateWorkersToPlans`）・必要人員見積り（`companyLab/workforce.ts`）・意思決定画面表示・Standard AI判断・Excel出力の**すべてがこの一つの関数を経由**する設計（コード内コメントで明示） |

**重要な訂正**：三宅さんが記憶されている「HOSO:PD:VAP = 1.0:1.2:3.0」という数値は、
現行コードのどの単一の状態（機械化前・機械化後いずれ）とも完全には一致しない。
コード上の実際の値は機械化前が1.0:1.8:3.0、機械化後が1.0:1.2:2.6であり、
「1.2」は機械化後PDの値、「3.0」は機械化前VAPの値と、**異なる2つの状態の数値が
混在した記憶**である可能性が高い（`production/parameters.ts`のコード内コメントに
よれば、旧Test15時点では実際に pd=1.2 を機械化前の値として使っていたが、これは
「機械化後の到達値」に相当する水準であり、機械化前の人手の重さを表現できず
投資回収が構造的に成立しない一因になっていたため、後の作業で1.8へ引き上げる
再校正が行われた、という変更履歴がコード内に記録されている）。

## 【新工場建設】（`newFactoryConstruction`）

| パラメータ | 現行本番値 | 単位 | ソースファイル |
|---|---|---|---|
| 投資額 | 22,000,000 | USD | `app/lib/v2/capex/parameters.ts:275-303` |
| 支払スケジュール | 30% / 35% / 35%（3四半期） | 比率 | 同上 |
| 竣工後操業準備期間 | 1 | 四半期 | 同上 |
| 建物比率／機械比率 | 45% / 55% | 比率 | 同上 |
| 保守費率 | 0.75%/四半期 | 比率 | 同上 |
| フル稼働時能力（HOSO/PD/VAP/共通前処理/凍結包装） | 10,000 / 8,000 / 6,000 / 22,000 / 20,000 | トン/四半期 | 同上 |
| ランプアップ倍率 | 稼働開始四半期50%→75%→100% | 比率 | 同上 |
| 実測（UI）投資額・今期支払・保守費・減価償却 | $22,000,000／$6,600,000／$165,000／四半期／$401,500/四半期 | USD | 本ラウンドPlaywright実測（`/v2/company-lab`意思決定画面） |

## 【PD省人化投資】（`pdMechanization`）

| パラメータ | 現行本番値 | 単位 | ソースファイル |
|---|---|---|---|
| 投資額 | 2,500,000 | USD | `app/lib/v2/capex/parameters.ts:305-330` |
| 支払スケジュール | 40% / 60%（2四半期） | 比率 | 同上 |
| 竣工後操業準備期間 | 1 | 四半期 | 同上 |
| 建物比率／機械比率 | 10% / 90% | 比率 | 同上 |
| 保守費率 | 1%/四半期 | 比率 | 同上 |
| 対象範囲 | 工場（Factory）単位、PD係数のみ低減。HOSO/VAPには無影響 | - | `app/lib/v2/capex/pdMechanization.ts` |
| 達成可能な最大削減率 | 約16.67%（1/6、基準係数と機械化後係数フロアの比から導出。ハードコードなし） | 比率 | `app/lib/v2/capex/pdMechanization.ts:reductionRatioAtFullMaturity()` |

## 【VAP商品開発】（`vapProductDevelopmentSpendUsd`）

| パラメータ | 現行本番値 | 単位 | ソースファイル |
|---|---|---|---|
| 選択可能投資額（4段階） | $0 / $100,000 / $250,000 / $500,000 | USD/四半期 | `app/lib/v2/companyLab/productDevelopmentState.ts:31` |
| 中立スコア | 50 | 0-100 | 同上（`neutralScore`） |
| 標準投資額 | 250,000 | USD/四半期 | 同上（`standardBudgetUsd`） |
| 標準投資時の四半期スコア増加量 | 4.0 | ポイント | 同上（`gainCoefficient`） |
| 投資比率上限 | 2.0（＝$500,000÷$250,000） | 比率 | 同上（`investmentRatioCap`） |
| 無投資時の減衰率 | 6%/四半期（中立値50へ収束） | 比率 | 同上（`idleDecayRatioPerQuarter`） |
| P&L計上 | 選択額を全額当四半期SG&Aへ費用化・同額が営業CF流出。資産計上・減価償却なし | - | UI実測（本ラウンドPlaywright確認）＋`companyLab/runner.ts` |
| 効果の接続先 | `sales/allocation.ts`の合成競争力ウェイト（`vapCapability`経由、`premiumPolicy.ts`の`calculateCompanyCapabilityCoefficient`経由）のみ。市場価格観測等の共有データは書き換えない | - | 同上 |

---

## 検証方法

本ドキュメントの全数値は以下の方法で確認した：
- 本番値：`app/lib/v2/sales/parameters.ts`, `app/lib/v2/finance/parameters.ts`,
  `app/lib/v2/companyLab/fixtures.ts`, `app/lib/v2/finance/quarterClose.ts`,
  `app/lib/v2/sales/allocation.ts`, `app/lib/v2/sales/marketAdapter.ts`,
  `app/lib/v2/sales/contracts.ts` を直接読み取り（本ラウンドで変更は一切していない）。
- 文書記載値：`docs/kb/ShrimpX_03_パラメータ仕様書.md`（§3.1営業人員、794/802/808/1021行目付近）、
  `docs/kb/ShrimpX_02_ゲームマニュアル.md`（549/648行目付近）を参照。
