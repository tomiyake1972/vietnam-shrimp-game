# ShrimpX V2 — SAI-GROW-3 PRE-AUDIT
## Growth / Deliverable Commitment / Liquidity / Survival Architecture Audit

**種別**: 実装前監査（**コード変更なし。新しい制御ロジックは一切実装していない**）
**監査対象コード**: `claude/nifty-faraday-q3y7gs` = `a9f869d`（SAI-GROW-3A）
**再現に使った世界**: `origin/feature/v2-dynamic-scenario-3`（DS3、6 commits / base `0400c4a`）を
**ローカル一時ブランチ `audit/grow3-preaudit` へマージして実行のみ**（push していない。
integration / develop/v2 / main へのマージも行っていない）。
**current integration HEAD**: `0400c4a`（GROW-2/3A の base と同一。integration側に新規commitなし）

---

## Part 0. 監査サマリ（先に結論）

| # | 事象 | 直接原因 | レイヤー |
|---|---|---|---|
| **F-1** | MASS 受注残 231kt（seed ds3-a・T32。DS3班8seed平均196kt） | **Commercial Commitment に「納品可能量（生産能力・原料・資金）」のcapが1つも無い**。提出≒成約100%で、成約が生産を毎期上回り続ける | Standard AI（Commercial） |
| **F-2** | BAL T2–T4 に CAPEX 26.3M（開始現金49.2Mの53%）を投下 | **CAPEX財務ゲートが「1案件・当期のみ・当期の他提案を無視」で判定**。同一Turn内の複数提案と既承認案件の残支払を合算しない | Standard AI（CAPEX） |
| **F-3** | BAL T5以降 恒常的な現金0・毎期借入 | **借入判断（working capital）に確定CAPEX支払が入っていない**。必要現金の定義が財務判断とCAPEXゲートで別物 | Standard AI（Finance） |
| **F-4** | BAL T26以降 国内調達0 → T28以降 生産0 | engine側の `computeProcurementConstraint`（現金按分）で買付が0に縮小。AIは毎期18,963t を希望し続ける | Engine（流動性） × Standard AI（調達） |
| **F-5** | 生産0でも常用worker 5,525人を維持し −13.96M/四半期の固定費が残る | **生産計画が「資金で買える原料量」ではなく受注残から立つ**ため、労務の過剰判定（sustainedExcess）が永久に成立しない | Standard AI（Production→Labor） |
| **F-6** | 回復不能（T28以降 借入0・現金−45.5M・純資産−52.6M） | `underwritingFrozen = creditTier E ∨ severeArrears ∨ insolvent` で通常融資停止。**Standard AI側に縮小・撤退・固定費削減の回復モードが存在しない** | Engine（与信） × Standard AI（回復） |

**GROW-1/2/3A との関係**: F-1・F-2・F-4・F-5 はいずれも **GROW以前から存在する構造**である
（F-1 は Turn1 から受注残が単調増加しており、GROW-2/3Aの寄与は末端の数%）。
Growth側を更に開けると顕在化が早まるだけであり、**先に納品可能性と資金の層を作る必要がある**。

---

## Part 1. Standard AI decision call graph（`policy.ts` 実行順）

```
generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, params, salesParams, visionOverrides)
 1  buildStandardAiObservation                       … 観測スナップショット（情報境界の唯一の入口）
 2  computePressureScores                            … cashPressure / borrowingPressure / targetMinimumCashUsd 等
 3  buildStandardAiUnitEconomics / situationDiagnosis … 診断（意思決定へは限定的にのみ使用）
 4  assessStandardAiCrisisState                      … NORMAL / LIQUIDITY_STRESS / SEVERE_DISTRESS
 5  computeTargetScaleBand → resolveCompanyVision → computeStrategicGrowthState
 6  computeObservableCommercialOpportunity + computeOrientationWeightedOpportunity
 7  computeGrowthPressureCore  【GROW-2/3A】          … score / adaptive share / growth step 倍率
 8  computeCommercialAmbition  ← (7)のshare・step倍率
 9  observeContractConversion → computeCommercialCommitment ← (7)のshare
10  applyCrisisGateToCommercialCommitment
11  buildStandardAiSalesPlans  ← ambitionMultiplier, submissionTarget
12  buildCurrentPeriodDeliveryDemand → computeEligibleCurrentPeriodDemand
    → computeNormalInventoryTargetByProduct → computeBasicCurrentPeriodProductionRequirement
13  buildStandardAiProductionPlans   ← 12（工場能力でcap）
14  buildStandardAiProcurementPlan   ← 13の合計のみ
15  buildStandardAiWorkerAssignments ← 13
16  buildStandardAiFinancingRequest  ← 14（domestic/import数量）＋ targetMinimumCash
17  buildStandardAiCapexDecision     ← 13のneededByProduct・稼働率・財務ゲート
18  evaluateNewFactoryDecision       ← Vision/gap/稼働率/需要/原料/労働/財務
19  buildStandardAiSalesForceHiringDecision ← 11の希望・targetScale・実効生産能力
20  Crisis Gate（SEVERE_DISTRESS時: 新規CAPEX停止・営業採用0・VAP開発停止）
21  buildStandardAiDividendDecision
22  assessGrowthPressure（診断のみ）
```

**構造上の要点**: 16（資金）は 14（調達）より後だが、**17（CAPEX）は16の結果を見ていない**。
また 13（生産計画）は 16 の資金判断を見ない。つまり
「作る → 買う → 資金が足りるか」の順で、**資金が足りないときに前段を作り直す経路が無い**。

---

## Part 2. Commercial Ambition → Commitment（F-1の直接原因）

```
ambition = min( baseline × (1 + baseStep × 倍率),      ← GROW-3A
                visionCeiling,
                attainableProfitable × effectiveAmbitionShare )   ← GROW-2
submission = min( ambition / expectedConversion,
                  ambition × maximumStretchOverAmbition(1.25),
                  attainableProfitable × effectiveCommitmentShare, ← GROW-2
                  salesCapacityCeilingTons )                      ← 営業工数のみ
```

**cap に無いもの（重要）**
- 当期・次期の **生産能力**（`computeBindingProductionCapacityTons`）
- **原料の入手可能量**（在庫＋確定入荷＋当期調達可能量）
- **資金で買える原料量**（`assessWorkingCapitalNeed` の結果）
- **既存受注残の消化可能性**（backlogは提出量を1トンも減らさない。`commercialCommitment.ts §12` が
  「在庫を理由に提出を減らさない」と明示。backlogについても同様の扱い）

MASS DS3（seed ds3-a）実測:

| Turn | 提出 | 成約 | 生産 | 受注残 | 原料入手 | 生産能力anchor |
|---|---|---|---|---|---|---|
| 8 | 21,398 | 21,398 | 14,429 | 36,409 | 9,676 | 16,673 |
| 16 | 26,513 | 26,513 | 19,927 | 73,732 | 15,471 | 20,093 |
| 24 | 58,184 | 58,184 | 39,096 | 80,722 | 34,088 | 44,460 |
| 32 | 69,318 | 69,318 | 54,045 | **231,397** | 49,643 | 72,675 |

- 成約は提出の **99.5〜100%**（市場は拒否していない）。
- 受注残は **Turn1 から単調増加**（T1 5,510 → T8 36,409）。GROW以前からの構造。
- T32 は生産能力（72,675）ではなく **原料（49,643t）** が生産の制約。
- 未履行のまま積み上がった受注残は納期超過となり、以後の顧客信頼・納期信頼性を毀損し続ける。

---

## Part 3. Factory / PD / VAP CAPEX（F-2の直接原因）

`decision/capex.ts` の財務ゲート（`financialGateFor(projectType)`）:

```
requiredCash = targetMinimumCash + projectCost × (1 + capexCostSafetyRatio 0.5)   … costBasedモード
safe = (observation.cashUsd > requiredCash) ∧ (pressures.borrowingPressure < 1)
```

**4つの構造欠陥**
1. **案件単位**: `projectCost` はその案件1件の標準予算のみ。同一Turnに複数案件
   （BAL T3 は2件、T2〜T4 で計3件）を提案しても、**各案件が満額の現金を見る**。
2. **当期のみ**: `paymentSchedule` を持つ案件（新工場は複数四半期に分割払い）でも、
   **既承認案件の今後の支払予定が requiredCash に入っていない**。
3. **当期の運転資金を見ない**: `observation.cashUsd` は期初現金であり、
   同じTurnに出ていく原料代・人件費・買掛・元利返済（＝`assessWorkingCapitalNeed` が
   既に計算している額）を差し引いていない。
4. **新工場ルートは別ゲート**: `newFactory.ts` Gate L は
   `upfrontCoverageRatioByRiskTolerance{HIGH .6 / MEDIUM .85 / LOW 1.1}` という**別式**。
   「必要現金」の定義が3箇所（capex / newFactory / finance）でバラバラ。

BAL DS3（seed ds3-a）実測:

| Turn | 期初現金 | 新規提案 | 稼働案件 | 投資CF | 期末現金 | 借入 |
|---|---|---|---|---|---|---|
| T1 | 49.2M | 0 | 0 | 0.0M | 49.2M | 48.5M |
| T2 | 49.2M | **1** | 1 | 6.6M | 35.3M | 47.0M |
| T3 | 35.3M | **2** | 3 | 10.4M | 23.4M | 45.5M |
| T4 | 23.4M | 0 | 3 | 9.3M | 11.6M | 44.2M |
| T5 | 11.6M | 0 | 1 | 0.0M | **−0.0M（資金不足）** | 30.5M |

開始時点で既に借入 48.5M ある会社が、3四半期で 26.3M を投資し、T5に現金が尽きた。

---

## Part 4. Borrowing / Procurement funding（F-3・F-4）

### 4.1 Standard AI 側（`decision/finance.ts` + `decision/workingCapital.ts`）

`assessWorkingCapitalNeed()` は既に「必要現金」を決定論的に計算している:

```
nearTermOperatingCashNeeds = 原料調達費(国内+輸入) + 人件費 + 買掛決済 + 元利返済
overallCashGap = nearTermOperatingCashNeeds + minimumCashBuffer − 現金 − AR回収見込み
domesticProcurementFundingGap = 国内買付費 − 現金 × domesticPurchaseCashAllocationRatio(1.0)
economicallyDesiredBorrowing = max(0, max(上2つ))
```

**欠落**: `nearTermOperatingCashNeeds` に **確定CAPEX支払（`CapitalProject.paymentSchedule` の当期分）が
入っていない**。したがって「投資しながら原料を買う」局面で必要額を過小評価する。
また `targetMinimumCash = max(5M, 四半期規模 × cashBufferQuarters 0.6)` は
**投資コミットメントと無関係**。

### 4.2 Engine 側（`financing/liquidityClose.ts`）

```
利用可能流動性 = max(0, 前期末現金) × domesticPurchaseCashAllocationRatio(1.0) + 承認融資
scaleRatio = clamp(利用可能流動性 / 国内買付必要額, 0, 1)
実際の国内買付 = 希望量 × scaleRatio
importOrdersBlocked = severeArrears ∨ insolvent
```

現金が尽きれば買付は比例縮小し、重大延滞・債務超過では輸入も止まる。
**AI側にはこの制約を先読みして希望量を落とす経路が無い**（希望は毎期そのまま出る）。

### 4.3 与信（`financing/borrowingCapacity.ts`）

```
grossLimit = min( max(担保ベース, 収益ベース), 信用区分×自己資本 )
underwritingFrozen = creditTier === "E" ∨ severeArrears ∨ insolvent   → 追加枠 0
```

BAL 実測: T10 で `paymentArrears`・与信枠0、T28 で `paymentDefault`・**frozen=true**。
以後は申請 141.8M〜195.9M に対し実行 0。

---

## Part 5. 既存の liquidity / reserve ロジック棚卸し

| # | 名称 | 場所 | 内容 | 使われ先 |
|---|---|---|---|---|
| L-1 | `targetMinimumCashUsd` | `parameters.ts::estimateTargetMinimumCashUsd` | `max(5M, 四半期規模 × 0.6)` | finance決定・CAPEXゲート・pressures |
| L-2 | `assessWorkingCapitalNeed` | `decision/workingCapital.ts` | 原料+人件費+買掛+元利 vs 現金+AR | **finance決定のみ** |
| L-3 | CAPEX cash gate | `decision/capex.ts` | `targetMinimumCash + cost × 1.5` | CAPEX提案のみ |
| L-4 | 新工場 upfront gate | `decision/newFactory.ts` Gate L | riskTolerance別カバレッジ | 新工場のみ |
| L-5 | 調達の現金抑制 | `decision/procurement.ts` | `cashPressure ≥ 0.7` で希望量を damping 0.5 | 調達のみ |
| L-6 | 期限前返済 | `decision/finance.ts` | 現金 > バッファ×2.5 で返済 | finance決定 |
| L-7 | engine 調達制約 | `financing/liquidityClose.ts` | 現金按分で買付縮小 | engine（事後） |
| L-8 | 与信凍結 | `financing/borrowingCapacity.ts` | E/延滞/債務超過で0 | engine（事後） |
| L-9 | Crisis Gate | `standardAi/crisisState.ts` | 提出縮小・CAPEX停止・採用停止 | 複数 |

**問題**: 「必要現金」を表す概念が L-1〜L-4 の**4通り**あり、どれも
「確定投資コミットメント＋次期運転資金」を一括で表していない。

---

## Part 6. Crisis / distress / Recovery

### 6.1 Crisis State（`crisisState.ts`）
入力は前Turnの `procurementScaleRatio` / `underwritingFrozen` / `importOrdersBlocked` /
`financialHealthTier` のみ。出力は NORMAL / LIQUIDITY_STRESS / SEVERE_DISTRESS。
効果は **(a) 新規提出量の縮小・停止、(b) 新規CAPEX提案の停止、(c) 営業採用の停止、
(d) VAP開発停止、(e) 配当停止** の5つ。

### 6.2 **回復（recovery）は存在しない**
BAL T28–T32 実測（すべて同値で固定）:

```
提出 0 / 成約 0 / 生産 0 / 受注残 103,413t
生産計画 34,628t（= 生産能力いっぱい）… 受注残から立つため0にならない
国内買付希望 18,963t / 実調達 0t
常用worker 5,525人（T12以降ずっと同数）
営業人員 60人（解雇0）
営業利益 −13.96M/四半期、純損失 −15.98M/四半期
現金 −45.5M、純資産 −52.6M、借入 51.6M、与信 frozen
```

**F-5の機序**: `decision/labor.ts` の縮小条件は
`sustainedExcess = isExcess ∧ hadPriorQuarterProduction ∧ requiredLastQuarter < 現有×0.9`。
`requiredRegular` は**当期の生産計画**から逆算されるが、その生産計画は
受注残（103,413t）に基づき能力いっぱいの 34,628t で立ち続ける。
したがって `isExcess` が永久に false → **人員は1人も減らない**。
「作れないのに作る計画を立て続け、その計画のために人を抱え続ける」状態である。

Standard AI に存在しない回復手段: 固定費の削減、工場の休止・売却、
受注残の放棄・納期再交渉、営業人員の縮小（layoff経路はあるが発火しない）、
生産計画の資金制約下での縮退。

---

## Part 7. MASS backlog root cause（F-1 詳細）

```
① submission が納品可能量と無関係に決まる（Part 2）
② 提出はほぼ100%成約する（DS3実測 99.5〜100%）
③ 生産必要量 = 当期納品需要 + 在庫目標 − 期首在庫、当期納品需要には受注残が100%入る
④ 生産は min(商品ライン能力, 共通前処理, 労働, 原料) で頭打ち
⑤ ③−④ の差が毎期そのまま受注残へ積み上がる（自己増殖）
⑥ 受注残が増えるほど③が増え、④は変わらないため差は拡大する
```

MASS DS3 実測の差分（成約−生産）: T23 +10,191 / T24 +19,088 / T28 +19,355 /
T32 +15,273 → 受注残 231,397t（生産能力の **3.2四半期分**）。

**注意**: これは「営業能力が高すぎる」問題ではない。DS3班の計測でも
営業能力 97,486 に対し生産能力 64,520 であり、**営業能力を下げるのではなく
Commitment に納品可能量のcapを入れるのが筋**である（営業能力を下げると
GROW-2/3Aで開けた市場機会がまた閉じる）。

---

## Part 8. BAL collapse root cause（F-2〜F-6 の連鎖）

```
T2–T4  CAPEX 26.3M（開始現金の53%）
        ← F-2: 案件単位・当期のみ・他提案を見ない財務ゲート
T5     現金0・資金不足 → 借入7.8M（申請12.0M）
        ← F-3: 借入必要額にCAPEX支払が入らず過小申請
T6–T25 毎期借入で凌ぐ。AR回収より先に原料代が要るため現金は常に0付近
        ← F-4: engineの現金按分で国内買付が縮小、AIは希望量を落とさない
T10    paymentArrears・与信枠0
T26    国内調達0
T28    生産0・paymentDefault・underwritingFrozen
T28–32 生産0のまま常用worker 5,525人・営業60人を維持 → −13.96M/四半期
        ← F-5: 受注残起点の生産計画により労務過剰判定が成立しない
        ← F-6: 縮小・撤退・固定費削減の回復モードが無い
T32    現金 −45.5M / 純資産 −52.6M（債務超過）
```

同一seedのDS2では同じ投資パターンでも CAPEX 14.4M に留まり完走している
（DS3班の記録）。**DS3で顕在化したのは、成長余地が大きい世界ではAIが投資を
前倒しするため、同じゲートの緩さが致命傷になる**ためである。

---

## Part 9. SSoT 候補（設計提案。**本Phaseでは実装しない**）

| # | SSoT候補 | 定義（案） | 置き換える現行の重複 | 使用先 |
|---|---|---|---|---|
| **S-1** | **Committed Cash Requirement** | 次期運転資金（原料+人件費+買掛+元利）**＋ 確定CAPEXの今後N四半期支払** ＋ 最低バッファ | L-1 / L-2 / L-3 / L-4 の「必要現金」4通り | finance決定・CAPEXゲート・新工場Gate L・将来のDIV-5 Required Reserve |
| **S-2** | **Fundable Procurement Volume** | `利用可能流動性 ÷ 期待原料単価`（engine `computeProcurementConstraint` と同一式） | AIが希望量をそのまま出す現状 | 調達計画・生産計画・Commitment |
| **S-3** | **Deliverable Capacity** | `min(binding生産能力, S-2由来の原料量, 労働で回せる量)` を当期＋次期で評価 | 無し（新設） | **Commercial Commitment の新しいcap**・生産計画・営業採用 |
| **S-4** | **Backlog Delivery Horizon** | `受注残 ÷ Deliverable Capacity`（四半期数） | 無し（新設） | Commitment抑制・納期信頼性の予防・診断 |
| **S-5** | **Survival Mode** | `crisisState` を拡張し、SEVERE_DISTRESS時に「生産計画を資金制約で縮退」「労務・営業を段階縮小」を許可 | 現状は"止める"だけで"縮む"が無い | labor / production / salesForce / procurement |

**S-1〜S-3 はいずれも既存の計算の再利用で作れる**（新しい経済モデルは不要）:
- S-1 は `assessWorkingCapitalNeed` に `CapitalProject.paymentSchedule` を足すだけ。
- S-2 は engine の `computeProcurementConstraint` と同じ式を先に自分で解くだけ。
- S-3 は `computeBindingProductionCapacityTons` に S-2 と労務を足した min。

---

## Part 10. Phase 分割の提案（#05判断待ち。実装は行っていない）

| 提案Phase | 内容 | 解決する事象 | 依存 |
|---|---|---|---|
| **GROW-3B-1** | S-1 Committed Cash Requirement を新設し、CAPEX財務ゲート・新工場Gate L・finance決定を**同一のSSoT**に統一（同一Turn内の複数提案と既承認案件の残支払を合算） | F-2・F-3（BAL崩壊の起点） | なし |
| **GROW-3B-2** | S-2/S-3 を新設し、**Commercial Commitment に Deliverable Capacity cap を追加** | F-1（MASS受注残） | S-2/S-3 |
| **GROW-3B-3** | 生産計画を「資金で買える原料」で縮退させ、S-5 Survival Mode で労務・営業を段階縮小 | F-5・F-6（回復不能） | S-2・S-5 |
| **GROW-3C** | 上記の後に、当初GROW-3で予定していた **Sales Hiring 先行許容** を再評価 | — | 3B-1〜3 |

**推奨順序**: 3B-1 → 3B-3 → 3B-2。
理由: 3B-1 は崩壊の起点を直接塞ぎ、他の層に依存しない。3B-3 は「壊れても死なない」を先に作る。
3B-2（Commitment cap）は成長を抑える方向であり、**先に入れると GROW-2/3A で開けた成長余地を
再び閉じかねない**ため、資金と生存の層を作った後に、
Deliverable Capacity を「抑制」ではなく「投資判断への圧力（Constraint Routing）」として
接続するのが望ましい。

---

## Part 11. 検証事実の出所

- 実行環境: ローカル一時ブランチ `audit/grow3-preaudit`（`a9f869d` + DS3ブランチのマージ、push無し）
- MASS: `COMPANY=MASS SEED=ds3-a npx tsx scripts/dynamicScenario3BalAudit.ts` および
  受注残・提出・成約・生産・原料の突合スクリプト（scratchpad、リポジトリ外）
- BAL: `SEED=ds3-a npx tsx scripts/dynamicScenario3BalAudit.ts`、
  および T28–T32 のP&L・worker・借入申請/実行の突合
- DS3班の既存記録: commit `ae735d2`（8seed平均 MASS 70,943t・受注残196,302t、
  営業能力97,486 > 生産能力64,520、BALのT2–T4 CAPEX 32.8M）
- コード: `policy.ts` / `vision/commercialAmbition.ts` / `vision/commercialCommitment.ts` /
  `decision/{capex,newFactory,finance,workingCapital,procurement,production,labor}.ts` /
  `financing/{liquidityClose,borrowingCapacity,bankUnderwriting}.ts` / `standardAi/pressures.ts`

**本監査で変更したコードは無い。** 新しい制御ロジックの実装は PRE-AUDIT 受入後に行う。
