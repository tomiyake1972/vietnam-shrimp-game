# SAI-GROW-3D PRE-AUDIT — Commercial Ambition Ceiling / Evidence Audit

**監査のみ。ロジック変更は0行。** 2e70d80 の全ロジックを維持。

| | commit |
|---|---|
| Standard AI branch HEAD | `2e70d80`（SAI-GROW-3C） |
| current integration HEAD | `0400c4a`（3B-1開始時から変化なし。新規変更の監査は不要） |
| DS3 branch HEAD | `00b72a9` |

作業ツリーは `2e70d80` と完全一致（`git diff 2e70d80` 空）。
測定は一時scriptのみで行い、実行後に削除した。

---

## 1. Commercial Ambition call graph（実ファイル・関数名）

```
market/… （前四半期の確定値のみ）
 └ standardAi/diagnosis/observableOpportunity.ts
     → observableDemandTons → attainableDemandTons → attainableProfitableTons
                                                   → weightedContributionUsdPerKg
                                                   → priceObservationMissing
 └ standardAi/orientationWeightedOpportunity.ts::computeOrientationWeightedOpportunity
     → orientationWeightedOpportunityTons          ★ Ambitionへは渡らない（§8）
 └ policy.ts L446-450
     capacityAnchorTons   = Σ observation.totalCapacityByProduct × params.salesUtilizationTarget
     recentActualScaleTons = Σ observation.lastQuarterActualProductionByProduct
 └ vision/strategicGrowth.ts::computeStrategicGrowthState
     → visionTargetScaleAtCurrentTurn / visionTargetScaleAtQ32
     → strategicScaleGapTons / strategicScaleGapRatio → growthPressure / onTrack
 └ standardAi/growth/growthPressure.ts::computeGrowthPressureCore   （policy.ts L469）
     入力 currentRelevantScaleTons = max(capacityAnchorTons, recentActualScaleTons)
     → effectiveOpportunityShare.ambition   （GROW-2）
     → growthEvidenceMultiplier             （GROW-3A）
 └ policy.ts L491-508  commercialAmbitionInput を組み立て
 └ vision/commercialAmbition.ts::computeCommercialAmbition   （policy.ts L509）
     → ambitionTons / baselineTons / limiter
```

## 2. limiter判定順（early return を含む・実装順そのまま）

```
baselineTons = max(capacityAnchorTons, recentActualScaleTons)
hold(x) は ambitionTons = baselineTons を返す（＝拡大しないだけで、縮まない）

1. !vision || !strategicGrowth                                   → hold("VISION_ON_TRACK")
2. !growthPressureAtLeast(growthPressure, minimumPressureForExpansion="MODERATE")
                                                                 → hold("VISION_ON_TRACK")
3. maxFinishedGoodsExcessRatio > inventoryExcessHoldRatio(1.5)   → hold("INVENTORY_EXCESS")
4. priceObservationMissing || attainableProfitableTons <= 0      → hold("MARKET_WEAK")
5. realisticOpportunityTons <= baselineTons                      → hold("MARKET_WEAK")
      realisticOpportunityTons = attainableProfitableTons × realisticShareOfProfitableOpportunity(0.35)
6. weightedContributionUsdPerKg < minimumContributionUsdPerKg(0.05) → hold("MARGIN_WEAK")
7. 到達したときだけ拡大:
      stepRatio     = maxStepRatioByAmbition[growthAmbition] × stepIntensityByPressure[growthPressure]
                      × stepLimitMultiplier(GROW-3A)
      stepped       = baselineTons × (1 + stepRatio)
      visionCeiling = max(baselineTons, visionTargetScaleAtCurrentTurn)
      ambitionTons  = min(stepped, visionCeiling, realisticOpportunityTons)
```

`maxStepRatioByAmbition = { HIGH: 0.12, MEDIUM: 0.07, LOW: 0.03 }`
`stepIntensityByPressure = { LOW: 0, MODERATE: 0.5, HIGH: 0.8, URGENT: 1 }`

**重要な構造**: `visionCeiling` は `max(baseline, visionTarget)` なので、
**自社規模がVision目標を超えた瞬間からVisionは一切pullしなくなる**（上限としてのみ残る）。

## 3. 会社別 Vision 設定（DS3・実測）

| 会社 | growthAmbition | maxStep | posture | prodEvo | Vision Q32目標 | 評価レンジ | 比 |
|------|---------------|--------:|---------|---------|---------------:|-----------|----:|
| MASS | HIGH | 0.12 | AGGRESSIVE_EARLY_CAPACITY | HOSO_SCALE | 80,000 | 90–100kt | 0.84 |
| BAL | HIGH | 0.12 | AGGRESSIVE_EARLY_CAPACITY | INTEGRATED | 34,000 | 55–65kt | 0.57 |
| JPQ | HIGH | 0.12 | DEMAND_CONFIRMED | PD_SCALE | 30,000 | 45–55kt | 0.60 |
| **VAP** | **LOW** | **0.03** | VALUE_FIRST | VAP_VALUE | **17,000** | **45–55kt** | **0.34** |
| CONSV | MEDIUM | 0.07 | DEMAND_CONFIRMED | INTEGRATED | 27,000 | 45–50kt | 0.57 |

VAPだけ `growthAmbition = LOW`（step上限が他社の1/4）、`willingnessToBuildFactories = LOW`、
Q32目標が評価レンジの **1/3**。

## 4. VAP shadow decomposition（DS3 seed ds3-a。Decisionへは未反映）

各制約を**単独で**外したときのAmbition（A=Vision ceiling / B=MARKET_WEAK /
C=growthPressure早期return / D=step limit / E=opportunity cap / F=recentActual feedback）:

| T | ambition | baseline | visionTgt | gp | limiter | A | C | D | E | F | **A+C** | **A+C+D** |
|---|---------:|---------:|----------:|----|---------|--:|--:|--:|--:|--:|--------:|----------:|
| T8 | 12,800 | 12,800 | 14,500 | LOW | VISION_ON_TRACK | 12,800 | 13,184 | 12,800 | 12,800 | 12,800 | 13,184 | **29,017** |
| T16 | 13,014 | 12,800 | 15,500 | MODERATE | STEP_LIMIT | 13,014 | 13,229 | 15,500 | 13,014 | 13,014 | 13,229 | **33,459** |
| T24 | 27,680 | 27,680 | 16,300 | LOW | VISION_ON_TRACK | 27,680 | 27,680 | 27,680 | 27,680 | 27,680 | 28,510 | **52,908** |
| T28 | 32,760 | 32,760 | 16,650 | LOW | VISION_ON_TRACK | 32,760 | 32,760 | 32,760 | 32,760 | 32,760 | 33,743 | **55,341** |
| T32 | 32,760 | 32,760 | 17,000 | LOW | VISION_ON_TRACK | 32,760 | 32,760 | 32,760 | 32,760 | 32,760 | 33,743 | **60,612** |

**単独で外しても、どの制約もAmbitionを動かさない。** 制約が互いをマスクしているため。

* A単独（Vision ceilingなし）… 手前の `growthPressure=LOW` 早期returnが先に効くので不変
* C単独（pressure=URGENTに）… 次に `visionCeiling = max(baseline, 17,000) = baseline` が効くので不変
* **A+C**（両方外す）… 初めて動くが +3.0%（33,743）。ここでは `maxStepRatioByAmbition.LOW = 0.03` が効く
* **A+C+D**（step上限も外す）… **60,612t**。この時点で残るのは opportunity cap のみ
* A+C で step を HIGH相当の0.12にすると 36,691t

VAPのT32 Ambitionを 32.3kt に固定しているのは
**「Vision ceiling」＋「growthPressure早期return」＋「LOWのstep上限」の3段重ね**であり、
単一原因ではない（Stop Condition H）。ただし3つとも**Vision設定に由来する**という点で共通する。

## 5. 5社比較（DS3 8seed・T32平均）

| 会社 | ambition | baseline | capAnchor | recentAct | visionTgt | attainable | realOpp | contrib | 生産 | 実売 | shadow A+C | shadow A+C+D | 評価レンジ |
|------|---------:|---------:|----------:|----------:|----------:|-----------:|--------:|--------:|-----:|-----:|-----------:|-------------:|-----------|
| MASS | 63,635 | 63,635 | 63,635 | 50,748 | 80,000 | 166,383 | 59,549 | 5.24 | 53,331 | 33,155 | 63,635 | 63,635 | 90–100kt |
| BAL | 58,490 | 58,490 | 58,490 | 43,656 | 34,000 | 166,383 | 58,234 | 5.31 | 44,434 | 42,844 | 59,361 | 59,361 | 55–65kt ✓ |
| JPQ | 42,910 | 42,910 | 42,910 | 38,557 | 30,000 | 166,383 | 58,234 | 5.28 | 38,441 | 33,164 | 48,059 | 58,234 | 45–55kt |
| CONSV | 41,755 | 41,755 | 41,755 | 39,816 | 27,000 | 166,383 | 58,234 | 5.27 | 39,880 | 37,845 | 44,678 | 58,234 | 45–50kt |
| VAP | 32,325 | 32,325 | 32,325 | 30,283 | 17,000 | 166,383 | 58,234 | 5.27 | 30,587 | 27,856 | 33,295 | 58,234 | 45–55kt |

limiter分布（8seed × 5マイルストーン = 40観測点）:

| 会社 | VISION_ON_TRACK | STEP_LIMIT | MARKET_WEAK |
|------|----------------:|-----------:|------------:|
| BAL / JPQ / CONSV | 24 | 16 | 0 |
| VAP | **30** | 10 | 0 |
| MASS | 4 | 28 | **8** |

**全社共通の構造問題**（Stop Condition G）:

1. **T32時点で5社とも `ambition == baseline == capacityAnchor`。Visionによる上乗せは0。**
   BAL/JPQ/CONSV/VAPは自社規模がVision目標を追い越しており、Visionが上限にしかなっていない。
2. `attainableProfitableTons` が **5社すべてで同一の 166,383t**。会社ごとに差が付いていない。
3. その 0.35 倍 = `realisticOpportunityTons ≈ 58,234t` が **全社共通の最終天井**。
   MASSはこれが自社baselineを下回るため `MARKET_WEAK` になる（成長したくても機会cap側が小さい）。

## 6. 自己抑制loopの確認（§5）

`baselineTons = max(capacityAnchorTons, recentActualScaleTons)`。

DS3 T32では**全社で capacityAnchor > recentActual**（VAP 32,325 > 30,283、
MASS 63,635 > 50,748 等）。したがって baseline は capacityAnchor 側で決まっており、
「Deliverability cap → 実績低下 → Ambition低下」というloopは **現在は成立していない**。
shadow F（recentActualScaleTons = 0）でAmbitionが1tも動かないことがこれを裏付ける。

**GROW-3Cで能力を増やせばAmbitionは確かに増える**（VAPは T24 27,680 → T28 32,760 と
capacityAnchor経由で上昇した）。Stop Condition D は**該当しない**。

## 7. MARKET_WEAK の寄与（§7）

VAP/BAL/JPQ/CONSVでは **MARKET_WEAK は一度も発火していない**（0/40）。
attainable 166,383t・contribution 5.27 USD/kg で、市場機会は潤沢に観測できている。

MASSだけ 8/40 で発火。原因は「市場が弱い」ではなく
`realisticOpportunityTons (59,549) <= baselineTons (63,635)` ——
**自社規模が「観測機会の35%」を追い越した**ことによる。
これは市場の弱さではなく **opportunity share 0.35 の天井**である。

## 8. Product / value aggregation の所見（§8）

* `computeOrientationWeightedOpportunity` は算出されており `GrowthPressureCore` へは渡るが、
  **`computeCommercialAmbition` へは渡っていない**（Ambitionは生の `attainableProfitableTons` を使う）。
  VAPのVALUE_FIRST / VAP_VALUE志向は Ambition の機会評価に反映されていない。
* Ambition・Commitment・Deliverable Capacity・Growth Routing はすべて
  **HOSO換算トンの総量スカラー**で扱われる。商品別の経済価値（VAPの contribution）は
  `weightedContributionUsdPerKg` として「拡大してよいか」の閾値判定（0.05）にしか使われず、
  **「どれだけ拡大してよいか」には一切入らない**。
* すなわち volume scale と economic value scale が分離されておらず、
  高付加価値・高労働集約の会社は volume 基準で不利になる。
  **新しい value metric は実装していない**（報告のみ）。

## 9. 評価レンジとの差の分解（shadow専用。AIの入力にもコードにもしていない）

| 会社 | 現在 | 評価レンジ | 差 | 差を説明する制約 |
|------|-----:|-----------|---:|-----------------|
| BAL | 58,490 | 55–65kt | **範囲内** | — |
| CONSV | 41,755 | 45–50kt | −3〜8kt | Vision ceiling（27,000）＋ growthPressure早期return。A+C+Dで58,234t |
| JPQ | 42,910 | 45–55kt | −2〜12kt | 同上（Vision 30,000）。A+Cで48,059t、A+C+Dで58,234t |
| VAP | 32,325 | 45–55kt | **−13〜23kt** | Vision ceiling（17,000）＋ pressure早期return ＋ **LOW step 0.03**。A+C+Dで60,612t |
| MASS | 63,635 | 90–100kt | **−26〜36kt** | **opportunity share 0.35**（realOpp 59,549 < baseline）。A/C/Dを外しても不変 |

**2種類の問題に分かれる**:

* **VAP / JPQ / CONSV**: Vision設定（目標規模・growthAmbition）が評価レンジより小さい → Visionの問題
* **MASS**: Visionは80,000tと十分大きいが `realisticShareOfProfitableOpportunity = 0.35` が
  自社規模より小さい機会しか認めない → **共通パラメータの問題**

## 10. DS2 regression の root cause（§11。調整はしていない）

`ds2-s4` BAL を 3B-3（0f07701）と 3C（2e70d80）で同一seed比較した実測:

| T | worker before → after | cash before → after | OP before → after |
|---|----------------------:|--------------------:|------------------:|
| T15 | 4,372 → 4,630 | 94.1 → 94.8M | 26.7 → 26.3M |
| T17 | 6,074 → 6,338 | 69.4 → 68.2M | 31.0 → 31.6M |
| T19 | 7,333 → **8,930** | 118.7 → 115.1M | −0.6 → **−2.9M** |
| T21 | 4,788 → 6,009 | 152.7 → 146.2M | 5.0 → 1.4M |
| T23 | 4,344 → 5,061 | 126.8 → **113.0M** | 40.1 → 45.0M |
| T26 | 11,143 → 10,080 | 259.1 → 248.0M | 75.0 → **59.6M** |

CAPEX額・タイミング・financing・production mix はほぼ同一。**差はすべて Worker 側**。

**root cause**: 3C の WORKFORCE route が Worker必要人数の下限を
`workerRequirementForAmbition` へ引き上げる。しかしその Ambition は
（§5のとおり）`capacityAnchor` であり、**実際の販売量ではない**。
DS2のように Ambition > 実売 の局面では、余剰人員の人件費が先に出て
cash と OP を押し下げる。これが DS2 MASS avg OP −5.2% と
BAL ds2-s4 の資金不足1T の直接原因である。

※ 本監査では調整していない。

## 11. Stop Conditions

| id | 判定 |
|----|------|
| A. VAPはVISION_ON_TRACKが主因 | **該当（第一原因）** 40観測点中30がVISION_ON_TRACK。ただし単独では動かない（§4） |
| B. VAPはMARKET_WEAKが主因 | **非該当** 0/40。attainable 166,383t・contrib 5.27で機会は潤沢 |
| C. VAPはStep / evidenceが主因 | **部分該当（第三段）** LOWのmaxStep 0.03。A+Cを外した後に効く |
| D. VAPはactual-scale feedback loopが主因 | **非該当** capacityAnchor > recentActual、shadow Fで不変 |
| E. VAPはScenario opportunity自体が不足 | **非該当** VAPのrealOppは58,234tで評価レンジを上回る |
| F. VAPはEngine capacity / worker / raw materialが依然主因 | **非該当** 生産30,587 < 能力35,408。3CのWORKFORCE routeで人員は増加中 |
| G. VAPだけでなくJPQ/CONSV等も同じ構造で止まる | **該当** BAL/JPQ/CONSVも24/40がVISION_ON_TRACK。T32は5社とも ambition == baseline |
| H. 複数制約が同程度で単一原因でない | **該当** A/C/D/Eいずれも単独では0t。A+Cで+983t、A+C+Dで+27,852t |
| I. Ambitionを開けるとBAL/MASS liquidity/backlogが再悪化する可能性が高い | **要注意** §10のとおり、Ambitionを上げると 3C の Worker floor が同じだけ人員を増やし、DS2で既に OP −5.2% を出している。Ambitionを開ける前にWorker floorの基準を「Ambition」から「実行可能な販売量」へ変える必要がある |

## 12. tests / no-code-change 確認

* `git diff 2e70d80` … **空**（app/・docs/以外の変更なし。本監査で追加したのは本ドキュメントのみ）
* ロジック変更0行。VISION_ON_TRACK / MARKET_WEAK / Vision値 / step multiplier /
  routing強度 / Scenario のいずれも変更していない。
* 測定は一時scriptのみで実施し、実行後に削除済み（`scripts/tmp*.ts` は残っていない）。
* 直近の全社suite（2e70d80時点）: 3,731 tests / 3,731 pass / 0 fail。本監査で再実行不要（コード無変更）。

## 13. 推奨する次の実装Phase

優先順位付きで、いずれも #05 の判断が要る。

1. **【最優先・データ側】Vision 目標規模の再設定（実装ではなく設定判断）**
   VAP 17,000 / JPQ 30,000 / CONSV 27,000 / BAL 34,000 は評価レンジの 0.34〜0.60 倍。
   Ambition architecture は「Visionに追いついたら止まる」設計として**正しく動作している**。
   評価レンジを狙うなら Vision 側を直すのが筋であり、制御ロジックを歪めるべきではない。
   VAPは `growthAmbition = LOW`（step 0.03）と `willingnessToBuildFactories = LOW` も併せて判断が要る。

2. **【共通パラメータ】`realisticShareOfProfitableOpportunity = 0.35` の再校正**
   MASSはこれが唯一のbindingであり、Visionを直しても解けない。
   5社の `attainableProfitableTons` が同一（166,383t）である点も併せて監査すべき
   （会社ごとの到達可能性が差別化されていない）。

3. **【3C の副作用是正】Worker floor の基準を Ambition から実行可能販売量へ**
   §10のとおり、DS2の OP 低下は Worker floor が `workerRequirementForAmbition` を
   使っていることに起因する。Deliverable Capacity または直近実売を基準にすれば、
   VAPの能力拡張効果を保ったまま DS2 の副作用を消せる見込みが高い。

4. **【中期】volume scale と economic value scale の分離**
   `orientationWeightedOpportunityTons` は既に存在するが Ambition へ渡っていない。
   VALUE_FIRST/VAP_VALUE の会社が volume 基準で不利になる構造の是正（§8）。

**実装順の提案**: 3 →（#05判断後に）1 → 2 → 4。
3 は 3C の明確な副作用是正であり、Vision/パラメータの判断を待たずに着手できる。
