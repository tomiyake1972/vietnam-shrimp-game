# SAI-EXEC-2 PRE-AUDIT — Factory Production Allocation Loss & Reallocation Feasibility

**生成時刻: 2026-08-25 14:13:12 UTC**

**監査のみ。Engine / Standard AI の production code は 1 行も変更していない。**

| | |
|---|---|
| base | `feature/v2-sai-cap-1 @ 96f54d13a46759757e90b284b6355ea9f1423458` |
| branch | `audit/v2-sai-exec-2` |
| 参照 | SAI-COMMIT-1 PRE-AUDIT `cf5e165b07d5da6823f3fe25729bb66beeda3f94` |
| 測定 | DS3 8seed（ds3-a〜h）× 32Turn、engine 直接実行 |
| #04 branch | read-only 参照のみ。merge していない |

---

## 0. 結論

1. **工場間 reallocation の欠如による損失は小さい。** MASS T32 で **895t**（生産 54,746t の 1.6%）。
   Case B（労働そのまま・工場間再配分可）で 55,129 → **56,023t（+894t / +1.6%）**。
   → **正式 root cause とはしない。**
2. Case C（労働も十分）でも **58,135t（+5.5%）** どまり。CAP-1 後に残る
   physical 64.3kt − production 54.7kt の差の**大部分は「工場間配分の硬直」では説明できない**。
3. 実際の損失内訳（MASS T32・8seed）は
   **共通前処理 2,166t ＋ 冷凍包装 1,510t ＋ 労働 1,432t** であり、
   **共有プールの能力そのものが足りない**のが主因。配分の問題ではない。
4. **Stop Condition に該当する Engine 側の defect を 1 件発見した。**
   `production/allocation.ts:194` が `allocated = min(desired, laborCapacity)` で、
   raw / common / freezing / product-line の各段階クリップを**参照していない**。
   結果として **DS3 全 5,688 entry のうち 225 件（3.96%）が冷凍・包装／商品ライン能力を
   超えて生産している**（最大 228.6t/entry、32Turn×8seed 累計で MASS 9,249t / VAP 7,179t）。
   → **#04 Engine 所有。実装は行わず報告する（§8 Stop Condition「#04 production allocation
   本体の変更が必要」に該当）。**

---

## 1. Factory allocation call graph

```
[Standard AI 側：計画]
  policy.ts
    └─ decision/production.ts::buildStandardAiProductionDecision
         ├─ 会社全体の必要量 neededByProduct を算出
         ├─ 工場×商品へ **名目能力シェア按分**（production.ts:147）
         │     share   = factoryObs.capacityByProduct[p] / capacityTotals[p]
         │     desired = min(effectiveCapacity_f_p, needed_p × share)     ← ★ここで既に損失
         └─ 共有プール（common / freezing）超過分を全商品一律比率で縮小（安全弁）

[Engine 側：実行]
  companyLab/runner.ts
    └─ production/allocation.ts::allocateProductionPlans
         段階1 原料      applyTier(..., groupKey = **companyId**,          budget = 会社の原料在庫)
         段階2 共通前処理 applyTier(..., groupKey = **factoryId**,          budget = 工場の commonProcessing)
                         → ここで歩留まり saleableRecoveryRatio を掛けて完成品側へ変換
         段階3 冷凍包装   applyTier(..., groupKey = **factoryId**,          budget = 工場の freezingPackaging)
         段階4 商品ライン applyTier(..., groupKey = **factoryId::product**, budget = 工場×商品のライン能力)
         段階5 労働      allocateWorkersToPlans(candidateQuantity = 段階4の結果)
         最終            allocated = min(desired, laborCapacity)          ← ★§3-2 の defect

  applyTier → production/priorityAllocation.ts::allocateByPriorityTiers
         → waterFillAllocate（**単一 budget group 内**で優先度階層ごとに水配分）
```

---

## 2. 計画配分経路（Standard AI 側）で考慮されているもの

| 要素 | 配分前に考慮しているか | 該当箇所 |
|---|---|---|
| nominal capacity ratio | **はい**（これが唯一の按分基準） | `production.ts:147` |
| 工場ごとの実効ライン能力 | はい（`min(capacity, …)` でキャップ） | `production.ts:148` |
| 工場ごとの commonProcessing / freezingPackaging | **いいえ**（工場別には見ていない） | 会社合計に対する一律縮小のみ |
| 工場ごとの worker 配置 | **いいえ** | — |
| product mix | はい（商品別に按分） | `production.ts:139` |
| **余った工場へ振り替える処理** | **存在しない** | — |

`desired_f = min(cap_f, needed × share_f)` のため、ある工場が share を能力で受け切れない場合、
その差分は他工場へ回されず**計画の段階で消える**。`anyCapacityConstraint` フラグは立つが、
再配分には使われていない。

---

## 3. Engine allocation の再配分有無

### 3-1. 工場間再配分は存在しない（確認済み）

`applyTier` は `budgetByGroup` の **group 単位**で `allocateByPriorityTiers` を呼ぶだけで、
ある group の未使用 budget を別 group へ回す処理は`priorityAllocation.ts` にも存在しない
（`remainingBudget` は同一 group 内の優先度階層間でのみ持ち越される）。

したがって **LostToNoReallocationTons** を shadow で算出した（§4・§10）。

### 3-2. ★発見した Engine defect（Stop Condition 該当）

```ts
// production/allocation.ts:190-194
const laborLimited = plans.map((_, i) => unwrapUnit(laborByPlanId.get(ids[i])!.laborCapacity));
const allocated = Math.min(desired, Math.max(0, laborLimited[i]));
```

`allocated` が **`desired` と `laborCapacity` の 2 つだけ**から決まっており、
段階1〜4（raw / common / freezing / product-line）のクリップ結果を参照していない。
`laborCapacity` は `calculateLaborCapabilityFromAssignedHeadcount` の返り値
（配置済み worker の能力）であって `candidateQuantity` でキャップされていないため、
**worker に余力がある工場では冷凍・包装／ライン能力を超えて生産できてしまう。**

実測（DS3 8seed × 32Turn、全 5,688 entry）:

| 指標 | 値 |
|---|---:|
| `allocated > 逐次min(desired, 各段階)` となる entry | **225 件（3.96%）** |
| 超過している段階（重複あり） | freezing 225 / product-line 225 / common 16 |
| 1 entry あたり最大超過 | **228.63t** |

最大ケース（seed=ds3-f / T31 / MASS-NEWF-MASS-CAPEX-2 / hoso）:

```
desired                10,846.29
rawMaterialLimited     10,846.29
commonCapacityLimited   9,405.00
freezingPackagingLimited 9,234.00   ← 本来の上限
productCapacityLimited   9,234.00   ← 本来の上限
laborCapacity            9,462.63
allocated                9,462.63   ← 上限を 228.63t 超過
shortfallReasons: commonCapacityShortage | packagingCapacityShortage
```

会社別・32Turn×8seed 累計の能力超過生産量:

| 会社 | 累計 over-allocation | T32 単期（8seed平均） |
|---|---:|---:|
| MASS | **9,249t** | 2t |
| VAP | **7,179t** | 134t |
| JPQ | 4,716t | 158t |
| BAL | 3,511t | – |
| CONSV | 1,720t | 80t |

**方向は「作りすぎ」であり、今回追っている「作れていない差」を説明するものではない。**
ただし CAP-1 で整えた物理能力の意味を壊す correctness defect であり、
**#04 Engine 所有として報告する**（§8 Stop Condition）。

---

## 4. Counterfactual Case A / B / C（恒久コード変更なし）

| case | 定義 |
|---|---|
| **A** | 現行配分（`allocatedQuantity` 実測） |
| **B** | 会社総 production plan・原料・worker・全 capacity は同じまま、**工場間で実行可能な範囲へ再配分できると仮定**<br>工場ごとの上限 = min(commonProcessing, freezingPackaging, lineCapacity, **当期の労働能力**) |
| **C** | B ＋ 労働十分と仮定<br>工場ごとの上限 = min(commonProcessing, freezingPackaging, lineCapacity) |

いずれも会社の総生産計画量 `planTotal` を超えない。

**近似の明示**: worker は工場ごとに配置済み（`workforceState.factories[].regularHeadcount`）で、
生産を工場間で動かしても worker は動かない。よって工場の労働上限は固定と見なせるが、
商品構成が変わると労働集約度（hoso 1.0 / pd 1.2 / vap 3.0）が変わるため、
Case B の労働上限は「当期の構成のまま」の値であり**上限側の近似**である。

---

## 5〜11. planned → actual loss bridge（DS3 8seed 平均）

段階値は **entry ごとに逐次 min を取ってから合計**している
（`stages.*` は running clip ではなく各段階の**能力値**であるため。§3-2 参照）。

| 会社 | T | planTotal | −raw | −common | −freezing | −line | −labor+超過 | **allocated (Case A)** | actual production | **Case B** | **Case C** | LostToNoRealloc | unused common | unused freezing | unused line |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **MASS** | T24 | 47,709 | 0 | 1,280 | 1,454 | 0 | 2,794 | 42,182 | 41,870 | 42,606 | 45,572 | **423** | 6,980 | 5,527 | 6,980 |
| **MASS** | T28 | 47,784 | 0 | 1,324 | 1,368 | 0 | 172 | 45,113 | 44,736 | 45,156 | 45,657 | **196** | 4,049 | 2,875 | 4,049 |
| **MASS** | T32 | 60,235 | 0 | 2,166 | 1,510 | 0 | 1,432 | 55,129 | 54,746 | **56,023** | **58,135** | **895** | 6,966 | 5,108 | 10,316 |
| BAL | T24 | 38,478 | 0 | 214 | 486 | 0 | 3,596 | 34,182 | 33,930 | 35,118 | 38,050 | 936 | 19,683 | 17,118 | 18,785 |
| BAL | T28 | 45,107 | 0 | 827 | 641 | 0 | 3,022 | 40,654 | 40,322 | 41,080 | 43,893 | 426 | 14,387 | 11,751 | 14,024 |
| BAL | T32 | 46,939 | 0 | 260 | 181 | 0 | 2,358 | 44,141 | 43,779 | 44,629 | 46,859 | **489** | 17,954 | 14,812 | 18,333 |
| JPQ | T24 | 42,223 | 0 | 1,208 | 1,625 | 0 | 905 | 38,486 | 38,043 | 38,544 | 39,932 | 58 | 5,974 | 4,350 | 5,076 |
| JPQ | T28 | 43,332 | 0 | 2,023 | 941 | 0 | 204 | 40,165 | 39,920 | 40,327 | 40,864 | 163 | 4,295 | 3,355 | 4,279 |
| JPQ | T32 | 43,724 | 0 | 2,534 | 470 | 0 | 43 | 40,835 | 40,627 | 40,764 | 41,441 | **88** | 3,636 | 3,356 | 4,406 |
| VAP | T24 | 28,256 | 0 | 1,083 | 1,176 | 0 | 1,401 | 24,597 | 24,421 | 24,611 | 26,072 | 14 | 13,985 | 12,810 | 3,827 |
| VAP | T28 | 30,551 | 0 | 616 | 1,496 | 0 | 305 | 28,134 | 27,879 | 28,134 | 29,143 | 0 | 13,975 | 12,479 | 4,276 |
| VAP | T32 | 33,986 | 0 | 1,412 | 1,594 | 0 | 396 | 30,719 | 30,505 | 30,615 | 31,165 | **31** | 13,153 | 11,631 | 3,829 |
| CONSV | T24 | 40,898 | 0 | 604 | 1,454 | 0 | 1,234 | 37,642 | 37,369 | 37,947 | 40,034 | 305 | 6,818 | 5,401 | 6,385 |
| CONSV | T28 | 43,028 | 0 | 1,228 | 1,368 | 0 | 18 | 40,414 | 40,205 | 40,501 | 41,195 | 87 | 4,046 | 2,678 | 3,859 |
| CONSV | T32 | 43,562 | 0 | 1,485 | 855 | 0 | 28 | 41,273 | 40,988 | 41,344 | 41,761 | **120** | 3,187 | 2,497 | 3,203 |

読み取り:

- **5. raw loss は全社・全 turn で 0。** 原料は段階1で **会社単位プール**（`companyKeys`）として
  配分されており、工場別には制約されていない。原料は今回のロスに一切寄与していない。
- **6. common loss** MASS T32 2,166t / JPQ T32 2,534t が最大。
- **7. freezing loss** MASS T32 1,510t / VAP T32 1,594t。
- **8. line loss は全社・全 turn で 0。** 商品別ライン能力は一度も binding していない。
- **9. labor loss** BAL が突出（T24 3,596t / T28 3,022t / T32 2,358t）。MASS は T24 2,794t → T32 1,432t へ縮小。
  この列は §3-2 の能力超過（+方向）と相殺された**正味**の値である。
- **10. LostToNoReallocation は最大でも MASS T32 895t / BAL T24 936t** と小さい。
- **11. unused capacity は大きい**（MASS T32 で common 6,966t / freezing 5,108t / line 10,316t、
  BAL に至っては common 17,954t）。ただしこれは「他工場が余らせている」のではなく、
  **同じ工場内で別プールが先に律速している**ためであり、再配分では回収できない。

---

## 12. MASS 工場別（seed = ds3-a、T24 / T28 / T32）

| T | factoryId | status | planned | capCommon | capFreez | capLine | 労働能力 | allocated | produced | unused common | unused freez | unused line | clipped | 失敗理由 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| T24 | MASS-F1 | active | 22,049 | 25,650 | 25,650 | 23,513 | 22,301 | 22,049 | 21,891 | 3,601 | 3,601 | 1,464 | **0** | — |
| T24 | NEWF-CAPEX-2 | active | 19,243 | 18,810 | 17,784 | 20,520 | 11,586 | 11,225 | 11,146 | 7,585 | 6,559 | 9,295 | 8,018 | common / packaging / labor |
| T24 | NEWF-CAPEX-4 | active | 19,243 | 18,810 | 17,100 | 20,520 | 10,687 | 10,687 | 10,565 | 8,123 | 6,413 | 9,833 | 8,556 | common / packaging / labor |
| T28 | MASS-F1 | active | 22,049 | 25,650 | 25,650 | 23,513 | 23,433 | 22,049 | 21,932 | 3,601 | 3,601 | 1,464 | **0** | — |
| T28 | NEWF-CAPEX-2 | active | 19,243 | 18,810 | 17,784 | 20,520 | 18,595 | 17,784 | 17,676 | 1,026 | 0 | 2,736 | 1,459 | common / packaging |
| T28 | NEWF-CAPEX-4 | active | 19,243 | 18,810 | 17,100 | 20,520 | 18,058 | 17,100 | 17,009 | 1,710 | 0 | 3,420 | 2,143 | common / packaging |
| T32 | MASS-F1 | active | 22,298 | 25,650 | 25,650 | 23,513 | 23,513 | 22,298 | 22,155 | 3,352 | 3,352 | 1,215 | **0** | — |
| T32 | NEWF-CAPEX-2 | active | 19,460 | 18,810 | 17,784 | 20,520 | 17,435 | 17,435 | 17,283 | 1,375 | 349 | 3,085 | 2,025 | common / packaging / labor |
| T32 | NEWF-CAPEX-4 | active | 19,460 | 18,810 | 17,784 | 20,520 | 16,878 | 16,878 | 16,743 | 1,932 | 906 | 3,642 | 2,583 | common / packaging / labor |

### なぜ再配分では回収できないか（T32 の具体例）

```
MASS-F1        余っている freezing 3,352t / common 3,352t
               しかし **自工場の line 余力は 1,215t しかない**
NEWF-CAPEX-2   clipped 2,025t（common 18,810 と freezing 17,784 が律速）
NEWF-CAPEX-4   clipped 2,583t（同上）

→ NEWF 側の未達 4,608t を F1 へ移しても、F1 が追加で受けられるのは
   min(freezing 3,352, common 3,352, **line 1,215**) = 1,215t だけ。
```

これが Case B の +894t（8seed 平均）とほぼ一致する。
**「余力工場に大量の空きがある」という描像は誤りで、余っているプールと足りないプールが
工場内で食い違っているだけである。**

---

## 13. MASS production uplift（§5 の成功判定）

| case | MASS T32 production | C0 比 |
|---|---:|---:|
| **Case A（現行）** | **54,746t**（allocated 55,129t） | — |
| **Case B（工場間再配分・労働そのまま）** | **56,023t** | **+894t / +1.6%** |
| **Case C（B ＋ 労働十分）** | **58,135t** | **+3,006t / +5.5%** |

**判定: 有意ではない。工場間 reallocation 欠如は正式 root cause としない。**

CAP-1 後に残っていた差（physical 64.3kt − production 54.7kt ≒ 9.6kt）のうち、
再配分で回収できるのは **895t（9.3%）**にすぎない。
残りは共有プール（common / freezing）の**能力そのものの不足**と労働である。

---

## 14〜17. 他社

| 会社 | T32 LostToNoRealloc | Case B uplift | 主因 | 判断 |
|---|---:|---:|---|---|
| **14. BAL** | 489t | +488t（+1.1%） | **労働**（−2,358t）。unused common 17,954t は自工場 line が先に律速 | 再配分では解決しない |
| **15. JPQ** | 88t | +（−71t）※ | **common −2,534t** が支配的 | 再配分の余地ほぼ無し |
| **16. VAP** | 31t | +（−104t）※ | freezing −1,594t / common −1,412t。unused line 3,829t と小さい | 再配分の余地ほぼ無し |
| **17. CONSV** | 120t | +71t（+0.2%） | common −1,485t | 再配分の余地ほぼ無し |

※ JPQ / VAP の Case B が allocated を下回るのは、§3-2 の能力超過分（JPQ 158t / VAP 134t）が
allocated に含まれているため。**能力を守れば本来はこの値**という意味であり、
再配分の余地が負ということではない。

会社 ID に依存した修正案は一切提示していない（§6 遵守）。

---

## 18. ENG-FAC-1 / lifecycle 整合

- 工場集合は `capex/factoryConstruction.ts::computeEffectiveFactories`（canonical）から取得。
- 能力は `production/capacity.ts::calculateFactoryEffectiveCapacity` を通す。同関数は
  `factory.status !== "active"` の工場へ全プール 0 を返すため、
  **非稼働工場は再配分候補に構造的に入らない。**
- 実測: DS3 8seed × 32Turn で観測した工場 status は **全件 `active`**
  （`active=N`、`idle` / `suspended` は 0 件）。
- SAI-BKL-1 §12 で確認済みのとおり、ENG-FAC-1 は
  MOTHBALLED → `"idle"` / SALE_PENDING → `"suspended"` / SOLD → `Factory[]` から除去
  という写像であり、**本監査の shadow 計算はそのまま追従する**。
  **ENG-FAC-1 未統合コードは必要としていない。**

---

## 19. #04 / #05 ownership

| 発見 | 所有 | 備考 |
|---|---|---|
| 計画が名目シェア按分で、受け切れない分を他工場へ回さない（`production.ts:147`） | **#05 Standard AI** | ただし回収可能量は小さい（§13） |
| Engine に工場間 reallocation が無い（`allocation.ts` / `priorityAllocation.ts`） | **#04 Engine** | 同上 |
| **`allocated = min(desired, laborCapacity)` が段階1〜4を参照していない（能力超過生産）** | **#04 Engine** | `allocation.ts:194`。§3-2。**要修正** |
| 共通前処理の能力不足（MASS T32 −2,166t / JPQ −2,534t） | **#04 Engine（parameter）** | 増設単位 +700t/件 |
| 冷凍・包装の能力不足（MASS T32 −1,510t / VAP −1,594t） | **#04 Engine（parameter）** | 増設単位 +800t/件 |
| 労働不足（BAL T32 −2,358t） | **#05 Standard AI（labor.ts）** | SAI-COMMIT-1 §13 で primary ではないと実証済み |
| 原料は段階1で会社プール＝工場間移動の概念が不要 | — | Stop Condition に非該当（§20） |

---

## 20. Stop Conditions（§8）

| 条件 | 判定 | 根拠 |
|---|---|---|
| Engine と AI で factory capacity 定義が異なる | **該当**（軽微） | AI 計画は工場別 common/freezing を見ず会社合計の一律縮小のみ。Engine は工場別に切る |
| ENG-FAC-1 が必須 | **該当なし** | canonical `computeEffectiveFactories` + `calculateFactoryEffectiveCapacity` で足りる（§18） |
| schema 変更が必要 | **該当なし** | 既存 `ProductionAllocationEntry.stages` で全段階を観測できた |
| reallocation すると会計 / 在庫不変条件が崩れる | **該当なし** | `FinishedGoodsLot` は `factoryId` を持つが会社合計は不変。原料は既に会社プール |
| raw material を工場間で移動可能とみなすことが現行 Engine semantics と矛盾 | **該当なし** | 段階1の budget group は `companyId`。**原料は元から会社単位プール**であり工場間移動の仮定が不要 |
| **#04 production allocation 本体の変更が必要** | **該当** | §3-2 の `allocation.ts:194` defect。および reallocation を入れるなら `applyTier` の構造変更が要る |

**→ 該当あり。実装は行わず報告する。**

---

## 21. 実装修正が必要か

| 項目 | 必要性 | 理由 |
|---|---|---|
| 工場間 reallocation の実装 | **不要（優先度低）** | 回収量が MASS T32 で 895t（1.6%）にとどまる。複雑さに見合わない |
| `allocation.ts:194` の能力超過 defect | **必要（#04）** | CAP-1 で整えた物理能力の意味を壊す correctness defect。累計 MASS 9,249t / VAP 7,179t |
| 共通前処理・冷凍包装の増設単位 | **要検討（#04 parameter）** | 今回の損失の主因。ただし本 Phase では変更禁止 |

---

## 22. 推奨修正箇所

1. **`app/lib/v2/production/allocation.ts:194`（#04 Engine・最優先）**
   ```ts
   // 現行
   const allocated = Math.min(desired, Math.max(0, laborLimited[i]));
   // 意図されていた形（段階1〜4の結果を必ず通す）
   const allocated = Math.min(desired, rawMaterialLimitedOutput[i], commonCapacityLimited[i],
                              freezingPackagingLimited[i], productCapacityLimited[i],
                              Math.max(0, laborLimited[i]));
   ```
   ※ あるいは `allocateWorkersToPlans` が `laborCapacity` を `candidateQuantity` でキャップして返す。
   どちらが正しいかは **#04 の設計判断**であり、本監査では実装しない。

2. **共通前処理 / 冷凍包装の増設単位（#04 parameter）** — §5〜11 の損失の主因。
   SAI-CAP-1 §8 で挙げた「+800t/件が MASS の規模に対して小さい」と同じ論点。

3. **工場間 reallocation（#04 + #05・優先度低）** — 効果が 1.6% と小さいため、
   1 と 2 の後に費用対効果を再評価する。

---

## 23. 変更していないもの

Commercial Commitment / Commercial Ambition / Vision / DS3 Vision multiplier /
opportunity share / Scenario / CAPEX parameter / Worker logic /
Engine production allocation 本体 / Standard AI production decision。

一時 script はリポジトリに残していない。
