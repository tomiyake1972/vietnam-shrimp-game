# SAI-COMMIT-1 PRE-AUDIT — Commercial Commitment & Deliverability Discipline after CAP-1

**監査のみ。Commercial Commitment / Vision / Scenario / opportunity share の production code は 1 行も変更していない。**

| | |
|---|---|
| base | `feature/v2-sai-cap-1 @ 96f54d1` |
| branch | `audit/v2-sai-commit-1` |
| 測定 | DS3 8seed × 32Turn / DS1 4seed / DS2 4seed、engine 直接実行 |
| backlog 定義 | SAI-BKL-1（`e82ca34`）canonical のみ |
| harness 一致 | **DS3 1280/1280・DS1 640/640・DS2 640/640 で engine と bit 一致（不一致 0）** |

---

## 0. 結論

**Commercial Commitment は「成長を不当に止めている」のではなく、「物理的に作れない量を
受けすぎないための妥当な規律」として機能している。** 反実仮想で規律を外すと、
生産はほぼ動かず overdue だけが 5〜6 倍に膨らむ。

| MASS（4seed・T32） | submitted | accepted | production | delivery | backlog | overdue | healthy forward |
|---|---:|---:|---:|---:|---:|---:|---:|
| **C0 現行** | 55,619 | 55,619 | **56,246** | **55,031** | 54,822 | **18,769** | 36,053 |
| C1 Commitment ceiling 解放 | 59,439 | 59,439 | 52,692 (**−6.3%**) | 53,670 (−2.5%) | 60,691 (+10.7%) | 20,434 (+8.9%) | 40,257 |
| C2 ＋Deliverability 解放 | 68,098 | 68,098 | 56,568 (**+0.6%**) | 56,581 (+2.8%) | 168,261 (**+207%**) | 110,357 (**+488%**) | 57,904 |
| C3 ＋労働十分 | 68,786 | 68,786 | 55,719 (**−0.9%**) | 55,719 (+1.2%) | 180,815 (**+230%**) | 118,421 (**+531%**) | 62,394 |

**Stop Condition #3「Commitment 緩和で backlog だけ増える」に明確に該当する。**
→ **Option A（Commercial Commitment 現行維持）を推奨。実装 Phase へは進まない。**

副次の重要発見: **C3（労働効率 10 倍）でも生産が伸びない**（55,719、C0 比 −0.9%）。
CAP-1 後の MASS の残る律速は Commercial でも労働でもなく、生産の実行段階側にある（§13）。

---

## 1. 測定条件と harness 一致確認

engine（`createSimulationSession` → `advanceSimulationTurn`）を直接実行。
診断取得のために `generateStandardAiDecisionWithDiagnostics` を並行して呼ぶ箇所は、
SAI-EXEC-1 で確定した 4 要素を engine と同一に渡している。

1. `resolveStandardAiProfileForMode(companyId, config.standardAiProfileMode).params`
2. `applyScenarioSalesCapacityOverride(SALES_PARAMETERS_V1, scenarioDefinition)`
3. `config.visionOverrides`
4. `scenarioDefinition.visionGrowthOverrides`

**全 turn・全社で engine が実際に採用した販売計画と突き合わせ、
DS3 1280/1280・DS1 640/640・DS2 640/640 が bit 一致**（不一致 0）。

### backlog 定義（SAI-BKL-1 canonical のみ使用）

```
期末値   Total Outstanding = CompanyQuarterSummary.outstandingQuantity
         Overdue           = CompanyQuarterSummary.overdueQuantity
         Healthy Forward   = outstanding − overdue
AI 判断時 DeliverableCommitmentState.overdueBacklogTons（= ledger 由来・turn 開始時）
```

期末 summary と AI の turn 開始時 observation は 1Q ずれるため、本書では**同じ列に混ぜていない**。

---

## 2. Commitment の exact limiter formula

`app/lib/v2/companyLab/vision/commercialCommitment.ts:206-233`

```
expectedConversionRatio = 履歴なし → targetConversionCeiling(0.9)
                          履歴あり → clamp(observed·λ + targetMid·(1−λ), minimumUsable, 1)

conversionAdjustedTons  = ambitionTons / expectedConversionRatio
stretchLimitTons        = ambitionTons × maximumStretchOverAmbition (1.25)
opportunityTons         = attainableProfitableTons × realisticShareOfOpportunity (0.5)
salesCapacityTons       = 営業組織が捌ける案件量（観測できなければ null）

submissionTarget = conversionAdjustedTons
   if > stretchLimitTons      → stretchLimitTons,   limiter = STRETCH_LIMIT
   if > opportunityTons       → opportunityTons,    limiter = MARKET_OPPORTUNITY
   if > salesCapacityTons     → salesCapacityTons,  limiter = SALES_CAPACITY
   （どれも効かなければ RECENT_CONVERSION / NONE）
```

その後 `policy.ts:598-616` で 2 段の上書きが入る。

```
applyDeliverabilityCap = crisisState === "NORMAL" && deliverableCommitment.applied
  → submissionTargetTons = deliverableCommitment.finalSubmissionTargetTons, limiter = "DELIVERABILITY"
applyCrisisGateToCommercialCommitment(...)   → 危機時のみ縮小、limiter = CRISIS 系
```

**注意（測定上の落とし穴）**: `diagnostics.commercialCommitment` は
**Deliverability cap と Crisis Gate 適用後**の状態である。cap 適用前の値は
`DeliverableCommitmentState.commitmentBeforeDeliverabilityTons` にある。
本書の `commitBefore` 列は後者を使用している。

---

## 3. MASS Commercial Funnel（DS3 8seed 平均）

| 段階 | T8 | T16 | T20 | T24 | T28 | T32 |
|---|---:|---:|---:|---:|---:|---:|
| Commercial Ambition | 20,282 | 25,134 | 38,850 | 54,334 | 55,540 | 66,127 |
| Ambition limiter | STEP_LIMIT | STEP_LIMIT | MARKET_WEAK | STEP_LIMIT | STEP_LIMIT | MARKET_WEAK |
| commitment **before** deliverability | 21,406 | 26,526 | 27,023 | 57,521 | 58,617 | **69,791** |
| expectedConversionRatio | 0.95 | 0.95 | 0.93 | 0.94 | 0.95 | 0.95 |
| cap: conversionAdjusted | 21,406 | 26,526 | 41,746 | 57,521 | 58,617 | 69,791 |
| cap: stretchLimit | 25,353 | 31,417 | 48,563 | 67,917 | 69,425 | 82,659 |
| cap: opportunity | 54,869 | 69,799 | **27,023** | 88,445 | 99,800 | 91,612 |
| cap: salesCapacity | 51,323 | 60,001 | 73,251 | 84,078 | 84,078 | 90,025 |
| **commitment limiter（最終）** | DELIVERABILITY | DELIVERABILITY | MARKET_OPPORTUNITY | DELIVERABILITY | DELIVERABILITY | DELIVERABILITY |
| deliverabilityCapTons | 17,596 | 16,491 | 45,318 | 50,510 | 51,887 | 57,779 |
| deliverableCapacityNearTerm | 16,673 | 20,093 | 42,216 | 47,709 | 49,163 | 64,317 |
| bindingDeliverabilityConstraint | PRODUCTION | BACKLOG | NONE | PRODUCTION | PRODUCTION | BACKLOG |
| cap 適用率（seed 比） | 1.00 | 1.00 | 0.00 | 1.00 | 0.88 | 0.63 |
| **finalSubmissionTarget** | 17,596 | 16,491 | 27,023 | 50,510 | 51,885 | **56,594** |
| accepted contracts | 17,596 | 16,491 | 26,672 | 49,744 | 51,323 | 54,687 |
| acceptance ratio | 1.00 | 1.00 | 0.99 | 0.98 | 0.99 | **0.97** |
| physical capacity | 16,673 | 20,093 | 42,216 | 47,709 | 49,163 | **64,317** |
| physical binding pool | PRODUCT_LINE | PRODUCT_LINE | FREEZING | FREEZING | FREEZING | FREEZING |
| worker-supported capacity | 18,944 | 18,698 | 23,436 | 34,215 | 48,756 | **55,147** |
| production plan | 16,488 | 18,402 | 35,198 | 47,709 | 47,784 | 60,235 |
| **actual production** | 15,242 | 18,252 | 32,138 | 41,870 | 44,736 | **54,746** |
| actual delivery | 15,632 | 17,871 | 31,763 | 42,559 | 44,717 | 54,020 |
| ledger Total Outstanding | 15,516 | 17,843 | 17,945 | 14,946 | 37,142 | 54,766 |
| ledger Overdue | 1,750 | 5,656 | 521 | 0 | 2,446 | 18,430 |
| ledger Healthy Forward | 13,765 | 12,187 | 17,424 | 14,946 | 34,696 | 36,336 |
| backlog coverage (Q) | 1.03 | 1.07 | 0.70 | 0.40 | 0.83 | **1.10** |
| overdue coverage (Q) | 0.12 | 0.34 | 0.02 | 0.00 | 0.05 | **0.37** |

### §7 A/B/C 判定（T24 / T28 / T32）

| turn | commitment before cap | final submission | physical | worker-supported | production | 判定 |
|---|---:|---:|---:|---:|---:|---|
| T24 | 57,521 | 50,510 | 47,709 | 34,215 | 41,870 | **B寄り**（submission ≈ physical。実生産は worker と実行段階で下回る） |
| T28 | 58,617 | 51,885 | 49,163 | 48,756 | 44,736 | **B**（submission ≈ physical。生産は worker 近傍） |
| T32 | **69,791** | **56,594** | 64,317 | 55,147 | 54,746 | **B**（cap 前は physical 超だが、cap 後は production とほぼ一致） |

**A（Commitment が 56〜66kt 未満で止めている）ではない。**
cap 前の commitment は 69,791 で physical 64,317 を **上回っている**。
**C（commitment が physical を大きく超え backlog を積む）でもない。**
Deliverability cap が 69,791 → 56,594（−18.9%）へ抑え、実生産 54,746 とほぼ一致させている。

→ **判定 B: Commitment は十分高い。止めているのは physical / 実行段階側。**

差の定量（T32・8seed）

```
finalSubmission 56,594 − accepted 54,687 =  1,907（市場・営業側の取りこぼし 3%）
accepted        54,687 − production 54,746 = −59（ほぼ一致）
production      54,746 − delivery   54,020 =   726（在庫繰り）
physical        64,317 − production 54,746 = 9,571 ← ここが未解決の損失
```

---

## 4. 他社の Commercial Funnel（DS3 8seed・T32）

| 会社 | ambition | ambLimiter | commitBefore | commitAfter | commitLimiter | cap適用率 | submit | accepted | 受入率 | physical | pool | workerSup | production | delivery | outstanding | overdue | healthyFwd | bkQ | ovdQ |
|---|---:|---|---:|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **BAL** | 59,457 | OPPORTUNITY_CEILING | 60,928 | 60,928 | SALES_CAPACITY | 0.00 | 60,928 | 42,691 | **0.70** | 59,487 | FREEZING | 45,685 | 43,779 | 42,691 | **0** | **0** | 0 | 0.00 | 0.00 |
| **JPQ** | 48,222 | STEP_LIMIT | 50,894 | 40,127 | DELIVERABILITY | 1.00 | 40,127 | 39,773 | 0.99 | 43,974 | FREEZING | 41,774 | 40,627 | 38,944 | 35,709 | 14,478 | 21,230 | 0.89 | 0.36 |
| **VAP** | 35,373 | STEP_LIMIT | 37,333 | 29,434 | DELIVERABILITY | 0.88 | 29,434 | 28,537 | 0.97 | 35,408 | **PRODUCT_LINE** | 29,659 | 30,505 | 28,887 | 30,872 | 12,825 | 18,047 | 1.05 | 0.44 |
| **CONSV** | 42,538 | STEP_LIMIT | 44,895 | 44,895 | **NONE** | 0.00 | 44,895 | 43,040 | 0.96 | 43,728 | COMMON | 40,803 | 40,988 | 41,105 | 12,170 | 162 | 12,008 | 0.30 | 0.00 |

---

## 5. company 別 primary limiter（final submission を最も強く制約しているもの）

| 会社 | T8 | T16 | T20 | T24 | T28 | T32 | 総合 |
|---|---|---|---|---|---|---|---|
| MASS | DELIVERABILITY | DELIVERABILITY | OPPORTUNITY | DELIVERABILITY | DELIVERABILITY | DELIVERABILITY | **DELIVERABILITY** |
| BAL | DELIVERABILITY | SALES_CAPACITY | OPPORTUNITY | SALES_CAPACITY | SALES_CAPACITY | SALES_CAPACITY | **SALES_CAPACITY** |
| JPQ | DELIVERABILITY | DELIVERABILITY | OPPORTUNITY | DELIVERABILITY | DELIVERABILITY | DELIVERABILITY | **DELIVERABILITY** |
| VAP | DELIVERABILITY | DELIVERABILITY | DELIVERABILITY | AMBITION(NONE) | DELIVERABILITY | DELIVERABILITY | **DELIVERABILITY** |
| CONSV | DELIVERABILITY | DELIVERABILITY | AMBITION(NONE) | AMBITION(NONE) | AMBITION(NONE) | **AMBITION(NONE)** | 混在 |

`AMBITION(NONE)` は「commitment の上限がどれも効かず、志の量 ÷ 転換率がそのまま提出量になった」状態。
CRISIS 由来の limiter は DS3 のどの turn でも観測されなかった。

---

## 6. Deliverability Cap 監査（§8）

### 6-1. nearTerm deliverable capacity は freezing を含むか

**含む（CAP-1 で修正済み）。** `policy.ts:554-560` が
`observation.nearTermEffectiveFreezingPackagingCapacity` を
`computeBindingProductionCapacityTons` の必須第3引数として渡している。
MASS T32 の `deliverableCapacityNearTerm` 64,317 は physical capacity 64,317 と一致しており、
CAP-1 前のように共通前処理までしか見ていない値（67,973 相当）ではない。

### 6-2. binding 統計（DS3 8seed × 32Turn = 各社 256 turn）

| 会社 | 全turn | cap 適用 turn | 適用率 | overdue 観測 turn | うち cap 適用 | overdue 時 binding 率 | 平均 cap margin（cap / production） |
|---|---:|---:|---:|---:|---:|---:|---:|
| MASS | 256 | 194 | **75.8%** | 143 | 111 | **77.6%** | 1.17 |
| BAL | 256 | 126 | 49.2% | 39 | 24 | 61.5% | 1.41 |
| JPQ | 256 | 203 | **79.3%** | 138 | 106 | **76.8%** | 1.19 |
| VAP | 256 | 224 | **87.5%** | 208 | 184 | **88.5%** | 1.17 |
| CONSV | 256 | 124 | 48.4% | 144 | 98 | 68.1% | 1.20 |

読み取り:

- **cap は実生産の 1.17〜1.41 倍の位置にある。** 実生産に張り付いて成長を殺す高さではない。
- **overdue が出ている局面では 61.5〜88.5% で cap が効いている**＝納期遅れが起きているときに
  ちゃんと新規受注を抑えている。
- backlog 0 の BAL は適用率が最も低く（49.2%）margin も最も広い（1.41）。
  **healthy forward だけの会社を過剰に罰していない。**

### 6-3. healthy forward への過剰罰則の有無

`deliverableCommitment.ts` の設計上、
`normalBacklogAllowance = max(0, sustainableDeliverable × leadTime − overdueBacklog)` であり、
**overdue だけが allowance を削る**。healthy forward は allowance 内に収まる限り罰されない。
実測でも BAL（overdue 0）は cap 適用率が最低、VAP（overdue coverage 0.44Q）が最高で、
overdue の多寡と binding 率が単調に対応している。

→ **判定: Deliverability cap は妥当に機能している。**

---

## 7. Backlog horizon（§9・shadow diagnostic）

`recent sustainable delivery` = 直近 4 四半期の実出荷の移動平均（既存 actual delivery のみ使用。
production code へは追加していない）。

| 会社 | T32 backlog coverage | overdue coverage | healthy forward coverage |
|---|---:|---:|---:|
| MASS | **1.10 Q** | 0.37 Q | 0.73 Q |
| BAL | 0.00 Q | 0.00 Q | 0.00 Q |
| JPQ | 0.89 Q | 0.36 Q | 0.53 Q |
| VAP | 1.05 Q | 0.44 Q | 0.61 Q |
| CONSV | 0.30 Q | 0.00 Q | 0.30 Q |

**「受注残 54,766t」は絶対値としては大きく見えるが、MASS の四半期出荷 54,020t に対して
1.10 四半期分でしかない。** 納期リードタイム（`standardLeadTimeTurns` = 1 四半期）を
考えると、healthy forward 0.73Q はむしろ健全な受注残高である。
問題は overdue 0.37Q（約 1/3 四半期分の納期遅れ）だけであり、
**total backlog を一律に見て抑制する設計は誤り**（§17 Option C の前提と一致）。

---

## 8. Counterfactual C0 / C1 / C2 / C3（§10、MASS 4seed）

### 手法（恒久コード変更なし・プロセス内 shadow のみ）

| case | 注入内容 |
|---|---|
| C0 | 現行 |
| C1 | `maximumStretchOverAmbition` 1.25→100、`realisticShareOfOpportunity` 0.5→100（Deliverability 維持） |
| C2 | C1 ＋ `minimumMarketPresenceRatioOfDeliverable` 0.2→1000（cap の headroom 下限を巨大化＝実質 cap 無効） |
| C3 | C2 ＋ `regularEfficiencyPerHeadTons` 6→60（**常用人数は増やさず 1人あたり効率だけ 10 倍**） |

C3 で人数ではなく効率を上げたのは、#04 counterfactual の Case4 が
「常用ワーカー 3 倍 → 人件費急増 → 資金枯渇 → 生産 0 へ崩壊」という
上書き手法の副作用で無効化された事象を避けるため。実際 C3 の資金不足 turn は 0 で、
現金は 961M へ増えており崩壊していない。

### 結果（T20 以降・4seed 平均）

| case | T | submitted | accepted | production | delivery | total backlog | overdue | healthy fwd | cash | debt | 資金不足T |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | T20 | 27,078 | 26,754 | 32,397 | 31,597 | 18,962 | 383 | 18,579 | 79M | 4.4M | 0 |
| C0 | T24 | 49,738 | 49,738 | 40,522 | 41,730 | 15,212 | 0 | 15,212 | 167M | 124.9M | 0 |
| C0 | T28 | 52,540 | 52,540 | 45,042 | 45,236 | 38,127 | 2,530 | 35,597 | 326M | 0 | 0 |
| **C0** | **T32** | **55,619** | **55,619** | **56,246** | **55,031** | **54,822** | **18,769** | **36,053** | **520M** | 0 | 0 |
| C1 | T20 | 41,312 | 38,805 | 35,885 | 35,650 | 32,386 | 4,762 | 27,625 | 65M | 6.1M | 0 |
| C1 | T24 | 39,583 | 39,583 | 43,562 | 41,606 | 39,459 | 13,141 | 26,318 | 148M | 124.4M | 0 |
| C1 | T28 | 43,974 | 43,974 | 44,511 | 43,509 | 43,364 | 15,314 | 28,050 | 282M | 5.1M | 0 |
| **C1** | **T32** | 59,439 | 59,439 | **52,692** | 53,670 | 60,691 | 20,434 | 40,257 | 475M | 0 | 0 |
| C2 | T24 | 66,660 | 66,660 | 52,550 | 52,550 | 98,702 | 45,309 | 53,393 | 158M | 178.0M | 0 |
| C2 | T28 | 64,069 | 64,069 | 56,018 | 56,018 | 132,036 | 78,752 | 53,284 | 352M | 17.3M | 0 |
| **C2** | **T32** | 68,098 | 68,098 | **56,568** | 56,581 | **168,261** | **110,357** | 57,904 | 727M | 0 | 0 |
| C3 | T24 | 67,965 | 67,965 | 53,883 | 53,883 | 92,599 | 40,455 | 52,143 | 179M | 62.5M | 0 |
| C3 | T28 | 65,332 | 65,332 | 55,302 | 55,302 | 135,721 | 78,926 | 56,795 | 524M | 0 | 0 |
| **C3** | **T32** | 68,786 | 68,786 | **55,719** | 55,719 | **180,815** | **118,421** | 62,394 | 961M | 0 | 0 |

### C0 比の増減（T32）

| case | production | delivery | total backlog | overdue | healthy forward |
|---|---:|---:|---:|---:|---:|
| C1 | **−3,554（−6.3%）** | −1,361（−2.5%） | +5,869（+10.7%） | +1,665（+8.9%） | +4,204 |
| C2 | **+322（+0.6%）** | +1,550（+2.8%） | **+113,439（+207%）** | **+91,588（+488%）** | +21,851 |
| C3 | **−527（−0.9%）** | +688（+1.2%） | **+125,993（+230%）** | **+99,652（+531%）** | +26,341 |

### 読み取り

1. **C1（Commitment ceiling だけ解放）は生産を減らす。** 提出量が増えて受注は伸びるが、
   作れないので backlog へ回り、原料・工場配分が受注消化へ引っ張られて生産効率が落ちる。
2. **C2（Deliverability も解放）でも生産は +0.6% しか増えない。** 一方 overdue は 5.9 倍。
   **これは「Commitment を広げれば生産が増える」という仮説の明確な反証である。**
3. **C3（労働も十分と仮定）でも生産は増えない（−0.9%）。**
   労働を 10 倍にしても 55,719t で頭打ち＝**労働も primary binding ではない**。
4. 現金は C2/C3 で増える（727M / 961M）。これは受注増による売掛回収であって
   生産増ではない。**財務指標だけを見ると改善して見えるが実体は納期遅れの山**。

---

## 9. 会社別判断

| 会社 | 判断 | 根拠 |
|---|---|---|
| **MASS** | **変更不要（時期尚早）** | cap 前 commitment 69,791 は physical 64,317 を上回っており不足していない。cap 後 56,594 は実生産 54,746 とほぼ一致。C1〜C3 で生産が増えない |
| **JPQ**（§12） | **変更不要** | CAP-1 後 production +6.9%・overdue −23.8%。cap 適用率 79.3%、overdue 時 binding 76.8% で規律が効いている。PD 志向は維持（limiter は STEP_LIMIT / DELIVERABILITY のみで商品構成に触れていない） |
| **VAP**（§13） | **明確に不採用** | 主制約は PRODUCT_LINE（physical 35,408 / line binding）。cap 適用率 87.5%・overdue coverage 0.44Q。Commitment を緩めれば受注だけ増える典型。序盤 working capital 期（T1–T18 LIQUIDITY route）は特に危険 |
| **CONSV**（§14） | **変更不要** | T24 以降 commitment limiter は NONE（上限がどれも効いていない）＝既に十分高い。cap 適用率 48.4%、overdue 162t（coverage 0.00Q）。LOW risk posture 維持 |
| **BAL**（§15） | **変更不要（Commercial 側に理由なし）** | backlog 0 / overdue 0。primary limiter は **SALES_CAPACITY**（営業組織）であり Commitment ではない。受入率 0.70 は市場側の取りこぼしで、Commitment を上げても成約は増えない。liquidity discipline を触る理由も無い |

---

## 10. DS1 / DS2 確認（§16）

engine 一致 DS1 640/640・DS2 640/640。

| scenario | 会社 | ambition | commitBefore | commitAfter | cap適用率 | submit | accepted | physical | pool | workerSup | production | outstanding | overdue |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| DS1 | **MASS** | 18,346 | 1,000 | 0 | **0.00** | 1,000 | **0** | 16,673 | PRODUCT_LINE | **0** | **0** | 25,534 | 25,534 |
| DS1 | BAL | 39,560 | 28,699 | 28,699 | 0.00 | 28,699 | 28,699 | 42,280 | PRODUCT_LINE | 34,200 | 28,007 | 0 | 0 |
| DS1 | JPQ | 35,267 | 28,699 | 28,699 | 0.00 | 28,699 | 28,699 | 36,701 | PRODUCT_LINE | 33,257 | 28,721 | 0 | 0 |
| DS1 | VAP | 14,539 | 15,344 | 13,574 | 1.00 | 13,574 | 13,574 | 15,508 | PRODUCT_LINE | 12,642 | 13,419 | 13,585 | 4,947 |
| DS1 | CONSV | 33,106 | 28,699 | 28,699 | 0.00 | 28,699 | 28,699 | 36,476 | PRODUCT_LINE | 31,370 | 29,769 | 0 | 0 |
| DS2 | MASS | 44,100 | 27,998 | 27,998 | **0.00** | 27,998 | 27,998 | 42,750 | FREEZING | 33,987 | 27,997 | **0** | **0** |
| DS2 | BAL | 39,560 | 27,998 | 27,998 | 0.00 | 27,998 | 27,998 | 42,280 | PRODUCT_LINE | 32,039 | 29,267 | 0 | 0 |
| DS2 | JPQ | 37,626 | 27,998 | 27,998 | 0.00 | 27,998 | 27,998 | 39,041 | PRODUCT_LINE | 27,717 | 27,883 | 0 | 0 |
| DS2 | VAP | 14,537 | 15,344 | 13,228 | 1.00 | 13,228 | 13,228 | 15,379 | PRODUCT_LINE | 13,090 | 13,164 | 13,396 | 4,980 |
| DS2 | CONSV | 32,699 | 27,998 | 27,998 | 0.00 | 27,998 | 27,998 | 36,028 | PRODUCT_LINE | 27,249 | 27,979 | 0 | 0 |

**DS1 MASS の既存破綻は Commercial Commitment 由来ではない。**
Deliverability cap 適用率 0.00、worker-supported 0、production 0 であり、
Commitment 側は何も抑制していない（`commitBefore` 1,000 は既に崩壊した後の残骸）。
SAI-GROW-3B-2 で記録済みの固定費 irreducible floor（#04 Engine 課題）のまま。

**DS2 の序盤 cash trough も Commercial Commitment 由来ではない。**
T32 で cap 適用率 0.00・backlog 0・overdue 0 であり、Commitment は一度も抑制していない。
SAI-BKL-1／SAI-EXEC-1 で確認した T5–T6 の運転資本の谷（#04 Scenario-Parameter）のまま。

---

## 11. Option 判定（§17）

### **Option A — Commercial Commitment 現行維持（推奨）**

根拠:
- cap 前 commitment は physical capacity を上回っており「不足」していない（MASS T32: 69,791 > 64,317）
- cap 後の submission は実生産とほぼ一致（56,594 vs 54,746）
- cap は実生産の 1.17〜1.41 倍の位置にあり、成長を殺す高さではない
- overdue 局面で 61.5〜88.5% binding、backlog 0 の BAL では適用率最低＝規律として機能
- C1/C2/C3 いずれも生産を増やさず overdue のみ 5〜6 倍に膨らませる

### Option B — Deliverability cap の physical / executable input のみ追加改善（次点・限定）

CAP-1 で physical 入力は正しくなったが、`deliverableCapacityNearTerm`（64,317）と
**実生産（54,746）の間になお 9,571t の乖離**がある。この乖離の原因は Commercial 側ではなく
生産の実行段階（§13）。実行可能量をより忠実に cap 入力へ渡せば、
overdue をさらに減らせる可能性がある。ただし **§13 の原因が解消される前に cap 側だけ
締めると成長を不当に止める**ため、順序としては §13 が先。

### Option C — Backlog-horizon aware Commitment（当面不要）

backlog coverage は MASS 1.10Q / VAP 1.05Q / JPQ 0.89Q / CONSV 0.30Q / BAL 0.00Q であり、
**暴走している会社は無い**。現行 cap は既に overdue と healthy forward を分離しており
（`normalBacklogAllowance` から overdue のみを差し引く）、Option C の要件を実質満たしている。
total backlog を一律に見る設計は §17 の禁止事項でもあり、採らない。

---

## 12. Stop Conditions（§19）

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | CAP-1 後も physical capacity が primary binding | **該当**（MASS/JPQ/CONSV は FREEZING or COMMON、VAP/BAL は PRODUCT_LINE） | §3・§4 |
| 2 | labor が primary binding | **部分的に該当**（MASS T32 workerSup 55,147 < physical 64,317）。ただし C3 で労働 10 倍にしても生産が増えないため **primary ではない** | §8 |
| 3 | **Commitment 緩和で backlog だけ増える** | **明確に該当** | §8（C2 生産 +0.6% / overdue +488%） |
| 4 | VAP working capital 期に受注膨張 | 現行では起きていない（cap 適用率 87.5% が防いでいる）。緩めれば起きる | §9 |
| 5 | BAL liquidity 悪化 | 該当なし（backlog 0・overdue 0・Commercial 側の変更理由なし） | §9 |
| 6 | JPQ overdue 再発 | 現行では改善中（CAP-1 で −23.8%）。緩めれば再発する | §9 |
| 7 | company / scenario ID hardcode が必要 | 該当なし（本 Phase は監査のみ） | — |
| 8 | Engine delivery semantics 不具合 | 該当なし（SAI-BKL-1 で 1,280 観測点・不一致 0） | — |
| 9 | backlog canonical 定義と AI 観測の新たな不一致 | 該当なし | §1 |

**#1 / #3 が該当 → 実装 Phase へ進まず停止。**

---

## 13. 次の binding constraint（未解決の 9,571t）

MASS T32・8seed 平均:

```
physical capacity                64,317
worker-supported capacity        55,147
actual production                54,746   ← physical との差 9,571t
```

C3（労働効率 10 倍）でも生産が 55,719 までしか伸びないことから、
**この 9,571t は Commercial でも労働でもない。** 候補は SAI-EXEC-1 §C-2 / SAI-CAP-1 §8 で
既に特定済みの以下であり、いずれも Commercial Commitment の責任ではない。

| 事象 | 所有 |
|---|---|
| 工場間配分が名目シェア按分で、実行不能分を余力工場へ振り替えない（`production.ts:147` / `allocation.ts:157-170`） | **Shared（#05 計画側 + #04 実行側）** |
| 冷凍・包装の増設単位 +800t/件 が MASS の規模に対して小さい（`capex/parameters.ts`） | **#04 Engine** |
| 同時進行 CAPEX 案件上限 3 件（`capex/parameters.ts:354`） | **#04 Engine** |
| 原料調達タイミング / 資金 | #05（3B-2 で対応済み。DS3 では非 binding） |

---

## 14. 所有区分（§18）

| 発見 | 所有 | Commercial Commitment の責任か |
|---|---|---|
| Deliverability cap は妥当に機能（1.17〜1.41 margin、overdue 時 binding 61〜88%） | #05 Standard AI | 責任範囲だが **変更不要** |
| cap 前 commitment が physical を上回る（MASS T32 69,791 > 64,317） | #05 Standard AI | **不足していない** |
| BAL の primary limiter が SALES_CAPACITY（受入率 0.70） | #05 Standard AI（Sales Capacity Engine） | Commitment とは別軸。今回変更禁止 |
| 工場間配分の実行不能分を振り替えない | Shared | **混同しない** |
| 冷凍・包装 +800t/件 | #04 Engine | **混同しない** |
| 同時進行 CAPEX 上限 3 件 | #04 Engine | **混同しない** |
| labor shortage（MASS workerSup < physical） | #05 Standard AI（labor.ts） | **混同しない**。かつ C3 で primary でないことを実証 |
| DS1 MASS 破綻（固定費 floor） | #04 Engine | **混同しない** |
| DS2 序盤 cash trough | #04 Scenario-Parameter | **混同しない** |

---

## 15. 変更していないもの

Commercial Ambition / Commercial Commitment / Deliverability cap / Vision /
DS3 Vision multiplier / opportunity share（`realisticShareOfOpportunity`）/
`maximumSupplierShare` / sales conversion / Sales Capacity Engine /
backlog commitment policy / market clearing / Scenario demand / CAPEX cost /
factory parameters / Worker logic / financing parameters / backlog engine semantics。

counterfactual の parameter 上書きはすべて**プロセス内 shadow**であり、
実行後に元値へ戻している（production code は 1 行も変更していない）。
