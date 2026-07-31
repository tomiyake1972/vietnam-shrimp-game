# SAI-6 設計提案 — Standard AI 経営能力強化

- 対象ブランチ: `develop/v2`（`f6b4e45` 時点）
- 作成日: 2026-07-31（JST）
- 状態: **設計提案。実装は未着手。レビュー後に実装へ進む。**

本書は三宅さんのご指示（検討テーマ1〜7）に対する設計提案である。すべての記述は
`develop/v2` の実コードを読んで確認した事実に基づき、ファイル名:行番号を添えている。
「現状こうなっているはず」という推測は書いていない。

---

## 0. 結論の先出し

### 0.1 いちばん重要な発見 — 縮小すべきは設備ではなく労務である

現行の標準初期条件（`standardAi/report/standardBaseline.ts:64-79`）を数字で見ると、
**能力余剰のコストは圧倒的に労務側にある**。

| 項目 | 四半期あたり | 根拠 |
|---|---:|---|
| 常用ワーカー人件費 | **$6.00M**（6,000人 × $1,000） | `standardBaseline.ts:75`, `finance/parameters.ts:140`, `finance/quarterClose.ts:342` |
| 工場固定費 ＋ 固定ユーティリティ | $1.45M（1工場 × ($1.2M + $0.25M)） | `finance/parameters.ts:148-149`, `quarterClose.ts:383-384` |

しかも `decision/labor.ts:15-23` のコメントには、32ターン検証で
**「`idleLaborCost` が常用人件費の6割前後に達しても縮小されない」**不具合が
記録されている。6割なら **$3.6M/四半期＝年$14.4M** が遊休人件費として流出している計算になる。

さらに構造的に人員は過剰である。共通前処理能力 22,000t に対し、
6,000人の労働能力は `6,000 × 6 × 0.95 × 0.8 ≈ 27,360t`
（`production/parameters.ts:121`, `production/labor.ts:53-59`）。
稼働率75%なら必要人数は約3,600人で、**約2,400人＝$2.4M/四半期が構造的余剰**になる。

一方、設備側は **5社とも工場を1つしか持たない**（`standardBaseline.ts:64-74`、
`factoryId: ${id}-STD-F1` のみ）。したがって既存の工場単位休止フック
（`production/capacity.ts:30-42`、`runner.ts:1224` の `activeFactoryCount`）は
**「事業を丸ごと止める」以外に使えない**。

**したがって SAI-6 の主戦場は労務であり、設備は二次的である。** これが本設計の骨格を決める。

### 0.2 スコープの提案（3段構え）

| 段 | 内容 | エンジン変更 | 期待効果 |
|---|---|---|---|
| **Phase 1（必須）** | 観測・KPIの拡張、意思決定フローの再構成、需要見通しの新設、労務の段階的能力調整、価格戦略の再設計、新規投資の抑制・未着工案件の取消 | **最小限**（採用・解雇コストの追加のみ） | 遊休人件費の削減。default率へ最も効く |
| **Phase 2（推奨）** | 商品ライン単位の設備休止（mothball） | 中（固定費ドライバーの分解が前提） | 低稼働ラインの固定費削減 |
| **Future（今回は実装しない）** | 設備売却・除却 | 大（会計恒等式に触れる） | — |

**設備売却は SAI-6 では実装すべきでない**と提案する。理由は §3.4 に詳述する。

---

## 1. 現状の制約（設計の前提となる事実）

設計判断の根拠になるので、確認できた事実を先に並べる。

### 1.1 設備

| 事実 | 根拠 |
|---|---|
| 稼働中の設備能力を下げる経路は**存在しない** | `capex/capacityEffect.ts:164-209` は加算専用。減算関数なし |
| 設備の売却・除却・廃棄は**存在しない** | `CapitalProjectStatus` に該当状態なし（`capex/types.ts:66-75`）。PLに営業外損益区分なし。投資CFは支出のみ（`finance/quarterClose.ts:1062`） |
| 設備の休止も**存在しない**。ただし受け皿は半分ある | `FactoryStatus = "active"｜"idle"｜"suspended"`（`production/types.ts:45`）と、非activeなら全能力0にする分岐（`production/capacity.ts:30-42`）が既にある。ただし本番経路で active 以外をセットするコードは無い |
| 工場は**静的fixture**で、ターンをまたぐ可変状態を持たない | `CompanyFixture.factories`（`companyLab/types.ts:104`）。`CompanyLabState` に工場状態なし |
| 案件の取消は **`cumulativePaidUsd === 0` のときのみ** | `capex/projectLifecycle.ts:162-164`。1ドルでも払ったら永久に放棄できない |
| 減価償却・保守費は**稼働率非依存**（期間ドライバー） | `capex/depreciation.ts:57-61`（引数に生産実績なし）、`capex/capacityEffect.ts:219-236` |
| 工場固定費は**工場「数」ドライバー**。ライン単位では何も減らない | `quarterClose.ts:383-384`, `runner.ts:1224` |
| 低稼働を直接罰する項目は**存在しない**（トン単価の悪化として間接的に現れるだけ） | `quarterClose.ts:486-501`。`unabsorbedFixedManufacturingCost` は生産完全停止時のみ（`:524-525`） |

### 1.2 労務

| 事実 | 根拠 |
|---|---|
| AIが変更できるのは `regularHeadcount` / `temporaryHeadcount` / `overtimeRate` の3つ | `production/types.ts:129-144`。`skills`・`attendanceRate` は fixture 固定（`decision/labor.ts:159,161`） |
| 状態を持ち越すのは `regularHeadcount` **だけ**。臨時・残業は毎期ゼロベース | `companyLab/workforce.ts:55-77, 108-142` |
| **採用コスト・解雇コスト・退職金・教育コスト・技能rampは1つも存在しない** | `workforce.ts:29-32, 354-356` に明示。全文検索でも計算式ゼロ |
| 費用の増減は**即時**（遅れなし） | `finance/companyLabAdapter.ts:263-265` → `quarterClose.ts:342` |
| 人数の上限・下限は**エンジンに無い**（0クリップのみ） | `workforce.ts:180-184`, `standardAi/normalize.ts:29-32` |
| 単価: 常用 $1,000 / 臨時 $800（0.8倍）/ 残業 1.5倍 | `finance/parameters.ts:140-144`, `quarterClose.ts:342-343, 381` |
| 残業は能力を最大 **+15%** しか増やせない | `overtimeRateCap 0.3 × overtimeEfficiencyFactor 0.5`（`production/parameters.ts:124-126`） |
| `skills` は**生産量にのみ**効く。品質・歩留まり・事故率には無関係 | `production/labor.ts:53-59`。`quality/operationalRisk.ts:68-89` の入力に skill なし |
| 「増やす」側には品質ペナルティがあるが、**「減らす」側には何もない** | 残業ストレス0.20・臨時ストレス0.15・急増産0.10（`quality/parameters.ts:109-122`）。減員に対応する項は無い |

**この非対称が本設計の中心論点である。** 解雇が完全無料である限り、
合理的なAIは「需要が落ちた瞬間に即座に最大限削減する」のが常に最適になり、
「段階的縮小」という設計思想を経済的に正当化できない。現行の damping 0.5 と
2期ヒステリシス（`decision/labor.ts:103-104, 108, 118`）は**純粋に恣意的なヒューリスティック**である。

### 1.3 AI の意思決定と観測

| 事実 | 根拠 |
|---|---|
| 現在の順序は実質2段階（販売→生産→その他4つは独立） | `standardAi/policy.ts:105-123` |
| **財務は最上流の情報しか見ない**（当期の調達・人件費・capex支出を知らない） | `decision/finance.ts:23-27`。引数は `observation` と `pressures` のみ |
| **需要予測ロジックは存在しない** | `standardAi/` に forecast/予測 の実装ゼロ。`decision/labor.ts:13` に「予測モデルは組み込まない」と明記 |
| AIが見られる財務値は**現金残高と借入残高の2つだけ** | `observation.ts:195-196`。利益・原価・固定費・在庫評価額は一切なし |
| ただし `ownState.financeState` には全部ある | `companyLab/types.ts:172`。**情報境界を広げずに観測を拡張できる** |
| 死蔵KPI 3件 | `contractFulfillmentPressure`（レポート専用）、`laborUtilizationLastQuarter`（完全未使用）、`expectedRawPriceUsdPerKg`（decisionから不可視） |
| デッドパラメータ 2件 | `sustainedShortageQuarterThreshold` / `sustainedExcessQuarterThreshold`（`parameters.ts:107,109`、参照ゼロ） |
| SAI-5A/5F の応答パラメータは**既定0で不活性** | `growthTrendResponsiveness: 0`, `oversupplyRetreatSensitivity: 0`（`parameters.ts:193-194`） |
| `production.ts` だけ `params` を受け取らない | `decision/production.ts:25-30` |
| **既存の実装不整合**: 能力の分母に capex 完成分が入る箇所と入らない箇所がある | `decision/production.ts:34`（capex反映済）vs `:71-75`（fixture静的）。capex完成後に計画生産量が必要量を下回る |

### 1.4 価格

| 事実 | 根拠 |
|---|---|
| 価格判断の入力は**「自社完成品在庫」と「前期設備稼働率」の2つだけ** | `decision/sales.ts:74-89` |
| 値引き幅は最大 **−12%** | `maxDiscountRatioForExcessStock: 0.12`（`parameters.ts:186`） |
| **価格スコアの飽和点は −15.67%**。現行AIは天井に届かない | `exp(3d) = 1.6` → `d = ln(1.6)/3 = 0.1567`（`sales/allocation.ts:49-52,69-73`, `sales/parameters.ts:128-130`） |
| `sales/parameters.ts:66-67` のコメント「約20%で上限」は**誤り**（正しくは15.67%） | 上記の式から |
| **最低受注価格が下限として強制されていない** | `decision/sales.ts:70` で計算されるが、askPrice との比較箇所がコードベース全体にゼロ |
| askPrice が許容範囲外だと **clamp ではなく throw** | `sales/allocation.ts:41-45`。範囲は基準価格の 0.5〜2.0 倍 |
| 設計思想は「プレミアムが下限を割ったら価格ではなく数量で調整する」 | `premiumPolicy.ts:12-19` に明記 |
| 契約単価は成約時スナップショットで以後不変。売上計上は**履行時（既定1四半期後）** | `sales/contracts.ts:88`, `finance/quarterClose.ts:794` |
| 診断 `PRICE_REDUCTION_FOR_EXCESS_STOCK` が価格調整0でも発火する不整合あり | `decision/sales.ts:83-84` と `:246-255` の条件不一致 |

---

## 2. 【テーマ5】AI 意思決定アーキテクチャ

### 2.1 現在の順序と、その問題

```
observation → pressures → sales → production → { procurement, labor, finance, capex }（4つは相互に独立）
```

真の依存は3本だけである（`policy.ts:109,113,114,120`）:
`sales.desiredByProduct → production` / `production.productionPlans → procurement, labor` /
`production.neededByProduct → capex`。

問題は3つ。

1. **需要見通しが無い。** 能力を増やす/維持する/縮小するの判断は本質的に
   「これから需要はどうなるか」に依存するが、現在その概念自体が存在しない。
   代理指標（ライフサイクルトレンド、供給圧力EWMA）はあるが既定パラメータで不活性。
2. **能力調整が生産計画の下流に埋もれている。** 労務は `productionPlans` を見て
   必要人数を逆算するだけで（`decision/labor.ts:69-72`）、「そもそもこの能力を持ち続けるか」
   という判断をしていない。
3. **財務が最上流の情報しか見ていない。** 借入額は「期首現金 − 目標バッファ」の差だけで決まり
   （`decision/finance.ts:33`）、当期の調達支出・人件費・capex 支出を知らない。
   資金計画が計画の受け皿になっていない。

### 2.2 提案する意思決定順序

```
 [0] 観測構築            buildStandardAiObservation        （財務KPIを追加）
      ↓
 [1] KPI 算定            computeStandardAiKpis             （PressureScores を拡張・再編）
      ↓
 [2] 需要見通し ★新設     buildDemandOutlook
      ↓  自社受注可能量の見通し（商品×市場、1〜4四半期先）＋確度
 [3] 能力ポジション判定 ★新設  assessCapacityStance
      ↓  商品別に expand / hold / trim / contract を決める
 [4] 価格戦略 ★新設       buildPricingStance
      ↓  商品×市場の価格調整比率と、その根拠（原価フロア／稼働埋め／市況）
 [5] 販売計画            buildStandardAiSalesPlans          （[3][4] を受ける）
      ↓
 [6] 生産計画            buildStandardAiProductionPlans
      ↓
 [7] 労務能力調整        buildStandardAiWorkerAssignments   （[3] の stance を受ける）
      ↓
 [8] 調達計画            buildStandardAiProcurementPlan
      ↓
 [9] 設備能力調整        buildStandardAiCapexDecision       （[3] の stance を受ける／増設・取消・休止）
      ↓
[10] 財務 ★最下流へ移動   buildStandardAiFinancingRequest    （[7][8][9] の支出見込みを受ける）
```

### 2.3 この順序にする理由

- **[2] 需要見通しを最上流に置く**のが今回の設計の核である。能力調整も価格も、
  「一時的な変動か、恒久的な変化か」の判定なしには決められない。現在この判定は
  labor が2時点比較で局所的に行っているだけ（`decision/labor.ts:103-104`）で、
  他のドメインと共有されていない。共通の見通しを1箇所で作り、全ドメインが同じ前提で動く形にする。
- **[3] 能力ポジション判定を独立させる**ことで、「増やす／維持する／縮小する」という
  三択が明示的な出力になる。現在この判断は capex と labor に別々に埋め込まれており、
  互いに矛盾しうる（例: 労務は削っているのに設備は増設提案を出す）。1箇所で決めて両者へ配る。
- **[4] 価格戦略を販売計画から分離する**。現在は `decision/sales.ts` の中に
  数量ロジックと価格ロジックが同居しており、価格が在庫だけを見る構造になっている。
  分離して、能力余剰・市況・原価を受け取れるようにする。
- **[10] 財務を最下流へ移す**。当期の支出見込み（原料買付・人件費・capex分割払い）を
  引数で受け取り、`必要現金 = 支出見込み + 目標バッファ − 期首現金` として借入額を決める。
  これは現在の最大の構造的欠陥の解消であり、**default率に直接効く可能性が高い**。

### 2.4 順序変更の互換性

[5]〜[9] の相互順序は現在と同じ（sales → production → labor → procurement → capex）。
新設は [2][3][4]、移動は [10] のみ。既存の真の依存3本は保たれる。

**すべての新機能は既定OFFのフラグでゲートする**（`standardAiCapexExtensionsEnabled`
と同じパターン、`parameters.ts:195` / `orientationProfile.ts:243-245`）。
OFF時は既存挙動とビット単位で一致させる。

---

## 3. 【テーマ1・3】能力調整ロジック

### 3.1 能力ポジション判定（`assessCapacityStance`）

商品（hoso/pd/vap）ごとに、4つの姿勢のいずれかを決める。

| stance | 意味 | 発動条件（案） |
|---|---|---|
| `expand` | 能力を増やす | 需要見通しが持続的に能力を上回り、かつ市場が過剰供給でない |
| `hold` | 維持する | 不足でも余剰でもない中立帯（**デッドバンド**） |
| `trim` | 可逆な範囲で縮小する | 余剰だが一時的の可能性がある。残業・臨時・採用停止まで |
| `contract` | 恒久的に縮小する | 余剰が持続し、需要見通しも回復しない。常用削減・ライン休止まで |

判定の骨格（すべて既存の観測＋新設KPIから計算できる）:

```
capacityHeadroomRatio = (有効能力 − 需要見通し) / 有効能力
persistence           = 需要見通しが余剰側にある連続四半期数
marketSignal          = 供給圧力EWMA と ライフサイクルトレンド

expand   : headroom < −expandThreshold  かつ persistence(不足) ≥ N  かつ marketSignal が過熱でない
contract : headroom >  contractThreshold かつ persistence(余剰) ≥ M  かつ 見通しが回復しない
trim     : headroom >  trimThreshold     （persistence 不問）
hold     : それ以外
```

**デッドバンドと滞留期間（dwell time）を明示的に持たせる**のが要点である。
現在は `±5% / ±10%` のマージン（`decision/labor.ts:36-37`）が labor にハードコードされ、
他ドメインと共有されていない。これを `StandardAiParameters` へ移し、
`expand` と `contract` で**非対称**にする（縮小は慎重に、拡大はより慎重に）。

なお `sustainedShortageQuarterThreshold` / `sustainedExcessQuarterThreshold`
（`parameters.ts:107,109`）は現在参照ゼロのデッドパラメータである。
**SAI-6 でこの2つを persistence の閾値として実際に使う**ことを提案する。

### 3.2 【テーマ2】労務能力調整

#### 3.2.1 段階の定義と、現状の実装状況

三宅さんのご提示の順序に、現状の実装状況を突き合わせた。

| 段 | 内容 | 現状 | エンジン変更 |
|---|---|---|---|
| ① 残業削減 | `overtimeRate` を下げる | **実装済み**。`isShortage=false` なら 0（`decision/labor.ts:131`） | 不要 |
| ② 臨時停止 | `temporaryHeadcount` を減らす | **実装済み**。`isShortage=false` なら 0（`decision/labor.ts:130`） | 不要 |
| ③ 採用停止 | `sustainedShortage` でも採用しない | 未実装（不足なら常に採用） | 不要 |
| ④ 常用削減 | `regularHeadcount` を減らす | 機構は実装済み（damping 0.5、`:118`）だが**経済的トレードオフが存在しない** | **必要** |
| ⑤ 再採用 | 需要回復時に戻す | 機構は実装済み（同じ式、`:108`）だが同上 | **必要** |

①②は既に「不足でなければ即ゼロ」という強い実装になっている。したがって
**段階①②は実質「常に最初に削減される」状態にあり、SAI-6 の課題は③④⑤である。**

#### 3.2.2 ④⑤を成立させるためのエンジン変更（最小限）

解雇が無料である限り「段階的縮小」に経済的意味がない（§1.2）。
そこで**最小限の追加**を提案する。

```
finance/parameters.ts の labor ブロックへ追加:
  severanceCostUsdPerHead : 常用1人を減らすときの一時費用
  hiringCostUsdPerHead    : 常用1人を採る時の一時費用（募集＋立ち上げ）
```

- 実装箇所は `finance/quarterClose.ts` に「前期人数 vs 当期人数」の差分経路を1本追加し、
  `CostRecord`（`finance/types.ts:125-144`）へ `stepFixed` / `committed` として計上する。
  現在アダプタは当期人数しか渡していない（`companyLabAdapter.ts:263-265`）ので、
  前期人数の受け渡しが必要になる。
- 水準の目安: 常用1人の四半期給与が $1,000 なので、**解雇 = 2四半期分（$2,000）、
  採用 = 1四半期分（$1,000）** 程度から始めるのが妥当と考える（要校正）。
  これにより「1,000人削って翌々期に戻す」往復に $3.0M の実費が付き、
  段階性・慎重さに経済的根拠が生まれる。
- **これは §0.1 の遊休人件費（推定 $2.4〜3.6M/四半期）と同じオーダーであり、
  片方だけ入れると判断が偏る。両方入れて初めてトレードオフが成立する。**

#### 3.2.3 AI が労務判断で見るべき情報

三宅さんのご指示の観点に、実装可能性を突き合わせた。

| 観点 | 使う情報 | 現状 |
|---|---|---|
| **将来需要** | `demandOutlook`（[2] で新設） | 新設 |
| **稼働率** | 商品別の能力余剰トン数＝`totalCapacityByProduct − 前期実績生産量` | **今すぐ計算できる**（両方とも観測済み） |
| **教育期間** | — | **エンジンに存在しない**（`skills` は fixture 固定）。SAI-6 では扱わず Future へ |
| **採用コスト** | `hiringCostUsdPerHead` | 新設（§3.2.2） |
| **解雇コスト** | `severanceCostUsdPerHead` | 新設（§3.2.2） |
| **品質維持** | 残業ストレス・臨時ストレス・急増産ストレスの寄与 | **既存**（`quality/parameters.ts:109-122`）。ただしAIは観測していない → KPIへ追加 |
| **遊休の実コスト** | `idleLaborCost` | **既存だがAIは見ていない**（`finance/types.ts:317`）→ 観測へ追加（最優先） |

**追加すべき最重要の観測は `idleLaborCost` である。** これが見えない限り、
AIにとって余剰人員を抱えるコストは永久にゼロであり、
32ターン検証で見つかった「6割の遊休」が繰り返される。

#### 3.2.4 現行ロジックの既知の癖（設計時に踏まえる）

- AIの必要人数計算は**残業ゼロ・臨時ゼロ前提**（`decision/labor.ts:78-79, 97-98`）。
  したがって「残業でカバーできるから常用は減らさない」という判断が現状の
  `requiredRegular` からは導けない。段階的縮小を設計するなら、
  **残業込み・臨時込みの必要人数を別に計算する**必要がある。
- 過剰判定の分母は**当期の生産「計画」**であり実績ではない（`:71`）。
  原料不足で作れなかった期でも、計画が大きければ過剰判定が出ない。
- `temporaryHeadcount` / `overtimeRate` は状態に残らない（`workforce.ts:108-142`）。
  「臨時を段階的に減らす」には前期値を持つ必要があり、
  `WorkforceState` の拡張（＋永続化スキーマの版上げ）が要る。
  ただし現行は「不足でなければ即0」なので、**段階性が必要かどうかは要検討**。
  臨時は本来「即時に増減できる緩衝材」であり、段階的に減らす対象ではないと考える。

### 3.3 【テーマ3】設備能力調整

#### 3.3.1 選択肢と評価

| 選択肢 | 現状 | 実装コスト | ゲーム性 | 現実性 | 提案 |
|---|---|---|---|---|---|
| 継続稼働 | 既定 | — | — | — | — |
| 低稼働（生産を絞る） | **既に可能**（生産計画を減らせば低稼働になる） | ゼロ | ○ | ○ | **そのまま使う** |
| 新規増設の抑制 | 部分実装（`CAPEX_DEFERRED_OVERSUPPLY`、既定OFF） | 小 | ○ | ○ | **Phase 1 で実装** |
| 未着工案件の取消 | 機構はあるが AI は `cancelRequests: []` 固定（`decision/capex.ts:310`） | 小 | ○ | ○ | **Phase 1 で実装** |
| 設備休止（mothball） | **存在しない** | 中 | ◎ | ○ | **Phase 2 で実装（ライン単位）** |
| 再稼働 | 同上 | 休止とセット | ◎ | ○ | **Phase 2 で実装** |
| 設備売却・除却 | **存在しない** | 大 | △ | ◎ | **今回は実装しない**（§3.4） |

#### 3.3.2 未着工案件の取消（Phase 1）— 落とし穴に注意

`applyCancelRequest` は `cumulativePaidUsd > 0` の案件に対して
**例外を投げる**（`capex/projectLifecycle.ts:162-164`）。したがって

> **取消可能な案件を判別する観測を先に追加しないと、AIが `cancelRequests` を出した瞬間に
> ターン処理が例外で落ちる。**

現在の観測は `activeCapexProjectTargets`（Set）と `suspendedCapexProjectIds` しか持たず、
案件ID単位の状態・支払実績が見えない（`standardAi/types.ts:110-114`）。
`cancellableCapexProjectIds`（status が approved かつ `cumulativePaidUsd === 0`）を
観測へ追加することが**前提作業**である。

#### 3.3.3 設備休止（Phase 2）— 工場単位ではなくライン単位にすべき理由

既存の受け皿は工場単位である（`production/capacity.ts:30-42` の
`status !== "active"` で全プール0、`runner.ts:1224` の `activeFactoryCount`）。
しかし **5社とも工場を1つしか持たない**（`standardBaseline.ts:64-74`）ため、
工場単位の休止は「事業の全停止」しか表現できず、能力調整の手段として使えない。

したがってライン単位（hoso/pd/vap/common）の休止が必要になる。ところが

> **現在の固定費は「工場数」ドライバーしかないため、ラインを1本止めても減る費用が何もない。**
> （`quarterClose.ts:383-384`。減価償却は取得原価ドライバー、保守費は期間ドライバー）

**これが SAI-6 で最初に決めるべき設計論点である。** 提案する解は次のとおり。

```
現行:  factoryFixedCost = activeFactoryCount × $1,200,000
       utilityFixedCost = activeFactoryCount × $250,000

提案:  factoryFixedCost = activeFactoryCount × 工場基礎固定費
                        + Σ(稼働ライン) × ライン別固定費
       ただし「全ライン稼働」のとき合計が現行と一致する配分にする（後方互換）
```

例: 工場基礎 $600,000 ＋ 4ライン（common/hoso/pd/vap）に $150,000 ずつ
＝ 全ライン稼働で $1,200,000（現行と一致）。VAPラインを休止すれば $150,000/四半期 減る。

- 後方互換は「全ライン稼働なら現行と同額」で担保でき、既存の財務テスト
  （`finance/__tests__/quarterClose.test.ts:319, 496` の固定費不変テスト）を壊さない。
- ただし**この配分自体が新しいゲームパラメータ**であり、
  「ラインを止める価値」の大きさを決める。**校正が必要な設計値**として扱う。

#### 3.3.4 休止に必要な実装（Phase 2 の内訳）

`WorkforceState`（Phase 8D-4、`companyLab/workforce.ts:55-77`）が完全な前例になる。

1. `FactoryOperationState`（会社×工場×プールの休止フラグ）を新設し `CompanyLabState` へ追加
2. `production/capacity.ts:30-56` にプール別休止量の引数を追加（既定引数で後方互換）
3. `finance` の固定費ドライバーを §3.3.3 のとおり分解
4. 意思決定入力に休止・再稼働の要求を追加（`CapexDecisionInput` か別ドメイン）
5. 観測へ休止状態を反映（**必須**。現在の `observation.ts:84-108` は
   `Factory.status` を見ていないので、休止しても幻の能力を見続ける）
6. 永続化スキーマの版上げ（4→5）。追加的変更のみでマイグレーション不要
7. 再稼働に**立ち上げ遅延**を持たせるか（休止→再稼働に1四半期かかる等）は要検討。
   遅延がないと「毎期止めたり動かしたりする」振動が起きうる

#### 3.3.5 観測のギャップ（休止以前の問題）

設計時に必ず踏まえるべき既知のずれが2つある。

- **AIが見ている能力は名目値で、エンジンの有効能力より約17%大きい。**
  エンジンは `× baseUtilizationRate 0.9 × equipmentAvailabilityRate 0.95 = 0.855` を掛ける
  （`production/capacity.ts:44-55`）が、観測は掛けていない（`observation.ts:82-103`）。
  能力余剰を計算する以上、この17%のずれは無視できない。**観測を有効能力へそろえるべき**。
- **`decision/production.ts:34` と `:71-75` で capex 完成分の扱いが食い違う。**
  結果として capex 完成後は計画生産量の合計が必要量を下回る。
  SAI-6 で能力を扱う以上、この不整合は先に直すべきである。

### 3.4 設備売却を今回実装しない理由

三宅さんのご質問（「設備売却まで実装する必要があるかどうか」）への回答である。
**SAI-6 では実装しないことを提案する。** 理由は4点。

1. **会計恒等式に触れる。** `fixedAssetsGross` と `accumulatedDepreciation` は
   現在**加算のみ**（`quarterClose.ts:1074-1076`）。減額可能にすると、
   BS貸借一致（`quarterClose.test.ts:255`）・CF恒等式（`:262`）・
   直接法/間接法照合（`quarterClose.ts:1134-1135`）のすべてを再検証する必要がある。
2. **売却損益を受けるPL行が存在しない。** `ProfitAndLossStatement` に営業外損益の区分がない。
   新設するか売上原価へ押し込むかの判断が要り、いずれも既存テストへ広く波及する。
3. **既存設備は売れない。** レガシー資産には個別台帳が存在しない
   （`finance/depreciation.ts:10-14` に「精密な固定資産台帳は新設しない」と明記）。
   売却できるのは capex 経由で完成した資産だけになり、
   **ゲーム開始時の設備（＝過剰能力の本体）は売却対象にならない。** 効果が薄い。
4. **休止で目的の大半が達成できる。** 「能力を減らして固定費を落とす」という
   ゲーム上の意思決定は休止で表現でき、しかも可逆なのでゲーム性（判断の巧拙が出る）も高い。
   売却は不可逆で、32四半期のゲーム長では判断機会が乏しい。

**Future として残す**。もし将来実装するなら、capex 完成資産に限定し、
簿価は `capitalized × (1 − 経過/耐用)` から導出できる（`capex/depreciation.ts:70-82`）ため
新規台帳は不要である。ただし
`nonDepreciatingCapexGrossAtPeriodStartUsd`（`capexClose.ts:174-176`）が
レガシー資産の償却基数の除外項に使われている（`quarterClose.ts:694-696`）ため、
**`fixedAssetsGross` の減額と除外額の減額を厳密に同時・同額で行わないと
レガシー資産の減価償却が誤って跳ね上がる**。この落とし穴は設計書に残しておく。

---

## 4. 【テーマ4】価格戦略との連携

### 4.1 現状の限界

価格は「自社完成品在庫」と「前期設備稼働率」の2つだけで決まり、最大 −12%
（`decision/sales.ts:74-89`）。市況・原価・限界利益・営業基盤は一切入っていない。
さらに:

- **原価フロアが強制されていない。** `minimumAcceptablePriceUsdPerHosoEqKg` は
  計算されるが（`:70`）、askPrice との比較箇所がコードベース全体にゼロ。
  現状の値下げの下限は「在庫過剰度に基づく −12%」という機械的な上限だけが担保している。
- **AIは自分がいくらで売れたかを知らない。** 実現単価も限界利益率も単位変動費も観測できない。
- 値下げの効果は **−15.67% で飽和**する（`exp(3d)=1.6`）。それを超える値下げは
  成約力を1ミリも増やさずに単価だけ落とす純損である。

### 4.2 提案する価格判断の構造

価格調整比率を、4つの入力から**上下限つきで**決める。

```
                          ┌── 原価フロア（ハード下限）
                          │     単位変動費 v ＋ 最低貢献利益
                          │     → これを下回る askPrice は出さない
                          │
priceAdjustmentRatio  ←───┼── 能力余剰（下げる圧力）
                          │     capacityStance が trim/contract のとき、
                          │     稼働を埋める価値 = 単位限界利益 × 追加獲得可能量
                          │
                          ├── 市況（下げない圧力）
                          │     供給圧力が高い＝市場全体が過剰なら、値下げしても取れない
                          │     → 値下げ競争を抑制する（共倒れの防止）
                          │
                          └── 営業基盤・ライフサイクル（下げない圧力）
                                基盤が強い市場では既に競争力があり値下げ不要
                                成長局面では価格を維持して収益性を確保
```

具体的な骨格（案）:

```
rawDiscount   = f_capacity(capacityHeadroom) + f_inventory(excessRatio)      … 下げたい量
marketDamper  = g(supplyPressureEwma)                                        … 市況による抑制
baseDamper    = h(salesBaseScore)                                            … 基盤による抑制
lifecycleDamper = k(lifecycleTrend)                                          … 成長局面の抑制

discount = clamp(rawDiscount × marketDamper × baseDamper × lifecycleDamper,
                 0, priceScoreSaturationRatio)          // 上限 = 15.67%（飽和点）
askPrice = max(basePrice × (1 − discount), costFloorPrice)   // 原価フロアで打ち切り
```

要点は3つ。

1. **上限を価格スコアの飽和点（15.67%）にする。** これを超える値下げには一切の意味がない。
   現在のコメント（`sales/parameters.ts:66-67`）は「約20%」と書いているが誤りなので、
   **式から導いた定数として `StandardAiParameters` に明記する**。
2. **原価フロアを実効的な下限にする。** 単位変動費 `v` は
   `variableUnitCostPerTon(FinishedGoodsUnitCostBreakdown)`（`finance/types.ts:194-196`）に
   実在するので、完成品原価台帳から残数量加重平均で取れる。
   `minimumAcceptablePriceUsdPerHosoEqKg`（`decision/sales.ts:70`）を実際の下限として使う。
3. **市況ダンパーを入れる。** 市場全体が供給過剰のときに値下げしても、
   外部選択肢（ウェイト 0.35 固定）と5社の全員が下げるだけで数量は取れない。
   SAI-5 の供給圧力EWMAはこの判定にそのまま使える。

### 4.3 価格と能力調整の組み合わせ（利益最大化）

三宅さんのご指示の中心である「価格だけでなく能力調整との組み合わせで利益最大化」は、
次の比較式で表現できる。実際の計算式から導ける。

```
選択肢A: 値下げして稼働を埋める
  Δ利益_A = (P − v) × ΔQ − ΔP × (Q + ΔQ)

選択肢B: 価格を維持して能力を縮小する
  Δ利益_B = 削減した固定費（常用人件費 ＋ ライン固定費）
          − 一時費用（解雇コスト）
          − 将来需要が戻ったときの再取得コスト（採用コスト × 確率）

選択肢C: 何もしない（価格維持・能力維持）
  Δ利益_C = 0 − 遊休コスト（idleLaborCost ＋ 稼働しない設備の固定費）
```

A が有利になる条件は式から `ΔQ / (Q + ΔQ) > ΔP / (P − v)` である。
`P − v`（単位限界利益）は `contributionMarginRatio`（`finance/quarterClose.ts:1187`）と
`netRevenue`・販売トン数から算出できる。

**ただし現状、AIはこの3つのどれも計算できない。** `P`（実現単価）も `v`（単位変動費）も
`idleLaborCost` も観測できないからである。したがって

> **価格戦略の再設計は、KPI（観測）の拡張なしには成立しない。**
> §5 の観測拡張が価格戦略の前提作業である。

### 4.4 併せて直すもの

- 診断 `PRICE_REDUCTION_FOR_EXCESS_STOCK` が価格調整0でも発火する不整合
  （`decision/sales.ts:83-84` と `:246-255` の条件不一致）
- askPrice が許容範囲外だと throw する（`sales/allocation.ts:41-45`）。
  価格自由度を広げるならAI側で `basePrice × [0.5, 2.0]` を自己制約する
  （エンジン側を clamp に変えるのは、値の由来が追えなくなるので推奨しない）
- `sales/parameters.ts:66-67` のコメント（飽和点20%）の訂正

---

## 5. 【テーマ6】KPI 設計

### 5.1 現状の KPI（PressureScores）の棚卸し

`standardAi/pressures.ts:46-103` の11フィールドを、SAI-6 での処遇つきで整理する。

| KPI | 現在の用途 | SAI-6 での処遇 |
|---|---|---|
| `contractFulfillmentPressure` | **どの判断でも未使用**（レポート表示のみ） | 需要見通しの入力へ接続する（確定した将来需要） |
| `finishedGoodsExcessRatioByProduct` | 販売の値引き・生産の優先度 | 継続。価格判断の1入力へ |
| `rawMaterialInventoryPosition` | 調達 | 継続 |
| `cashPressure` | 調達・財務（severityのみ） | 継続。財務の借入額計算へ実接続 |
| `borrowingPressure` | 設備投資 | 継続 |
| `equipmentUtilizationLastQuarter` | 販売・設備投資 | 継続。ただし商品別へ細分化 |
| `hadPriorQuarterUtilization` | 設備投資 | 継続 |
| `laborUtilizationLastQuarter` | **完全未使用**（分母の欠陥で1.0に張り付く） | **削除するか、分母を「保有人員」へ直して復活させる**。§5.3 参照 |
| `marketPriceRanking` | 販売の市場按分 | 継続 |
| `targetMinimumCashUsd` | 財務・設備投資 | 継続 |
| `expectedRawPriceUsdPerKg` | **decisionから不可視**（内部中間値） | 公開して sales・procurement の重複導出をなくす |

### 5.2 追加すべき KPI

観測できる情報はすべて `ownState.financeState`（`companyLab/types.ts:172`）に既にあり、
**情報境界を広げずに追加できる**。優先度順に整理する。

#### 最優先 — 能力調整の意思決定に必須

| KPI | 定義 | 出所 | 何に使うか |
|---|---|---|---|
| `idleLaborCostUsd` | 遊休労務費 | `finance/types.ts:317` | **余剰人員を抱えるコスト**。労務縮小の直接の根拠 |
| `capacitySurplusByProduct` | 商品別の有効能力 − 需要見通し（トン） | `totalCapacityByProduct × 0.855` と需要見通しから | 能力ポジション判定の主指標 |
| `effectiveCapacityByProduct` | 名目能力 × `baseUtilizationRate × equipmentAvailabilityRate` | `production/capacity.ts:44-55` | **現在AIは17%大きい名目値を見ている**。是正 |
| `unabsorbedFixedCostUsd` | 未吸収固定製造費 | `finance/types.ts:307` | 稼働率低下の金額表現 |
| `capexMaintenanceCostUsd` | capex資産の保守費 | `finance/types.ts:324` | 保有し続けるコスト |

#### 最優先 — 価格判断に必須

| KPI | 定義 | 出所 |
|---|---|---|
| `contributionMarginRatio`（全社・商品別） | 限界利益率 | `finance/types.ts:574, 594` |
| `variableUnitCostByProduct` | 商品別の単位変動費 `v`（USD/トン） | `variableUnitCostPerTon()`（`finance/types.ts:194-196`）を完成品原価台帳上で残数量加重平均 |
| `realizedUnitPriceByProduct` | 実現平均単価 `P` | `contributionMargin.byProduct[].netRevenue ÷ 販売トン`。計算実装は `report/collect.ts:52-59` に既存 |

#### 高優先 — 収益性・資金の全体像

| KPI | 出所 | 備考 |
|---|---|---|
| `operatingProfitUsd` / `operatingProfitMarginRatio` | `finance/types.ts:348` ほか | 率の計算は `report/collect.ts:185-187` に既存 |
| `totalFixedCostUsd` | `finance/types.ts:581` | **`capexMaintenanceCost` と `interestExpense` が漏れている**（`quarterClose.ts:1189-1196`）。AI側で加算し直すか、財務側を直すかの判断が必要 |
| `breakEvenRevenueUsd` / `marginOfSafetyRatio` / `operatingLeverage` | `finance/types.ts:585, 589, 591` | 「あと何トン売れば固定費を回収できるか」。`operatingLeverage` は値下げのリスク許容度そのもの |
| `finishedGoodsInventoryValueUsd` / 在庫回転 | `BalanceSheet.finishedGoodsInventory`（`finance/types.ts:367`） | **在庫回転率はエンジンに存在しない**。AI側で `売上原価 ÷ 平均在庫` として算出 |

#### 中優先 — 市場地位

| KPI | 出所 | 備考 |
|---|---|---|
| `marketShareByMarket` | `report/collect.ts:62-86` に計算実装済み | **前期の結果のみ公開**という情報境界の中で完結する |
| `targetDemandByMarketProduct`（前期） | `salesRecord.allocations[].targetDemand` | AIは市場規模を知らないため、`targetDemand × 0.35` の供給者シェア上限が効いているかすら判断できない |

#### 品質（能力調整の副作用の監視）

| KPI | 出所 | 備考 |
|---|---|---|
| `operationalRiskLastQuarter` とその内訳 | `quality/operationalRisk.ts:92-113` | 残業ストレス0.20・臨時ストレス0.15・急増産0.10。「残業で凌ぐ」判断の副作用を見るために必要 |

### 5.3 死蔵KPI・デッドパラメータの処遇（明示的に決める）

SAI-5 の学びとして「定義だけあって使われないもの」を残さない方針を採る。

| 対象 | 提案 |
|---|---|
| `contractFulfillmentPressure` | **判断へ接続**（需要見通しの確定需要部分） |
| `laborUtilizationLastQuarter` | **分母を「保有人員から導く能力」へ直して復活**。現在は「配属された人員」が分母のため常に1.0付近に張り付き、人員過剰を検出できない（`decision/labor.ts:15-23` に経緯あり）。分母を保有人員ベースに直せば、そのまま労務余剰の主指標になる |
| `expectedRawPriceUsdPerKg` | **公開**して sales・procurement の重複導出を解消 |
| `sustainedShortageQuarterThreshold` / `sustainedExcessQuarterThreshold` | **能力ポジション判定の persistence 閾値として実際に使う**（§3.1） |

---

## 6. 【テーマ7】テスト計画・受入試験案

### 6.1 テスト設計の原則（SAI-5 の学びを最初から適用）

1. **結果水準で検証する** — 「stance が contract になった」ではなく
   「人件費が実際に減り、営業利益が実際に改善した」を見る
2. **単一変数にする** — 機能ON/OFF比較は複数パラメータを同時に変えることがある。
   何を変えたか1つに絞れない比較は因果の証拠にならない
3. **テスト側の計算を実装と別経路にする** — 実装の関数で実装を検証しない
4. **前提は guard ではなく assert にする** — `if (前提) { assert }` は前提が崩れた瞬間に無検証になる
5. **リグレッションを注入して検出力を測る** — 「テストが通る」ではなく「バグを入れたら落ちる」

### 6.2 受入試験シナリオ

制御条件は SAI-5 で確立した `runControlled`（実エンジンを回しつつ意思決定だけを操作する）
の枠組みを流用する（`companyLab/__tests__/sai5CausalOutcomes.test.ts`）。

#### 能力調整

| ID | シナリオ | 期待される結果（結果水準） |
|---|---|---|
| **S1** | 需要の**恒久的**減少（ライフサイクルでVAP需要が縮小、または全市場の需要を継続的に絞る） | ①残業→②臨時→③採用停止→④常用削減の順に発火する。常用人件費が実際に減る。`idleLaborCost` が縮小する。営業利益が「何もしない対照」より改善する |
| **S2** | **一時的**な需要減（1〜2四半期だけ落ちて戻る） | **常用は削減されない**（残業・臨時の停止だけで吸収）。削減した対照より、需要回復後の生産量が多い |
| **S3** | 需要の減少 → 回復 | 再採用が起きる。かつ「切りすぎ→高い採用コストで買い戻す」より、段階的縮小のほうが累計利益が高い |
| **S4** | 需要減少下で**能力調整OFF**（フラグOFF） | 既存挙動とビット単位で一致する |
| **S5** | 恒久的な需要減少（Phase 2） | 低稼働ラインが休止され、ライン固定費が実際に減る。需要回復時に再稼働する |
| **S6** | 未着工の capex 案件がある状態で需要が落ちる | 取消が提案され、CIPへの現金固定が回避される。**着工済み案件には取消を出さない**（例外を投げないこと） |

#### 価格戦略

| ID | シナリオ | 期待される結果 |
|---|---|---|
| **S7** | 在庫過剰 ＋ **高稼働** | 値下げしない（作る余力がないので値下げは純損） |
| **S8** | 在庫過剰 ＋ **低稼働** | 値下げして稼働を埋める。値下げしない対照より営業利益が高い |
| **S9** | 市場全体が供給過剰（供給圧力EWMAが高い） | 値下げ幅が抑制される（値下げ競争をしない） |
| **S10** | 原価が上昇して単位変動費が市場価格に接近 | **原価フロアで打ち切られ、それ以下では受注しない**。赤字受注が発生しない |
| **S11** | 値下げ幅の上限 | 飽和点（15.67%）を超える値下げが提案されない |
| **S12** | 営業基盤が強い市場 vs 弱い市場 | 基盤が強い市場のほうが値下げ幅が小さい |

#### 統合・回帰

| ID | シナリオ | 期待される結果 |
|---|---|---|
| **S13** | 8Q / 32Q・複数seed の A/B（SAI-6 全機能 ON vs OFF） | **default率が低下**する。累計営業利益・期末現金が改善する |
| **S14** | 全機能OFF | 既存の全結果とビット単位で一致 |
| **S15** | 保存 → 復元 → 継続 | 中断なし実行と完全一致（SAI-5 因果(8) と同型） |
| **S16** | 決定論 | 同一config・同一seedで2回実行して完全一致 |

### 6.3 リグレッション注入テスト（必須）

実装完了後、次を実際に注入して検出できることを確認する。

| 注入 | 落ちるべきテスト |
|---|---|
| 能力ポジション判定を常に `hold` にする | S1, S3, S5 |
| `idleLaborCost` を観測から外す（常に0を返す） | S1（縮小が起きなくなる） |
| 原価フロアの打ち切りを外す | S10 |
| 値下げ上限を飽和点から外す | S11 |
| 解雇コストを0にする | S2, S3（段階性が消え、即最大削減になる） |
| 財務を最上流の情報だけに戻す | S13（default率が悪化する） |

### 6.4 受入判定の観点

- **default率が control より改善していること**（最重要）
- 遊休人件費（`idleLaborCost`）が縮小していること
- 能力調整が**振動しないこと**（増→減→増を繰り返さない）。
  デッドバンドと滞留期間が効いていることを32Qで確認
- 品質が悪化していないこと（残業・臨時への過度な依存が起きていない）
- 5社が同質化していないこと（会社別の反応度パラメータが効いている）

---

## 7. 推奨実装順序

### Phase 0 — 前提整備（他のすべての前提）

| # | 内容 | エンジン変更 |
|---|---|---|
| 0-1 | **観測の拡張**（§5.2 の最優先KPI）。`ownState.financeState` から抽出するだけで情報境界は広げない | なし |
| 0-2 | **有効能力への是正**（名目→`× 0.855`）。現在AIは17%大きい能力を見ている | なし |
| 0-3 | `decision/production.ts:34` と `:71-75` の能力分母の不整合を修正 | なし |
| 0-4 | 死蔵KPI・デッドパラメータの処遇を確定（§5.3） | なし |
| 0-5 | **測定**: 32Qで `idleLaborCost` / 未吸収固定費 / 能力余剰の実額を計測し、SAI-6 の効果目標を数値で置く | なし |

> **0-5 を先にやることを強く推奨する。** 「遊休人件費が常用人件費の6割」は
> `decision/labor.ts:15-23` のコメントに基づく推定であり、現在の実測値ではない。
> SAI-5 の Blocker B と同じく、**係数を触る前にまず実測する**。

### Phase 1 — 必須（エンジン変更は最小限）

| # | 内容 | 依存 |
|---|---|---|
| 1-1 | 需要見通し（`buildDemandOutlook`）の新設 | 0-1 |
| 1-2 | 能力ポジション判定（`assessCapacityStance`）の新設 | 1-1 |
| 1-3 | **採用コスト・解雇コストの追加**（エンジン変更。これのみ） | — |
| 1-4 | 労務の段階的能力調整（③採用停止・④常用削減・⑤再採用） | 1-2, 1-3 |
| 1-5 | 価格戦略の分離・再設計（原価フロア・飽和点上限・市況ダンパー） | 0-1 |
| 1-6 | 新規投資の抑制と**未着工案件の取消**（観測へ `cancellableCapexProjectIds` 追加が前提） | 1-2 |
| 1-7 | 意思決定順序の再構成（財務を最下流へ） | 1-1〜1-6 |
| 1-8 | KPI・reason code の整備、テスト（S1〜S4, S6〜S16） | 全部 |

### Phase 2 — 推奨（設備休止）

| # | 内容 |
|---|---|
| 2-1 | **固定費ドライバーの分解**（工場数 → 工場基礎＋稼働ライン）。全ライン稼働で現行と同額 |
| 2-2 | `FactoryOperationState` の新設（`WorkforceState` が前例）＋ 永続化 v4→v5 |
| 2-3 | `production/capacity.ts` へプール別休止の反映（既定引数で後方互換） |
| 2-4 | 意思決定入力・観測への反映（**観測に反映しないと幻の能力を見続ける**） |
| 2-5 | 休止・再稼働の判断ロジックと、再稼働の立ち上げ遅延 |
| 2-6 | テスト（S5） |

### Future — 今回は実装しない

- 設備売却・除却（§3.4）
- 技能ramp・教育期間（`skills` が fixture 固定である現状を変える必要がある）
- 市場別の直接固定費配賦（`ContributionMarginByDimension.directFixedCost` は市場別で常に0、
  `finance/types.ts:549`）。市場別の撤退・深耕判断をさせるなら前提になる

---

## 8. 設計上の未決事項（レビューでご判断いただきたい点）

1. **採用コスト・解雇コストを入れるか。** 入れないと ④⑤ の段階性に経済的根拠がなく、
   「需要が落ちた瞬間に最大限削減」が常に最適になる。入れる場合の水準
   （解雇2四半期分・採用1四半期分の給与を提案）も併せてご判断いただきたい。
2. **Phase 2（設備休止）まで踏み込むか。** §0.1 のとおり効果は労務が主で設備は従である
   （$1.45M vs $6.0M）。Phase 1 の実測（0-5）を見てから判断する、という進め方も可能。
3. **固定費ドライバーの分解比率**（工場基礎 : ライン別）。これは新しいゲームパラメータであり、
   「ラインを止める価値」の大きさを決める。
4. **`totalFixedCost` に `capexMaintenanceCost` を含めるか**（現在は漏れており、
   capex稼働資産を持つ会社ほど損益分岐点が過小評価される。`quarterClose.ts:1189-1196`）。
   財務側を直すか、AI側で加算し直すか。
5. **価格の自由度をどこまで広げるか。** 現在の −12% を飽和点 −15.67% まで広げるか、
   値上げ方向（現在は使っていない）も解禁するか。
6. **休止・再稼働に遅延を設けるか**（Phase 2）。遅延がないと毎期の振動が起きうる。

---

## 付録: 本設計が前提とする実測値・定数の一覧

| 項目 | 値 | 出所 |
|---|---:|---|
| 標準会社の工場数 | 1 | `standardAi/report/standardBaseline.ts:64-74` |
| 共通前処理能力 | 22,000 t/Q | 同 `:68` |
| HOSO / PD / VAP 能力 | 10,000 / 8,000 / 6,000 t/Q | 同 `:69-71` |
| 常用ワーカー | 6,000人 | 同 `:75` |
| 常用人件費 | $1,000/人/Q（＝$6.0M/Q） | `finance/parameters.ts:140` |
| 臨時人件費 | $800/人/Q（常用の0.8倍） | 同 `:141` |
| 残業割増 | 1.5倍 | 同 `:144` |
| 工場固定費 | $1,200,000/工場/Q | 同 `:148` |
| 固定ユーティリティ | $250,000/工場/Q | 同 `:149` |
| 常用ワーカー効率 | 6 t/人/Q | `production/parameters.ts:121` |
| 臨時ワーカー効率 | 3.5 t/人/Q（常用の58.3%） | 同 `:122` |
| 残業上限 / 効率係数 | 0.3 / 0.5（能力+15%まで） | 同 `:124-126` |
| 設備の有効能力係数 | 0.9 × 0.95 = 0.855 | `production/capacity.ts:44-55` |
| 価格感度 | 3.0 | `sales/parameters.ts:128` |
| 価格スコアの上下限 | 0.5 〜 1.6 | 同 `:129-130` |
| **価格スコアの飽和点** | **−15.67%**（`ln(1.6)/3`） | 上記から導出 |
| 現行AIの最大値引き | −12% | `standardAi/parameters.ts:186` |
| 最大供給者シェア | 0.35 | `sales/parameters.ts:132` |
| 外部選択肢ウェイト | 0.35 | 同 `:134` |
| askPrice の許容範囲 | 基準価格の 0.5〜2.0 倍（外は throw） | 同 `:140-141`, `allocation.ts:41-45` |
