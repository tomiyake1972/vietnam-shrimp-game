# SAI-CAP-1 — Physical Bottleneck Recognition & CAPEX Routing

| | |
|---|---|
| base | `origin/claude/nifty-faraday-q3y7gs @ 997d0a9` |
| branch | `feature/v2-sai-cap-1` |
| 実装 commit | `fa37765` |
| 測定 | DS3 4seed（ds3-a〜d）／DS1 4seed／DS2 4seed × 32Turn、engine 直接実行 |
| #04 参照（merge していない） | `52a9acd` benchmark 表示修正 / `3df1612` DS3 Capacity・CAPEX 監査 |

---

## 1. 修正した root cause

Standard AI の物理能力認識は

```
min(Σ商品別ライン, 共通前処理)
```

であり、生産エンジン `production/allocation.ts` の**段階3（冷凍・包装）が丸ごと欠落**していた。
実際の制約順序は

```
段階1 原料
段階2 共通前処理（原料投入側。ここを通った量に歩留まりを掛けて完成品側へ変換）
段階3 冷凍・包装（完成品側）
段階4 商品別ライン（完成品側）
段階5 労働
```

であり、共通前処理だけが原料投入側の量である点も扱われていなかった。

新しい式（`standardAi/bindingCapacity.ts`）:

```
bindingPhysicalCapacityTons = min(
    Σ商品別ライン能力,
    共通前処理能力 × 販売可能回収率,
    冷凍・包装能力
)
```

回収率は `PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio`（現行 全商品 1.0）。
したがって換算そのものは現時点で数値を変えない＝**挙動差はすべて冷凈・包装の追加に由来する**。

### 旧／新の物理能力（DS3 4seed 平均・T32）

| 会社 | ライン計 | 共通前処理 | 冷凍・包装 | 旧認識 min(line, common) | **新認識** | 差 |
|---|---:|---:|---:|---:|---:|---:|
| MASS | 72,397 | 67,973 | 66,006 | 67,973 | **66,006** | −1,967 |
| BAL | 63,730 | 63,270 | 60,021 | 63,270 | **60,021** | −3,249 |
| JPQ | 46,213 | 44,460 | 44,289 | 44,460 | **44,161** | −299 |
| VAP | 35,344 | 44,460 | 42,750 | 35,344 | **35,344** | 0（ライン律速） |
| CONSV | 44,578 | 44,460 | 44,118 | 44,460 | **43,851** | −609 |

VAP はライン律速のため新旧同値。**全社が冷凍・包装へ収束してはいない**（§19 の
all-company packaging convergence に該当しない）。

---

## 2. canonical 関数の再利用と工場 lifecycle

- 能力値は必ず `production/capacity.ts::calculateFactoryEffectiveCapacity` を通った
  `observation.totalEffective*` / `nearTermEffective*` を受け取る。物理式を再実装していない。
- 工場集合は `capex/factoryConstruction.ts::computeEffectiveFactories`
  （runner / simulation engine / AI Analysis Pack と同一関数）由来。
- `calculateFactoryEffectiveCapacity` は `factory.status !== "active"` の工場へ
  全プール 0 を返すため、非稼働工場は構造的に集計へ入らない。
  **本Phaseでは `factory.status` の判定を一切自前で書いていない。**

### ENG-FAC-1 について（§3 の確認結果）

本 base に ENG-FAC-1（Factory Mothball / Sale）は**未搭載**。
`FactoryStatus` は `"active" | "idle" | "suspended"` のみで、MOTHBALLED / SOLD は存在しない
（ENG-FAC-1 は `origin/feature/v2-sai-growth-liquidity-survival @ fa072b8` にあり、未 merge）。

Engine lifecycle の再実装は行っていない。lifecycle 判定は canonical 関数の中だけに存在し、
本Phaseはその結果を受け取るだけなので、ENG-FAC-1 が merge され MOTHBALLED / SOLD が
非稼働として扱われるようになれば、**bindingCapacity 側の変更なしに自動的に追従する**。
テスト CAP1-5 / CAP1-6 は本 base に実在する非稼働 status で同じ性質を検証している。

---

## 3. freezingPackagingExpansion の提案経路

`STANDARD_AI_PROPOSABLE_CAPEX_TYPES` へ追加し、共通前処理と同一形の判定ブロックを新設した
（shortfall / 持続性 / 財務 / 重複 / スペース / routing の6ゲート）。
既存 `CAPEX_PARAMETERS_V1.templatesByType.freezingPackagingExpansion`（2.8M / +800t/Q）を
そのまま使用。シナリオ固有係数・新価格は追加していない。

`coldStorageExpansion` は追加していない（ストックであり段階3のフロー上限とは意味が異なるため）。

---

## 4. commonProcessingExpansion が DS3 32Turn で0件だった原因（§6）

持続性判定の分子が**前期の実績生産量**だった。実績生産量は段階1〜5をすべて通った後の値であり、
より小さい別プールで既にクリップされている。MASS の実測では

```
共通前処理 63,270t / 冷凍・包装 59,850t / 実績生産 53,634t
→ 共通前処理の稼働率 = 53,634 / 63,270 = 0.847 < しきい値 0.92
```

となり、**構造的に到達不能**だった。

共有プールに限り、分子へクリップ前の需要も採る `sustainedForSharedPool` を追加した。
使用したのは既存指標のみで、新しい需要モデルは作っていない。

| プール | クリップ前の指標 | 側 |
|---|---|---|
| 冷凍・包装 | `productionNeededByProductBeforeCap` の合計 | 完成品側 |
| 共通前処理 | `requiredRawMaterialUnconstrained` | 原料投入側 |

実績と需要の**大きい方**を採るため、需要が能力を下回る平常時は従来と同一判定になる
（能力に余裕がある会社で新たに投資が誘発されない）。しきい値 0.92 は変更していない。

---

## 5. Bottleneck-aware CAPEX routing（§7〜§9）

候補ごとに `incrementalDeliverableCapacityTons` を評価する。

```
before      = bindingPhysicalCapacity(現在のプール)
after       = bindingPhysicalCapacity(候補適用後のプール)
incremental = max(0, after - before)
```

能力算出は `computePhysicalCapacity` を再利用（routing 側で能力式を再実装しない）。
テンプレートの `capacityIncreaseTonsPerQuarter` は名目値のため、実効プールへ加算する前に
observation の名目／実効比（= `baseUtilizationRate × equipmentAvailabilityRate`）を掛ける。

MASS T24〜T32 の実例（line 68.8kt / common 63.3kt / freezing 59.85kt）:

| 候補 | 名目 +t | binding への効果 | incremental |
|---|---:|---|---:|
| hosoLineExpansion | +4,000 | binding は冷凍・包装のまま | **0** |
| commonProcessingExpansion | +700 | 同上 | **0** |
| freezingPackagingExpansion | +800 | 59.85kt → 60.65kt | **+800** |

### 採否条件を incremental > 0 にしなかった理由

2プールが同値（TIED）のとき、どちらを1件増やしても binding は動かず incremental = 0 になり、
**どちらも提案されず永久に詰まる**。TIED は「順に解消すべき状態」であって
「投資しなくてよい状態」ではない。そこで採否は

> 候補が現在 binding しているプールを対象にしているか（`headroomByPool[pool] ≒ 0`）

とし、incremental は §11 の診断項目として併記する（binding 外への投資が納品可能量を
1トンも増やさないことを診断から追える）。

### ライン増設への適用範囲

今期のボトルネック解消経路にのみ課す。SAI-5F のライフサイクル成長エントリ
（公開トレンドに基づく将来の商品構成シフトへの先行投資）は判断の目的が異なるため対象外とし、
既存のトレンド・稼働率・在庫・財務条件にそのまま委ねている。

会社ID・シナリオIDによる分岐は一切追加していない。
`MAX_FACTORIES_PER_COMPANY` / 同時進行案件上限 / 新工場テンプレート / CAPEX cost は無変更。

---

## 6. DS3 before / after（4seed 平均）

### 6-1. MASS（§16 の成功判定）

| 指標 | T24 before → after | T28 before → after | T32 before → after |
|---|---|---|---|
| 冷凍・包装能力 | (未記録) → 47,709 | (未記録) → 50,360 | **59,850 → 66,006** |
| 物理能力（新定義） | 48,949 → 47,709 | 51,514 → 50,317 | 67,973※ → **66,006** |
| 生産計画 | 47,025 → 47,709 | 47,025 → 47,859 | **59,850 → 61,389** |
| 実生産 | 39,617 → **40,522** | 42,206 → **45,042** | 53,242 → **56,246** |
| 出荷 | 40,679 → 41,730 | 42,206 → **45,236** | 53,372 → **55,031** |
| backlog | 17,105 → 15,212 | 50,699 → **38,127** | 59,289 → **54,822** |
| overdue | 0 → 0 | 8,506 → **2,530** | 18,189 → 18,769 |
| worker | 13,855 → 14,007 | 15,575 → 16,053 | 19,951 → 20,522 |
| 累計CAPEX | 48.1M → 47.2M | 68.6M → 68.1M | 91.2M → 99.8M |
| 現金 | 169M → 167M | 316M → 326M | 486M → **520M** |
| 借入 | 123.0M → 124.9M | 0 → 0 | 0 → 0 |
| 資金不足Turn | 0 → 0 | 0 → 0 | 0 → 0 |

※ before の「物理能力」は旧定義 min(line, common) の値。当時の実際の生産上限は
冷凍・包装 59,850t であり、AI はそれを 67,973t と誤認していた。

**§16 判定**

| 条件 | 結果 |
|---|---|
| freezingPackagingExpansion > 0 | **13件**（4seed 合計。before 0件） ✔ |
| T32 冷凍・包装 > 59.85kt | **66,006t** ✔ |
| 物理能力上昇 | 59,850 → 66,006（+10.3%） ✔ |
| 無駄なライン増設の減少 | hosoLine 12 → 11 ✔ |
| production 上昇 | 53,242 → 56,246（**+5.6%**）、T28 は +6.7% ✔ |
| 次 binding の明確化 | T32 で依然 FREEZING_PACKAGING（水準は上昇）。§8 参照 |

CAPEX 件数が増えただけではなく、生産・出荷・backlog がいずれも改善している。
特に T28 の overdue −70.3%（8,506 → 2,530）、backlog −24.8% が大きい。

### 6-2. 他社（T32・4seed 平均）

| 会社 | 実生産 | 出荷 | backlog | overdue | 累計CAPEX | 現金 | 借入 | 資金不足T |
|---|---|---|---|---|---|---|---|---|
| BAL | 43,950 → 44,089 | 43,488 → 43,488 | 0 → 0 | 0 → 0 | 81.6M → 82.3M | 586M → 584M | 0 → 0 | 0 → 0 |
| JPQ | 38,113 → **40,728** | 36,708 → **39,033** | 36,476 → 34,448 | 18,377 → **13,995** | 82.5M → 84.3M | 628M → 628M | 0 → 0 | 0 → 0 |
| VAP | 29,689 → 29,689 | 29,328 → 29,327 | 28,429 → 28,429 | 10,026 → 10,027 | 51.9M → 51.9M | 348M → 348M | 0 → 0 | 0.3 → 0.3 |
| CONSV | 39,861 → **41,108** | 40,890 → 41,463 | 13,916 → **11,801** | 439 → 324 | 85.1M → **81.9M** | 619M → 610M | 0 → 0 | 0 → 0 |

- **BAL**（§17）: ほぼ完全に不変。追加CAPEX は +0.7M、現金 −2M、借入 0、資金不足 0Turn。
  過去の破綻の再発は無い。冷凍・包装案件は 4seed 合計で 1件のみ。
- **JPQ**（§17）: 生産 +6.9%・出荷 +6.3%・overdue −23.8%。
  PD 志向は維持（pdLine 14→12、vapLine 10→9 で構成順序は不変）。
- **VAP**（§17）: **全指標が不変**。VAP はライン律速（35,344 < 冷凍42,750）であり、
  冷凍・包装案件は 0件。working capital 制約期に受注・投資が膨らんでいない。
- **CONSV**（§17）: 生産 +3.1%・backlog −15.2% を、**CAPEX を減らしながら**達成
  （85.1M → 81.9M）。無駄なライン増設が binding 解消へ振り替わった結果。
  LOW risk posture は維持（借入 0・資金不足 0Turn）。

### 6-3. CAPEX 承認件数（DS3 4seed 合計・種別別）

| 会社 | before | after |
|---|---|---|
| MASS | hosoLine 12 / newFactory 12 / qualityControl 4 | **freezingPackaging 13** / hosoLine 11 / newFactory 12 / pdLine 2 / qualityControl 5 |
| BAL | hosoLine 9 / newFactory 8 / pdLine 9 / pdMech 4 / qc 7 / vapLine 4 | **freezingPackaging 1** / 他は同一 |
| JPQ | common 1 / hosoLine 12 / newFactory 4 / pdLine 14 / pdMech 8 / qc 8 / vapLine 10 | common 1 / **freezingPackaging 11** / hosoLine 11 / newFactory 4 / pdLine 12 / pdMech 8 / qc 8 / vapLine 9 |
| VAP | newFactory 4 / pdLine 11 / pdMech 8 / qc 8 / vapLine 8 | **完全に同一**（freezingPackaging 0） |
| CONSV | hosoLine 11 / newFactory 4 / pdLine 18 / pdMech 8 / qc 8 / vapLine 12 | **common 1** / **freezingPackaging 8** / hosoLine 10 / newFactory 4 / pdLine 13 / pdMech 8 / qc 8 / vapLine 9 |

- newFactoryConstruction の件数はどの会社でも**変わっていない**
  （新工場が第一候補へ寄る現象は起きていない。§9 の懸念に該当しない）。
- commonProcessingExpansion は JPQ 1件（従来どおり）＋ CONSV 1件（新規）。
  §6 の修正で発火可能にはなったが、多くの会社では冷凍・包装のほうが先に binding するため
  乱発していない。

---

## 7. DS1 / DS2 regression（各4seed・T32）

**DS1 は全社・全項目が before / after で完全一致。**
**DS2 も MASS の実生産が 27,998 → 27,997（−1t、丸め差）のほかは全項目一致。**

| scenario | 会社 | 実生産 before→after | CAPEX | 現金 | 借入 | 資金不足T |
|---|---|---|---|---|---|---|
| DS1 | MASS | 0 → 0 | 0.0M → 0.0M | −47M → −47M | 43.7M → 43.7M | 23.0 → 23.0 |
| DS1 | BAL | 28,007 → 28,007 | 56.3M → 56.3M | 576M → 576M | 0 → 0 | 0 → 0 |
| DS1 | JPQ | 28,721 → 28,721 | 54.1M → 54.1M | 604M → 604M | 0 → 0 | 0 → 0 |
| DS1 | VAP | 13,419 → 13,419 | 41.4M → 41.4M | 346M → 346M | 0 → 0 | 0 → 0 |
| DS1 | CONSV | 29,769 → 29,769 | 60.4M → 60.4M | 433M → 433M | 0 → 0 | 0 → 0 |
| DS2 | MASS | 27,998 → 27,997 | 40.0M → 40.0M | 387M → 387M | 0 → 0 | 0 → 0 |
| DS2 | BAL | 29,267 → 29,267 | 56.8M → 56.8M | 522M → 522M | 0 → 0 | 0 → 0 |
| DS2 | JPQ | 27,883 → 27,883 | 56.4M → 56.4M | 526M → 526M | 0 → 0 | 0 → 0 |
| DS2 | VAP | 13,164 → 13,164 | 41.1M → 41.1M | 351M → 351M | 0 → 0 | 0 → 0 |
| DS2 | CONSV | 27,979 → 27,979 | 54.4M → 54.4M | 450M → 450M | 0 → 0 | 0 → 0 |

理由: DS1 / DS2 では冷凍・包装（42,750t）が binding になる局面がほとんど無く、
ライン能力が先に律速する。**真にボトルネックのときだけ発火する**という設計どおりの結果。

**DS1 MASS の破綻（生産0・現金 −47M・資金不足23Turn）は before / after で完全に同一**であり、
CAP-1 による regression ではない。SAI-GROW-3B-2 で記録済みの既存事象
（`unabsorbedFixedManufacturingCost` + 利息の irreducible floor、#04 Engine 課題）。

---

## 8. 残る binding constraint（次Phaseへの引き渡し）

### MASS（DS3 T32）

```
物理能力 66,006（= 冷凍・包装。依然として binding）
      ↓
生産計画 61,389
      ↓
実生産   56,246   ← 物理能力との差 9,760t
```

- 冷凍・包装は **+800t/件** と増設単位が小さく、13件投資しても 59,850 → 66,006（+6,156t）。
  MASS の需要規模（生産必要量 T32 で 13万t超）に対して 1件あたりの効果が小さい。
  ただしこれは `capex/parameters.ts` の値であり、**今回変更禁止**のため触れていない。
- 実生産が物理能力に 9,760t 届いていない分は、労働・工場間配分・原料タイミングの側にある
  （SAI-EXEC-1 §C-2 で分解済み。工場間の名目シェア按分が実行不能分を振り替えない件を含む）。

### 会社別の次 binding

| 会社 | T32 の binding pool | 次に見るべきもの |
|---|---|---|
| MASS | FREEZING_PACKAGING（水準は上昇） | 増設単位 +800t/件の妥当性（#04）、工場間配分（Shared） |
| BAL | FREEZING_PACKAGING | 現状 backlog 0・overdue 0 で健全。追加対応不要 |
| JPQ | FREEZING_PACKAGING | overdue は −24% だが 13,995t 残存 |
| VAP | **PRODUCT_LINE** | VAP/PD ライン増設単位（+250 / +350t）と同時進行案件枠 |
| CONSV | FREEZING_PACKAGING | 良好（CAPEX 減で生産増） |

---

## 9. Stop Conditions（§19）の判定

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | MASS が資金危機化 | **該当なし** | T32 現金 486M → 520M（改善）、借入 0、資金不足 0Turn |
| 2 | packaging expansion 連打 | **該当なし** | 4seed 合計 13件 = 約3.3件/seed/32Turn |
| 3 | newFactory + shared expansion 過剰併走 | **該当なし** | newFactory 件数は全社で before と同一 |
| 4 | 物理能力が増えても production 改善せず | **該当なし** | MASS +5.6%、JPQ +6.9%、CONSV +3.1% |
| 5 | DS1 / DS2 重大 regression | **該当なし** | DS1 完全一致、DS2 は −1t のみ |
| 6 | BAL collapse 悪化 | **該当なし** | ほぼ完全不変（CAPEX +0.7M、現金 −2M） |
| 7 | all-company packaging convergence | **該当なし** | VAP 0件、BAL 1件。VAP は LINE 律速のまま |
| 8 | lifecycle canonical API 不足 | **該当なし** | computeEffectiveFactories / calculateFactoryEffectiveCapacity を使用。lifecycle 判定の再実装なし |
| 9 | #04 Engine bug が必要条件 | **該当なし** | Engine 変更は診断記録用の CapacitySnapshot.freezingPackaging 追加のみ（挙動不変） |

**Stop Condition 該当なし。**

---

## 10. backlog metric として使用した exact field / path（§20）

本Phaseの backlog 値は success criterion の主判定に**使っていない**（§20 の指示どおり）。
参考として記録した値の出所は全 run で以下の1経路のみである。

```
backlog : CompanyQuarterRecord.companySummaries[].outstandingQuantity
overdue : CompanyQuarterRecord.companySummaries[].overdueQuantity
```

（`app/lib/v2/companyLab/types.ts` の `CompanyQuarterSummary`。
`unwrapUnit` で HosoEqTons を数値化し、seed 平均を取っている。）

SAI-EXEC-1（#05）と #04 capacity audit / counterfactual で MASS の backlog 値が
一致していない件は未解決のままである。本書の before / after は**同一 field・同一 path**で
測っているため内部比較としては妥当だが、**他監査の backlog 値と直接比較してはいけない**。
contract ledger からの canonical 導出（total / overdue / healthy-forward）の正典化は
SAI-COMMIT-1 開始前に別途行う。

---

## 11. 変更していないもの

Commercial Ambition / Commercial Commitment / Vision / DS3 Vision multiplier /
opportunity share / maximumSupplierShare / sales conversion / Sales Capacity Engine /
backlog commitment policy / Worker hiring・assignment・productivity /
MAX_FACTORIES_PER_COMPANY / 同時進行 CAPEX 案件上限 / 新工場テンプレート / CAPEX cost /
Scenario 定義 / financing parameters。

3B-1 / 3B-1.1 / 3B-2 の liquidity・survival discipline は既存の `financialGateFor` と
`hadPriorQuarterUtilization` をそのまま通しており、緩めていない
（テスト CAP1-12 / CAP1-13 で担保）。
