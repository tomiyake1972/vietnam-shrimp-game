# SAI-GROW-3C — Deliverability Constraint Routing / Capacity Expansion

base commit: `0f07701`（3B-3）。GROW-2 / GROW-3A / Liquidity SSoT / Growth Financing /
Fundable Operations / Survival & Recovery / Deliverable Commitment はすべて維持。

## 1. 解決しようとした構造

3B-3で「売りたい量」と「今受けてよい量」は分離できたが、Deliverability capで提出量を
縮めた情報が診断に留まり、能力側の判断へ戻っていなかった。DS3 VAPで

```
Production / Worker不足 → Commitment縮小 → 実績規模縮小 → 次TurnのAmbition縮小
```

という新しいdeadlockが露出した（Ambition 39.4kt → 32.2kt、生産 37.9kt → 29.3kt）。

**3B-3のcapは1ミリも緩めていない。** 「売れない」のではなく「作れない」のだから、
Deliverability Gapを能力側へrouteする。Commercial Ambition・Visionには一切書き戻さない。

## 2. Routing logic（`decision/growthRouting.ts`）

### 2.1 Deliverability Growth Gap

```
sustainableDeliverableCapacity = min( 設備側の納品可能量（3B-3の評価）,
                                      workerCapacitySupportedTons,
                                      fundableRawMaterialTons )
deliverabilityGrowthGap        = max(0, Commercial Ambition − sustainableDeliverableCapacity)
```

3B-3の `DeliverableCommitmentState` は設備能力ベースであり、**Workerと原料はrouting側でだけ**
minに加える（§15）。3B-3のcap本体には一切影響させない（§2）。

### 2.2 Worker capacity（§4）

新しいworker modelを作らず、`companyLab/workforce.ts::computeRequiredRegularHeadcount`
をそのまま使う（商品別労働集約度 HOSO 1.0 / PD 1.2 / VAP 3.0 を内包する唯一の情報源）。

```
ambitionMix               = 志の量を「営業が売りたい商品構成」（salesWishByMarketProduct の
                            desiredQuantityBeforeEffortConstraint 構成比）へ割り付ける
workerRequirementForAmbition = computeRequiredRegularHeadcount(ambitionMix, 平均skill, 平均出勤率)
workerCapacitySupportedTons  = 志 × min(1, 現有Worker / workerRequirementForAmbition)
workerGap                    = max(0, workerRequirementForAmbition − 現有Worker)
workerLimited                = workerGapTons > productionGapTons
```

VAPは労働集約度3.0なので、同じ人数でもHOSOより少ないトン数しか捌けない。
**会社IDによる分岐をせずに §5 の会社差が自然に出る**（受入G3C-9で固定）。

### 2.3 Route選択（§3の優先順位）

| 条件 | route | 効果 |
|------|-------|------|
| gap ≤ 0 | NONE | 何もしない |
| SURVIVAL / RECOVERY | LIQUIDITY | 3B-2の既存制約を優先し能力投資を起こさない |
| 流動性が塞がる / 原料不足の原因が資金 | LIQUIDITY | **設備も営業採用も増やさない** |
| overdueあり かつ 非持続 | BACKLOG_RECOVERY | まず既存backlogの消化 |
| 原料gapが最大 | PROCUREMENT | Production CAPEXを増やさない |
| Workerがbinding | WORKFORCE | **Factory CAPEXよりWorker増員を優先** |
| 生産能力gap | PRODUCTION_CAPEX | ボトルネック商品のライン増設へ |
| 営業能力だけがbinding | SALES_HIRING | 最後に評価 |

### 2.4 持続性（§8）

新しいカウンタ・新しい閾値を作らず、既存の「前四半期に実際に満杯まで回していたか」だけを
根拠にする（新工場の `persistentCapacityCausedUnserved` と同じ考え方）。
計器はrouteに合わせる：

* WORKFORCE … `pressures.laborUtilizationLastQuarter >= capexSustainedUtilizationThreshold`
* PRODUCTION_CAPEX … `pressures.equipmentUtilizationLastQuarter >= 同`

PROCUREMENT / LIQUIDITY / BACKLOG / SALES_HIRING は各ドメイン側に既存ガードがあるため
持続性を要求しない。

## 3. 各ドメインへの接続

| route | 接続先 | 実装 |
|-------|--------|------|
| PRODUCTION_CAPEX | `decision/capex.ts` | ボトルネック判定の分子を `max(生産必要量, 回付量)` にする。**sustained / noExcess / 3B-1財務ゲートは無変更**。引数はoptionalで、渡さなければ従来と完全に同一 |
| WORKFORCE | `decision/labor.ts` | 必要人数の下限を志側へ引き上げる。**増員の刻みは既存 `regularHeadcountAdjustmentDamping` のまま**＝一括採用しない。引数はoptional |
| PROCUREMENT / LIQUIDITY / BACKLOG_RECOVERY | 診断のみ | 調達量は縮退後の生産計画へ自動追従（3B-2）、借入は3B-1.1が既に投資分を申請する |
| SALES_HIRING | `policy.ts` | LIQUIDITY routeのときだけ採用を止める（下記§6） |

## 4. 新しいmodel・新しい閾値を作っていない

`computeRequiredRegularHeadcount` / `computeBindingProductionCapacityTons` /
3B-3 `DeliverableCommitmentState` / 3B-2 `computeFundableRawMaterial` /
3B-1 `LiquidityAssessment` / `salesCapacityCeilingTons` /
`capexSustainedUtilizationThreshold` / `pressures.equipmentUtilizationLastQuarter` /
`pressures.laborUtilizationLastQuarter` — すべて既存。
company IDのhardcodeは0件（受入G3C-12でソースを走査）。
Commercial Ambition・Vision・Commitmentへの書き戻しも0件（受入G3C-11）。

## 5. 実装中の訂正（silent tuningをしていない記録）

1. **Sales Hiringを一律に止めていた**: PRODUCTION / WORKFORCE / PROCUREMENT / LIQUIDITY の
   いずれかがbindingなら採用を止めたところ、成長中の会社は常に何らかのgapを持つため
   事実上の採用停止になり、新工場のDEMAND_PULLゲートへ到達する会社が消えて既存回帰テスト
   **CG-21が落ちた**（実測）。生産余力・原料供給制約・資金余力に対する採用ガードは既存の
   `buildStandardAiSalesForceHiringDecision` が既に持っているため、§3が明示する
   **LIQUIDITYだけ**をこの層の責務として止める形へ訂正。
2. **持続性の計器がrouteと合っていなかった**: どのrouteでも設備稼働率で判定し、さらに
   「3B-3のcapが実際に効いたこと」も要求していた。Workerがbindingな会社では設備稼働率が
   頭打ちにならず（VAP実測 0.90 < しきい値0.92）、Workerが先に効くのでcapも発火しないため、
   持続性が永久に成立せず能力側が動かないままだった。Worker制約はlabor稼働率で判定する形へ訂正。
3. **routingの納品可能量に Worker / 原料が入っていなかった**: 設備能力だけで測ると
   VAPのgapが常に0になり（ambition 32,760 < 設備 35,012）routeがNONEのままだった。
   §15に従い routing側のsustainable capacityへ Worker と原料を min で加えた
   （3B-3のcap本体には影響させない）。RAW_MATERIALも同じ理由で構造的にbindingになり得ず、
   受入G3C-3で検出して同時に訂正。

## 6. 実測（DS3 8seed × 5社、T32平均。before = 0f07701）

| 会社 | ambition | sales | 生産 | VAP生産 | 生産能力 | Worker | CAPEX累計 | cash | backlog | overdue |
|------|---------:|------:|-----:|--------:|---------:|-------:|----------:|-----:|--------:|--------:|
| VAP before | 32,220 | 28,550 | 29,309 | 6,726 | 35,103 | 11,343 | 50.0M | 398.7M | 27,138 | 7,703 |
| VAP **after** | 32,325 | 27,856 | **30,587** | 6,463 | 35,408 | **11,532** | 53.0M | 388.4M | 31,153 | 12,551 |
| JPQ before → after | 44,120 → 42,910 | 30,417 → **33,164** | 36,740 → **38,441** | 6,603 → 6,211 | 44,535 → 44,471 | 13,256 → **13,602** | 81.3 → 82.1M | 627.4 → 635.8M | 33,778 → 36,026 | 18,038 → 15,978 |
| CONSV before → after | 42,205 → 41,755 | 36,837 → 37,845 | 39,668 → 39,880 | 6,291 → 6,202 | 44,182 → 43,787 | 12,235 → 12,560 | 86.8 → 82.4M | 630.4 → 627.7M | 17,570 → **14,310** | 1,132 → **220** |
| MASS before → after | 63,670 → 63,635 | 36,504 → 33,155 | 54,163 → 53,331 | 5,099 → 6,348 | 70,324 → 66,797 | 19,427 → 19,486 | 92.4 → 91.8M | 491.0 → 482.1M | 64,779 → **57,973** | 17,462 → 18,265 |
| BAL before → after | 58,890 → 58,490 | 43,770 → 42,844 | 44,432 → 44,434 | 8,239 → 8,234 | 62,447 → 62,404 | 14,503 → 14,504 | 87.8 → 84.8M | 588.5 → 549.8M | 494 → 566 | 0 → 0 |

### VAP turn-by-turn（seed ds3-a）— 能力拡張経路

```
T   amb    finalSub  sales  prod   worker  wCapT  wReq   constraint  route            gap
T21 13,280 11,986    11,986 11,930  4,676  12,802  4,850 BACKLOG     BACKLOG_RECOVERY  477
T22 13,287 14,092    13,287 13,046  4,676  12,802  4,853 WORKFORCE   WORKFORCE         484
T23 22,880 24,227    17,900 18,924  6,446  12,683  8,436 WORKFORCE   WORKFORCE      10,197
T24 27,680 29,214    21,259 25,252  8,533  17,995 10,272 LIQUIDITY   LIQUIDITY       9,685
T27 32,760 31,072    21,070 29,168 11,043  29,660 12,197 WORKFORCE   WORKFORCE       3,100
T30 32,760 34,575    29,098 31,806 11,799  31,691 12,197 WORKFORCE   WORKFORCE       1,069
T32 32,760 29,478    29,098 30,792 11,799  31,691 12,197 BACKLOG     BACKLOG_RECOVERY 1,069
```

Workerがbindingであることを正しく特定し、Worker 11,043 → 11,799人、
生産 29,168 → 31,806t（+9%）、gap 3,100 → 1,069t へ縮小した。
**HOSO量産化していない**（VAP生産は6,4kt前後を維持、Ambitionの商品構成は不変）。

## 7. DS1 / DS2 regression

DS1（T25-32）: BAL 636.9 → 633.1M、JPQ 391.8 → 391.1M、VAP 356.7 → 357.0M、
CONSV 379.6 → 378.8M、MASS 変化なし。生産はいずれも±0.6%以内。

DS2（8seed × 5社）:

| 会社 | avg OP | avg 生産 | 資金不足T計 |
|------|-------|---------|------------|
| BAL | 1030.2 → 1012.4M | 654,420 → 649,906 | **0 → 1**（ds2-s4） |
| MASS | 929.8 → **881.2M**（−5.2%） | 685,723 → 673,960（−1.7%） | 0 → 0 |
| JPQ | 764.5 → 759.8M | 601,395 → 601,458 | 0 → 0 |
| CONSV | 740.7 → 740.8M | 558,196 → 558,977 | 1 → 1（ds2-s8、変化なし） |
| VAP | 646.7 → 644.2M | 515,235 → 512,951 | 0 → 0 |

## 8. minimumMarketPresenceRatio 監査（§14。値は変更していない）

3B-3は市場プレゼンス下限として `parameters.ts::minDomesticPurchaseRatioOfBase`（0.2）を
流用した。監査結果:

1. **floorは必要である。** 外すと、能力が一時的に極端に落ちた会社の新規提出が0になり、
   「生産能力不足を販売へ機械的に伝播させない」という既存の受入条件（situationDiagnosis F-1）に
   抵触する（3B-3実装中に実測で確認済み）。
2. **同じ意味の既存parameterは存在しない。** sales / commitment ドメインを走査した結果、
   `SalesParameters.minimumPriceCompetitiveness` / `minAskPriceRatioOfBase`、
   `CommercialCommitmentParameters.targetConversionFloor` / `minimumUsableConversion` /
   `productionExpectedConversionFloor`、`CommercialAmbitionParameters.minimumContributionUsdPerKg` /
   `minimumPressureForExpansion` はいずれも意味が異なり、
   「納品能力に対して最低限維持する新規提出の割合」に相当するものは無い。
3. **domainを跨いだ流用は正式仕様にすべきではない（tech debt）。**
   procurementの「最低確保比」とsalesの「市場プレゼンス下限」は意味が異なり、
   将来 `minDomesticPurchaseRatioOfBase` を調達都合で動かすと、意図せず提出量の下限が動く。
   **本Phaseでは値も参照先も変更していない。**
   別commitでの提案: `CommercialCommitmentParameters` へ
   `minimumMarketPresenceRatioOfDeliverable` を新設し、初期値を現行と完全同一の 0.2 として
   挙動を1ビットも変えずに参照先だけ移す（数値の再校正はその後の別判断）。

## 9. Reason codes

`GROWTH_ROUTE_NONE` / `GROWTH_ROUTE_PRODUCTION_CAPEX` / `GROWTH_ROUTE_WORKFORCE` /
`GROWTH_ROUTE_PROCUREMENT` / `GROWTH_ROUTE_LIQUIDITY` / `GROWTH_ROUTE_SALES_HIRING` /
`GROWTH_ROUTE_BACKLOG_RECOVERY`

1件の診断に §16 の全項目を記録（commercialAmbitionTons / deliverableCapacityTons /
deliverabilityGapTons / routedGrowthTons / workerCapacitySupportedTons /
workerRequirementForAmbition / currentWorkerHeadcount / workerGap / workerLimited /
productionGapTons / rawMaterialGapTons / liquidityBlocked / persistent / actionTaken /
salesHiringSuppressedByGrowthRoute、および bindingConstraint と actionNotTakenReason）。
`diagnostics.growthRouting` からも同じ評価を読める。

## 10. Stop Conditions

| id | 判定 | 実測 |
|----|------|------|
| A. VAPが32kt前後で固定され能力側が動かない | **部分的に該当** | 能力側は動いた（Worker +189人、生産 +4.4%、seed ds3-aでは +9%）。ただし32TではAmbitionが32.3ktのままで39ktへは戻らない |
| B. VAPを伸ばすためHOSO量産型になる | **なし** | VAP生産は6.5kt前後を維持。routedGrowthByProductは志の構成比のまま |
| C. MASS backlogが再び100kt超へ恒常化 | **なし** | 64,779 → 57,973t（さらに改善） |
| D. BALが再びLiquidity崩壊 | **軽微に該当** | DS3 BALは無傷（cash 549.8M、資金不足0）。DS2 ds2-s4で資金不足1Tが新規発生（8seed中1seed） |
| E. 全社が大量CAPEXへ収束 | **なし** | DS3 CAPEX累計は 84.8 / 91.8 / 82.1 / 82.4 / 53.0M と会社差が維持 |
| F. CONSVがMASS型になる | **なし** | CONSV backlog 17,570 → 14,310、overdue 1,132 → 220。LOW risk toleranceのまま |
| G. Sales Hiringだけが先行する | **なし** | LIQUIDITY routeでは採用を止める。他はSales Hiring側の既存ガードが機能 |
| H. DS1/DS2 regression | **一部該当** | DS1は±0.6%。DS2でMASS OP −5.2%、BAL 資金不足 0 → 1 |
| I. Vision / MARKET_WEAK等が先に成長を止める | **未確認** | VAPのAmbitionが32.3ktで頭打ちの理由は本Phaseでは切り分けていない |
| J. Scenario/Engine capacityが最終binding | **未確認** | 同上 |

## 11. 次のbinding constraint

1. **VAPのAmbitionが32kt台で頭打ちの理由（Stop Condition I/J の切り分け）【最優先】**:
   能力側は動くようになったが、Commercial Ambition自体が戻らない。
   `commercialAmbition.ts` の evidence（recentActualScaleTons / attainableProfitableTons /
   MARKET_WEAK / VISION_ON_TRACK）のどれが上限になっているのかを次に監査すべき。
2. **DS2 MASS OP −5.2% と BAL ds2-s4 の資金不足1T**: routingが投資タイミングを
   前倒しした副作用の可能性。Liquidity SSoTは通っているため崩壊ではないが要観察。
3. **minimumMarketPresenceRatio のdomain跨ぎ流用（tech debt）**: §8の別commit提案。
4. 固定製造費の不可逆性（3B-2 Stop Condition I、engine側課題・#04）。
