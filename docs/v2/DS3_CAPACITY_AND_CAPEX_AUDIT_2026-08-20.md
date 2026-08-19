# DS3 能力プール / CAPEX ボトルネック監査（#04）

branch `feature/v2-ds3-accounting-factory-recovery`（benchmark修正 `52a9acd`）
seed: ds3-a / ds3-b / ds3-c / ds3-d（CAPEX timeline と counterfactual は ds3-a）

---

## 0. 結論

1. **MASSの天井は冷凍・包装能力（59,850t）**。3工場ぶんの基礎能力のみで、
   `freezingPackagingExpansion` への投資は32Turn中**一度も行われていない**。
2. **JPQ / VAP / CONSV の天井は商品別ライン能力**。増設単位が
   PD +350t / VAP +250t と極端に小さく、需要増に追随できていない。
3. **Standard AI は冷凍・包装のボトルネックを構造的に認識できない**。
   `standardAi/bindingCapacity.ts` の `computeBindingProductionCapacityTons` が
   `min(ライン計, 共通前処理)` で、`freezingPackaging` を含んでいない
   （今回benchmarkで修正したのと同じ欠落が、AIの認識側にも存在する）。
   → 分類は **WRONG_CAPEX_TYPE + 認識不能**。#05課題。
4. 販売量の天井は能力ではなく **Commercial Commitment**。MASSはT32で
   成約71,322t＝commitment上限に張り付き、生産53,100tとの差が受注残195ktになっている。
   能力を3倍にしても成約は71kt止まり。

---

## 1. PHASE A: benchmark production capacity 修正

| | 定義 |
|---|---|
| 旧 | `min(hoso + pd + vap, commonProcessing)` |
| 新 | `min(ライン計, 共通前処理 × 販売可能回収率, 冷凍・包装)` |

`production/allocation.ts` の制約段階は
段階1 原料 → 段階2 共通前処理（**原料投入側**）→ 歩留まりで完成品側へ変換 →
段階3 冷凍・包装（完成品側）→ 段階4 商品別ライン（完成品側）→ 段階5 労働。
旧定義は段階3が抜けており、かつ段階2の単位変換も行っていなかった。
歩留まりは `PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio`（現状 全商品1.0）を参照。
能力値はエンジンの正典関数のみから算出し、再実装していない。

### before / after（4seed平均）

| Turn | 会社 | 旧表示 | 新表示 | 差 |
|---|---|---|---|---|
| T24 | MASS | 63,270 | **59,850** | −3,420（冷凍包装が真の天井） |
| T24 | CONSV | 35,515 | 35,440 | −75 |
| T28 | MASS | 63,270 | **59,850** | −3,420 |
| T28 | JPQ | 36,444 | 36,370 | −74 |
| T28 | VAP | 42,109 | 42,055 | −54 |
| T28 | CONSV | 38,379 | 38,154 | −225 |
| T32 | BAL | 47,880 | **44,033** | −3,847 |
| T32 | MASS | 63,270 | **59,850** | −3,420 |
| T32 | CONSV | 41,232 | 40,997 | −235 |

**simulation KPIは完全不変**。同一seed・同一TURNSで実行し、出力差分が
「生産能力列」と凡例1行のみで、sales / ambition / target / actual / 調達 /
輸入比率 / cash / debt / 価格 / 営業利益率 / 順位はすべて一致することを確認。

---

## 2. PHASE B: 32Turn 能力プール推移（4seed平均・HOSO換算トン/四半期）

### MASS
| T | 工場 | ライン計 | 共通前処理 | 冷凍包装 | **物理天井** | 生産計画 | 生産実績 | 不足 common/pack/labor | 販売 | 受注残 |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 1 | 16,673 | 25,650 | 25,650 | 16,673 | 16,673 | 16,288 | 0/0/213 | 17,943 | 5,510 |
| T12 | 1 | 16,673 | 25,650 | 25,650 | 16,673 | 16,673 | 16,541 | 0/0/0 | 17,491 | 40,950 |
| T16 | 1 | 20,093 | 25,650 | 25,650 | 20,093 | 20,093 | 19,934 | 0/0/0 | 23,543 | 52,427 |
| T20 | 2 | 44,546 | 44,460 | 42,750 | 42,750 | 37,304 | 35,255 | 0/0/1,356 | 26,531 | 46,948 |
| T24 | 3 | 68,785 | 63,270 | 59,850 | **59,850** | 59,850 | 52,397 | 3,745/6,826/4,318 | 71,610 | 49,282 |
| T28 | 3 | 68,785 | 63,270 | 59,850 | **59,850** | 59,850 | 53,451 | 3,241/5,534/2,716 | 71,322 | 122,286 |
| T32 | 3 | 68,785 | 63,270 | 59,850 | **59,850** | 59,850 | 53,100 | 3,241/5,534/2,716 | 71,322 | 195,556 |

ライン計 68,785 は共通前処理 63,270・冷凍包装 59,850 を**上回っており**、
ライン増設が余剰になっている。生産計画は T24 以降ずっと冷凍包装天井 59,850 に張り付く。

### JPQ / VAP / CONSV（T32）
| 会社 | ライン計 | 共通前処理 | 冷凍包装 | 物理天井 | 生産計画 | 生産実績 | binding |
|---|---|---|---|---|---|---|---|
| JPQ | **36,680** | 44,460 | 42,750 | 36,680 | 36,680 | 33,057 | **ライン** |
| VAP | **42,333** | 44,460 | 42,750 | 42,333 | 41,901 | 37,604 | **ライン** |
| CONSV | **41,104** | 44,460 | 42,750 | 41,104 | 40,997 | 35,511 | **ライン** |
| BAL | **44,033** | 51,514 | 49,163 | 44,033 | 34,747 | 29,185 | 需要・流動性（天井に未到達） |

MASSだけが「ラインを伸ばしすぎて共有プールが天井」、他3社は逆に「ラインが天井」。

### 労働
常用ワーカーは MASS 5,236（T12）→ 19,480（T32）と拡大しており、絶対量としては
増えている。ただし T24 以降も laborShortage が 2,716〜4,318t 残り続けており、
能力増設と同期しきれていない。

---

## 3. PHASE C: CAPEX timeline（seed=ds3-a・32Turn全件）

承認された案件種別の内訳:

| 種別 | 件数 | 能力効果 | 予算 | 工期 |
|---|---|---|---|---|
| newFactoryConstruction | 8 | 新工場（共通前処理+18,810 / 冷凍包装+17,100 / ライン一式） | $22.0M | 3Q |
| hosoLineExpansion | 5 | HOSO **+4,000t** | $8.0M | 1Q |
| pdLineExpansion | 12 | PD **+350t** | $4.0M | 3Q |
| vapLineExpansion | 8 | VAP **+250t** | $6.0M | 4Q |
| pdMechanization | 6 | 能力増なし（省人化） | $2.5M | 2Q |
| qualityControlEquipment | 7 | 能力増なし | $1.2M | 2Q |
| **freezingPackagingExpansion** | **0** | +800t/件（$2.8M・工期1Q） | — | — |
| **commonProcessingExpansion** | **0** | +?t/件（$5.0M） | — | — |

### MASS
- T13 hosoLine / pdLine / vapLine（F1）
- T14 新工場 → T20 稼働（2工場目）
- T16 hosoLine、T17 pdLine
- T18 新工場 → T24 稼働（3工場目）
- T21 hosoLine（新工場側）
- T30 新工場 → **32Turn以内に完成せず**

**T32で冷凍包装が59,850tしかない理由**: 冷凍包装能力は
「基礎工場25,650 ＋ 新工場1つあたり+17,100」でしか増えず、MASSは3工場止まり。
`freezingPackagingExpansion`（+800t/$2.8M/1Q）は一度も提案されていない。
90ktへ届かせるには (90,000−25,650)/17,100 ≒ 3.8、つまり**新工場が計5棟必要**で、
`MAX_FACTORIES_PER_COMPANY = 4` を超える。**新工場だけでは物理的に到達不可能**であり、
冷凍包装増設CAPEXを使う以外に手段がない。

### JPQ（T32 ライン36,680で頭打ちの理由）
新工場は T14承認 → T20稼働で2工場。以後のライン増設は
pdLine（+350t）×3、vapLine（+250t）×2 のみで、**hosoLineExpansion（+4,000t）を
2工場目取得以降は一度も行っていない**。結果、ライン計は T20 36,220 → T32 36,680 と
32Turn中わずか+460t しか伸びていない。

### VAP（T32 ライン42,333で頭打ち）
T15/T19 に hosoLine（+4,000t）を2回実施し T24 に 40,922 まで伸びたが、
以後は pdLine（+350t）・vapLine（+250t）のみで T32 42,333。伸び率が需要に追随しない。

### CONSV（T32 ライン41,104で頭打ち）
T11・T15・T24 に pdLine、T27 に vapLine。**hosoLineExpansion は32Turn中0回**。
T20 35,440 → T32 41,104 と +5,664t（新工場稼働ぶんを含む）。

### BAL
T2に新工場承認（T8稼働）、T3に pdLine / vapLine。
初期に能力を確保したが T8〜T20 に rawMaterialShortage（最大21,896t）と
流動性制約が重なり稼働できず、能力があっても使えない状態が続いた。
T26に3棟目を承認。**CAPEXは早期に実行済みで、問題は能力ではなく資金**。

---

## 4. PHASE D: CAPEX不足の分類

| 会社 | 分類 | 根拠 |
|---|---|---|
| MASS | **WRONG_CAPEX_TYPE**（+ CAPEX_COMPLETED_BUT_OTHER_POOL_BINDING） | ライン計68,785 > 共通63,270 > 冷凍包装59,850。ラインへ投資し続け、真の天井である冷凍包装へは0件 |
| JPQ | **WRONG_CAPEX_TYPE**（増設単位が過小） | ライン天井なのに +350/+250 の小口増設のみ。hosoLine(+4,000)を2工場目以降0回 |
| VAP | **WRONG_CAPEX_TYPE**（同上） | 同上 |
| CONSV | **WRONG_CAPEX_TYPE**（同上） | hosoLineExpansion 32Turn中0回 |
| BAL | **CAPEX_FINANCING_BLOCKED**（+ NO_PHYSICAL_NEED） | 能力天井44,033に対し生産計画34,747。能力は余っており制約は流動性 |

### 「認識しているが投資しない」のか「認識できない」のか

**認識できていない。** 決定的な根拠:

`app/lib/v2/companyLab/standardAi/bindingCapacity.ts`
```ts
export function computeBindingProductionCapacityTons(effectiveCapacityByProduct, totalEffectiveCommonProcessingCapacity) {
  return Math.min(sumProductAmount(effectiveCapacityByProduct), totalEffectiveCommonProcessingCapacity);
}
```
**`freezingPackaging` が含まれていない。** Standard AI の能力認識そのものが
冷凍・包装プールを見ておらず、
`app/lib/v2/companyLab/standardAi/decision/capex.ts` にも
`freezingPackagingExpansion` を提案するコードパスが**存在しない**（grep 0件）。

一方 `commonProcessingExpansion` は提案経路が存在する（capex.ts:1127）が、
判定が `requiredRawMaterialUnconstrained / commonCapacity > 閾値` であり、
生産計画自体が `min(ライン, 共通前処理)` で頭打ちになるため比率が1を超えにくく、
32Turn中一度も発火しなかった。

---

## 5. PHASE E: Counterfactual（seed=ds3-a・倍率3・T32時点）

| 会社 | Case | 生産t | 販売t | 受注残t | 次のbinding |
|---|---|---|---|---|---|
| MASS | Base | 55,183 | 61,160 | 96,326 | packagingCapacityShortage 3,612t |
| MASS | 冷凍包装×3 | 50,405 | 60,480 | 96,957 | commonCapacityShortage 5,815t |
| MASS | 共通前処理×3 | 50,384 | 60,480 | 98,269 | commonCapacityShortage 5,837t |
| MASS | **両方×3** | **66,468** | **70,967** | 89,202 | commonCapacityShortage 10,040t |
| JPQ | Base | 37,742 | 45,467 | 55,070 | commonCapacityShortage 4,639t |
| JPQ | **共通前処理×3** | **49,593** | 44,587 | 38,215 | commonCapacityShortage 5,701t |
| VAP | Base | 35,053 | 40,738 | 46,579 | commonCapacityShortage 5,686t |
| VAP | **共通前処理×3** | **45,981** | 36,448 | 0 | packagingCapacityShortage 2,694t |
| CONSV | Base | 37,854 | 41,413 | 25,231 | commonCapacityShortage 4,669t |
| CONSV | **共通前処理×3** | **47,918** | 36,692 | 14,704 | commonCapacityShortage 5,626t |

**読み取り:**
- 片方のプールだけ増やしても効果は限定的で、次のプールがすぐ天井になる。
  MASSは両方3倍にして初めて生産が55,183→66,468（+20%）へ伸びる。
- **販売量はほとんど動かない**（MASS 61,160→70,967）。成約は Commercial Commitment
  （T32で71,322t）で頭打ちのため、能力を増やしても成約は増えない。
  増えるのは「受注残の消化」であり、96,326→89,202 と減る方向に働く。
- Case4（両方＋労働×3）は生産0へ崩壊した。常用ワーカー3倍で人件費が急増し
  資金が枯渇してCAPEXも調達も止まったためで、**この粗い上書きの副作用**であり
  労働制約についての知見にはならない（無効ケースとして扱う）。

---

## 6. PHASE F: DS3目標への到達可能性

| 会社 | 目標 | ① 現行AIのまま | ② 物理能力を十分に解消 | ③ ＋労働も十分 | ④ ＋流動性も正常 |
|---|---|---|---|---|---|
| MASS | 90–100kt | 70.5kt（成約）/ 53.1kt（生産） | 生産 ~66kt、成約 ~71kt | 生産は伸びるが**成約は71kt止まり** | 同左 |
| BAL | 55–65kt | 24.3kt | 能力天井44.0kt | — | **流動性解決で40kt台**が上限 |
| JPQ | 45–55kt | 38.6kt | 生産 ~50kt、成約 ~45kt | — | — |
| VAP | 45–55kt | 42.8kt | 生産 ~46kt、成約 ~36kt | — | — |
| CONSV | 45–50kt | 37.8kt | 生産 ~48kt、成約 ~37kt | — | — |

### 判定

- **MASS 90–100kt は現構造では到達不可能。** 理由は2つ。
  (a) 成約が Commercial Commitment 71.3kt で頭打ち（Vision / ambition 側の問題）
  (b) 冷凍包装が新工場でしか増えず、`MAX_FACTORIES_PER_COMPANY = 4` の下では
      90kt相当の冷凍包装（必要 ~5棟）を確保できない
  → **目標が過大**か、**冷凍包装増設CAPEXをAIが使えるようにする**かの二択。
- **JPQ / VAP / CONSV 45–55kt は、能力制約を解けば生産側では射程内**（46〜50kt）。
  ただし成約側が36〜45ktに留まるため、Commercial Ambition の引き上げも同時に必要。
- **BAL 55–65kt は物理能力（44.0kt）を上回っており、現状の工場構成では到達不可能。**

したがって、
**「目標が妥当」なのは JPQ / VAP / CONSV のみ**、
**「CAPEXロジックが不足」が MASS / JPQ / VAP / CONSV に共通**、
**「目標が物理的に過大」なのが MASS と BAL** と分離される。

---

## 7. #04 / #05 責任分界

### #04（本監査で対応済み・または#04課題）
- ✅ benchmark の生産能力定義に冷凍包装が抜けていた → 修正済み（`52a9acd`）
- Engine の能力計算・工場能力反映・建設完了処理・プール整合にバグは**発見されず**
- （情報）冷凍包装能力は「基礎25,650 ＋ 新工場ごとに+17,100」で、
  `freezingPackagingExpansion`（+800t/件）は用意されているが誰も使っていない。
  1件あたりの増分が新工場の1/21しかなく、**単価あたりの効率は良い**
  （$2.8M で +800t、新工場は $22M で +17,100t → ほぼ同等）が、
  刻みが細かいため多数回の投資が必要。Scenario側の物理上限そのものの妥当性は
  オーナー判断（下記§8）。

### #05（今回は修正しない）
1. **`computeBindingProductionCapacityTons` が冷凍包装を含まない**
   → AIが自社のボトルネックを誤認する根本原因
2. **`freezingPackagingExpansion` を提案するコードパスが存在しない**
3. `commonProcessingExpansion` の発火条件が、自身が計画を頭打ちにしている
   ために構造的に成立しにくい
4. ライン増設の選択が偏っている（hosoLine +4,000t を使える局面で
   pdLine +350t / vapLine +250t を選び続ける）
5. 能力増設に対して労働拡張が遅れ、laborShortage が恒常的に残る
6. 受注残が195ktまで膨張しても能力増設へ結びついていない
7. 能力制約が Commercial Ambition / Commitment へ反映されていない
   （成約は積むが作れず、受注残だけが増える）

---

## 8. DS3目標の変更が必要か（オーナー判断）

現状のままでは MASS 90–100kt と BAL 55–65kt は**物理的に到達不可能**。
選択肢は3つ:

1. **#05でCAPEXロジックを直す**（冷凍包装・共通前処理を認識・投資できるようにする）
   → MASSの冷凍包装は理論上 `freezingPackagingExpansion` の反復で到達可能。
     ただし成約側の Commercial Ambition も同時に引き上げる必要がある。
2. **目標レンジを工場能力の到達可能範囲へ下げる**（MASS 65–75kt 程度）
3. **Scenario側の物理上限を見直す**（`MAX_FACTORIES_PER_COMPANY` や
   1工場あたりの冷凍包装能力）
   → ただしこれはEngine/Scenarioの根本設計変更であり、慎重な判断が必要

推奨は **1 → 効果測定 → それでも届かなければ 2** の順。

---

## 9. 未解決事項

- Case4（労働counterfactual）は上書き手法の副作用で崩壊し、労働制約の
  純粋な効果を測れていない。労働だけを増やす診断は、人件費を据え置く必要があり
  別の手法が要る。
- MASSの成約71.3ktが Commercial Commitment 由来であることは確認したが、
  その commitment がなぜ71.3ktに決まるか（Vision成長軌道・転換率学習の寄与）は
  本監査の範囲外。
