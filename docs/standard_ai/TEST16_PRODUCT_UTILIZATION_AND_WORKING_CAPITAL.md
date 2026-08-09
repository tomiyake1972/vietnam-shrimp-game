# Test16: 商品別稼働率による設備投資判断 ＋ 短期運転資金ファイナンス

作成日: 2026-08-09
branch: `feature/v2-test16-balance-foundation`
状態: **実装・検証完了。Stage E（商品集中効果）には未着手**

実測: `artifacts/test16AfterProductUtilAndWorkingCapital.json` / `artifacts/rawProcurementAuditAfter.json`

common 30,000t・freezing 30,000t の工場設計は**維持**した（指示A）。

---

## 1. capex稼働率の旧式 / 新式

### 旧式（1つの分母をすべての投資判断に使っていた）

```
稼働率 = 実生産量合計 / commonProcessing能力      （production/loadMetrics.ts:54）
```

投資対象が HOSO でも PD でも共通前処理でも、この1つの値で持続性を判定していた。
Test16の工場設計（箱は大きく、商品別専用能力が構成を制約する）では
`Σ商品別能力 / common = 0.633〜0.733` が理論上限になり、しきい値0.92へ**算術的に到達不可能**だった。

### 新式（投資対象設備に対応する稼働率）

`standardAi/decision/capex.ts` の `relevantUtilizationFor()`:

| 投資種別 | 分子 | 分母 |
|---|---|---|
| HOSOライン増設 | HOSOの前期実績生産量 | HOSOの実効能力 |
| PDライン増設 | PDの前期実績生産量 | PDの実効能力 |
| VAPライン増設 | VAPの前期実績生産量 | VAPの実効能力 |
| 共通前処理能力増設 | 全商品の実績生産量合計 | 共通前処理の実効能力 |
| 冷凍・包装能力増設 | 全商品の実績生産量合計 | 冷凍・包装の実効能力 |

能力は必ず `observation.totalEffective*`（`production/capacity.ts` の
`calculateFactoryEffectiveCapacity` 経由）を使い、ここで能力を再計算しない。

`capexSustainedUtilizationThreshold = 0.92` は**変更していない**（指示B2）。
financial gate / inventory gate / ongoing project gate / shortfall gate も**すべて維持**。

成長エントリ（`capexGrowthEntryUtilizationThreshold`）の稼働率条件も商品別へ揃えた。

---

## 2. HOSO投資の before / after

### 持続性条件の成立状況（5社×8Q）

| | before（旧式） | after（新式） |
|---|---|---|
| 商品別ボトルネック検知 | 86件 | 継続して検知 |
| **持続性条件の成立** | **0件** | **11件** |
| 商品別稼働率の最大値 | （測定不能） | **0.993** |
| capex提案 | 0件 | **0件（下記の理由）** |

新式では HOSO/VAPライン稼働率が 0.95〜0.99 に達し、**持続性条件が初めて成立した**。
「common 30,000だから投資しない」という誤った見送りは解消された。

### ただし提案には至っていない — 残る唯一のゲートは財務ゲート

持続性が成立した11件すべてが `financialGate = 0` で止まっている。
内訳を diagnostics に追加して確認した結果、**全件が現金条件で落ちており、借入圧力条件ではない**。

```
必要現金 = targetMinimumCashUsd × capexCashSafetyMultiple(1.75) ≒ 45〜60M USD
実際の現金 = 25〜46M USD
borrowingPressure = 0.54〜0.90（すべて 1 未満＝借入側は安全）
```

| | 現金 | 必要現金 | 借入圧力 |
|---|---|---|---|
| MASS T2 | 34M | 60M | 0.90 |
| BAL T3 | 46M | 47M | 0.77 |
| JPQ T3 | 25M | 48M | 0.54 |
| VAP T3 | 29M | 47M | 0.62 |
| JPQ T5 | 34M | 45M | 0.79 |
| VAP T7/T8 | 27M / 43M | 46M / 45M | 0.72 / 0.87 |

BAL T3（46M vs 47M）・VAP T8（43M vs 45M）は**あと数%**である。

**この財務ゲートは指示B2「既存の financial gate 等は維持」に従い変更していない。**
`capexCashSafetyMultiple = 1.75` を動かすかは判断が要るため §9 に挙げる。

### K（12k→16k→20k→24k）について

上記のとおり提案に至っていないため、**8Qの範囲では HOSO 能力は 8,000t のまま**であり、
段階的な投資進行は観測できていない。毎期無条件に投資する挙動も出ていない（提案0件）。
上限24,000tの実装自体は単体テストで検証済み（`Test16-CAPEX-7`）。

---

## 3. 5社の商品別稼働率（新式・8Q最大値）

| 会社 | HOSO | PD | VAP | 旧式（会社全体） |
|---|---|---|---|---|
| BAL | 0.991 | — | — | 0.398〜0.653 |
| MASS | 0.993 | — | — | 0.215〜0.506 |
| JPQ | 0.989 | — | — | 0.355〜0.525 |
| VAP | 0.993 | — | 0.951 | 0.303〜0.531 |
| CONSV | 0.991 | — | — | 0.387〜0.545 |

旧式では最大でも 0.65 だったものが、商品別に見ると 0.99 に達する。
**「工場全体は空いているが、HOSOラインは満杯」という実態が初めて可視化された。**

---

## 4. 短期運転資金の借入判断（設計）

新規モジュール `standardAi/decision/workingCapital.ts`。

```
nearTermOperatingCashNeeds
  = 国内買付コスト + 輸入発注コスト + 人件費 + 当期決済買掛 + 元利返済

overallCashGap
  = nearTermOperatingCashNeeds + 最低現金バッファ − 手元現金 − 当期回収予定売掛

domesticProcurementFundingGap
  = 国内買付コスト − 手元現金 × domesticPurchaseCashAllocationRatio

projectedWorkingCapitalGap = max(overallCashGap, domesticProcurementFundingGap)
economicallyDesiredBorrowing = max(0, projectedWorkingCapitalGap)

借入申請額 = max(最低現金バッファ不足額, economicallyDesiredBorrowing)
```

「置き換え」ではなく「いずれか大きい方」とし、既存の安全側の判断を失わない。

**運転資金が不足しているときは任意期限前返済を行わない**ようにした
（返済して現金を減らした直後に原料が買えなくなる自己矛盾を防ぐ）。

長期のキャッシュフロー予測モデルは作っていない（指示D3）。

---

## 5. 原料調達必要額の組込み方

`policy.ts` で調達計画を確定させた**後**に資金繰り判断を呼ぶ順序を利用し、
実際の調達計画をそのまま渡している（循環しない）。

```ts
const procurementResult = buildStandardAiProcurementPlan(...);   // 先に確定
const financingResult = buildStandardAiFinancingRequest(observation, pressures, params, {
  domesticDesiredQuantityTons: ...procurementResult.domesticPurchasePlan.desiredQuantity,
  importOrderedQuantityTons:  ...procurementResult.importOrders 合計,
});
```

国内買付コストの式は、資金ゲート（`financing/liquidityClose.ts`）が使う式と**同一**にした。

```
数量(t) × 1000 × 期待国内価格(USD/kg)
```

これを揃えないと、AIは自分が受ける制約の大きさを取り違える。
前期価格が無いturn1の代替値も、ゲート側・autoPolicy側と同じ 2.5 USD/kg を使う。

### 二重計上の回避

輸入は買掛（`apImportPaymentQuarters = 1`）を経由するため、

- **当期発注ぶん** → 次四半期の需要として計上（指示D3の「current + next turn」）
- **過去発注ぶん** → `payablesDueThisPeriodUsd` として当期の支出に計上

とし、同じ金額を二度数えない。

---

## 6. ARの扱い

`observation.receivablesDueThisPeriodUsd`（**当期が決済予定期のものだけ**）を
資金供給側に算入する。売掛金の帳簿残高全体は使わない
（`arCollectionQuarters = 1` により当期発生の売上は当期中に現金化されないため）。

`receivablesNotYetDueUsd` は将来の回収予定として観測できるが、
短期判断では**意図的に使っていない**（回収前の資金を当てにしない）。

---

## 7. borrowing capacityとの関係

**借入可能枠は `observation.availableBorrowingHeadroomUsd` として意図的に undefined** である
（`standardAi/types.ts` に「憶測で近似値を作らない」と明記されている）。
今回もこれを変更せず、AIは**必要額を申請するだけ**で、いくら借りられるかは
`financing` エンジンの `computeBorrowingCapacity` + `underwriting` が決める。

したがって diagnostics には `requestedBorrowing` を保存し、
`actualBorrowing`（承認額）は決定時点で確定しないため保存していない。
承認結果は `financingResults[].underwriting` に既に記録されている。

E1 の「Short-term Working Capital Facility を新設する」は**行っていない**。
既存の borrowingCapacity（AR・原料在庫・完成品在庫の掛目 ＋ EBITDA倍率 ＋ 信用区分×自己資本）
が既に運転資金の裏付けを評価しており、実測でも 15〜57M USD の枠が出ていた。
**枠が足りなかったのではなく、AIが申請していなかった**ことが原因だったため、
新しい銀行モデルは不要と判断した。

---

## 8. MASS の borrowing capacity 原因（E2）

**結論: モデル上の過度な制約ではなく、経済的に妥当である。**

| Turn | 信用区分 | 担保ベース枠 | 収益ベース枠 | 信用区分上限 | 総枠 | 既存借入 | 追加可能 |
|---|---|---|---|---|---|---|---|
| 1 | B | 40M | 0M | 135M | 40M | **80M** | 0M |
| 2 | A | 44M | 1M | 181M | 44M | 78M | 0M |
| 4 | B | 47M | 5M | 132M | 47M | 73M | 0M |
| 6 | B | 43M | 8M | 129M | 43M | 45M | 0M |
| 7 | B | 22M | 0M | 115M | 22M | 43M | 0M |
| 8 | **D** | 29M | 0M | 40M | 29M | 38M | 0M |

対照として CONSV:

| Turn | 信用区分 | 担保ベース枠 | 既存借入 | 追加可能 |
|---|---|---|---|---|
| 3 | A | 52M | 36M | 15M |
| 7 | A | 63M | 6M | **57M** |

### 原因

**MASSは初期時点で既に 80M USD の借入があり、担保価値（40M）の2倍を負っている。**
`availableAdditionalCapacity = max(0, 総枠 − 既存借入)` なので、構造的に0になる。
binding は全期間 `collateralBased`。

収益ベース枠も 0〜12M しかない（8Q累計営業利益 −26M）。
T8で信用区分がDへ低下し、信用区分上限も 40M まで落ちた。

### 妥当性の判定

担保（AR＋在庫、掛目適用後）の2倍の負債を持ち、営業赤字が続く会社に
追加融資しないのは**銀行の判断として妥当**である。パラメータは緩めていない。

ただし**この状態の起点は段階C**である。MASSの初期借入80Mは
HOSO 30,000t 規模を前提に設定されていたが、段階Cで 12,000t へ再設計した結果、
売上・在庫・ARが縮小して担保価値だけが下がり、負債はそのまま残った。
判断2（MASSの能力再設計）の帰結として追跡が必要である。

---

## 9. `domesticPurchaseCashAllocationRatio = 0.6` の意味（F）

### 何を表現するパラメータか

`financing/parameters.ts:87` の定義コメント:

> 調達（国内買付）に充当してよい、利用可能流動性に対する割合（**残りは賃金等の最優先支払に確保**）

つまり「手元現金の全額を原料に突っ込ませない」ための優先支払留保である。

### なぜ0.6か

**根拠はコード・ドキュメントのいずれにも記載がない。** 導入時の校正記録も見つからなかった。
0.6という水準の由来は不明であり、これは事実として報告する（推測で補わない）。

### cash reserve との二重制約になっていないか → **なっている**

今回実装した運転資金評価は、資金需要側で既に

- 人件費
- 当期決済買掛
- 元利返済
- 最低現金バッファ（`targetMinimumCashUsd`）

を差し引いている。**0.6 の留保はこれと同じ目的（賃金等の最優先支払の確保）であり、
同じリスクを二重に手当てしている。**

ただし0.6は「借入で埋められる」制約なので、致命的ではない
（借入は100%が利用可能流動性へ加算される）。今回はAIにこの制約を認識させ、
不足分を借入で埋める形にした。

### Standard AI だけに効くのか、Player にも効くのか → **Player にも効く**

`companyLab/runner.ts:1065` で `decisions.map(...)` により**全社の意思決定へ一律に適用**される。
Standard AI だけの制約ではない。したがって今回の運転資金判断も
「AIだけの裏技」にはならず、Player も同じ制約下で同じ資金計画を立てられる（指示G）。

### 0.6→0.8 / 1.0 にした場合の影響

**まだ変更していない**（指示F）。運転資金ファイナンス修正後の binding 状況:

| | 修正前 | 修正後 |
|---|---|---|
| 資金ゲートが binding した四半期 | 35 / 40 | **18 / 40** |
| うち MASS を除く | 30 | **10** |
| 会社別 | 全社 | BAL 1 / MASS 8 / JPQ 4 / VAP 5 / CONSV 0 |

**CONSV は 0 になった。** 残る10件（MASS除く）のうち7件はまだ借入余力が残っている。
0.6 の是非は、これらの残件を追ってから判断するのが妥当である。

---

## 10〜15. Benchmark（5社×8Q、Stage C/D条件）

| 会社 | raw不足 | 成約 | 営業利益($M) | 借入承認累計($M) | 期末現金($M) | 期末借入残高($M) |
|---|---|---|---|---|---|---|
| BAL | 8,116 → **6,023** | 108,403 → 107,690 | 86.3 → 83.5 | 0 → 7 | 49 → 51 | 23 |
| MASS | 74,909 → 75,335 | 101,294 → 101,294 | -25.2 → -26.1 | 0 → 0 | 3 → 2 | 38 |
| JPQ | 41,935 → **16,341** | 96,704 → **106,159** | 59.6 → **80.2** | 11 → 47 | 32 → 29 | 41 |
| VAP | 36,134 → **28,222** | 99,650 → 99,570 | 62.2 → **71.8** | 15 → 36 | 30 → 42 | 56 |
| CONSV | 21,876 → **1,385** | 97,630 → **105,128** | 69.8 → **77.4** | 4 → 40 | 35 → 37 | 16 |

### J の確認項目

**1. 原料不足が減ったか** → はい。CONSV **−94%**、JPQ **−61%**、VAP −22%、BAL −26%。
MASS のみ横ばい（借入余力ゼロのため。§8）。

**2. 借入余力を遊ばせなくなったか** → はい。
「未充足なのに借入申請ゼロ、かつ借入余力あり」の四半期が **17 → 0**。

**3. 借入過剰になっていないか** → なっていない。
承認累計は 30M → 130M（5社合計・8Q）。期末借入残高は 16〜56M で、
いずれも各社の担保ベース枠（40〜63M）の範囲内。
新たな支払不能・信用区分Eは発生していない。
財務制限条項違反は MASS のみ（before 2件 → after 3件、T5が増加）。

**4. HOSO設備投資が実際に発動するか** → **まだ発動していない**（§2）。
持続性条件は 0件 → 11件に改善したが、財務ゲート（現金条件）で止まっている。

**5. commonが低稼働でもHOSO高稼働ならHOSO投資できるか** → **判断としては可能になった**。
`Test16-CAPEX-5` で「common 0.31 / HOSO 0.975」の条件で HOSO 増設が提案されることを検証済み。
ベンチマークで発動しないのは稼働率ではなく現金条件が理由である。

**6. MASSの借入不能が妥当か** → 妥当（§8）。

**7. Debt急増でゲームが破綻しないか** → 破綻していない。
期末現金は 2〜51M で全社プラス。BAL/VAP/CONSV は現金が増加。
営業利益は JPQ +20.6M、VAP +9.6M、CONSV +7.6M と改善。
BAL は −2.8M、MASS は −0.9M の微減。

---

## 16. テスト

新規 `standardAi/__tests__/test16ProductUtilizationAndWorkingCapital.test.ts`（17件）。

| # | 内容 | 結果 |
|---|---|---|
| CAPEX-1 | HOSO稼働率はHOSO能力が分母 | pass |
| CAPEX-2 | PD稼働率はPD能力が分母 | pass |
| CAPEX-3 | VAP稼働率はVAP能力が分母 | pass |
| CAPEX-4 | common稼働率はHOSOの持続性判定に使われない | pass |
| CAPEX-5 | common低稼働 / HOSO>92% → HOSO投資候補 | pass |
| CAPEX-6 | HOSO低稼働 → HOSO投資見送り | pass |
| CAPEX-7 | HOSO上限24,000t・+4,000t・工期1Q・8M | pass |
| FIN-8 | 原料調達必要額が借入判断へ入る | pass |
| FIN-9 | 現金十分なら借りない | pass |
| FIN-10 | 現金不足＋余力 → 短期借入 | pass |
| FIN-11 | 期待ARが借入必要額を減らす | pass |
| FIN-12 | 実際の借入額は審査が決める（枠は捏造しない） | pass |
| FIN-13 | 必要額を超えて借りない | pass |
| FIN-14 | 資金ゲートはPlayer・AI共通 | pass |
| DIAG-15 | capex稼働率一式が保存される | pass |
| DIAG-16 | 運転資金diagnostics（指示H）が保存される | pass |
| 追加 | 運転資金不足時は期限前返済しない | pass |

Regression（17〜21）は既存スイートで担保。**全2,515件 pass / 0 fail。**

既存テスト `sai5fCapex.test.ts` の合成observationを1箇所更新した。
「前期稼働率が高い」という前提を表す信号が
`lastQuarterEquipmentUtilizationRate` から商品別の前期実績生産量へ移ったためで、
0.9 と整合する実績生産量（各ライン能力の90%）を与えた。
**期待値を書き換えたのではなく、テストが表明していた前提を新しい信号で表し直している。**

---

## 17. tsc / lint / build

- `npx tsc --noEmit` → **0 error**
- `npm test` → **2,515 pass / 0 fail**
- production deploy は行っていない。develop/v2・main・Test15 integration へ merge していない。
- 進行中の Test15 保存データは変更していない（fixture・state migration なし）。

---

## 18. 残るリスク・判断が必要な点

### (a) capex の現金ゲートが実質的な最後の壁

`capexCashSafetyMultiple = 1.75` により、投資には
「最低現金バッファの1.75倍（45〜60M）」を**保有したまま**であることが要る。
運転資金を借りて原料を買う会社は現金を積み上げないため、この条件と両立しにくい。

8M USD の投資に対して 45〜60M の現金保有を求めるのは保守的すぎる可能性がある。
BAL T3（46M vs 47M）・VAP T8（43M vs 45M）は**あと数%**で、しきい値の位置の問題である。

選択肢:
- (a-1) `capexCashSafetyMultiple` を下げる（例 1.75 → 1.2）
- (a-2) 現金条件を「投資額に対する倍率」へ変える（8M の投資に 45M を求めない）
- (a-3) 現状維持。「借りて原料を買う段階では設備投資しない」を正しい経営判断とみなす

**指示B2で既存ゲートは維持としたため変更していません。ご判断ください。**

### (b) `domesticPurchaseCashAllocationRatio = 0.6` の二重制約（§9）

運転資金評価と目的が重複している。まだ10件（MASS除く）で binding している。

### (c) MASS の構造問題（§8）

段階Cの能力再設計により、担保価値だけが縮小し初期借入80Mが残った。
8Q通じて原料不足75,000t・営業赤字26M。判断2の追跡対象。

### (d) 輸入単価の代理指標

輸入コストの見積もりに国内価格を代理として使っている
（着地価格の内訳は発注時点でAIが観測していないため）。
実際の着地価格は運賃・関税・保険を含むため、やや過小評価になる。

### (e) Player向けUI（指示G）

短期借入可能額・運転資金需要・原料調達資金ギャップは
`WORKING_CAPITAL_ASSESSED` diagnostics に実数で保存済みだが、
**UIへの表示は未実装**。指示Gは「UIの大規模改修は不要」としているため、
既存の診断表示経路へ載せるかは次の判断事項。

---

## 19. Stage E へ進んでよいか

**技術的には進めます。** ただし2点を先に確認いただきたいです。

1. **§18(a) の capex 現金ゲート。** これを判断しないと、
   Stage E で商品集中効果（Worker削減）を入れても
   「HOSO 24,000t へ育てて集中効果を得る」という戦略が成立するか検証できません。
   K の 12k→16k→20k→24k は現状まだ観測できていません。

2. **Stage E 着手前の設計判断（前回報告の4箇所）。**
   判断3で `concentrationFactor(product, quantity)` を Single Source of Truth とし、
   Worker→最大生産量は binary search で逆算する方針をいただきました。
   この方針で実装に入ってよいか、最終確認をお願いします。
