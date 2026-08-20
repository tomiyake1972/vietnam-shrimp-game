# SAI-GROW-3B-3 — Deliverable Commitment / Backlog Discipline

base commit: `798d044`（3B-2）。GROW-2 / GROW-3A / Liquidity SSoT / Growth Financing /
Fundable Operations / Survival & Recovery はすべて維持。

## 1. 解決した構造

DS3 MASSで新規提出・成約が納品可能量を継続的に上回り、backlogが積み上がる。
実測（DS3 8seed平均、修正前）: MASS backlog **155,659t**、うち overdue **107,046t**。

分離したもの:

```
Strategic Growth Opportunity  ≠  Commercial Ambition  ≠  Immediate Deliverable Commitment
```

**Commercial Ambition（志）は一切下げない。** 下げるのは「今期の提出量」だけであり、
capが効いたことは「成長機会が無い」ではなく「次に何へ投資すべきか」のsignalとして出す。

## 2. Deliverable Capacity SSoT（`decision/deliverableCommitment.ts`）

### 2.1 納期（delivery horizon）は既存値

`sales/parameters.ts::standardLeadTimeTurns = 1`（実測で確認）。
今期成約した契約の納期は**翌四半期**である。「4Q固定」等の独自horizonは持ち込んでいない。

### 2.2 式

```
CurrentDeliverableCapacity  = 完成品在庫 + min(当期の実効生産能力, 資金手当て可能原料)
NearTermDeliverableCapacity = 納期到来時点の実効生産能力
```

* 当期の実効生産能力・納期時点の実効生産能力はいずれも
  `bindingCapacity.ts::computeBindingProductionCapacityTons`（商品別ライン合計と共通前処理のmin）。
  **物理ton合計だけでは判定していない**——商品別能力がそのまま効く（§11）。
* 納期時点の能力は `observation.nearTermEffectiveCapacityByProduct`。これは
  `capex/factoryConstruction.ts::computeEffectiveFactories` を**納期の四半期で呼んだだけ**であり、
  承認済みCapitalProjectの完成判定・新設Factoryの稼働開始・ramp-upはすべて既存関数のまま。
  未承認案件・Visionの構想は `capexState.portfolio` に存在しないため構造的に入らない（§7）。
* 原料資金の制約は**当期の概念**なので Current 側にだけ入れる。今期成約した契約の原料は
  翌四半期の資金で買うため、当期の現金で翌期の納品可能量を打ち切らない（§8。下記§6の訂正参照）。

### 2.3 Backlog（§3・§4・§5）

```
sustainableDeliverable   = max(NearTermDeliverableCapacity, 当期の生産納品可能量)
backlogDeliveryHorizon   = 既存受注残 / sustainableDeliverable          [四半期]
baseAllowance            = sustainableDeliverable × deliveryLeadTimeQuarters
normalBacklogAllowance   = max(0, baseAllowance − overdueBacklog)
excessBacklog            = max(0, 既存受注残 − normalBacklogAllowance)
```

* リードタイム1四半期のゲームでは**常に約1四半期分の受注残が存在するのが正常**。
  それが Healthy Forward Backlog であり、excess にはならない（§4・受入G3B3-6）。
* **Overdue は正常水準の枠を削る**形で効く。同じ受注残総量でも overdue の方が
  新規受注余力を強く減らす（§4・受入G3B3-7）。
* 自社の納品能力比なので、100kt企業の30ktと10kt企業の30ktが同じ危険度にならない（§5・受入G3B3-5）。
  固定の「backlog ◯kt以上」という閾値は置いていない。

### 2.4 Commitment Cap（§6）

```
remainingDeliverableHeadroom = max( max(0, NearTermDeliverableCapacity − excessBacklog),
                                    NearTermDeliverableCapacity × minimumMarketPresenceRatio )
deliverabilityCap            = remainingDeliverableHeadroom / expectedConversionRatio
finalSubmission              = min(既存Commercial Commitmentの結果, deliverabilityCap)
```

* `submissionTargetTons` は**提出量**（＝成約見込み ÷ 期待転換率）、納品余力は**成約量**の制約。
  提出量の上限へ直すため期待転換率で**1回だけ割り戻す**。二重にconversionを掛けない（受入G3B3-9）。
* `minimumMarketPresenceRatio` は新設定数ではなく、既存の
  `parameters.ts::minDomesticPurchaseRatioOfBase`（=0.2、「どんなときでも基準活動のこの割合は確保する」）
  をそのまま流用。過剰受注でも新規提出を0にせず市場から退出しない（§10・§16-D・受入G3B3-8）。

### 2.5 新しい閾値・新しいeconomic modelを作っていない

| 使った値 | 出所（既存） |
|---------|-------------|
| 納期 | `sales/parameters.ts::standardLeadTimeTurns` |
| overdue判定 | `sales/backlog.ts` と同じ `dueDate < currentPeriod` 規約 |
| 実効生産能力 | `bindingCapacity.ts::computeBindingProductionCapacityTons` |
| 納期時点の能力・ramp | `capex/factoryConstruction.ts::computeEffectiveFactories` |
| 資金手当て可能原料 | 3B-2 `fundableOperations.ts::computeFundableRawMaterial`（engineと同一式） |
| 期待転換率 | `vision/commercialCommitment.ts` の出力 |
| 市場プレゼンス下限 | `parameters.ts::minDomesticPurchaseRatioOfBase` |

company IDのhardcodeは0件（受入G3B3-12でソースを走査）。
`computeCommercialCommitment` 本体・Sales Capacity Engine・Commercial Ambition はいずれも無変更。

## 3. Constraint Routing（§9）

capが効いたときは「成長機会が無い」とは診断せず、次の投資先へrouteする。

| reason code | 意味 | 次に繋ぐ先（GROW-3C） |
|-------------|------|---------------------|
| `DELIVERABLE_LIMIT_BACKLOG` | 正常水準超の受注残が納品能力を食っている | まず捌く／Production CAPEX |
| `DELIVERABLE_LIMIT_RAW_MATERIAL` | 資金手当て可能な原料が足りない | Procurement拡大 |
| `DELIVERABLE_LIMIT_LIQUIDITY` | 原料不足の原因が資金である | 資金調達 |
| `DELIVERABLE_LIMIT_PRODUCTION` | 生産能力が足りない | Production CAPEX / Worker |
| `DELIVERABLE_COMMITMENT_ASSESSED` | capは効いていない | — |

診断1件に §13 の全項目を記録（commercialAmbitionTons / commercialCommitmentBeforeDeliverability /
deliverableCapacityCurrent / NearTerm / existingBacklog / healthyForward / overdue /
normalBacklogAllowance / excessBacklog / carryOver / backlogDeliveryHorizon /
remainingDeliverableHeadroom / deliverabilityCap / finalSubmissionTarget /
incrementalSubmissionReduction / deliveryLeadTimeQuarters / applied）。
`diagnostics.deliverableCommitment` からも同じ評価を読める。

## 4. Survivalとの適用順（§12）

```
computeCommercialCommitment（無変更）
  → Deliverability cap   … crisisState === NORMAL のときだけ適用
  → Crisis Gate（既存）  … LIQUIDITY_STRESS 0.7倍 / SEVERE_DISTRESS 0
```

危機会社では既存Crisis Gateと3B-2 Fundable Operationsが先に効いているため、
deliverability capは適用しない（二重抑制で0へ潰さない）。受入G3B3-15で固定。

## 5. 実測

### 5.1 MASS（DS3 seed ds3-a、turn-by-turn の要点）

| | before (798d044) | after (3B-3) |
|---|---|---|
| T32 backlog | **145,075t** | **55,366t** |
| T32 overdue | **91,197t** | **5,120t** |
| T32 backlog delivery horizon | 2.29四半期相当 | **0.54四半期** |
| T32 Commercial Ambition | 64,360t | 64,080t（維持） |
| T32 生産 | 53,400t | 54,552t |
| T32 Cash | 539.5M | 632.3M |

### 5.2 DS3 8seed × 5社（T32平均）

| 会社 | ambition | 生産 | backlog | overdue | horizon | CAPEX累計 | cash | distress |
|------|---------:|-----:|--------:|--------:|--------:|----------:|-----:|---------:|
| MASS before | 63,342 | 54,912 | **155,659** | **107,046** | — | 103.2M | 525.4M | 3.0 |
| MASS **after** | **63,670** | 54,163 | **64,779** | **17,462** | **0.76** | 92.4M | 491.0M | **1.2** |
| BAL before → after | 58,760 → 58,890 | 44,882 → 44,432 | 0 → 494 | 0 → 0 | 0.01 | 79.2 → 87.8M | 634.9 → 588.5M | 0.9 → 0.6 |
| JPQ before → after | 43,380 → 44,120 | 39,752 → 36,740 | 49,365 → 33,778 | 23,630 → 18,038 | 0.88 | 85.0 → 81.3M | 645.2 → 627.4M | 0.4 → 0.5 |
| CONSV before → after | 41,645 → 42,205 | 39,843 → 39,668 | 14,109 → 17,570 | 0 → 1,132 | 0.34 | 81.1 → 86.8M | 646.0 → 630.4M | 0.0 → 0.0 |
| VAP before → after | 39,355 → 32,220 | 37,887 → 29,309 | 46,016 → 27,138 | 22,694 → 7,703 | 0.76 | 72.8 → 50.0M | 442.9 → 398.7M | 3.9 → 3.9 |

MASS・JPQ・CONSV・BAL は Commercial Ambition を維持したまま backlog / overdue が減った。
VAPのみ規模が縮んだ（§7 Stop Condition E）。

### 5.3 DS1 / DS2 regression

DS1（T25-32）: BAL 633.2M → 636.9M、JPQ 391.7M → 391.8M、VAP 356.6M → 356.7M、
CONSV 379.5M → 379.6M、MASS −40.9M（変化なし）。生産はいずれも±0.6%以内。

DS2（8seed × 5社）:

| 会社 | avg OP | avg 生産 | 資金不足T計 |
|------|-------|---------|------------|
| BAL | 1030.8 → 1030.2M | 654,022 → 654,420 | 0 → 0 |
| MASS | 950.7 → 929.8M | 690,841 → 685,723 | 0 → 0 |
| JPQ | 764.3 → 764.5M | 600,619 → 601,395 | 0 → 0 |
| CONSV | 744.9 → 740.7M | 560,385 → 558,196 | 1 → 1 |
| VAP | 644.7 → 646.7M | 512,276 → 515,235 | 0 → 0 |

## 6. 実装中の訂正（silent tuningをしていない記録）

1. **near-term capacityを当期の資金で打ち切っていた**: 当初 `min(納期時点の能力, 当期の資金手当て可能原料)`
   としたが、翌期納品の原料は翌期の資金で買うため誤り。健全なJPQのT1提出が 18,667t → 2,778t に潰れ、
   既存回帰テスト**21件**が落ちた。原料資金は Current 側にのみ入れる形へ訂正。
2. **overdueを無条件に差し引いていた**: 受注残総量が正常水準を大きく下回る会社にも overdue 全額を課し、
   JPQ / CONSV / VAP の生産が17〜22%落ち Commercial Ambition まで縮んだ（DS3 8seed実測）。
   overdueは「正常水準の枠を削る」形へ訂正。
3. **過剰受注時に提出が0になった**: 能力を極端に縮めた受入F-1で新規提出が0になり、
   「生産能力不足を販売へ機械的に伝播させない」という既存の禁止事項に抵触。
   既存の `minDomesticPurchaseRatioOfBase` を市場プレゼンス下限として流用して訂正。

## 7. Stop Conditions

| id | 判定 | 実測 |
|----|------|------|
| A. MASS backlogがほぼ変わらない | **なし** | 8seed平均 155,659 → 64,779t（−58%）、overdue −84% |
| B. MASSのsalesが大幅に崩れる | **なし** | 生産 54,912 → 54,163t（−1.4%）、cash 525 → 491M |
| C. Commercial Ambition自体が縮む | **VAPのみ該当** | MASS/BAL/JPQ/CONSVは維持〜微増。VAPは 39,355 → 32,220（−18%） |
| D. 全社が低submissionへ収束 | **なし** | cap適用は32観測点中 BAL 9 / MASS 17 / JPQ 21 / CONSV 9 / VAP 17。全社一律ではない |
| E. VAP/JPQが物理ton換算の誤りで過剰抑制 | **VAPは要判断** | 判定は商品別能力由来の binding capacity のみを使い物理ton合計では判定していないが、VAPは生産 −23%。overdueは 22,694 → 7,703 へ改善しており「小さいが納期を守る会社」へ移行している |
| F. CAPEX completionを過大評価してbacklog再増大 | **なし** | 納期時点の能力は既存 `computeEffectiveFactories` のramp・完成判定そのまま。全社でbacklog horizonが1.0四半期以下 |
| G. DS1/DS2 regression | **なし** | いずれも±2.5%以内 |
| H. capが次のGrowth investment signalへ繋がらない | **なし** | 4種の `DELIVERABLE_LIMIT_*` へrouteし、binding constraintを診断に記録（§3） |

## 8. 次のbinding constraint

1. **VAPの規模縮小（最優先の判断事項）**: VAPはWorker intensityが高く、overdueが常態化していた。
   deliverability disciplineで納期は守るようになったが規模が−18〜23%。
   「小さく確実」を許容するか、VAP向けにProduction CAPEX / Worker側で能力を先に伸ばすか（GROW-3C）は#05判断。
2. **Deliverability signal → 投資判断の接続（GROW-3C）**: `DELIVERABLE_LIMIT_*` は現在診断までであり、
   Production CAPEX / Procurement / Worker / Sales Hiring の優先順位へはまだ繋いでいない。
3. **固定製造費の不可逆性（3B-2 Stop Condition I、engine側課題）**: 工場閉鎖・売却は#04へ。
   本Phaseでは実装していない（§17）。
4. CONSVのDS2 ds2-s8 1T資金不足（未解消）。
