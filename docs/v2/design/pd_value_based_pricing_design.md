# PD価値ベース価格モデル — 正式設計書・テスト仕様（Phase C）

**文書状態**: 実装前の正式設計。**本Phaseでも製品コードは一切変更していない。**
次のセッションがこの文書だけを見て実装に着手できることを目的とする。

**関連文書**: `docs/v2/design/pd_value_based_pricing_analysis.md`
（Phase B の因果トレース・単位分析・数値プロトタイプの実測。以下「分析書」と呼び、
本書は重複する数値を再掲せず参照する）。
**プロトタイプ**: `scripts/pdValueBasedPricingPrototype.ts`（式の実体はここにある）。

---

## 1. 現行モデルについての事実

| 事実 | 実装場所 |
| --- | --- |
| PDプレミアムは HOSO価格 ×（0.18 × 供給圧力倍率 × 稼働率倍率）＋ 品質調整 | `market/productPremium.ts` |
| **価格形成の経路上に加工コストが1つも入っていない** | 同上（分析書 §3-1） |
| 世界PD稼働率 = 世界PD需要 ÷ 4か国のPD加工能力合計 | 同上 |
| 国別稼働率は世界稼働率のコピー | 同上（分析書 §U-5） |
| 産地別の加工コストというデータが存在しない | `market/types.ts` `CountrySupplyInput`（分析書 §4-1） |
| `minPremiumUsdPerKg = 0.05` のハード床が国別に無条件適用される | `market/parameters.ts`（分析書 §U-4） |
| 仕向市場差は `pdPremiumCoefficient`（0.9395〜1.0963）の乗算のみ | `market/destinationPricing.ts` |
| 契約単価は成約時に凍結され、以後改定されない | `sales/types.ts` `ContractCostSnapshot` |
| HOSO⇔PD の直接代替が存在しない（代替関数はPD⇔VAP専用） | `companyLab/marketEvolution.ts`（分析書 §U-6） |
| 自社の加工コストは `baseProcessingCostUsdPerTon` {hoso 350, pd 520, vap 780} USD/HOSO換算トン | `production/parameters.ts` |

## 2. 現行モデルで「PD加工コストを上げると利益だけが悪化する」因果連鎖

```
PD労働集約度係数を 1.2 → 1.8 に引き上げる（Phase A で実施済み）
  ↓
production/labor.ts  resolveLaborIntensityCoefficient が返す係数が上がる
  ↓
effectiveEfficiencyPerHeadTons = 6 / 1.8 = 3.333 t/人/Q（1.2のときは 5.0）
  ↓
同じPD数量に必要な常用人員が 1.5 倍になる
  ↓ ①コスト増                              ↓ ②数量減
finance/quarterClose.ts の人件費が増える     労働制約で生産未達が出る（PDB-11 実測: 未達 1,145t）
  ↓                                        ↓
売上原価↑                                  売上↓
  ↓                                        ↓
  └──────────────→ 営業利益↓ ←──────────────┘

一方、価格側:
market/productPremium.ts は加工コストを引数に持たない
  ↓
PDプレミアムは 1 セントも動かない
  ↓
destinationPricing → sales/allocation → 成約単価 も動かない
```

**結論**: コスト側にだけ経路があり、価格側には経路が存在しない。
だから「現実的なコスト引き上げ」が一方的な悪化にしかならない。

## 3. 新モデルの目的と、目的でないもの

### 3-1 目的

1. 消費地市場の経済価値（PDを受け取ることの価値）を、価格形成の**第一級の入力**にする。
2. 産業全体の競争的加工コストを価格のアンカーにし、コスト水準の変化が
   （需給に応じた率で）価格へ伝わるようにする。
3. 「安くなったPDが普及を進め、普及が需要を増やし、新しい需給均衡に至る」という
   産業発展のループを表現する。
4. 個社の効率差が**利益の差**として現れ、**価格の差**としては現れないようにする。

### 3-2 目的でないもの（明示的な非目的）

1. **PDを常に儲かる商品にすること。** 供給過剰では非効率企業が赤字になるべきである。
2. **個社の救済。** 自社コスト上昇が市場価格を押し上げてはならない（最重要の禁止事項）。
3. **VAPモデルの実装。** 本設計はエンジンをVAPへ再利用可能にするだけで、VAPは実装も校正もしない。
4. **HOSO価格形成の変更。** `market/hosoPricing.ts` は一切触らない。
5. **総需要の変更。** 動かすのは商品構成比のみ。市場合計需要は本モデルの管轄外。
6. **Test15 の既存ラボ・保存データの挙動変更。** §18 のとおり opt-in で完全に隔離する。

## 4. 用語と単位の定義

| 用語 | 定義 | 単位 |
| --- | --- | --- |
| **Potential PD Premium** | 消費地市場 m の買い手が、HOSOではなくPDを受け取ることに余分に払ってよい**潜在的上限** | USD/HOSO換算kg |
| **Competitive PD Processing Cost** | 世界のPD供給者（産地）の競争的な**増分**加工コスト。**個社のコストではない** | USD/HOSO換算kg |
| **Actual PD Premium** | 市場で実際に成立するPD上乗せ | USD/HOSO換算kg |
| **ScarcityCapture** | 逼迫度に応じて Potential − CompetitiveCost の差をどれだけ取れるか | 無次元 0〜1 |
| **Undercut** | 供給過剰時に競争的コストを下回る率（ソフト床） | 無次元 ≤0 |
| **AffordabilityRatio** | Actual ÷ Potential | 無次元 |
| **AbsoluteSurplus** | Potential − Actual。消費者が1kgあたり取る余剰 | USD/HOSO換算kg |
| **own incremental PD cost** | プレイヤー1社のPD増分加工コスト（HOSO比） | USD/HOSO換算kg |

**単位規約（分析書 §5 の再掲・厳守事項）**

- 数量はすべて **HOSO換算トン**。`physicalYieldRatio`（PD≈0.54）を HOSO換算量へ掛けてはならない。
- 価格・プレミアムはすべて **USD/HOSO換算kg**。商品実重量kgではない。
  物理kg換算は表示専用（$0.30/HOSO換算kg ≈ $0.556/物理PD kg）。
- 加工コストは歩留まり損失を**含まない**（HOSO換算が既に正常な重量減少を織り込む）。
- 本モデルの新規フィールド名には必ず `UsdPerHosoEqKg` を付ける（分析書 §U-2 の再発防止）。

## 5. 3層構造

```
                 ┌──────────────────────────────────────────┐
  需要側（市場別）  │ Layer 1  Potential PD Premium            │  §6
                 └──────────────────┬───────────────────────┘
                                    │
  供給側（世界）    ┌────────────────┴───────────────────────┐
                 │ Layer 2  Competitive PD Processing Cost  │  §9-2
                 └──────────────────┬───────────────────────┘
                                    │  + 世界稼働率
                 ┌──────────────────┴───────────────────────┐
                 │ Layer 3  Actual PD Premium               │  §7・§8
                 └──────────────────┬───────────────────────┘
                                    │
                 ┌──────────────────┴───────────────────────┐
  個社側          │ 単位マージン = Actual − 自社増分コスト      │  §12
                 └──────────────────────────────────────────┘
```

**個社は Layer 1〜3 のどこにも入力を持たない。** これが設計の中心的な制約である。

## 6. 市場別 Potential のデータ構造

```ts
// 新規: app/lib/v2/market/pdPotentialPremium.ts
export interface PdPotentialCurve {
  /** turn=1 時点の潜在プレミアム（USD/HOSO換算kg）。 */
  readonly initialPotentialUsdPerHosoEqKg: number;
  /** 成熟後の潜在プレミアム。 */
  readonly maturePotentialUsdPerHosoEqKg: number;
  readonly floorUsdPerHosoEqKg: number;
  readonly ceilingUsdPerHosoEqKg: number;
  /** 成熟S字の中点turn。 */
  readonly maturityMidpointTurn: number;
  /** 成熟S字の幅（四半期数）。 */
  readonly maturitySlopeQuarters: number;
  /** 景気指数1.0からの乖離への感応度。 */
  readonly economicSensitivity: number;
}

export interface PdPotentialParameters {
  readonly byMarket: Readonly<Record<DemandMarketId, PdPotentialCurve>>;
}
```

```
Potential(m,t) = clamp(
   [ P0 + (Pmax − P0) × smoothstep((t − (mid − w/2)) / w) ]
     × (1 + (economicIndex(m,t) − 1) × econSens),
   floor, ceiling )
```

`smoothstep` は `market/productLifecycle.ts` の既存関数を再利用する（重複定義しない）。

**将来の分解に備える設計上の要請**: Potential は**絶対額の単一スカラー**として閉じる。
所得・人件費・外食/中食比率・簡便志向・加工労働の希少性・廃棄物処理コストへの分解は、
`initialPotentialUsdPerHosoEqKg` をこれらの重み付き和で置き換えるだけで済む形にしておく。
比率や係数の積として持つと、後から分解できなくなる。

暫定初期値は分析書 §8-3 の表（JP 1.30→1.75 / EU 1.10→1.55 / US 1.00→1.40 /
OTHER 0.70→1.00 / CN 0.42→0.72）。**すべて要校正。**

## 7. Actual Premium の候補式と推奨

### 7-1 候補A（オーナー原案）— **採用しない**

```
Gap    = max(0, Potential − CompetitiveCost)
Actual = CompetitiveCost + Gap × ScarcityCapture
```

**棄却理由（実測つき）**: `Gap ≥ 0` かつ `ScarcityCapture ≥ 0` なので
`Actual ≥ CompetitiveCost` が**恒等的に成立する**。すなわち構造的にハード床であり、
オーナー自身が指示している「供給過剰時にActualが競争的総コストを一時的に下回れる
ソフト床」と直接矛盾する。稼働率0.30（深刻な供給過剰）でも Actual = 0.300
（＝競争コストちょうど）から下がらない（分析書 §10-1 の表）。

### 7-2 候補B（採用）— 原案に1項だけ追加

```
Gap(m,t)           = max(0, Potential(m,t) − CompetitiveCost(t))
ScarcityCapture(t) = clamp((u(t) − u_lo) / (u_hi − u_lo), 0, 1)
Undercut(t)        = −maxUndercut × clamp(1 − u(t) / u_ref, 0, 1)          // ≤ 0

Target(m,t) = CompetitiveCost(t) × (1 + Undercut(t))      // ←【追加項はここだけ】
            + Gap(m,t) × ScarcityCapture(t)

Actual(m,t) = Actual(m,t−1) + speed × (Target(m,t) − Actual(m,t−1))
Actual(m,t) = max(absoluteBackstop, Actual(m,t))
```

暫定値: `u_lo = 0.55`, `u_hi = 1.00`, `maxUndercut = 0.35`, `u_ref = 0.80`,
`speed = 0.35`, `absoluteBackstop = 0.02`。

### 7-3 候補C（検討し棄却）— 対数/CES型の混合

`Actual = CompetitiveCost^(1−a) × Potential^a` 型も検討したが、
(1) 供給過剰でコストを下回れない、(2) `a` の解釈が需給と直結せず説明可能性が落ちる、
(3) Potential=0 近傍で退化する、の3点で候補Bに劣る。棄却。

### 7-4 推奨

**候補B。** 原案からの差分が1項だけで、原案の意図（コストをアンカーに、
潜在価値との差を逼迫度で取る）をそのまま保ちながら、ソフト床要件を満たす。

**重要な性質（仕様として明記すること）**: `d(Actual)/d(CompetitiveCost) = 1 − ScarcityCapture`。
すなわち**競争的コストの価格転嫁率は逼迫時ほど低く（Capture→1 で 0%）、
過剰時ほど高い（Capture→0 で 100%）**。実測では転嫁率は約31%だった
（コスト 0.180→0.416 に対し Actual 0.641→0.714。分析書 §14-1-3）。
「PD加工コストを上げれば売値も上がる」という素朴な期待は**逼迫時には満たされない**。
これは意図した挙動であり、隠さず仕様に書く。

## 8. ソフト床の扱い

| 項目 | 方針 |
| --- | --- |
| ソフト床の実体 | `CompetitiveCost × (1 + Undercut)`。`Undercut` は稼働率が `u_ref`(0.80) を下回るほど深くなり、下限 `−maxUndercut`(−0.35) |
| ハード床 | 置かない。`absoluteBackstop`(0.02) は**数値的保険**であり経済的な床ではない。コメントで明記する |
| 既存 `minPremiumUsdPerKg = 0.05` | **新モデル有効時は適用しない。** 適用したままだとソフト床の効果を打ち消す（分析書 §U-4）。旧モデル経路では従来どおり残す |
| 実測 | 割込率 0 → 0.70 で Actual 0.260 → 0.175 と単調。割込率0で原案と一致 |

## 9. HOSO→PD 需要転換関数

### 9-1 中心信号は**2つ**必要（オーナー案からの変更点）

オーナー指示の `AffordabilityRatio = Actual / Potential` **だけでは低価値市場を再現できない。**
実測（分析書 §11-2）: ケースD（低価値市場）の最終PDシェアが
比率のみ **0.410** vs 絶対余剰ゲート追加 **0.273**。

原因: 比率は低価値市場でも中庸な値（0.62）を取るため割安シグナルが立たず、
基礎ライフサイクル曲線がそのまま走る。**比率は「いつ普及するか（時間軸、±4四半期）」は
制御できるが、「そもそも普及するか（水準）」を原理的に制御できない。**

### 9-2 採用する形

```
[時間軸 — オーナー案のまま]
  affordability(m,t) = Actual(m,t) / Potential(m,t)
  cheapness(m,t)     = clamp((affRef − affordability(m,t)) / affRef, −1, 1)
  signal(m,t)        = signal(m,t−1) + α × (cheapness(m,t) − signal(m,t−1))
  shift(m,t)         = clamp(signal(m,t) × sens, −maxShift, +maxShift)

[水準 — 追加提案]
  surplus(m,t)       = Potential(m,t) − Actual(m,t)
  gate(m,t)          = smoothstep((surplus(m,t) − s_lo) / (s_hi − s_lo))
  ceiling'(m,t)      = pdShareFloor(m) + (pdShareCeiling(m) − pdShareFloor(m)) × gate(m,t)

[構成比の確定]
  desired  = adoptionShare(pdCurve(m), t+1, shift(m,t), maxShift)     // 既存関数を再利用
  bounded  = clamp(desired, pdShareFloor(m), ceiling'(m,t))
  stepped  = clamp(bounded, pdShare(m,t) − maxStep, pdShare(m,t) + maxStep)
  pdShare(m,t+1) = clamp(stepped, 0, 1 − vapShare(m,t))
  hosoShare(m,t+1) = 1 − vapShare(m,t) − pdShare(m,t+1)
```

暫定値: `affRef = 0.62`, `α = 0.35`, `sens = 8`, `maxShift = 4`,
`s_lo = 0.10`, `s_hi = 0.80`, `maxStep = 0.02`。
市場別 PDシェア下限/上限の暫定値: JP 0.30/0.52, EU 0.24/0.46, US 0.26/0.50,
OTHER 0.18/0.42, CN 0.08/0.34。

### 9-3 二重計上とVAP吸収の防止（構造的保証）

- 動かすのは **HOSO と PD の間だけ**。`vapShare` は読むだけで書かない。
- `hosoShare` は残差として毎期再計算する。実測で全8ケース全turnの
  `|hoso + pd + vap − 1|` の最大が **2.22e-16**（浮動小数点誤差のみ）。
- 市場合計需要は本モデルが一切変更しない。
- 既存の `applyProductSubstitution`（PD⇔VAP）は**使わない**。分析書 §U-6 のとおり
  HOSO を明示的に固定する設計であり、HOSO⇔PD には使えない。

## 10. 四半期あたりの計算順序

```
turn t:
  ① pdShare(m,t)        ← 前期末に確定済み。当期は読むだけ
  ② worldPdDemand(t)    = Σ_m consumption(m,t) × pdShare(m,t)
  ③ worldPdCapacity(t)  = Σ_c pdProcessingCapacity(c,t)
  ④ utilization(t)      = worldPdDemand(t) / worldPdCapacity(t)
  ⑤ CompetitiveCost(t)  ← 産地の unitCost・capacity・utilization(t)
  ⑥ Potential(m,t)      ← 市場カーブ・economicIndex(m,t)
  ⑦ Actual(m,t)         ← 平滑化（Actual(m,t−1) を起点）
  ⑧ 価格出力            ← PD市場参照価格 = HOSO基礎価値部分 + Actual(m,t) × pdPremiumCoefficient(m)
  ⑨ 成約・生産・原価・財務（既存経路。当期の Actual を使う）
  ⑩ signal(m,t) / gate(m,t) を更新
  ⑪ pdShare(m,t+1) を確定    ←【当期の価格は翌期の構成比にしか効かない】
turn t+1: ①へ
```

**同一四半期内の循環は存在しない。** ⑦の Actual が①の pdShare を変える経路はなく、
必ず⑪を経て翌期に効く。これは既存の `marketEvolution.ts` /
`consumerInventory.ts` の規約と同一である。

既存の11ステップ連鎖（分析書 §2）との対応: 本モデルは既存 5f
（`calculateProductPremium("pd", ...)`）を置き換え、既存 6〜7
（`decomposeVietnamProductPrices` / `computeMarketReferencePrice`）へ
`Actual` を渡す形にする。5a〜5e（HOSO価格形成）と 8〜10（成約・生産・財務）は無変更。

## 11. 世界能力・競合国能力・5社供給圧力との接続

| 接続先 | 扱い |
| --- | --- |
| 世界PD能力 | `market/processingCapacityEvolution.ts` の産地別S字カーブをそのまま分母に使う（既存 opt-in `originProcessingCapacity` と同じデータ） |
| 競合国の参入 | 産地の `capacity` 増と `unitCost` の変化として入る。**外生**（シナリオ側）で与える |
| 5社供給圧力 EWMA | 現行は `premiumRatioMultiplier` として `basePremiumRatio` に乗じている。新モデルでは **Actual へ直接乗じない**。代わりに `worldPdDemand` の一部として稼働率に入れるか、あるいは当面**接続しない**（§25-3 の未決事項） |

**5社供給圧力の扱いは未決である。** 現行の乗算接続をそのまま新モデルへ持ち込むと、
「5社が売り込むと市場価格が下がる」という経路と「稼働率が価格を決める」という経路が
二重になる。プロトタイプでは接続していない。**オーナー確認が必要**（§25）。

## 12. PD省人化との接続

### 12-1 個社側にとどまるもの

自社のPD加工コスト・必要人員・残業/臨時・スループット・生産未達・成熟期のPD利益・
競争力・供給可能量。実装上は**単位マージン = Actual − 自社増分コスト**の1式にのみ現れる。

実測（分析書 §12-1、ケースG 同一市場・同一需給）:
機械化済（自社コスト 0.2033）と未機械化（0.3033）が**同一の Actual = 0.533** に直面し、
マージンだけが 0.329 vs 0.229 と異なる。

### 12-2 世界側を経由する正当な経路

産地の `unitCost` 低下と `capacity` 増加を通じて Actual が下がるのは正当。
実測（普及度 0→1、単価 −33%・能力 +50%）: Actual 0.400 → 0.146。

### 12-3 実装上の禁止事項（裏口の封鎖）

**プレイヤー5社の機械化状態を産地の `unitCost` / `capacity` へ直接流し込んではならない。**
それをすると「自社コスト → 市場価格」の経路が復活する。
産地の機械化普及は**シナリオ側の外生カーブ**でのみ与える。
ベトナム加工能力に対する5社のシェアが小さくない可能性があるため、
「集計してから希釈する」方式を採る場合は希釈率をオーナーが決める（§25）。

## 13. 消費国在庫との関係

`market/consumerInventory.ts` は既に「消費遅行弾力性・在庫キャリー・
翌期の仕向市場価格係数」を担当している。本モデルとの関係:

- **重複させない。** consumerInventory は「市場全体需要の水準」と「仕向市場係数」を、
  本モデルは「HOSO/PD の構成比」と「PDプレミアムの絶対額」を担当する。軸が違う。
- HOSO の安値 → 市場全体需要増 の経路は consumerInventory が既に持っている。
  本モデルは**総需要に触れない**ので二重計上は構造的に起きない。
- ただし `perProductDestinationPricing`（仕向市場係数を商品別に動かす opt-in）が
  有効な場合、`pdPremiumCoefficient` が時間変化する。本モデルの Actual に
  さらにこの係数が乗るため、**両方を有効にしたときの合成挙動を
  シミュレーションテストで確認する**（§テスト SIM-4）。

## 14. 成約済み価格の保全

**変更不要。** 既存 `sales/types.ts` の `SalesContract.unitPrice` と
`ContractCostSnapshot`（`expectedRawMaterialPriceUsdPerHosoEqKg` /
`expectedProcessingCostUsdPerHosoEqKg` / `expectedContributionMarginUsdPerHosoEqKg`）が
成約時スナップショットとして凍結されており、後から改定されない。

本モデルは `deriveMarketReferencePrices` の出力（＝**新規成約の basePrice**）だけを
変える。既存契約のレコードには一切触れない。
テスト CONTRACT-1 / CONTRACT-2 でこれを固定する。

## 15. Standard AI 観測への追加

`companyLab/standardAi/types.ts` の `StandardAiObservation` へ追加する。

```ts
  /** 【新規】市場別のPD潜在プレミアム（公開情報として与えてよい水準）。 */
  readonly pdPotentialPremiumByMarket?: Readonly<Partial<Record<DemandMarketId, number>>>;
  /** 【新規】世界のPD競争的加工コスト（産地側。自社コストではない）。 */
  readonly pdCompetitiveProcessingCostUsdPerHosoEqKg?: number;
  /** 【新規】世界PD稼働率。 */
  readonly worldPdUtilization?: number;
```

**混同防止が最大の設計論点。** 現行の観測は既に
`marketPremiumByProduct.pd`（＝実現プレミアム）と
`productEconomics.expectedProcessingCostUsdPerHosoEqKg.pd`（＝自社コスト）を
両方持っており、ここに Potential と CompetitiveCost が加わると **4つの似た量**が並ぶ。

対策:
1. フィールド名で役割を明示する（`pdPotential…` / `pdCompetitive…` / `marketPremium…` /
   `productEconomics.expected…`）。
2. 判断ロジック側では、**「儲かるか」の判定には必ず
   `marketPremiumByProduct.pd − productEconomics.expected….pd`（＝自社マージン）を使い、
   `pdCompetitiveProcessingCost` を自社コストの代わりに使わない**という規約を
   コメントとテスト（AI-1）で固定する。
3. `pdPotentialPremium` は「まだ取れていない余地」の観測であり、
   これを収益予測にそのまま使ってはならない。

投資・撤退判断への接続（`standardAi/decision/marketEvolutionInvestment.ts`）:
既存の `pdPremiumErosionDetected` は「プレミアム低下局面」を検知しているが、
新モデルでは **`AbsoluteSurplus` の趨勢**（＝これから普及が進むか）と
**`ScarcityCapture` の水準**（＝いま潜在価値を取れているか）で置き換えるほうが正確。
ただし本Phaseでは接続方法を指定するにとどめ、実装順は §21 の最後に置く。

## 16. 永続化・schemaVersion・後方互換

### 16-1 現状（重要な前提）

| 場所 | 値 |
| --- | --- |
| `origin/develop/v2` | `CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION = 6` |
| 本ブランチスタック | **7**（コミット `77de284`。コミットメッセージは「v4→v5」と書いてあるが実際の変更は 6→7 で、メッセージが不正確） |
| マージベース `083425a` | 6 |

マージベースが既に6なので、develop/v2 の6と本スタックの起点は同一。
**現時点では衝突していないが、develop/v2 が独立に7へ上げた場合は衝突する。**
この突き合わせは未了である。

### 16-2 したがって番号を決め打ちしない。ルールを定める

1. **PD価格モデルは新しい番号を要求しない。** 追加する carry state は
   `pdPricingState?` という **optional キー**として持ち、
   キー欠落・null は「機能無効（undefined）」を返す。
   これは既存 `validateMarketEvolutionState`（`schema.ts` L887〜、
   「キー欠落・nullは undefined（機能無効）を返す」）と**完全に同じ前例**である。
   → 旧データは**マイグレーション不要でそのまま読める**。
2. 書き込み側の番号は **「マージ確定時点の `CURRENT_…_VERSION` + 1」** とし、
   実装時にリテラルを決め打ちしない。PRの最後に1行で上げる。
3. 上限チェック（`schema.ts` L1267 の `rawVersion > CURRENT` で
   `UnsupportedCompanyLabPersistedStateVersionError`）は変更しない。
   「未来のバージョンは読めない」という既存の安全性を維持する。
4. **本スタックと develop/v2 の版番号突き合わせが完了するまで、
   PD価格モデルの版番号は確定させない。** 突き合わせ担当（コーディネーター）へ
   引き継ぐべき事項として §25 に記載する。

### 16-3 保存する carry state

```ts
export interface PdPricingCarryState {
  /** 市場別の前期 Actual（平滑化の起点）。 */
  readonly lastActualPremiumByMarket: Readonly<Record<DemandMarketId, number>>;
  /** 市場別の割安シグナルEWMA。 */
  readonly affordabilitySignalByMarket: Readonly<Record<DemandMarketId, number>>;
  /** 市場別のPDシェア（翌期に適用する確定値）。 */
  readonly pdShareByMarket: Readonly<Record<DemandMarketId, number>>;
}
```

決定論の要請から、この3つは**必ず保存する**。保存しないと中断・再開で
平滑化とEWMAの起点が変わり、再現性が壊れる（既存 `marketEvolutionState` が
`recentAppliedMixes` を carry state に移した監査指摘F と同じ理由）。

## 17. Excel / CSV / 画面 / 市場レポートの出力項目

追加先: `app/api/v2/exports/_lib/dto/marketDto.ts`（既存の
`pdPremium.basePremium` / 国別 `premium` / `finalPrice` / `qualityAdjustment` /
`capacityUtilization` の隣）。

| 出力項目 | 単位 | 出力先 |
| --- | --- | --- |
| `pdPotentialPremiumByMarket` | USD/HOSO換算kg | Excel / CSV / JSON / 市場レポート |
| `pdCompetitiveProcessingCost` | USD/HOSO換算kg | 同上 |
| `pdCompetitiveCostMethod` | 文字列 | JSON（説明可能性のため） |
| `pdCompetitiveCostCapacityWeightedMean` | USD/HOSO換算kg | JSON（分位点がどの水準に対して動いたかの補助指標。分析書 §9-3） |
| `worldPdUtilization` | 無次元 | 同上 |
| `pdScarcityCapture` | 無次元 0〜1 | 同上 |
| `pdUndercutRatio` | 無次元 ≤0 | 同上（ソフト床がどれだけ効いたか） |
| `pdActualPremiumByMarket` | USD/HOSO換算kg | 同上 |
| `pdAffordabilityRatioByMarket` | 無次元 | 同上 |
| `pdAbsoluteSurplusByMarket` | USD/HOSO換算kg | 同上 |
| `pdShareByMarket` / `hosoShareByMarket` | 無次元 | 同上 |

**すべての項目名に単位を含めるか、DTOのコメントで単位を明記する**（分析書 §U-2 の再発防止）。
Excel の加工能力見込みとの整合は既存テスト（`processingCapacityForecast.test.ts` の
EXPFC-6/7、Phase A で追加）と同じ方式で固定する（§テスト EXPORT-1）。

## 18. Test14 / Test15 への影響

**結論: opt-in フラグで完全に隔離するため、Test15 の既存ラボ・保存データは一切変わらない。**

根拠:

1. 本スタックのこれまでの実装はすべて `config.marketEvolution?.X` /
   `config.sai5?.X` の optional chaining で、**未指定なら false**。
   `runner.ts` の全参照箇所（L508, 555, 962, 977, 1020, 1024, 1171, 1175）が
   この形になっていることを確認済み。
2. PD価格モデルも同じ形で `config.marketEvolution.pdValueBasedPricing?: boolean` を
   追加し、**未指定なら従来の `calculateProductPremium` 経路をそのまま通す**。
3. 永続化は §16-2 のとおり optional キー方式で、旧データはマイグレーション不要。
4. Test15 の既存ラボは config にこのフラグを持たないので、
   価格・需要・保存データのいずれも変化しない。

**Test14 への影響**: Test14 は Standard AI の能力認識・原価構造の検証であり、
価格形成モデルの切り替えとは独立。フラグ未指定なら影響なし。
ただし §15 の観測追加は**フラグ有無にかかわらず型が増える**ため、
`StandardAiObservation` の新フィールドは **optional（`?`）** にし、
未接続時は undefined のままにする。これで Test14 の既存テストは無変更で通る。

**新モデルを有効にしたラボは Test15 とは別のラボとして作る。**
既存ラボの config を後から書き換えて有効化することは、保存データの
carry state が存在しないため**してはならない**（§テスト PERSIST-3 で固定）。

## 19. VAP拡張の境界

エンジン（3層・時間順序・単位・carry state 構造）はそのまま再利用可能。
以下の区別を設計として残す。**本設計では VAP を実装も校正もしない。**

| 論点 | PD | VAP |
| --- | --- | --- |
| Potential の中心 | 消費地で剥き作業をせずに済むこと（回避される加工コスト） | 調理労働の節約・簡便性・製品開発・差別化 |
| 積み上がり | HOSO の上 | **PD の上にさらに** |
| 会社間の能力差 | 相対的に小さい | **強く反映される** |
| 実現価格を左右する要素 | 加工コストと需給がほぼすべて | 製品開発・品質・CTS・販売関係・納品能力が強く効く |

**禁止**: VAP の総プレミアムを HOSO から直接算出すること（PDの価値を二重計上する）。
必ず `VAP価格 = HOSO価格 + PD Actual + VAP増分 Actual` の積み上げで持つ。
既存 `market/destinationPricing.ts` の分解構造
（`hosoBasePrice` / `pdProcessingPremium` / `vapIncrementalPremium`）が
既にこの形なので、それを踏襲する。

## 20. 製品実装の対象ファイル候補

| # | ファイル | 変更種別 | 内容 |
| --- | --- | --- | --- |
| 1 | `app/lib/v2/market/types.ts` | 変更 | `CountrySupplyInput` へ `pdProcessingUnitCostUsdPerHosoEqKg` を追加（**optional** にして既存呼び出しを壊さない） |
| 2 | `app/lib/v2/market/pdPotentialPremium.ts` | **新規** | Layer 1。`PdPotentialCurve` / `PD_POTENTIAL_PARAMETERS_V1` / `potentialPremium()` |
| 3 | `app/lib/v2/market/pdCompetitiveCost.ts` | **新規** | Layer 2。3手法と `competitiveCost()`。既定は `supplyStateQuantile` |
| 4 | `app/lib/v2/market/pdActualPremium.ts` | **新規** | Layer 3。`scarcityCapture()` / `undercutRatio()` / `actualPremiumTarget()` / 平滑化 |
| 5 | `app/lib/v2/market/parameters.ts` | 変更 | 新パラメータ群を `MarketParameters` へ追加（既存 `pdVapPremium` は残す） |
| 6 | `app/lib/v2/market/index.ts` | 変更 | `calculateMarketQuarter` にフラグ分岐を1箇所追加（新経路 / 従来経路） |
| 7 | `app/lib/v2/market/destinationPricing.ts` | 変更 | `decomposeVietnamProductPrices` が新モデル時は Actual をそのまま `pdProcessingPremium` として受け取る経路を追加 |
| 8 | `app/lib/v2/companyLab/pdDemandConversion.ts` | **新規** | §9 の需要転換（signal / gate / pdShare 更新） |
| 9 | `app/lib/v2/companyLab/types.ts` | 変更 | `MarketEvolutionFeatureFlags` へ `pdValueBasedPricing?: boolean`、`CompanyLabState` へ `pdPricingState?` |
| 10 | `app/lib/v2/companyLab/runner.ts` | 変更 | §10 の計算順序の配線。①〜⑪ |
| 11 | `app/lib/v2/companyLab/persistence/schema.ts` | 変更 | `validatePdPricingState`（キー欠落 → undefined） |
| 12 | `app/lib/v2/companyLab/persistence/types.ts` | 変更 | carry state 型追加。版番号は §16-2 のルールで最後に |
| 13 | `app/lib/v2/companyLab/standardAi/types.ts` | 変更 | §15 の観測3項目（optional） |
| 14 | `app/lib/v2/companyLab/standardAi/observation.ts` | 変更 | 観測の組み立て |
| 15 | `app/api/v2/exports/_lib/dto/marketDto.ts` | 変更 | §17 の出力項目 |
| 16 | `app/lib/v2/companyLab/standardAi/decision/marketEvolutionInvestment.ts` | 変更 | §15 後段。**最後に着手** |

## 21. 実装順とコミット分割の提案

### 21-1 オーナー提案の順序を「変更する」

オーナー提案:
型・パラメータ → Potential → Competitive Cost → Actual → 既存価格出力へ接続 →
翌期需要転換へ接続 → 永続化・出力 → Standard AI 観測 → Test14/Test15 比較 →
Standard AI 投資・撤退判断。

**2点だけ変更する。理由は実際のコード構造にある。**

**変更点1: 「フラグと分岐だけを先に入れる」ステップを最初に足す。**
`market/index.ts` の `calculateMarketQuarter` は Phase1 から一貫して
「入力を書き換える opt-in アダプター」方式で拡張されてきた
（`processingCapacityEvolution` / `productLifecycle` がその形）。
新モデルは既存 5f を**置き換える**ので、アダプター方式では吸収できず
`calculateMarketQuarter` 内に初めて分岐が入る。
この分岐を、中身が空（＝従来経路そのまま）の状態で先に入れて
全テストが緑であることを確認しておくと、以降の各コミットで
「Test15 を壊していないこと」を毎回確かめられる。

**変更点2: 「永続化・出力」を「翌期需要転換へ接続」より**前**に持ってくる。**
需要転換は carry state（`lastActualPremiumByMarket` /
`affordabilitySignalByMarket` / `pdShareByMarket`）に依存する。
carry state の器が無い状態で需要転換を実装すると、
中断・再開で再現性が壊れる状態のコミットが履歴に残る。
既存の監査指摘F（`recentAppliedMixes` を carry state に移した件）と同じ失敗を
繰り返さないため、器を先に作る。

### 21-2 採用する順序（コミット分割案）

| # | コミット | 内容 | 完了条件 |
| --- | --- | --- | --- |
| C1 | `feat(market): PD価値ベース価格モデルのフラグと分岐点を追加（中身は従来経路）` | フラグ定義＋`calculateMarketQuarter` の分岐（両側とも従来実装） | 全テスト緑・挙動完全不変 |
| C2 | `feat(market): 型・パラメータ・産地別加工コストの入力を追加` | 対象ファイル 1・5 | 型が通る。既定値で従来と同値 |
| C3 | `feat(market): Layer1 Potential PD Premium` | 対象 2 ＋ 単体テスト POT-1〜4 | — |
| C4 | `feat(market): Layer2 Competitive PD Processing Cost` | 対象 3 ＋ COST-1〜4 | 3手法すべて実装、既定は分位点 |
| C5 | `feat(market): Layer3 Actual PD Premium（ソフト床つき）` | 対象 4 ＋ ACT-1〜6 | — |
| C6 | `feat(market): 新モデルを既存の価格出力へ接続` | 対象 6・7 ＋ 統合テスト INT-1〜3 | フラグONで価格が変わり、OFFで完全不変 |
| C7 | `feat(persistence): PD価格carry stateの永続化（キー欠落は機能無効）` | 対象 11・12 ＋ PERSIST-1〜3 | 旧データがマイグレーション無しで読める |
| C8 | `feat(company-lab): HOSO→PD需要転換を翌期構成比へ接続` | 対象 8・9・10 ＋ CONV-1〜6 | 同一四半期循環なし・構成比保存 |
| C9 | `feat(export): PD価格モデルの出力項目をExcel/CSV/JSONへ追加` | 対象 15 ＋ EXPORT-1〜2 | Excel と内部値が一致 |
| C10 | `feat(standard-ai): PD潜在・競争コスト・稼働率を観測へ追加` | 対象 13・14 ＋ AI-1〜2 | 4つの量を混同しない |
| C11 | `test(market): Test14/Test15 非影響のcharacterizationとシミュレーション` | CHAR-1〜3・SIM-1〜4 | Test15 の既存出力が完全一致 |
| C12 | `feat(standard-ai): PD投資・撤退判断を新指標へ接続` | 対象 16 ＋ AI-3 | **最後**。ここだけは挙動が変わる |

## 22. テスト計画（単体 / 統合 / characterization / シミュレーション）

**テスト仕様の本体は §23 に記載する。**構成のみここに示す。

| 層 | 目的 | 本数の目安 | 配置 |
| --- | --- | --- | --- |
| 単体 | 各層の式が仕様どおりか | 16 | `app/lib/v2/market/__tests__/pd*.test.ts` |
| 統合 | 層をつないだときの整合 | 6 | `app/lib/v2/companyLab/__tests__/pdValuePricing*.test.ts` |
| characterization | **Test15 を壊していないこと**の固定 | 3 | `app/lib/v2/companyLab/__tests__/pdValuePricingNoImpact.test.ts` |
| シミュレーション | 複数四半期の動的挙動 | 4 | 同上（長時間のためスクリプト側でも可） |
| 永続化 | 往復・後方互換 | 3 | `app/lib/v2/companyLab/persistence/__tests__/` |
| 出力 | Excel/内部一致 | 2 | `app/api/v2/exports/__tests__/` |
| Standard AI | 4量の非混同 | 3 | `app/lib/v2/companyLab/standardAi/__tests__/` |

## 23. フィーチャーフラグ・旧モデル比較経路の要否

**両方とも必要。**

1. **フィーチャーフラグ: 必須。** `config.marketEvolution.pdValueBasedPricing?: boolean`。
   §18 のとおり Test15 の隔離がこれに依存する。既存6フラグと同じ形にする。
2. **旧モデル比較経路: 必須。** 理由は2つ。
   (a) §24 のパラメータ校正は「旧モデルとの差」を見ないと水準を決められない
       （現行の暗黙プレミアム 0.954 が唯一の実測アンカーであるため）。
   (b) characterization テスト CHAR-1〜3 が「フラグOFFで完全一致」を主張するには
       同一プロセス内で両経路を回して突き合わせる必要がある。
   実装: `calculateMarketQuarter` の分岐（C1）をそのまま比較にも使う。
   **新規の比較専用コードパスは作らない**（二重実装を避ける）。

## 24. 未確定パラメータと校正方法

| パラメータ | 暫定値 | 校正方法 |
| --- | --- | --- |
| 市場別 Potential（5市場×7値） | 分析書 §8-3 | 現行の暗黙プレミアム 0.954（HOSO 5.3 × 0.18）を US 中位に合わせ、市場順序は人件費・加工労働確保・廃棄物処理規制の3指標で相対付け。**実データ照合が望ましいが未了** |
| 産地別 `pdProcessingUnitCost`（4か国） | VN 0.26 / IN 0.30 / ID 0.34 / EC 0.46 | **現行コードに存在しないデータ。** 自社の増分コスト（未機械化 0.3033・機械化済 0.2033）との大小関係が §25-1 の決定事項 |
| `u_lo` / `u_hi`（Capture） | 0.55 / 1.00 | 現行の `referenceUtilization = 0.85` を中央に含む帯にした。稼働率分布を実測して再調整 |
| `maxUndercut` | 0.35 | 感度は分析書 §14（0→0.70 で Actual 0.260→0.175）。**どこまで下回ってよいかはオーナー判断** |
| `u_ref` | 0.80 | 同上 |
| `speed` | 0.35 | 既存 `marketEvolution` の EWMA α=0.35 と揃えた。0.1〜1.0 で発振しないことを実測済み |
| `affRef` | 0.62 | プロトタイプの中立点。**旧モデル比較経路で実測してから決める** |
| `s_lo` / `s_hi`（余剰ゲート） | 0.10 / 0.80 | 低価値市場 0.158 と通常市場 0.726 を分離できる値として選んだ |
| 市場別 PDシェア下限/上限 | §9-2 | 既存 `productLifecycle` の `initialShare` / `matureShare` と整合させる |
| 分位点 `q_slack` / `q_tight` | 0.25 / 0.85 | 産地数が4しかないため分位点の刻みが粗い。産地を増やすなら再検討 |

**校正の順序**: (1) 旧モデル比較経路で現行の Actual 相当値の分布を測る →
(2) Potential をその分布の上側に置く → (3) 産地コストを自社コストとの
大小関係（§25-1）から決める → (4) Capture/Undercut を稼働率分布に合わせる →
(5) 需要転換パラメータを最後に合わせる。

## 25. リスク・未解決・オーナー決定事項

### 25-1 オーナーが決めるべきこと

1. **プレイヤーの機械化後コスト（0.2033）と世界最効率産地コスト（0.26）の大小。**
   前者を低くすると、完全に機械化した会社は PD で**決して赤字にならない**
   （実測: 能力1.8倍の供給過剰でもマージン +0.006）。
   後者を低くすると、機械化してもなお産地平均に届かない設計になる。
   **この1点で「PDが常に儲かる構造」を作るかどうかが決まる。**
2. **ソフト床の割込率 `maxUndercut`。** 供給過剰時に競争的コストを何割まで
   下回れるか。0.35（暫定）で Actual 0.216、0.70 で 0.175。
3. **5社供給圧力 EWMA を新モデルへ接続するか**（§11）。接続すると
   稼働率経路と二重になる恐れがある。プロトタイプでは未接続。
4. **産地の機械化普及にプレイヤーの寄与を混ぜるか**（§12-3）。
   混ぜる場合の希釈率。混ぜなければ裏口は構造的に閉じる。
5. **既存 `minPremiumUsdPerKg = 0.05` を新モデル経路で外すこと**の承認（§8）。

### 25-2 リスク

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| 版番号の衝突（本スタック7 vs develop/v2 6、突き合わせ未了） | マージ時に永続化が壊れる | §16-2 のルール（番号を決め打ちせず、carry state は optional キー）で影響を最小化 |
| `calculateMarketQuarter` に初めて分岐が入る | 既存のアダプター方式の一貫性が崩れる | C1 で分岐だけを先に入れ、両側が同一実装であることをテストで固定 |
| 産地別加工コストが実データでない | 校正が仮定に依存 | 数値を「現状の事実」として提示しない。DTO・コメントで仮定であることを明記 |
| 逼迫時のコスト転嫁率が約0% | 「コストを上げれば売値も上がる」期待が外れる | §7-4 のとおり仕様に明記する |
| Potential と自社コストの混同 | AI が誤った投資判断をする | §15 の命名規約＋テスト AI-1 |

### 25-3 未解決（本設計で決めきれなかったもの）

1. 5社供給圧力の接続方法（§11）。
2. 国別稼働率が世界稼働率のコピーである問題（分析書 §U-5）。
   産地別の逼迫を表現するには別途データが要る。本設計では世界稼働率のみを使う。
3. `fixedCostAllocationCoefficientByProduct` の誤り（分析書 §U-1。VAPで7.7%乖離）。
   **本モデルとは独立に修正が必要**だが、本設計のスコープ外。
4. Phase A で発見した「通常審査を通った借入が一度も実行されない」問題。
   PD価格モデルとは無関係だが、シミュレーション結果の解釈に影響する。

---

# テスト仕様

各テストについて **対象モジュール / 入力 / 期待結果 / assert 項目** を示す。
テストIDはそのままテスト名の接頭辞として使うこと。

## 単体テスト — Layer 1 Potential

### POT-1 市場ごとに Potential が異なる
- **対象**: `market/pdPotentialPremium.ts` `potentialPremium()`
- **入力**: `PD_POTENTIAL_PARAMETERS_V1`、`turn = 1`、`economicIndex = 1.0`、5市場すべて
- **期待**: JP > EU > US > OTHER > CN の狭義単調
- **assert**:
  - `potential("JP") > potential("EU") > potential("US") > potential("OTHER") > potential("CN")`
  - すべて有限かつ正
  - `potential("JP") ≈ 1.30`（暫定値。パラメータ変更時はこの期待値も更新する旨をコメント）

### POT-2 経済発展が Potential を上げる
- **入力**: 同一市場・同一turn で `economicIndex` を 0.9 / 1.0 / 1.1
- **期待**: 単調増加
- **assert**:
  - `potential(econ=1.1) > potential(econ=1.0) > potential(econ=0.9)`
  - 増分が `economicSensitivity` に比例:
    `(potential(1.1) − potential(1.0)) / potential(1.0) ≈ 0.1 × econSens`（上下限に当たらない範囲で）

### POT-3 上下限でクランプされる
- **入力**: `economicIndex = 5.0` および `0.1`
- **assert**: `potential ≤ ceiling` かつ `potential ≥ floor`

### POT-4 S字が単調非減少で、中点で中間値をとる
- **入力**: `turn = 1..32`、`economicIndex = 1.0`
- **assert**:
  - 全 turn で `potential(t+1) ≥ potential(t) − 1e-12`（単調非減少）
  - `potential(maturityMidpointTurn) ≈ (initial + mature) / 2`（許容 ±2%）
  - `potential(1) ≈ initialPotential`、`potential(32) ≈ maturePotential`

## 単体テスト — Layer 2 Competitive Cost

### COST-1 3手法がすべて実装され、産地コストの範囲内に収まる
- **対象**: `market/pdCompetitiveCost.ts` `competitiveCost()`
- **入力**: 4産地（VN 0.26/260,000t, IN 0.30/120,000t, ID 0.34/90,000t, EC 0.46/60,000t）、稼働率 0.4〜1.1
- **assert**: どの手法・どの稼働率でも `0.26 ≤ cost ≤ 0.46`

### COST-2 能力加重平均・中央値は稼働率に反応しない
- **入力**: 同上、稼働率 0.4 / 0.8 / 1.1
- **assert**:
  - `capacityWeightedMean` の3値がすべて厳密一致
  - `capacityWeightedMedian` の3値がすべて厳密一致
  - （**この2手法を既定にしてはならない**理由の固定。分析書 §9-2）

### COST-3 需給連動分位点は過剰で低コスト側・逼迫で限界供給者側へ動く
- **入力**: `supplyStateQuantile`、稼働率 0.40 / 0.80 / 1.10
- **期待**: 0.260 / 0.300 / 0.340
- **assert**:
  - `cost(u=0.40) ≈ 0.260`（= 最効率産地 VN）
  - `cost(u=1.10) ≈ 0.340`（= 中位より上）
  - `cost(u=0.40) < cost(u=0.80) < cost(u=1.10)` の狭義単調

### COST-4 **個社コストは引数に存在しない（型と実行の両面）**
- **assert**:
  - `competitiveCost()` のシグネチャに個社を表す引数がないことをコメントで明示
  - 同一の産地状態・稼働率に対し、**呼び出し側が異なる会社であっても戻り値が同一**
    （会社ループの中で呼んで全社同値であることを確認）

## 単体テスト — Layer 3 Actual Premium

### ACT-1 世界能力の増加が Actual を下げる
- **対象**: `market/pdActualPremium.ts` `actualPremiumTarget()`
- **入力**: `Potential = 1.30` 固定、`CompetitiveCost = 0.30` 固定、稼働率を能力増に対応させて 1.00 → 0.60 → 0.40
- **assert**: `actual(u=1.00) > actual(u=0.60) > actual(u=0.40)`

### ACT-2 世界需要の増加が Actual を上げる
- **入力**: 同上、稼働率を需要増に対応させて 0.40 → 0.80 → 1.05
- **assert**: 狭義単調増加。`actual(u=1.05) ≈ Potential`（Capture=1のため）

### ACT-3 通常条件で Actual は Potential を超えない
- **入力**: `Potential ∈ {0.5, 1.0, 1.5, 2.0}` × 稼働率 `∈ {0.6, 0.8, 1.0, 1.2}`、`CompetitiveCost ≤ Potential`
- **assert**: すべての組み合わせで `actual ≤ potential + 1e-9`

### ACT-4 ソフト床の割り込みは深刻な供給過剰でのみ許される
- **入力**: `Potential = 1.30`、`CompetitiveCost = 0.30`、稼働率 0.30 / 0.60 / 0.80 / 0.95
- **期待**: 0.234 / 0.385 / ≈0.30以上 / 0.30以上
- **assert**:
  - `actual(u=0.30) < CompetitiveCost`（＝割り込む）
  - `actual(u=0.80) ≥ CompetitiveCost − 1e-9`（`u_ref=0.80` 以上では割り込まない）
  - `actual(u=0.95) > CompetitiveCost`
  - **【オーナー案からの乖離を明記】** このテストは、オーナー原案
    `Actual = CompetitiveCost + max(0,Gap) × Capture` では **u=0.30 で 0.300 となり失敗する**。
    原案が構造的にハード床であることの回帰防止テストである（分析書 §10-1）。

### ACT-5 割込率0で原案と一致する
- **入力**: `maxUndercut = 0`、稼働率 0.30〜1.20
- **assert**: 全稼働率で `actualPremiumTarget(...) ≈ actualPremiumOwnerForm(...)`（許容 1e-9）
  - （採用案が原案の**厳密な拡張**であることの固定）

### ACT-6 高い Potential が供給過剰の効果を打ち消さない
- **入力**: 稼働率 0.40（供給過剰）固定、`Potential` を 1.0 / 1.5 / 2.0 / 3.0 倍
- **期待**: Actual がほぼ動かない
- **assert**: `|actual(Pot×3.0) − actual(Pot×1.0)| < 0.05`
  - 実測では +0.002（分析書 §10-3）

## 単体テスト — 需要転換

### CONV-1 Actual/Potential の低下が翌期のPDシェアを上げる
- **対象**: `companyLab/pdDemandConversion.ts`
- **入力**: 同一市場・同一基礎曲線で `affordability` を 0.80 / 0.62 / 0.40 とし、EWMA を4四半期回す
- **assert**:
  - `pdShare_next(aff=0.40) > pdShare_next(aff=0.62) > pdShare_next(aff=0.80)`
  - `shift` が `[−4, +4]` にクランプされている

### CONV-2 **絶対余剰ゲートが低価値市場の普及を抑える**
- **入力**: 低価値市場（`Potential = 0.42`）と通常市場（`Potential = 1.337`）を、
  同一の `Actual`比率になるよう調整して12四半期回す
- **期待**: 低価値市場の最終PDシェアが有意に低い
- **assert**:
  - ゲート有効時: 低価値市場の最終PDシェア < 0.30（初期値以下にとどまる）
  - ゲート無効時: 低価値市場の最終PDシェア > 0.40
  - **【オーナー案からの乖離を明記】** オーナー指示の中心信号
    `AffordabilityRatio` のみでは低価値市場の普及を抑えられない
    （実測 0.410 vs 0.273。分析書 §11-2）。本テストは絶対余剰ゲートの
    必要性そのものを固定する

### CONV-3 同一四半期内の循環がない
- **入力**: turn t の `Actual` を人為的に2倍にする
- **assert**:
  - turn t の `pdShare` が変化しない（厳密一致）
  - turn t+1 の `pdShare` は変化する
  - （時間順序 §10 の構造的固定）

### CONV-4 HOSO+PD のアドレッサブル総量が保存される
- **入力**: 全8ケース相当の条件で32四半期
- **assert**: 全 turn・全市場で `|hosoShare + pdShare + vapShare − 1| < 1e-12`
  - 実測の最大は 2.22e-16

### CONV-5 VAP需要が二重計上されない
- **入力**: PDシェアが下限から上限まで動く条件で32四半期
- **assert**:
  - 全 turn で `vapShare` が入力値と厳密一致（本モデルが書き換えていない）
  - `pdShare ≤ 1 − vapShare`
  - VAP の絶対需要量（`consumption × vapShare`）が PD の変化に対して不変

### CONV-6 四半期あたりの変化が上限で抑えられる
- **入力**: `affordability` を 0.9 → 0.1 に急変させる
- **assert**: 全 turn で `|pdShare(t+1) − pdShare(t)| ≤ maxStep + 1e-12`

## 統合テスト

### INT-1 個社の加工コストだけを変えても市場 Actual が変わらない
- **対象**: `companyLab/runner.ts` 経由の1四半期実行
- **入力**: 同一シード・同一シナリオで、1社の `baseProcessingCostUsdPerTon.pd` 相当だけを 520 → 900 に変える
- **期待**: 市場価格は完全一致、その会社の利益だけが悪化
- **assert**:
  - `marketResult.pdActualPremiumByMarket` が両実行で**全市場・厳密一致**
  - `pdCompetitiveProcessingCost` が厳密一致
  - 当該会社の PD 単位マージンが減少
  - 他社の PD 単位マージンが厳密一致
  - （**最重要の禁止事項の回帰防止テスト**）

### INT-2 個社の機械化がその会社のマージンだけを改善する
- **入力**: 同一シード・同一需給で、1社だけ `pdMechanizationState` を機械化済にする
- **assert**:
  - `pdActualPremiumByMarket` が両実行で厳密一致
  - 機械化した会社の PD 単位マージンが増加（実測相当: 0.229 → 0.329）
  - 他社のマージンが厳密一致

### INT-3 成熟期に未機械化企業が赤字になりうる
- **入力**: 世界PD能力を過剰（×1.8）にして12四半期
- **assert**:
  - 未機械化企業（自社増分コスト 0.3033）の PD 単位マージン < 0
  - 非効率企業（0.46）の PD 単位マージン < 0
  - `actual < competitiveCost`（ソフト床が効いている）

### INT-4 既存契約の価格が変わらない
- **入力**: turn t で成約 → turn t+1 で新モデルの `Actual` を大きく変動させる
- **assert**:
  - turn t に成約した契約の `unitPrice` が turn t+1 でも厳密一致
  - `ContractCostSnapshot` の3項目がすべて厳密一致
  - （テスト名: `CONTRACT-1` としてもよい）

### INT-5 新規契約だけが新価格を使う
- **入力**: 同上
- **assert**:
  - turn t+1 に成約した契約の `unitPrice` が新しい `Actual` に基づく値
  - turn t の契約と turn t+1 の契約で `unitPrice` が異なる
  - （テスト名: `CONTRACT-2`）

### INT-6 固定シードで結果が再現する
- **入力**: 同一シード・同一 config で2回実行
- **assert**:
  - 全 turn・全市場の `pdActualPremiumByMarket` / `pdShareByMarket` /
    `pdCompetitiveProcessingCost` が**厳密一致**（浮動小数点の完全一致）
  - 会社別の最終現金・純資産が厳密一致

## characterization テスト（Test15 非影響の固定）

### CHAR-1 フラグ未指定なら市場結果が完全に一致する
- **入力**: `config.marketEvolution` に `pdValueBasedPricing` を**指定しない** config で、
  新実装と `origin/develop/v2` 相当の期待値を突き合わせる
- **assert**:
  - `pdPremium.basePremium` / 国別 `premium` / `finalPrice` / `qualityAdjustment` /
    `capacityUtilization` が従来値と**厳密一致**
  - `deriveMarketReferencePrices` の 5市場×3商品の全値が厳密一致

### CHAR-2 フラグ未指定なら会社ラボの32四半期実行が完全に一致する
- **入力**: Test15 相当の config・シードで32四半期
- **assert**: 全会社の最終現金・純資産・累積売上・累積営業利益・受注残が厳密一致

### CHAR-3 フラグ未指定なら永続化スナップショットに新キーが現れない
- **assert**:
  - 保存された JSON に `pdPricingState` キーが**存在しない**
  - `schemaVersion` が従来値のまま

## シミュレーションテスト

### SIM-1 導入期→成長期→成熟期でプレミアムが山型に推移する
- **入力**: 世界PD能力を 0.62倍 → 線形増加 → 1.55倍 と動かして24四半期
- **assert**:
  - 序盤の `Actual` が終盤より高い（実測相当: 0.941 → 0.215）
  - `Actual/Potential` が単調に近く低下
  - PDシェアが単調非減少

### SIM-2 供給ショック後、遅れてPD需要が増える
- **入力**: turn6 で世界PD能力を 413,400 → 768,500 t
- **assert**:
  - `Actual` が turn6〜7 で下落（0.434 → 0.356 → 0.306）
  - `worldPdDemand` が turn9 以降で shock 前を上回る
  - 価格の下落が需要の増加より**先行**する（ピーク位置の比較）

### SIM-3 需要ショックで稼働率とプレミアムが上がる
- **入力**: turn6 で全市場消費を 1.35倍、能力固定
- **assert**:
  - `utilization` が 0.62 → 0.88 前後へ上昇
  - `Actual` が 0.353 → 1.058 前後へ上昇
  - `ScarcityCapture` が 0.18 → 0.70 以上へ上昇

### SIM-4 値が発散も激しい発振もしない
- **入力**: 全シナリオ×32四半期、`speed` を 0.1 / 0.35 / 1.0 の3水準
- **assert**:
  - 全 turn で `Actual` が有限かつ `[absoluteBackstop, ceiling]` 内
  - `|Actual(t) − Actual(t−1)|` の最大が 0.25 未満（実測の最大は 0.162）
  - `pdShare` が `[0, 1 − vapShare]` 内
  - **`perProductDestinationPricing` を同時に有効にした場合も上記が成立**（§13）

## 永続化テスト

### PERSIST-1 carry state が往復する
- **対象**: `companyLab/persistence/schema.ts`
- **入力**: `pdPricingState` を持つ状態を保存 → 読み込み
- **assert**:
  - `lastActualPremiumByMarket` / `affordabilitySignalByMarket` / `pdShareByMarket` の
    全市場の値が**厳密一致**
  - 保存 → 読み込み → 1四半期実行 の結果が、中断なし実行と**厳密一致**

### PERSIST-2 旧保存データがマイグレーション無しで読める
- **入力**: `pdPricingState` キーが**存在しない**旧スナップショット（`schemaVersion` 6 相当）
- **assert**:
  - 読み込みが例外を投げない
  - `pdPricingState` が `undefined`（＝機能無効）になる
  - 読み込み後の実行が従来経路で進む
  - （既存 `validateMarketEvolutionState` と同じ前例に従う）

### PERSIST-3 carry state を持たない既存ラボでフラグを後から有効化できない
- **入力**: `pdPricingState` の無い保存データを、`pdValueBasedPricing: true` の config で読む
- **期待**: 明示的なエラー、または安全な初期化＋警告
- **assert**:
  - 黙って不定な初期値で走り出さないこと
  - エラーメッセージに「既存ラボでの後から有効化は不可」の旨が含まれる
  - （§18 の「新モデルは別ラボとして作る」を強制する）

## 出力テスト

### EXPORT-1 Excel の PD 価格・加工能力が内部値と一致する
- **対象**: `app/api/v2/exports/_lib/dto/marketDto.ts`
- **入力**: 新モデル有効の1四半期結果
- **assert**:
  - `pdActualPremiumByMarket` の5市場すべてが `marketResult` の内部値と**厳密一致**
  - `pdCompetitiveProcessingCost` / `worldPdUtilization` / `pdScarcityCapture` が内部値と厳密一致
  - 加工能力見込みは既存 EXPFC-6/7 と同じ方式で画面値と一致

### EXPORT-2 新モデル無効時に新項目が出力されない
- **assert**: DTO に新フィールドが現れない、または全て `undefined`

## Standard AI テスト

### AI-1 **Potential / Actual / Competitive Cost / 自社コストを混同しない**
- **対象**: `companyLab/standardAi/observation.ts` および判断ロジック
- **入力**: 4つの値を意図的にすべて異なる値にする
  （例 Potential 1.40 / Actual 0.60 / CompetitiveCost 0.30 / 自社コスト 0.45）
- **assert**:
  - 観測の4フィールドがそれぞれ正しい値を持つ（取り違えていない）
  - 収益性判定に使われる値が `Actual − 自社コスト = 0.15` であること
    （`Actual − CompetitiveCost = 0.30` でも `Potential − 自社コスト = 0.95` でもない）
  - 自社コスト 0.45 > Actual 0.60 ではないので黒字判定、
    自社コストを 0.70 に変えると赤字判定に切り替わる

### AI-2 観測フィールドが optional で、未接続時に undefined になる
- **入力**: `pdValueBasedPricing` 未指定の config
- **assert**:
  - `pdPotentialPremiumByMarket` / `pdCompetitiveProcessingCostUsdPerHosoEqKg` /
    `worldPdUtilization` がすべて `undefined`
  - 既存の Test14 相当の判断結果が**従来と厳密一致**

### AI-3 投資判断が Potential を収益予測に直接使わない
- **入力**: Potential だけを 2倍にし、Actual・自社コストは固定
- **assert**:
  - PD省人化の投資可否判断が**変わらない**
  - （Potential は「まだ取れていない余地」であり、収益予測の入力ではない。§15）
