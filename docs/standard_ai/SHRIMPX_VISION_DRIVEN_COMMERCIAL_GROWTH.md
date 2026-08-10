# ShrimpX V2 — Vision 駆動の商業成長（Phase 6 / 6B / 6C 完成版）

最終更新: 2026-08-10（Phase 6C 完成・正式営業能力モデル切替）

---

## 0. この文書が答えること

「この会社は大きくなりたい」から「だからこれだけ生産した」まで、**どの数字がどの数字を生むのか**を1本の因果として定義する。

```
VISION
 ↓
COMMERCIAL AMBITION      売りたい量
 ↓
COMMERCIAL COMMITMENT    今期、市場へ取りに行く量
 ↓
SALES ORGANIZATION       その量を捌ける営業組織か
 ↓
SUBMITTED SALES          実際に市場へ提示した量
 ↓
CONTRACTS                市場が実際に応じた量
 ↓
PRODUCTION REQUIREMENT   作ると決めた量
 ↓
PRODUCTION               実際に作った量
 ↓
UNSERVED OPPORTUNITY     取りたかったのに取れなかった量
 ↓
BOTTLENECK               何が成長を止めているのか
 ↓
STRATEGIC INVESTMENT / NEW FACTORY
```

**この6つは別々の量である。** 「売りたい」「市場へ取りに行く」「実際に売れた」「作る」を同じ数字として扱ってはならない。

---

## 1. Commercial Ambition（売りたい量）

`app/lib/v2/companyLab/vision/commercialAmbition.ts`

Vision の参考成長軌道と、観測できる採算つき市場機会から、その四半期に**どこまで売りたいか**を決める。

- 供給側アンカー（自社能力 × 稼働率目標）を**床**として保つ。
- 志が先行していれば拡大せず、市場が弱い・採算が薄い・在庫が過剰なら据え置く。
- 商品構成は変えない（どの商品を伸ばすかをここで発明しない）。

限定要因は `VISION_ON_TRACK / MARKET_WEAK / MARGIN_WEAK / INVENTORY_EXCESS / STEP_LIMIT / OPPORTUNITY_CEILING / NONE`。

---

## 2. Commercial Commitment（今期、市場へ取りに行く量）【Phase 6C 新設】

`app/lib/v2/companyLab/vision/commercialCommitment.ts`

### なぜこの層が必要になったか

Phase 6B で、現行の市場別営業能力が「営業能力の表現」であると同時に、**偶然、販売提出量のリミッター**として働いていたことが判明した。営業能力の壁を外した途端、Commercial Ambition がほぼそのまま提出量になった。

```
提出 24,420t → 成約 14,425t（転換率59%）
→ 生産は提出量へ追随 → 完成品在庫 4,991t → 15,042t（3.0倍）
→ 32Q累計営業利益 −61%
```

### 計算

1. 志を出発点にする。
2. 期待成約率を求める（下記3）。
3. 「志を成約するために必要な提出量」＝ 志 ÷ 期待成約率。
4. 志への上乗せは `maximumStretchOverAmbition`（1.25）が天井。
5. 観測できる採算つき市場機会 × `realisticShareOfOpportunity`（0.5）で上から抑える。
6. 営業組織が捌ける案件量で上から抑える。
7. **完成品在庫では下げない。** 在庫は「生産を抑える理由」であって「売るのをやめる理由」ではない。

### パラメータ（`COMMERCIAL_COMMITMENT_PARAMETERS_V1`）

| 項目 | 値 | 意味 |
|---|---|---|
| `targetConversionFloor` | 0.75 | 目標成約率の下限 |
| `targetConversionCeiling` | 0.90 | 目標成約率の上限。**100%を目標にしない** |
| `maximumStretchOverAmbition` | 1.25 | 志に対する提出の上乗せ上限 |
| `minimumUsableConversion` | 0.35 | 観測成約率の下限打ち切り |
| `conversionLearningRate` | 0.70 | 観測値と目標帯中央値の混合比 |
| `realisticShareOfOpportunity` | 0.50 | 観測機会のうち現実に取りに行ける比率 |
| `productionExpectedConversionFloor` | 0.50 | 生産見積りに使う率の下限 |

限定要因は `NONE / RECENT_CONVERSION / MARKET_OPPORTUNITY / SALES_CAPACITY / STRETCH_LIMIT`。

---

## 3. Conversion（提出 → 成約 の学習）【Phase 6C 新設】

`app/lib/v2/companyLab/standardAi/commercialHistory.ts`
`app/lib/v2/companyLab/commercialHistoryState.ts`

直近4四半期の「**自社が提出した量**」に対する「**自社が実際に成約した量**」の比を観測する。

- 提出側は新設の carry state（`commercialHistoryState`）から。
- 成約側は既存の契約台帳（`contracts[].originalQuarter/originalQuantity`）から。
- **TRUE WORLD（市場の真の需要）は見ない。他社の計画も見ない。**
- 履歴が無い場合は `null` を返す。**`null` を 1.0 と読み替えてはならない。**

### 提出用と生産用で別の率を使う理由

| 用途 | 使う率 | 理由 |
|---|---|---|
| 提出量の逆算 | 観測値 × 0.70 ＋ 目標帯中央値 × 0.30 | 「目標成約率75〜90%を狙って取りに行く」ための**狙い** |
| 生産量の見積り | 観測値そのもの（下限0.50で打ち切り） | 「実際に何トン成約しそうか」という**予測** |

生産側を目標帯へ引き寄せると、実際にほぼ100%成約している会社でも生産を約5%過小に見積もってしまう。狙いと予測を混ぜない。

### なぜ provider のクロージャではなく永続化状態なのか

クロージャに記憶を置くと、Console（1プロセスで32Q連続実行）では学習するのに、API（1四半期ごとに永続化状態から復元）では学習しない、という**経路によって挙動が変わる**状態になる。プレイヤーが遊ぶ本番経路と、校正に使う経路が食い違うのは許容できないため、`salesBaseState` と同じ carry state として実装した。キー欠落＝履歴なし（学習しないだけで壊れない）。

---

## 4. Production Requirement（作ると決めた量）【Phase 6C 修正】

`app/lib/v2/companyLab/standardAi/diagnosis/currentPeriodDeliveryDemand.ts`

```
当期納品需要 = 確定した受注残 × 1.0
             + 未成約の販売計画 × 期待成約率

基本生産必要量 = 当期納品需要 + 通常在庫目標 − 期首完成品在庫
```

### 修正した根本原因

旧実装は「未成約の販売計画 × 1.0」だった。この「× 1.0」はコードのどこにも書かれておらず、**掛け算そのものが存在しないことで暗黙に1.0になっていた**。Control ではこれが露見しなかった（営業能力が提出量を削っていたため、転換率が実測ほぼ100%で前提が偶然正しかった）。

- 受注残には期待成約率を掛けない（確定した需要を確率で割り引かない）。
- 先行生産はゼロにしない（期待成約率ぶんは織り込む）。下限0.50で生産停止も防ぐ。
- 在庫が多ければ `− 期首完成品在庫` で自動的に生産が抑制される。

理由コード: `PRODUCTION_LIMITED_TO_CONFIRMED_DEMAND` / `PRODUCTION_INCLUDES_EXPECTED_CONVERSION`。

---

## 5. Sales Capacity SSoT【Phase 6C 修正】

`app/lib/v2/sales/salesCapacityModel.ts` が唯一の情報源。

### 修正した穴

`sales/allocation.ts` の個社成約上限が `processingCapacity(headcount)` を自分で呼び直しており、会社全体営業能力モデルを通らなかった。販売計画は会社全体モデルで縮小されるのに、成約配分では**旧・市場別曲線が二重に効いていた**。

現在は `applyMarketSalesEffortCapacity` が「実際に適用した会社×市場の能力」を返し、`sales/runner.ts` がそれを `allocateMarketProduct` へ渡す。工数トン → 商品トンは当該商品の営業工数係数で割り戻す（工数の単位を混ぜない）。

---

## 6. Test16 正式営業能力モデル（2026-08-10 切替）

### 会社営業組織モデル v1（`SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1`）

ベンチマーク上の呼称は "Case B + V1" だったが、Case名は研究用の一時的な符牒であるため正式名称で格納した。

```
kind:                            companyWide
capacity(h) = 1,000 + 95,000 × h/(h+190)    工数トン/四半期
fragmentation penalty:           0（適用しない）
営業工数係数:                     HOSO 1.0 / PD 1.2 / VAP 3.0（切替で変更していない）
```

| 営業人員 | 会社の営業能力（工数t/Q） |
|---|---|
| 0 | 1,000 |
| 60 | 23,800 |
| 100 | 33,759 |
| 130 | 39,594 |
| 190 | 48,500（半飽和点） |
| ∞ | 96,000（漸近上限） |

### モデルの意味

営業能力は**会社の営業組織**が持つものであり、市場ごとに独立して湧くものではない。会社全体で1回だけ処理能力を求め、各市場の営業工数需要の比率で配分する。したがって市場を増やしても会社の総能力は増えない（旧モデルはここが逆だった）。

### 採用理由

5seed × 32Q で、Control（旧モデル）以上の累計営業利益・生産停止なし・現金負なし・在庫発散なしを確認した。

### 採用しなかった候補

- **Case A**（市場別のまま曲線だけ再校正）: 累計営業利益が Control の66%まで低下。
- **Case C（＋市場分散の非効率0.03）**: 5seed中1seedで MASS が資金枯渇 → 生産0×16Q → 現金 −159M → 借入61M。重大 regression。
  研究候補として `SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_WITH_FRAGMENTATION_RESEARCH` に残す（将来の AGGRESSIVE / growth-oriented archetype の材料）。

### 後方互換

`SALES_PARAMETERS_LEGACY_PER_MARKET` として旧モデルを明示的に保存している。`salesCapacityModel` を持たない旧スナップショットは `perMarket` として復元される（マイグレーション処理は不要）。

---

## 7. Sales Organization 診断【Phase 6C 新設】

`SalesHiringDiagnosticsRecord`（`decision/salesForceHiring.ts`）

「人が足りない」と「増やしたくない」を区別するために、次を毎四半期かならず残す。

| 項目 | 意味 |
|---|---|
| `currentHeadcount` | 現在の稼働営業人員 |
| `requiredHeadcount` | 目標販売量を捌くのに必要な人数 |
| `unconstrainedEconomicDesiredHeadcount` | 経済合理性だけで欲しい人数 |
| `organizationallyAllowedHeadcount` | 組織の吸収能力（max(3, ceil(現在×30%))）まで |
| `financiallyAllowedHeadcount` | 最低現金バッファ余力 ÷ 四半期給与 まで |
| `actualHireCount` / `actualLayoffCount` | 実際に動かした人数 |
| `zeroHireReason` | **採用0のときは必ず入る** |

Phase 6B の監査では「required > current なのに採用0、理由コードなし」が29件あった。現在は0件（実測: 採用0が101件、理由コードなしは0件）。

---

## 8. 未充足機会の制約分解

`app/lib/v2/companyLab/vision/unservedOpportunity.ts`

取りたかったのに取れなかった採算つき機会を、**同じトン数を二度数えない**順序で割り当てる。

```
在庫 → 生産能力 → 営業能力 → その他
（労働力・原料は、診断がそれらを名指しした場合にのみ生産能力ぶんから移す）
```

**新工場の根拠になりうるのは `PRODUCTION_CAPACITY` の分だけである。** 工場を建てても解決しない不足（労働力・原料）を新工場の根拠にしない。

---

## 9. 画面と Pack

| 場所 | 内容 |
|---|---|
| Company Inspector「Commercial Growth」 | ①Vision参考軌道 ②売りたい ③取りに行く ④提示 ⑤売れた ⑥作った ＋ 決定論テンプレートの説明文 |
| Company Inspector「Commercial Thinking」（折りたたみ） | 提出を縛った要因・各種転換率・生産必要量 |
| Company Inspector「Sales Organization」（折りたたみ） | 現在/必要/経済的に欲しい/組織上/資金上/採用/減員/能力/稼働率/理由 |
| `/v2/management/analysis/commercial-growth` | 6系列の同一チャート・Constraint Breakdown・Sales Organization・Conversion |
| AI Trace（WANTED 段階） | Vision → Ambition → Commitment → 営業組織（既存6段階は不変） |
| Pack `14e_Commercial_Growth` | 因果の全列 |
| Pack `14f_Constraint_Breakdown` | 制約別の未充足量 |
| Pack `14g_Sales_Organization` | 営業組織の全列 |
| Pack `05_Data_Dictionary.md` | 4つの量の定義（混同防止） |

説明文は**決定論的テンプレート**で組み立てる。生成AIは使わない。値が無いところは書かない。

---

## 10. 変更していないもの

market demand / targetDemand生成 / external outflow / maximumSupplierShare /
competitivenessWeights / price formation / raw availability / factory parameters /
worker productivity / R&D / Scenario / Vision targets

---

## 11. 未解決の課題（future issue）

Phase 6B の市場配分監査で判明し、**意図的に変更していない**もの。

1. `maximumSupplierShare = 0.35` は 480セル中 binding 0 件。この値を動かしても何も変わらない。
2. `EXTERNAL_OPTION` は競争相手ではなく**残余**。5社が取りに行かなかった量が全額そこへ流れる。ウェイトは固定で、価格・品質・信頼に反応しない。
3. `competitivenessWeights.salesBase = 0` / `vapCapability = 0`（`SALES_PARAMETERS_V1` 直値。運用中の派生パラメータでは vapCapability のみ有効）。
4. 5社間の合成競争力の差が小さい（0.641〜0.669）。経営の巧拙が市場シェアに現れにくい。

いずれも独立した次 Phase の候補である。
