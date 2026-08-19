# SAI-EXEC-1 PRE-AUDIT — MASS / VAP Execution Bottleneck

**本書は監査のみ。実装は一切していない。**
本 PRE-AUDIT で production code に加えた変更は Vision 正式値（`1319e57`）だけであり、
それは別 commit として分離済み。Standard AI ロジック・Engine・Scenario・
opportunity share 0.35・MARKET_WEAK / VISION_ON_TRACK・Growth step・
Deliverability cap・Sales Capacity Engine・VAP CAPEX 価格・Worker 生産性・
raw material economics はいずれも**変更していない**。

| | |
|---|---|
| Standard AI HEAD | `1319e57`（SAI-VISION-1 正式採用） |
| 監査 branch | `audit/exec1`（= `1319e57` + `origin/feature/v2-dynamic-scenario-3`） |
| 評価 | DS3 8seed（ds3-a〜h）× 32Turn / 代表 seed = ds3-a |
| Vision | 本 PRE-AUDIT の正式値（BAL 60,000 / JPQ 50,000 / CONSV 45,000 / MASS 80,000 / VAP 17,000） |

---

## 0. 測定手法の訂正（先に読むこと）

本監査の途中で、**これまでの一時 harness が engine と同一の意思決定を再現していなかった**
ことが判明した。`generateStandardAiDecisionWithDiagnostics` を harness から直接呼ぶ場合、
engine（`simulation/engine.ts:339-369`）が渡している

1. `resolveStandardAiProfileForMode(companyId, config.standardAiProfileMode).params`
   （**既定は "ON"**。`DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE`）
2. `applyScenarioSalesCapacityOverride(SALES_PARAMETERS_V1, scenarioDefinition)`
3. `config.visionOverrides`
4. `scenarioDefinition.visionGrowthOverrides`

の4つを渡さないと別の意思決定になる。特に (1) を省くと MASS の T24 販売計画が
26,255t（誤）対 61,987t（engine 実値）と 2.4 倍ずれる。本書の数値はすべて
4つを渡して engine と bit 単位で一致することを確認した後に取り直したものである。

もう一点、**DS3 は `DS3_VISION_GROWTH_OVERRIDES.scaleMultiplier` を既定 Vision へ乗算する**
（MASS 1.25 / BAL 1.85 / JPQ 1.75 / VAP 2.9 / CONSV 1.8、
`scenario/definitions/dynamicScenario3Parameters.ts:246`）。
したがって DS3 上の実効 Q32 目標は `vision/defaults.ts` に書いた値そのものではない。
夜間 sensitivity の Case 0 / A1 も同じ経路で測っているため比較は等価だが、
「Vision を 60,000 にした」という表現と DS3 実効値（111,000）は別物である。

---

## B. MASS Execution Funnel

### B-1. DS3 8seed 平均（各段階、HOSO換算 t/四半期）

| 段階 | T8 | T16 | T20 | T24 | T28 | T32 | T32 の前段比 | 減少率 |
|------|---:|----:|----:|----:|----:|----:|---:|---:|
| ① Commercial Ambition | 20,282 | 25,134 | 38,850 | 56,309 | 58,710 | 66,835 | — | — |
| ② Submission Target | 17,596 | 16,485 | 27,021 | 51,869 | 55,608 | 63,006 | −3,829 | −5.7% |
| ③ Accepted Contracts | 17,596 | 16,485 | 26,696 | 50,612 | 54,546 | 63,006 | ±0 | **0.0%** |
| ④ Delivery Demand | 31,099 | 35,711 | 48,548 | 57,858 | 96,761 | 115,135 | +52,129 | （backlog 加算） |
| ⑤ Production Requirement | 35,032 | 39,929 | 57,999 | 70,222 | 111,696 | 132,494 | +17,359 | （在庫目標加算） |
| ⑥ Production Plan | 16,488 | 18,383 | 35,121 | 47,025 | 47,025 | 58,781 | −73,713 | **−55.6%** |
| ⑦ Actual Production | 15,229 | 18,233 | 32,077 | 39,080 | 42,107 | 52,334 | −6,447 | **−11.0%** |
| ⑧ Actual Delivery | 15,619 | 17,869 | 31,776 | 39,789 | 42,107 | 52,464 | +130 | +0.2% |
| Backlog（期末） | 15,480 | 17,842 | 17,158 | 18,269 | 54,654 | 62,670 | | |
| うち overdue | 1,746 | 5,660 | 519 | 0 | 10,253 | 18,360 | | |
| Fundable Raw（期首在庫） | 5,029 | 9,394 | 15,552 | 27,176 | 29,893 | 35,900 | | |
| **effFreezingPackaging** | 25,650 | 25,650 | 39,009 | **47,025** | **47,025** | **58,781** | | |

### B-2. 決定的な観測

**`Production Plan` は T24 以降、`totalEffectiveFreezingPackagingCapacity` と
1トンの誤差もなく一致する。**

| T | prodPlan（8seed平均） | effFreezingPackaging | 一致 |
|---|---:|---:|---|
| T24 | 47,025 | 47,025 | ✔ |
| T28 | 47,025 | 47,025 | ✔ |
| T32 | 58,781 | 58,781 | ✔ |

代表 seed ds3-a では T24〜T32 の全 turn で `prodPlan = 59,850 = effFreezing`（定数）。
同時点の line 能力合計は 67,973→78,233、commonProcessing は 63,270→72,675 であり、
**line でも commonProcessing でもなく凍結・包装能力が唯一の律速**である
（`standardAi/decision/production.ts:180-190` の `sharedCaps`）。

### B-3. ds3-a 全 Turn（T1–T32、抜粋列）

| T | ambition | submit | contracts | delivDemand | prodReq | prodPlan | effFreez | actualProd | sold | backlog | overdue | limiter | route |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| T1 | 16,380 | 18,200 | 17,943 | 21,555 | 26,674 | 16,673 | 25,650 | 16,288 | 16,033 | 5,510 | 0 | MARKET_WEAK | LIQUIDITY |
| T5 | 18,439 | 17,599 | — | 24,128 | 29,454 | 16,185 | 25,650 | 16,059 | 14,674 | 9,456 | 296 | STEP_LIMIT | LIQUIDITY |
| T8 | 20,282 | 17,596 | 17,596 | 28,391 | 32,243 | 16,456 | 25,650 | 15,224 | 15,619 | 12,772 | 0 | STEP_LIMIT | LIQUIDITY |
| T12 | 17,379 | 15,780 | — | 28,284 | 32,327 | 15,947 | 25,650 | 15,824 | 15,392 | 12,908 | 2,338 | OPPORTUNITY_CEILING | LIQUIDITY |
| T16 | 25,134 | 17,642 | 17,642 | 36,106 | 40,659 | 18,092 | 25,650 | 17,953 | 18,180 | 17,926 | 4,889 | STEP_LIMIT | BACKLOG |
| T18 | 37,443 | 39,561 | — | 63,715 | 69,531 | 33,650 | 34,200 | 29,195 | 30,067 | 27,239 | 3,071 | STEP_LIMIT | WORKFORCE |
| T20 | 43,260 | 26,684 | 26,290 | 50,464 | 59,888 | 38,225 | 42,750 | 37,621 | 37,034 | 14,892 | 0 | MARKET_WEAK | WORKFORCE |
| T22 | 53,340 | 26,131 | — | 28,366 | 37,368 | 37,368 | 51,300 | 35,238 | 30,215 | 0 | 0 | MARKET_WEAK | LIQUIDITY |
| T24 | 66,780 | 67,047 | 61,987 | 63,633 | 74,461 | **59,850** | **59,850** | 42,089 | 45,907 | 18,066 | 0 | VISION_ON_TRACK | LIQUIDITY |
| T26 | 66,780 | 66,776 | — | 89,124 | 106,990 | **59,850** | **59,850** | 51,761 | 52,941 | 36,183 | 0 | MARKET_WEAK | WORKFORCE |
| T28 | 66,780 | 66,776 | 62,525 | 107,498 | 126,262 | **59,850** | **59,850** | 53,541 | 53,541 | 53,957 | 6,809 | MARKET_WEAK | WORKFORCE |
| T30 | 69,774 | 51,357 | — | 114,186 | 132,959 | **59,850** | **59,850** | 53,767 | 53,199 | 60,987 | 22,946 | OPPORTUNITY_CEILING | BACKLOG |
| T32 | 66,780 | 70,480 | 70,480 | 120,723 | 140,023 | **59,850** | **59,850** | 53,634 | 53,634 | 67,089 | 17,761 | MARKET_WEAK | BACKLOG |

各段階の binding constraint（T32・ds3-a）:

- ①→②: Deliverability cap は **binding していない**（`deliverabilityCapTons` 76,702 > submit 70,480、`bindingDeliverabilityConstraint = NONE`）。
- ②→③: **binding なし**。提出量 70,480 が 100% 成約している（営業能力・市場需要のいずれも律速していない）。
- ③→④: backlog 繰越（前期末 50,242 のうち未納分）。
- ④→⑤: 通常在庫目標。
- ⑤→⑥: **凍結・包装能力 59,850**（唯一）。
- ⑥→⑦: 設備不足 5,865 ＋ 労務不足 2,364（工場別実行不能分。B-4）。
- ⑦→⑧: なし（完成品在庫 0、作った分はすべて出荷）。

### B-4. ⑥→⑦ の内訳（工場別、ds3-a T28）

| 工場 | equipmentUtilization | laborUtilization | productionShortfallRate |
|---|---:|---:|---:|
| MASS-F1（初期工場） | 0.807 | 1.00 | **0.000** |
| MASS-NEWF-CAPEX-2 | 0.935 | 1.00 | 0.166 |
| MASS-NEWF-CAPEX-4 | 0.835 | 1.00 | 0.131 |
| 会社計 | 0.857 | 1.00 | 0.092 |

計画は工場ごとの**名目**能力シェアで按分される
（`standardAi/decision/production.ts:147`
`const share = factoryObs.capacityByProduct[product] / capacityTotals[product]`）。
実行できなかった新工場ぶんを、余力のある F1（利用率 0.807）へ振り替える経路が無い。

---

## C. MASS 能力利用率の分解（66.8kt → 53.3kt）

### C-1. 「能力 66.8kt」が何を測っていたか

夜間監査の「生産能力 66,797」は `session.capacityByTurn` の
`min(hoso + pd + vap, commonProcessing)` である（`scripts/dynamicScenario3Benchmark.ts:293`）。
これは Standard AI の `computeBindingProductionCapacityTons`
（`standardAi/bindingCapacity.ts:18-23`）と同じ式であり、

```
min( Σ product line capacity, totalEffectiveCommonProcessingCapacity )
```

**凍結・包装能力（freezingPackaging）と冷凍保管能力（coldStorage）を含まない。**
一方、生産エンジン（`production/allocation.ts:157-170`）は
`commonCapacityLimited → freezingPackagingLimited → productCapacityLimited`
の順に **工場ごとの freezingPackaging 予算**で切る。
したがって「能力 66.8kt」は**実行可能能力ではなく、上限の一部だけを見た値**である。

本監査で測り直した実効上限（DS3 8seed 平均・T32）:

| 指標 | 値 | 出所 |
|---|---:|---|
| Σ line capacity | 78,233 | capacityByTurn |
| commonProcessing（実効） | 63,270〜72,675 | observation |
| **freezingPackaging（実効）** | **58,781** | observation |
| Production Plan | 58,781 | 意思決定 |
| Actual Production | 52,334 | engine |

### C-2. 12 要因への配分（T32・8seed平均、66,797 → 52,334 の 14,463t）

**基準値の注記**: 66,797 は夜間監査 Case 0 の「生産能力」（= min(Σline, commonProcessing)）、
52,334 は本監査 HEAD の実生産である。本 Vision 正式値での同指標は 69,148 であり、
基準を揃えるなら差は 16,814t になる。指示が「66.8kt → 53.3kt」を対象としているため
以下は 66,797 を基準に置いた配分であり、差の 2,351t は Vision 更新による能力増ぶんである。

| # | 候補要因 | 寄与 t | 判定・根拠 |
|---|---|---:|---|
| 1 | 原料不足 | **0** | `rawMaterialShortfall = 0`（T28/T32 とも）。期首原料 35,900t + 当期調達で計画を満たしている |
| 2 | 原料調達の資金不足 | 0 | T28/T32 とも cash 329M / 624M・借入残 0。`fundableRawMaterial` は binding していない |
| 3 | Worker 不足 | 2,364 | `laborShortfall`。ただし laborUtilization = 1.00 であり「人が足りない」ではなく「これ以上残業できない」状態 |
| 4 | Worker 採用の遅れ | （3に含む） | WORKFORCE route は T25 以降ほぼ毎 turn 発火しており、採用は継続している |
| 5 | 商品別ライン能力不足 | 0 | Σ line 78,233 > plan 58,781。product tier で切られていない |
| 6 | **共通前処理能力不足** | 0 | commonProcessing 63,270〜72,675 > plan 58,781。**binding していない** |
| 7 | **凍結・包装能力不足** | **8,016** | 66,797 −58,781。**単独最大の要因**。Standard AI は当該能力を認識も拡張もできない（C-3） |
| 8 | 工場ランプアップ未了 | （9に含む） | 新工場の `rampMultipliers [0.5, 0.75, 1.0]` は effective capacity 側に既に織込済 |
| 9 | 工場間配分の硬直（名目シェア按分） | 6,447 | plan 58,781 → actual 52,334。F1 が 0.807 で遊ぶ一方、新工場が shortfall 0.13〜0.17 |
| 10 | 完成品在庫の滞留 | 0 | T28/T32 とも finishedGoods = 0 |
| 11 | 品質・廃棄損失 | 0 | `processingLossRate = 0`（全工場・T24/28/32） |
| 12 | CAPEX 承認の遅れ | （C-3） | MASS は 8seed で CAPEX 却下 0 件。ただし同時進行案件上限 3 件が全社の実質的な上限になっている |

合計 8,016 + 6,447 = 14,463t（＝差分と一致）。3 の労務不足 2,364t は 9 の内数。

### C-3. 構造的原因（Standard AI 側）

`standardAi/decision/capex.ts:95` の `STANDARD_AI_PROPOSABLE_CAPEX_TYPES` は

```
hosoLineExpansion / pdLineExpansion / vapLineExpansion /
commonProcessingExpansion / newFactoryConstruction /
pdMechanization / qualityControlEquipment
```

の 7 種であり、**`freezingPackagingExpansion` と `coldStorageExpansion` を含まない**
（同ファイル冒頭に「ここに無い種別は Standard AI からは構造的に一度も提案されない」と明記）。

一方、新工場テンプレート（`capex/parameters.ts:312-317`）の能力は

| 次元 | 新工場1棟あたり |
|---|---:|
| commonProcessing | 22,000 |
| hoso + pd + vap | 24,000 |
| **freezingPackaging** | **20,000** |

であり、**freezingPackaging が構造的に最小**。したがって
「工場を建てる → 凍結・包装が最初に埋まる → 他は拡張できるが凍結・包装だけ拡張できない」
という一方通行になる。MASS が ds3-a で 3 工場に到達した T24 以降、
`effFreezing = 25,650 + 2 × 17,100 = 59,850` に固定され、9 turn 連続で
生産計画がこの値に張り付いたのはこの帰結である。

---

## D. MASS の販売ギャップ（生産 53kt vs 販売 33kt）

**HEAD ではこのギャップは再現しない。**

DS3 8seed・T32 の実測:

| 指標 | 値 |
|---|---:|
| Actual Production | 52,334 |
| Actual Delivery（`companySummaries.fulfilledQuantity`） | 52,464 |
| 完成品在庫（期末） | 0 |
| 新規成約（`salesRecord.newContracts`） | 63,006 |
| 提出量（`finalSubmissionTargetTons`） | 63,006 |

生産 ≒ 出荷であり、作ったものは 1 トンも売れ残っていない。
契約は提出量の 100% が成立しており、**市場側でも営業能力側でも失注していない**。
ご指摘の「販売 33kt」は本 harness のどの指標とも一致しなかった。
夜間監査（`SAI_VISION1_SENSITIVITY.md`）の "sales" 列は `allocatedSalesTons`
＝新規成約であり、同表の Case 0 MASS 33,155 は本監査で測った新規成約 63,006 と
大きく食い違う。§0 の測定手法訂正の影響を受けている可能性が高いため、
**「販売ギャップ」は現時点では成立が確認できない事象として扱うべき**である。

実在するのは販売ギャップではなく、**成約（63,006）と出荷（52,464）の 10,542t の差**であり、
これは C で分解したとおり全額が生産側（凍結・包装能力＋工場間配分）で説明される。

---

## E. MASS の backlog パラドックス

T32 で backlog 62,670・overdue 18,360 が残る一方、SAI-GROW-3B-3 の
Deliverability cap は **一度も binding していない**（ds3-a の T24〜T29・T32 で
`bindingDeliverabilityConstraint = NONE / PRODUCTION`、cap 値 66,776〜76,702 >
提出量）。3B-3 のロジックが緩んだのではなく、**cap の入力が過大**である。

原因は C-1 と同一。`DeliverableCommitmentState` の

- `bindingProductionCapacityTons`
- `nearTermBindingProductionCapacityTons`

はいずれも `computeBindingProductionCapacityTons`
（= min(Σline, commonProcessing)）で作られる。ds3-a T32 では

| 項目 | 値 |
|---|---:|
| `deliverableCapacityNearTermTons` | 72,675 |
| 実際の生産計画上限（凍結・包装） | 59,850 |
| 実際の生産量 | 53,634 |

であり、**deliverable 判定が実行可能量より 35.5% 過大**。
提出量はこの過大な headroom の下で 70,480t まで通り、成約も 70,480t 成立し、
実際に納品できたのは 53,634t なので、毎期 16,846t が backlog へ積み上がる。

したがって切り分けは:

| 事象 | 帰属 |
|---|---|
| Deliverability cap が緩い | **3B-3 のロジックの問題ではない**。入力（binding capacity 定義）の問題 |
| binding capacity が凍結・包装を無視 | **Standard AI（#05）**。`bindingCapacity.ts:22` |
| 凍結・包装を拡張する手段が無い | **Standard AI（#05）**。`capex.ts:95` の提案可能種別 |
| 新工場の凍結・包装が他次元より小さい | **Engine（#04）**。`capex/parameters.ts:316` |
| 工場間で実行不能分を振り替えない | **Engine（#04）＋ Standard AI**。`allocation.ts` は工場別予算、`production.ts:147` は名目シェア按分 |

overdue が T28 以降にだけ出るのも整合する（T24 までは backlog が納期内に収まる規模）。

---

## F. VAP Execution Funnel

### F-1. ds3-a 全 Turn（抜粋）

| T | ambition | submit | 生産計画 | 実生産 | 出荷 | capVap | effCommon | effFreez | 期首原料 | workerSupport | backlog | overdue | cash | debt | route |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| T1 | 12,800 | 14,222 | 13,680 | 11,219 | 11,219 | 1,710 | 25,650 | 25,650 | 2,500 | 12,800 | 2,514 | 0 | 19M | 43.5M | LIQUIDITY |
| T5 | 13,696 | 14,668 | 13,680 | 11,404 | 11,404 | 1,710 | 25,650 | 25,650 | 3,632 | 13,696 | 9,881 | 3,053 | **0M** | 24.9M | LIQUIDITY |
| T8 | 13,696 | 14,438 | 12,851 | 7,745 | 7,745 | 1,710 | 25,650 | 25,650 | 3,512 | 13,644 | 11,851 | 4,782 | 19M | 38.2M | LIQUIDITY |
| T10 | 14,911 | 7,114 | 13,306 | 6,792 | 6,792 | 1,710 | 25,650 | 25,650 | 2,975 | 13,672 | 14,434 | 8,635 | 13M | 27.8M | LIQUIDITY |
| T13 | 14,325 | 14,716 | 13,626 | 12,850 | 12,873 | 1,710 | 25,650 | 25,650 | 5,431 | 12,692 | 10,836 | 2,604 | 45M | 55.0M | LIQUIDITY |
| T16 | 15,070 | 10,377 | 11,619 | 11,526 | 11,326 | 1,710 | 25,650 | 25,650 | 8,797 | 12,705 | 11,091 | 5,255 | 70M | 17.4M | BACKLOG |
| T18 | 15,076 | 12,896 | 12,491 | 12,390 | 12,430 | 1,710 | 25,650 | 25,650 | 8,262 | 12,705 | 11,205 | 4,051 | 89M | 4.2M | BACKLOG |
| T22 | 14,901 | 15,803 | 13,138 | 13,047 | 13,288 | 4,489 | 25,650 | 25,650 | 8,222 | 12,734 | 13,347 | 4,755 | 85M | 0M | WORKFORCE |
| T24 | 31,186 | 32,914 | 29,583 | 25,254 | 25,254 | 7,054 | 39,758 | 38,475 | 13,056 | 17,829 | 18,795 | 1,837 | 64M | 44.2M | LIQUIDITY |
| T28 | 35,574 | 36,952 | 32,866 | 30,091 | 31,389 | 7,054 | 44,460 | 42,750 | 19,130 | 29,323 | 17,174 | 0 | 241M | 35.1M | WORKFORCE |
| T32 | 35,747 | 29,137 | 35,012 | 30,787 | 30,006 | 7,054 | 44,460 | 42,750 | 23,090 | 31,134 | 32,443 | 13,831 | 407M | 0M | BACKLOG |

### F-2. T1–T18 が LIQUIDITY route である根本原因

T1〜T15 は毎 turn LIQUIDITY、T16〜T21 は BACKLOG_RECOVERY。設備は
**T22 まで 1 ミリも増えない**（capVap 1,710・effCommon 25,650・effFreez 25,650 が固定）。

原因は資金であり、しかも**成長投資の資金ではなく運転資金**である:

| T | 期首現金 | 借入残 | 期首原料 | Worker が捌ける量 | 実際の binding capacity |
|---|---:|---:|---:|---:|---:|
| T1 | 19M | 43.5M | 2,500 | 12,800 | **2,500**（原料） |
| T5 | 0M | 24.9M | 3,632 | 13,696 | 9,911 |
| T6 | 14M | 36.7M | 3,876 | 13,696 | **3,876**（原料） |
| T8 | 19M | 38.2M | 3,512 | 13,644 | 4,741 |
| T10 | 13M | 27.8M | 2,975 | 13,672 | 6,290 |

`sustainableDeliverableCapacityTons` は多くの turn で `fundableRawMaterialTons`
（＝期首原料 ＋ 現金×`domesticPurchaseCashAllocationRatio` ÷ 国内価格 ＋ 実現可能借入）
に一致する。つまり **VAP は「作れないから小さい」のではなく「原料を買う金が無いから作れない」**。
現金が 0〜20M、既存借入が 25〜55M という状態が T13 まで続き、
`realisticallyAvailableBorrowingUsd` の `policyHeadroom = policyLimit − existingLoanBalance`
がほぼ枯れているため、追加借入もできない。

T13 以降に現金が回復（45M→70M→89M）すると route は BACKLOG_RECOVERY へ移り、
T22 に初めて VAP ライン増設が効いて capVap 1,710→4,489→7,054 と伸び、
生産は 13,047 → 30,787（+136%）になる。**構造的に不可能なのではなく、
序盤 21 四半期を運転資金の谷で失っている**。

### F-3. VAP 社の商品構成（T32・8seed平均）

| 商品 | 生産量 | 構成比 |
|---|---:|---:|
| HOSO | 12,175 | 39.7% |
| PD | 11,984 | 39.1% |
| VAP | 6,477 | 21.1% |
| 計 | 30,636 | 100% |

Vision は `emphasisProducts: ["vap"]`・`desiredProductEvolution: "VAP_VALUE"` だが、
実際には HOSO/PD が 8 割を占める。VAP 能力は T32 でも 7,054t/期しかない。

---

## I. DS2 の資金不足（MASS ds2-s5 / s6、CONSV ds2-s8）

**HEAD では `cashShortfall` も現金マイナスも 1 件も発生しない。**

DS2 8seed（ds2-full-a, ds2-full-b, ds2-s3〜s8）× 32Turn × 5社 = 1,280 観測点で、
`financialResults.cashShortfall = true` の四半期は **0 件**、
期末現金 < 0 の四半期も **0 件**。

指摘された 3 ケースの実測:

| seed | 会社 | 32Turn 中の最小現金 | 発生 Turn | T32 現金 | T32 借入 | T32 生産 |
|---|---|---:|---|---:|---:|---:|
| ds2-s5 | MASS | 2.39M | **T6** | 334M | 0M | 28,179 |
| ds2-s6 | MASS | 0.25M | **T6** | 422M | 0M | 27,946 |
| ds2-s8 | CONSV | 4.67M | **T6** | 552M | 0M | 27,020 |
| （参考）ds2-s5 | CONSV | 7.90M | T6 | 565M | 0M | 27,277 |
| （参考）ds2-s8 | JPQ | 0.00M | T6 | 506M | 0M | 28,683 |

**分類: timing（序盤の運転資本の谷）であり、real defect ではない。**

根拠:

1. 谷は 3 ケースとも **T5–T6 に集中**しており、seed・会社を問わず同じ位置に出る。
   seed 固有・会社固有の事象ではない。
2. 谷の後は単調に回復し、T32 で 334M〜565M。破綻も操業縮小も起きていない。
3. 32Turn を通じて借入残が 0 のまま。**そもそも借りずに耐えている**。
   資金調達が失敗しているのではなく、資金調達を必要としていない。
4. `cashShortfall` フラグ（＝engine が資金不足と判定した状態）は一度も立たない。

ただし「最小現金 0.00〜0.25M」は最低現金準備水準に張り付いていることを意味し、
DS2 のパラメータでは序盤の運転資本が構造的にギリギリであることは事実である。
これは**耐えられているが余裕は無い**状態であり、シナリオ側の初期現金・
支払サイトの校正課題として #04 へ渡すのが妥当（欠陥ではない）。

なお、この結果は SAI-GROW-3B-1 / 3B-1.1 / 3B-2（Liquidity SSoT・
Growth Financing・Fundable Operations）以降のものである。指摘時点の DS2 実測と
食い違う場合、その差は当該3 Phase の効果である可能性が高い。

---

## J. 所有区分

| # | 事象 | 具体箇所 | 所有 | 理由 |
|---|---|---|---|---|
| 1 | binding capacity が凍結・包装／冷凍保管を無視 | `standardAi/bindingCapacity.ts:22` | **#05 Standard AI** | 判断側の能力認識式。engine は既に工場別に freezing で切っている |
| 2 | `freezingPackagingExpansion` / `coldStorageExpansion` を提案できない | `standardAi/decision/capex.ts:95` | **#05 Standard AI** | 提案可能種別の定義そのもの |
| 3 | Deliverability cap の headroom が実行可能量より 35% 過大 | `decision/deliverableCommitment.ts`（入力が 1 に依存） | **#05 Standard AI** | 1 を直せば連動して解消する。3B-3 の式自体は変更不要 |
| 4 | 工場間で実行不能分を振り替えない（名目シェア按分） | `decision/production.ts:147` | **Shared** | 計画側は #05、実行側の tier 適用は `production/allocation.ts:157-170` で #04 |
| 5 | 新工場の freezingPackaging(20,000) < commonProcessing(22,000) < lines(24,000) | `capex/parameters.ts:312-317` | **#04 Engine** | 工場テンプレートの能力校正 |
| 6 | 同時進行 CAPEX 案件上限 3 件 | `capex/parameters.ts:354` `maxConcurrentActiveProjectsPerCompany` | **#04 Engine** | DS3 8seed の CAPEX 却下 **全 125 件がこの理由のみ**。資金・スペース起因の却下は 0 件 |
| 7 | VAP 社の序盤 21 四半期の運転資金の谷 | シナリオ初期現金・初期借入 | **#04 Scenario-Parameter** | Standard AI 側の判断は既に LIQUIDITY を正しく検出している |
| 8 | DS3 の `scaleMultiplier` が既定 Vision に乗算される | `dynamicScenario3Parameters.ts:246` | **#04 Scenario-Parameter** | Vision 正式値と DS3 実効値が別物になる。仕様として妥当だが要明示 |
| 9 | DS2 序盤 T5–T6 の現金トラフ | DS2 初期条件 | **#04 Scenario-Parameter** | 欠陥ではない。余裕度の校正課題 |
| 10 | VAP CAPEX 単価 24,000 USD/t | `capex/parameters.ts:184` | **#04 Engine（ただし非 binding）** | 別紙 `SAI_VAP_CAPEX_ECONOMICS_AUDIT.md` 参照。価格を半分にしても結果が動かない |

---

---

## ★ Stop Condition（実装せず #05 の判断を仰ぐ）

**Vision 正式採用 `1319e57` は、既存の設計契約テスト 3 件を破っている。**
いずれも指示で変更禁止とされた領域（Scenario parameters / Commercial Ambition /
Deliverability cap）に触れなければ直せないため、**勝手に直さず報告する**。
テストは赤のまま残してある（緩めていない）。

### SC-1. DS3 の `scaleMultiplier` と二重適用になる（最重要）

`DS3-11: Vision 成長上書きは会社別に異なり、固定トン数目標ではなく倍率で与えられている`
（`scenario/__tests__/dynamicScenario3.test.ts:174`）が失敗する。

DS3 の実効 Q32 目標 = `既定Vision × DS3_VISION_GROWTH_OVERRIDES.scaleMultiplier`:

| 会社 | 旧既定 | 倍率 | 旧実効 | §2 レンジ | 新既定 | **新実効** | 判定 |
|---|---:|---:|---:|---|---:|---:|---|
| MASS | 80,000 | 1.25 | 100,000 | 90,000〜100,000 | 80,000 | 100,000 | ✔ |
| BAL | 34,000 | 1.85 | 62,900 | 55,000〜65,000 | 60,000 | **111,000** | ✘ |
| JPQ | 30,000 | 1.75 | 52,500 | 45,000〜55,000 | 50,000 | **87,500** | ✘ |
| CONSV | 27,000 | 1.80 | 48,600 | 45,000〜50,000 | 45,000 | **81,000** | ✘ |
| VAP | 17,000 | 2.90 | 49,300 | 45,000〜55,000 | 17,000 | 49,300 | ✔ |

**DS3 の倍率は、旧既定 Vision に掛けたときに #05 自身の §2 レンジへ収まるよう
校正されていた。** 推奨値 60,000 / 50,000 / 45,000 は、DS3 上では倍率によって
**既に実現されていた水準とほぼ同じ**（62,900 / 52,500 / 48,600）である。
これを既定側へも書くと二重適用になり、実効目標がレンジの 1.7〜1.8 倍になる。

なお夜間 sensitivity の Case A1 も同じ経路（既定を差し替え、倍率はそのまま）で
測っているため、本 commit が A1 を再現するという検証結果は正しい。
**再現性は正しいが、「BAL の Vision は 60,000 になった」という解釈は DS3 上では成り立たない。**

選択肢（いずれも #05 の決定事項）:

| 案 | 内容 | 影響 |
|---|---|---|
| (a) | 既定は新値のまま、DS3 の `scaleMultiplier` を 1.0 付近へ下げる | Scenario parameter 変更（今回禁止） |
| (b) | 既定は旧値へ戻し、DS3 は倍率だけで運用する | Vision 正式採用の撤回 |
| (c) | 既定は新値のまま、§2 レンジ（DS3-11 の bands）を引き上げる | 仕様変更 |
| (d) | 既定は新値、DS3 の倍率を撤廃し Vision を唯一の SSoT にする | Scenario 設計変更 |

### SC-2. 既定 Vision 合計が Q32 需要の 94.5% になる

`VISION-3`（`vision/__tests__/visionStrategicGrowth.test.ts:138`）の固定値が
188,000 → **252,000** へ変わる。Q32 TRUE 需要 266,642t に対し **94.5%**。

`vision/defaults.ts` 冒頭の校正方針は、当初案（合計 250,000〜270,000）を
**「5社が世界の対ベトナム需要を100%取り切る」形になり、strategic gap が全社で
恒常的に最大へ張り付いて Vision 間の差が判断へ出なくなる**という理由で明示的に
却下し、4/7 へ縮尺して 148,000 にした経緯がある。
今回の採用はその当初案の水準へ戻ることを意味する。

本監査では固定値を 252,000 へ更新し、警告コメントを残した
（`assert.ok(total < 266_642)` は依然成立するが余裕は 5.5% しかない）。
**この方針転換が意図されたものかどうかは #05 の判断事項。**

### SC-3. baseline シナリオで完成品在庫が終盤に発散する

`CCI-1b: 完成品在庫が終盤に単調増加し続けない`
（`vision/__tests__/commercialCommitmentIntegration.test.ts:92`）が失敗する。
**DS3 ではなく `scenarioId: "baseline"`** での実測であり、DS3 倍率とは無関係に
**Vision 引き上げ単独で起きる**。

5社合計の完成品在庫（T20 → T24 → T28 → T32）:

```
17,919 → 27,039 → 38,564 → 47,692     （各期 +15% 以上で単調増加）
```

同ファイルの `CCI-8: 既定パラメータ（perMarket）では、営業能力SSoT化後も
転換率がほぼ100%のまま` も JPQ で失敗する（提出→成約の転換率が落ちる）。

MASS の funnel（本書 B/D）では完成品在庫は 0 であり在庫は溜まっていない。
baseline シナリオでは市場が DS3 ほど広くないため、
**引き上げた志のぶんだけ提出量が増え、成約されない／売れ残る**方向に出ている。
これは Deliverability cap（3B-3）が緩んだのではなく、
Commercial Ambition の入力（Vision）が市場規模に対して大きすぎることの帰結である。

対処は Vision 水準の再考（SC-1/SC-2 と同じ判断）か、
baseline シナリオの市場規模の見直し（Scenario parameter・今回禁止）のいずれか。

### 現在のテスト状態

```
claude/nifty-faraday-q3y7gs（DS3 未merge・本監査 commit 適用後の実測）
  npm test → 3737 tests / pass 3735 / fail 2
    ・CCI-1b  … SC-3。未修正（赤のまま）
    ・CCI-8   … SC-3。未修正（赤のまま）
  ※ DS3-11 は DS3 の test file が存在しないため、このブランチでは走らない。

audit/exec1（= 上記 + origin/feature/v2-dynamic-scenario-3）
  Vision commit 1319e57 直後の実測 → 3755 tests / pass 3750 / fail 5
    ・GROW3A-11 … 正式変更に合わせて固定値を更新済み → pass
    ・VISION-3  … 同上（警告コメント付き）         → pass
    ・DS3-11    … SC-1。未修正（赤のまま）
    ・CCI-1b    … SC-3。未修正（赤のまま）
    ・CCI-8     … SC-3。未修正（赤のまま）
  固定値2件の更新後に残る恒常的な失敗は 3 件。

型チェック npx tsc --noEmit -p . → exit 0 / eslint → exit 0
```

---

## 変更禁止事項の遵守

本 PRE-AUDIT で **変更していない**もの（すべて確認済み）:

MASS Vision / VAP Vision / opportunity share 0.35 / MARKET_WEAK / VISION_ON_TRACK /
Growth step multiplier / Deliverability cap / Sales Capacity Engine /
Scenario parameters / VAP CAPEX price / Worker productivity / raw material economics。

VAP CAPEX 価格の 75% / 50% は**プロセス内の shadow 実行のみ**で、
`capex/parameters.ts` は変更していない。
