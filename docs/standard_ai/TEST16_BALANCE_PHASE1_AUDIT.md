# Test16 バランス再設計 Phase 1 監査

作成日: 2026-08-08
branch: `feature/v2-test16-balance-foundation`（分岐元 `feature/v2-standard-ai-market-aware-sales` = `71cc788`）
状態: **Phase 1完了。Phase 2へ進む前に判断が必要な項目あり（§12）**

分岐元の選定理由: Test15 integration 系の最新であり、market-aware allocation と
30%増員ルールを含む。この2つは今回の前提として必要なため、素の Test15 integration
ではなくこちらを親にした。

---

## 1. 現行の初期営業人数

| BAL | MASS | JPQ | VAP | CONSV | 合計 |
|---|---|---|---|---|---|
| 18 | 22 | 14 | 14 | 10 | 78 |

定義: `app/lib/v2/companyLab/fixtures.ts` の `salesForceHeadcountTotal`。

## 2〜3. 現行の工場能力（全社・単位 HOSO換算t/四半期）

| 会社 | common | HOSO | PD | VAP | freezing | 商品計 | 商品計 vs common |
|---|---|---|---|---|---|---|---|
| BAL | 22,000 | 10,000 | 8,000 | 6,000 | 20,000 | 24,000 | 超過 +2,000 |
| MASS | 36,000 | **30,000** | 6,000 | 2,000 | 34,000 | 38,000 | 超過 +2,000 |
| JPQ | 16,000 | 4,000 | 11,000 | 3,000 | 15,000 | 18,000 | 超過 +2,000 |
| VAP | 18,000 | 3,000 | 4,000 | **12,000** | 17,000 | 19,000 | 超過 +1,000 |
| CONSV | 15,000 | 8,000 | 6,000 | 4,000 | 14,000 | 18,000 | 超過 +3,000 |

**重要**: 指示C3の「商品別能力の合計 > 共通能力」という構造は**既に成立している**。
`commonProcessingCapacity` が実質的な総量上限として機能しており、
「factory total throughput」という独立した第3の制約は存在しない。

→ 指示C1の「現行構造上 total throughput が無ければ common + freezing の2つで表現してよい」に該当する。
**新しい制約を追加する必要はない。**

## 4. 現行の養殖能力

| BAL | MASS | JPQ | VAP | CONSV |
|---|---|---|---|---|
| 15,000 | 18,000 | 9,000 | 10,000 | 10,000 |

指示Iの「4,000t前後」は **73〜78%の削減**にあたる。

## 5. 現行の労働計算

`app/lib/v2/production/labor.ts`

```ts
effectiveEfficiencyPerHeadTons(base, product, params, coefficientOverride)
  = base / coefficient
  coefficient = coefficientOverride ?? params.labor.laborIntensityCoefficient[product]

laborIntensityCoefficient = { hoso: 1.0, pd: 1.2, vap: 3.0 }
```

必要Worker数は `requiredHeadcountForQuantity`（同ファイル）が上記の逆算を行う。
**UIも意思決定画面もこの1関数を共有している**（「画面では足りると出たのに実際は足りない」を防ぐ設計）。

`coefficientOverride` は既に **PD省人化投資**（`pdMechanizationState.ts`）が使用中。

## 6. 商品集中効果を入れる最適箇所

**`effectiveEfficiencyPerHeadTons` の coefficient 決定部**が唯一の正しい挿入点である。

理由:
- 必要Worker・労働能力・UI表示のすべてがこの1関数を通る。ここへ入れれば自動的に全経路へ反映される。
- 指示F4の「既存 labor intensity を削除せず、intensity × concentration factor にする」を
  素直に実装できる（`coefficient = (override ?? intensity) × concentrationFactor`）。

**ただし合成順序に注意**: `coefficientOverride` は現在 intensity を**置換**する。
PD省人化投資と商品集中効果は**両立させる必要がある**ため、
`(override ?? intensity) × concentrationFactor` という乗算合成にする。
置換のままだとPD省人化投資が集中効果を打ち消す（またはその逆）。

## 7. HOSO capex を入れる最適箇所

**既存の `hosoLineExpansion` テンプレートが既に存在する。**

```
app/lib/v2/capex/parameters.ts
hosoLineExpansion: 3,000,000 USD / 支払 [0.3, 0.4, 0.3] /
                   productionEquipment / 工期1Q /
                   建物20% 機械80% / 保守0.75%/期 /
                   +500 t/期 / 完成後 readiness 1Q
```

CIP・減価償却・完成振替・工期は既存の capex エンジンが処理済み。
**新しい project type を作る必要はなく、既存テンプレートの数値を変えるだけで足りる。**

## 8. migration 要否 → **不要**

根拠（前回の初期営業人数調査と同じ構造）:
- `salesForceHeadcountTotal` は静的 fixture 値。実際の人数は
  `state.salesForceHiringState` が保持する。
- `buildInitialSalesForceHiringState` は `initializeCompanyLab` からのみ呼ばれる＝**新規ラボ作成時だけ**。
- 工場能力も同様に、ラボ作成時に fixture から state へ写される。

進行中の Test15 は永続化済みの state を読むため、fixture を変えても影響を受けない。
**migration は不要。**

## 9. 影響する golden test

初期営業人数を 18→37 にした実験（前回）で **9件失敗**した。うち5件は挙動由来:

| テスト | 壊れる理由 |
|---|---|
| SAI-5因果(1): 営業基盤が成約配分の順位を決めている | 営業基盤の差が縮む |
| Test15 4ケース比較A: 需要制約下で新工場建設が悪化 | 需要制約の効き方が変わる |
| NFPC-4: 倍率が大きい環境ほど設備稼働率が高い | 同上 |
| **Test14 Turn1型: 営業が強い制約と診断される** | 営業60人では営業が制約でなくなる |
| SAI-6.4: 生産計画が22,100tより明確に小さくなる | delivery demand が増える |

**60人ではこれ以上に壊れる。** 指示Oのとおり期待値の機械的書き換えはしない。
分類:
- **A（初期ゲーム状態の検証）**: 期待値を新しい初期値へ更新してよい
- **B（営業不足診断そのものの検証）**: Test14 Turn1型・SAI-6.4 が該当。
  **テスト専用 fixture で営業人数を低く固定**し、「営業不足ケース」として独立させる。

## 10. 実装予定ファイル

```
app/lib/v2/companyLab/fixtures.ts          初期営業人数・工場能力・養殖能力
app/lib/v2/production/parameters.ts        集中効果パラメータ（新規）
app/lib/v2/production/labor.ts             集中係数の合成
app/lib/v2/production/concentration.ts     集中係数の計算（新規）
app/lib/v2/capex/parameters.ts             hosoLineExpansion の金額・増分
app/v2/company-lab/components/…            能力表示・集中係数表示
app/lib/v2/companyLab/adminExport/…        製造原価計算書への表示
```

## 11. 提案パラメータ

指示どおりの値を第一候補とする（§12の判断待ち項目を除く）。

| 項目 | 現行 | 提案 |
|---|---|---|
| 初期営業人数（全社） | 18/22/14/14/10 | **60** |
| common processing（全社） | 15,000〜36,000 | **30,000** |
| freezing/packaging（全社） | 14,000〜34,000 | **30,000** |
| HOSO 初期（全社） | 3,000〜30,000 | **8,000** |
| HOSO capex 単価 | 3,000,000 | **8,000,000** |
| HOSO capex 増分 | +500 t | **+4,000 t** |
| HOSO 上限 | （上限なし） | **24,000**（初期8,000＋4回） |
| PD 初期 | 4,000〜11,000 | **6,000〜8,000** |
| VAP 初期 | 2,000〜12,000 | **4,000〜6,000** |
| 養殖 | 9,000〜18,000 | **4,000** |
| HOSO 集中係数 | （なし） | 8,000t=1.00 → 24,000t=0.60 線形 |
| PD 集中係数 | （なし） | 4,000t=1.00 → 12,000t=0.80 線形 |
| VAP 集中係数 | （なし） | 4,000t=1.00 → 12,000t=0.80 線形 |

## 12. **Phase 2 へ進む前に判断が必要な項目（4件）**

### 判断1: 集中係数の基準となる生産量（構造上の循環）

集中係数は生産量に依存するが、生産量は労働能力に依存する。
`calculateLaborCapacityFromAssignedHeadcount` は「N人で何t作れるか」を計算する関数であり、
その中で「何t作るか」に依存する係数を使うと**不動点問題**になる。

推奨案: **意思決定の計画生産量（planned production quantity）を基準にする**。
これは Worker 配分の前に確定しており、循環しない。
プレイヤーにも「この計画量なら係数はいくつ」と事前に見せられる（指示H）。

代案（非推奨）: 前期実績生産量。循環はしないが、当期に集中を決めても当期は効かない。

**どちらにするかの確定をお願いします。**

### 判断2: MASS の HOSO 能力を 30,000 → 8,000 へ下げてよいか

MASS は massMarket archetype で、現在 HOSO 30,000t を持つ。
これを 8,000t にすると、**MASS が現在の戦略を実行できなくなる**。
24,000t へ戻すには 4回 × 8M = **32M USD** の投資と最低4四半期が必要。

指示K は「MASS が HOSO 16,000〜24,000t へ集中する戦略を成立させる」ことを求めているが、
初期 8,000t 統一はその戦略の**出発点を奪う**。

選択肢:
- (a) 指示どおり全社 8,000t 統一（MASS も投資して積み上げる。「最初から強い」ではなく「選べば強くなれる」）
- (b) MASS のみ初期 12,000〜16,000t（archetype を初期値に反映）
- (c) 全社 8,000t だが MASS は初期現金／既存 CIP を厚くする

**(a) が指示に忠実ですが、MASS の性格付けが初期値から消えます。判断をお願いします。**

### 判断3: HOSO capex の経済性が3倍良くなる

| | 現行 | 提案 | 変化 |
|---|---|---|---|
| 金額 | 3,000,000 | 8,000,000 | 2.67× |
| 増分 | +500 t/期 | +4,000 t/期 | 8× |
| **単価** | **6,000 USD/t** | **2,000 USD/t** | **1/3** |

PD ライン増設は 4,000,000 / +350t = 11,429 USD/t、VAP は 250t で更に高い。
提案どおりにすると **HOSO の投資効率が PD の5.7倍・VAP の更に上**になる。

指示L は「HOSO 一択にならないこと」を求めているが、
この単価差だけでも HOSO 集中が強く誘導される。集中係数（Worker −40%）が加わると更に強まる。

選択肢:
- (a) 提案どおり（HOSO の「大量処理型」性格を単価で表現。弱点は原料・営業・運転資本で担保）
- (b) 金額を上げる（例 12M / +4,000t = 3,000 USD/t）
- (c) PD/VAP の単価も同時に見直す

**判断をお願いします。** なお Phase 5 のベンチマークで HOSO 一択になるかは実測できます。

### 判断4: 養殖 15,000〜18,000 → 4,000 の影響

養殖は原料の内製手段であり、73〜78% の削減は**原料調達の外部依存を大幅に高める**。
指示I の意図（養殖を主要戦略にしない）は理解しましたが、
同時に原料不足がボトルネックになりやすくなり、
「HOSO を 24,000t まで増やしても原料が無い」状態が起きやすくなります。

これは指示L の「HOSO 大量モデルの弱点＝大量原料調達」と整合的であり、
**意図的な設計であれば問題ありません**。意図の確認だけお願いします。

---

## 13. リスク

1. **3つの大変更が同時に入る**（営業60人・能力再編・集中効果）。
   Phase 5 のベンチマークで悪化が出たとき、どれが原因か切り分けられない。
   → 段階的に入れて各段でベンチマークを取ることを推奨する。
2. **golden test の再設計が必要**（§9）。機械的な期待値書き換えを禁じられているため、
   営業不足診断テストは専用 fixture へ分離する作業が発生する。
3. **集中係数と PD 省人化投資の相互作用**。乗算合成にすると
   PD 省人化 0.8 × 集中 0.8 = 0.64 となり、意図より強く効く可能性がある。
   上限（下限係数）を設けるかの検討が要る。
4. **能力の下方修正が既存の capex 判断を壊す可能性**。
   MASS/JPQ/VAP は現行能力を前提に Standard AI が投資判断しており、
   初期能力を下げると投資が過剰に誘発されうる。
