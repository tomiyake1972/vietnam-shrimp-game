# SAI-VISION-1 PRE-AUDIT — Vision Candidate A Sensitivity

**shadow評価のみ。Vision正式値・Scenario・opportunity share・step multiplier は変更していない。**

| | |
|---|---|
| Standard AI HEAD | `2244f18`（SAI-GROW-3C.1） |
| integration HEAD | `0400c4a`（変化なし） |
| DS3 HEAD | `00b72a9` |
| 評価 | DS3 8seed（ds3-a〜h）× 32Turn |

## 再現方法

一時scriptは残していない。再現するには `DEFAULT_COMPANY_VISION_DOCUMENTS`
（`app/lib/v2/companyLab/vision/defaults.ts` の export）を実行時に差し替えるだけでよい
（production codeの変更は不要）。開始規模は現行の `referenceGrowthPath[0]` を保ち、
Q32目標まで線形に引き直す（`overrides.ts` の既定fallbackと同じ考え方）:

```
q1 = 現行 referenceGrowthPath[0].scaleTonsPerQuarter
at(t) = round(q1 + (newQ32 - q1) * (t - 1) / 31)   for t in {1, 8, 16, 24, 32}
```

## Case 定義

| 会社 | Case 0 Q32 / amb / build | Case A1 Q32 | Case A2 Q32 / amb / build |
|------|--------------------------|------------:|---------------------------|
| MASS | 80,000 / HIGH / HIGH | 90,000 | 90,000 / HIGH / HIGH |
| BAL | 34,000 / HIGH / HIGH | 60,000 | 60,000 / HIGH / **MEDIUM** |
| JPQ | 30,000 / HIGH / MEDIUM | 50,000 | 50,000 / **MEDIUM** / MEDIUM |
| VAP | 17,000 / LOW / LOW | 48,000 | 48,000 / **MEDIUM** / **MEDIUM** |
| CONSV | 27,000 / MEDIUM / MEDIUM | 45,000 | 45,000 / MEDIUM / **LOW** |

## 1. 結果（DS3 8seed・T32平均）

| 会社 | Case | ambition | sales | 生産 | 生産能力 | worker | 工場 | CAPEX累計 | cash | backlog | overdue |
|------|------|---------:|------:|-----:|---------:|-------:|-----:|----------:|-----:|--------:|--------:|
| BAL | 0 | 58,455 | 42,980 | 43,758 | 62,367 | 14,285 | 3.0 | 83.2M | 573M | 206 | 0 |
| BAL | **A1** | **75,220** | 43,964 | **44,824** | **80,317** | 15,358 | 4.0 | 104.6M | 538M | **0** | 0 |
| BAL | A2 | 75,220 | 43,964 | 44,824 | 80,317 | 15,358 | 4.0 | 104.6M | 538M | 0 | 0 |
| CONSV | 0 | 41,780 | 37,594 | 39,842 | 43,813 | 12,694 | 2.0 | 83.5M | 627M | 13,842 | 220 |
| CONSV | **A1** | **59,955** | **41,783** | **50,639** | **63,270** | 17,362 | 3.0 | 114.5M | 536M | **9,432** | **0** |
| CONSV | A2 | 59,955 | 41,783 | 50,639 | 63,270 | 17,362 | 3.0 | 114.5M | 536M | 9,432 | 0 |
| JPQ | 0 | 43,310 | 31,790 | 38,185 | 44,535 | 13,587 | 2.0 | 82.4M | 634M | 37,832 | 19,232 |
| JPQ | **A1** | **62,110** | **40,555** | **53,843** | **67,171** | 19,446 | 3.4 | 118.4M | 534M | **16,118** | **0** |
| JPQ | A2 | 62,110 | 40,555 | 53,843 | 67,171 | 19,446 | 3.4 | 118.4M | 534M | 16,118 | 0 |
| MASS | 0 | 63,635 | 33,155 | 53,330 | 66,797 | 19,624 | 3.4 | 91.8M | 484M | 58,012 | 18,265 |
| MASS | **A1** | 65,337 | 33,882 | 55,616 | 72,675 | 21,048 | 3.9 | 91.1M | 489M | **66,683** | 20,204 |
| MASS | A2 | 65,337 | 33,882 | 55,616 | 72,675 | 21,048 | 3.9 | 91.1M | 489M | 66,683 | 20,204 |
| VAP | 0 | 32,325 | 27,188 | 30,505 | 35,408 | 11,412 | 2.0 | 52.6M | 389M | 30,873 | 12,824 |
| VAP | **A1** | 34,034 | 27,785 | **31,563** | 37,428 | 11,772 | 2.1 | 61.3M | 379M | 31,550 | 11,366 |
| VAP | A2 | **35,911** | 27,785 | 31,563 | 37,428 | 11,772 | 2.1 | 61.3M | 379M | 31,550 | 11,366 |

**A1 と A2 は VAP の ambition 以外すべて bit-identical**（生産・能力・worker・CAPEX・
cash・backlog・product mix いずれも完全一致）。VAPも ambition は +1,877t 増えるが
生産は 1t も変わらない。

## 2. limiter分布（全turn・8seed = 40観測点/社）

| 会社 | Case 0 | Case A1 | Case A2 |
|------|--------|---------|---------|
| BAL | VISION_ON_TRACK 24 / STEP_LIMIT 16 | 21 / 19 | 21 / 19 |
| CONSV | 24 / 16 | 24 / 16 | 24 / 16 |
| JPQ | 24 / 16 | 21 / 19 | 23 / 17 |
| MASS | VISION_ON_TRACK 4 / STEP 28 / **MARKET_WEAK 8** | 0 / 28 / **11** + OPPORTUNITY_CEILING 1 | 同左 |
| VAP | **VISION_ON_TRACK 30** / STEP 10 | **STEP_LIMIT 40** | **STEP_LIMIT 40** |

VAPは A1 で VISION_ON_TRACK が完全に消え STEP_LIMIT 一色になる
（＝Vision ceiling は確かに外れた）。しかし生産は +3.5% しか動かない。

## 3. VAP 詳細（A-3。seed ds3-a、Case A2）

| T | ambition | limiter | visionTgt | 生産能力 | 生産 | worker | CAPEX累計 | 工場 | cash | route |
|---|---------:|---------|----------:|---------:|-----:|-------:|----------:|-----:|-----:|-------|
| T1 | 12,800 | VISION_ON_TRACK | 14,000 | 13,680 | 11,219 | 6,500 | 0.0M | 1 | 19M | LIQUIDITY |
| T7 | 13,517 | STEP_LIMIT | 20,580 | 13,680 | 10,310 | 5,050 | 0.0M | 1 | 6M | LIQUIDITY |
| T13 | 14,184 | STEP_LIMIT | 27,161 | 13,680 | 12,876 | 4,684 | 0.0M | 1 | 45M | LIQUIDITY |
| T19 | 14,738 | STEP_LIMIT | 33,742 | 13,680 | 12,644 | 4,684 | **12.3M** | 1 | 99M | BACKLOG_RECOVERY |
| T25 | 30,397 | STEP_LIMIT | 40,323 | **35,012** | 25,551 | 8,612 | 39.7M | **2** | 61M | LIQUIDITY |
| T31 | 35,598 | STEP_LIMIT | 46,903 | 35,012 | 31,688 | 11,434 | 48.6M | 2 | 329M | BACKLOG_RECOVERY |

**VAPの真のボトルネックはVisionではなく、T1〜T18の資金不足である。**
CAPEXは T19 まで 0.0M、2工場目の稼働は T25。route は T1〜T16 のほとんどが LIQUIDITY。
32Turnのうち能力が動くのは最後の8Turnだけであり、Visionを 17→48kt にしても
物理的に間に合わない。

### A-3 の3つの問い

1. **Q32 Vision 17→48 だけで十分か** → 不十分。ambition 32.3 → 34.0kt、生産 +3.5%。
2. **growthAmbition LOW→MEDIUM も必要か** → **不要**。A2で ambition が +1,877t 増えるだけで
   生産・能力・worker・CAPEX はすべて A1 と bit-identical。
3. **factory willingness LOW→MEDIUM も必要か** → **効果が観測できない**。A2でCAPEX累計・工場数とも A1 と同一。

## 4. JPQ（A-4）product mix（T24-32累計・8seed）

| Case | HOSO | PD | VAP | 計 |
|------|-----:|---:|----:|---:|
| 0 | 49.6% | 34.7% | 15.7% | 2,802,938t |
| A1 / A2 | **47.2%** | **35.4%** | **17.4%** | 3,165,930t |

HOSO偏重化・VAP偏重化・mix崩壊はいずれも起きていない。PD比率はむしろ上昇。
A2 の growthAmbition HIGH→MEDIUM は **結果に一切影響しない**（A1とbit-identical）ため、
「quality型として自然」という理由で MEDIUM にすること自体は無害だが、挙動上の意味は無い。

参考（全社 T24-32累計 mix、Case 0 → A1）:
BAL 50.3/32.2/17.5 → 49.4/32.2/18.4、CONSV 50.7/33.5/15.8 → 49.7/33.8/16.5、
MASS 59.7/26.8/13.6 → 58.3/27.4/14.3、VAP 39.6/39.4/21.1 → 41.3/38.2/20.5。

## 5. BAL（A-5）Liquidity discipline

| Case | T8 CAPEX累計 | T8 cash | T8 debt | T8 調達制約T |
|------|-------------:|--------:|--------:|-------------:|
| 0 | 0.0M | 29M | 35.9M | 1.0 |
| A1 | 0.0M | 29M | 36.0M | 1.0 |
| A2 | 0.0M | 29M | 36.0M | 1.0 |

**T2-T4のCAPEX集中は再発しない。** 3B-1 Liquidity SSoT が先に効いているため、
Vision を 34→60kt にしても早期投資は起きない。T32 distress 0.6、backlog 206 → **0**、
overdue 0 → 0。**Case A1/A2 は BAL の Liquidity / Workforce discipline を壊さない。**

## 6. CONSV（A-6）leverage

| Case | T32 debt | T32 cash | T32 CAPEX累計 | distress |
|------|---------:|---------:|--------------:|---------:|
| 0 | 0.0M | 627M | 83.5M | 0.0 |
| A1 / A2 | **0.0M** | 536M | 114.5M | **0.0** |

**借入0のまま**。CAPEX増は手元資金の範囲で行われている。LOW financialRiskTolerance の
性格は維持され、高レバレッジ化していない。backlog 13,842 → 9,432、overdue 220 → 0 と
むしろ健全化する。

## 7. MASS（A-7）Vision 80→90 の効果

ambition 63,635 → **65,337**（+2.7%）にとどまる。生産 53,330 → 55,616（+4.3%）。
一方 **backlog 58,012 → 66,683（+15%）**、overdue 18,265 → 20,204（+11%）と悪化する。

limiter は MARKET_WEAK が 8 → 11 に増える。3D PRE-AUDITのとおり
`realisticOpportunityTons ≈ 59,549t < baselineTons 63,635t` が先にbindingであり、
**Vision変更だけでは 90kt へ届かない**ことが確認できた（指示A-7の想定どおり）。

## 8. Phase B — Vision Candidate Recommendation

### 推奨: **Case A1（Q32 target scaleのみ変更）**

| 会社 | 推奨 Q32 | growthAmbition | factory willingness | financialRiskTolerance | strategicPosture | 期待挙動 | risk |
|------|---------:|----------------|---------------------|------------------------|------------------|----------|------|
| MASS | 90,000 | HIGH（現行維持） | HIGH（現行維持） | HIGH | AGGRESSIVE_EARLY_CAPACITY | ambition +2.7% のみ。opportunity architecture がbinding | backlog +15% / overdue +11%。**Vision単独変更は非推奨**（下記B-5） |
| BAL | 60,000 | HIGH（現行維持） | HIGH（現行維持） | MEDIUM | AGGRESSIVE_EARLY_CAPACITY | ambition 58.5 → 75.2kt、生産 +2.4%、backlog 0 | 早期CAPEX集中なし・debt増なしを実測済み。**低risk** |
| JPQ | 50,000 | **HIGH のまま**（MEDIUMにしても挙動不変） | MEDIUM（現行維持） | MEDIUM | DEMAND_CONFIRMED | 生産 38.2 → 53.8kt、overdue 19,232 → 0 | mix維持を実測済み。**低risk** |
| VAP | 48,000 | **LOW のまま**（MEDIUMにしても挙動不変） | LOW のまま（MEDIUMにしても挙動不変） | MEDIUM | VALUE_FIRST | ambition 32.3 → 34.0kt、生産 +3.5%のみ | **Visionでは解けない**（真因は初期18Turnの資金制約と VAP capex の単価。下記B-1） |
| CONSV | 45,000 | MEDIUM（現行維持） | MEDIUM（現行維持） | LOW | DEMAND_CONFIRMED | 生産 39.8 → 50.6kt、debt 0 維持 | **低risk** |

**A2 を推奨しない理由**: BAL/JPQ/CONSV/MASS では A1 と bit-identical、
VAP でも ambition が +1,877t 増えるだけで生産は 1t も変わらない。
`growthAmbition` と `willingnessToBuildFactories` の変更は、現在の architecture では
**観測可能な効果を持たない**（会社は baseline / MARKET_WEAK / 資金制約で先に止まるため）。
挙動を変えない設定変更は、後で原因追跡を難しくするだけなので推奨しない。

### B-1 VAP
A1 でも A2 でも不十分。**Vision変更はVAPの解ではない。** 真因は
(a) T1〜T18 の資金制約で CAPEX が 0、(b) VAP設備の単価が極端に高い（下記 value scale 監査）。
`growthAmbition` を LOW→MEDIUM にする根拠は観測できなかった。

### B-2 JPQ
HIGH のままでよい。MEDIUM へ落としても挙動は完全に同一であり、
「quality型として自然」という表現上の理由しかない。mix は A1 でも維持される。

### B-3 BAL
60kt は強すぎない。T8 の CAPEX / cash / debt が Case 0 と同一で、
T32 の backlog が 0、distress 0.6 のまま。追加の 55/65kt shadow は
挙動差が小さいと見込まれるため実施していない（必要なら同じ手順で再現可能）。

### B-4 CONSV
45kt でも debt 0・distress 0 を維持し、財務姿勢は十分差別化される。

### B-5 MASS
**Vision 90kt / 95kt の比較は意味が薄い。** opportunity architecture が先に binding であり
（`realisticOpportunity 59.5kt < baseline 63.6kt`）、Vision を上げるほど
ambition と backlog だけが増えて生産は増えない。
MASS は Vision ではなく opportunity architecture 側の判断が先である
（`SAI_MASS_OPPORTUNITY_ARCHITECTURE_AUDIT.md` 参照）。

## 9. Stop / 注意

* 評価レンジ（MASS 90-100 / BAL 55-65 / JPQ 45-55 / VAP 45-55 / CONSV 45-50 kt）は
  **shadow評価にのみ使用し、AIの入力にもコードにも入れていない。**
* Case A1 でも **VAP は 31.6kt、MASS は 55.6kt** にとどまり、評価レンジには届かない。
* Vision を正式変更しても解けないのは VAP と MASS の2社である。
