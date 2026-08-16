# Dynamic Scenario 1 — Phase 2: Turn 1〜32 仕様表（candidate）

- 作成日: 2026-08-16
- 前提: `DYNAMIC_SCENARIO_1_PHASE1_AUDIT.md`（同ディレクトリ）
- 実装: **未実施**。本書は #04 の game-design 判断を仰ぐための仕様案
- 数値はすべて **candidate**。正式値ではない

---

## 0. 本仕様の成立条件

| # | 依存 | 状態 | これが無いと落ちるもの |
|---|---|---|---|
| D1 | `productLifecycleOverrides`（Phase1 §7-A） | **#04 承認待ち** | Japan VAP path / EU PD 転換 / Others 隠れ成長 / China premiumization = **§4 の商品列すべて** |
| D2 | 需要ラチェット修正（Phase1 §7-B） | **#04 承認待ち** | T13 以降の市場別 demand path 全部（T16 で JP 0.62% / EU 2.93% まで縮小するため） |
| D3 | News の company-lab UI 配線（Phase1 §7-C） | 小規模・要実施 | News がプレイヤーに見えない |
| D4 | `vietnamProcessingEconomics` の scenario 設定 | **engine 変更不要**（既存 `initialStateOverrides`） | 原料 path（§3）。**D1/D2 が否決でも原料側は成立する** |

**D1/D2 が否決された場合でも、Phase A（T1〜8）の原料ストーリーと供給側の物語は完全に成立する。**
需要側（市場別・商品別）だけを落とした縮小版として実装可能。

---

## 1. シナリオ全体設定

```
scenarioId:    "dynamic-scenario-1-v0.1"
durationTurns: 32                                  （validation 範囲 20〜40 内）
prehistory:    SCENARIO_PREHISTORY_BASELINE_V1     （既存5シナリオと共有＝比較可能性を維持）
variationSettings: allowedModes ["canonical"], defaultMode "canonical"
```

### 1.1 `initialStateOverrides.vietnamProcessingEconomics`（**この仕様の要**）

| 項目 | 既存 baseline | Dynamic Scenario 1 candidate | 理由 |
|---|---|---|---|
| `hosoEqRecoveryRatio` | 1.00 | 1.00 | 変更なし |
| `processingExportCostUsdPerKg` | 0.85 | **0.20** | ↓ |
| `requiredMarginUsdPerKg` | 0.25 | 0.25 | 変更なし |
| **合計控除額** | **1.10** | **0.45** | |

買付上限 = `VN_FOB × recovery − (加工輸出費用 + 必要利益)`。
控除額を 1.10 → 0.45 に絞ると、**国内原料価格が VN FOB により強く連動する**（＝加工業者間の競争が激しく、
FOB 価値のより多くが農家へ渡る世界）。

**なぜ必須か**: Phase1 §6 の実測で、控除額 1.10 のままだと
供給レバー・コストレバーをどれだけ動かしても **T13 以降の「高いTurn は import 有利」（指示 §17）が
一度も成立しない**（最良ケースでも国内が輸入より 7.3% 安いまま）。
控除額を 0.45 にすると4条件すべてが同時に成立する（§3.4 の実測表）。

**⚠ 副作用**: 全期間を通じて 5社の原料仕入価格が約 $0.6/kg 上がる。
Finance / margin への影響は Phase 5 benchmark で測る（指示 §「Financeが苦しくなること自体は問題ではない」）。

**候補**: `0.45`（推奨） / `0.60`（保守的・端境期の逆転幅が +1.0% と薄い） / `1.10`（現状維持・T13以降の調達転換を諦める）

---

## 2. Phase 構成と意図

| Phase | Turn | 世界で起きること | プレイヤーに要求する経営 |
|---|---|---|---|
| **A** | 1–8 | 成長・国内原料安・第一次原料ショック | Sales 増員 / 国内調達 / backlog 積み上げ → **調達リスク管理** |
| **B** | 9–16 | 消費ブーム・商品差別化・global 調達への転換 | PD/VAP 転換 / 市場特化 / 輸入調達の常設化 |
| **C** | 17–24 | 世界需要ショック・隠れ機会・再開ブーム | 現金保全 / 在庫 / 事業再構築 / 多角化 → 攻めへの復帰 |
| **D** | 25–32 | 拡大・China premiumization・業界再編 | 規模 / 中国高付加価値化 / 集約 |

---

## 3. 原料 path（供給 / 価格）— **engine 変更不要**

### 3.1 Long-term trends（国別）

**`VN.AQUACULTURE_COST`**（linear）
`T1 1.00 → T4 0.94 → T6 0.98 → T12 1.04 → T16 1.16 → T20 1.24 → T24 1.27 → T32 1.31`

**`VN.UTILIZATION_RATE`**（**step**。T13 以降が指示 §17 の季節乱高下）
| 区間 | 値 |
|---|---|
| T1 | 0.90 |
| T2–T4 | 0.92（豊漁・国内原料安の演出） |
| T5 | 0.88 |
| T6–T12 | 0.85 |
| T13 以降・Q1(T13,17,21,25,29) | **0.68**（端境期） |
| T14,18,22,26,30 (Q2) | 0.82 |
| T15,19,23,27,31 (Q3) | **1.00**（主漁期） |
| T16,20,24,28,32 (Q4) | 0.88 |

**`VN.COUNTRY_CAPACITY`**: `T1 base → T8 base×1.03 → T32 base×1.12`
**`EC.COUNTRY_CAPACITY`**: `T1 base → T12 base×1.03 → T16 base×1.20 → T20 base×1.26 → T32 base×1.35`
**`IN.COUNTRY_CAPACITY`**: `T1 base → T12 base×1.02 → T16 base×1.10 → T32 base×1.18`
**`ID.COUNTRY_CAPACITY`**: `T1 base → T32 base×1.07`
**`EC.AQUACULTURE_COST`**: `T1 1.00 → T12 1.00 → T16 0.92 → T32 0.90`
**`IN.AQUACULTURE_COST`**: `T1 1.00 → T12 1.00 → T16 0.95 → T32 0.93`
**`ID.AQUACULTURE_COST`**: `T1 1.00 → T32 1.10`

### 3.2 Events（原料側）

| eventId | type | 対象 | start / ramp / dur / recov | 実効ターン | effects |
|---|---|---|---|---|---|
| `ds1-vn-raw-shock` | DISEASE_OUTBREAK | VN | 6 / 1 / 3 / 3 | **T7–T10 満額、T11–12 減衰** | `SURVIVAL_RATE` +add −0.32、`UTILIZATION_RATE` ×0.80、`AQUACULTURE_COST` ×1.60 |
| `ds1-india-supply-disruption` | LOGISTICS_DISRUPTION | IN | 23 / 0 / 2 / 2 | T23–T24 満額、T25–26 減衰 | `EXPORT_ELIGIBILITY_RATE` ×0.85、`AQUACULTURE_COST` ×1.10 |
| `ds1-vn-disease-y7` | DISEASE_OUTBREAK | VN | 26 / 1 / 2 / 2 | T27–T28 満額 | `SURVIVAL_RATE` +add −0.12、`AQUACULTURE_COST` ×1.15 |
| `ds1-ec-disease-y8` | DISEASE_OUTBREAK | EC | 29 / 1 / 2 / 2 | T30–T31 満額 | `SURVIVAL_RATE` +add −0.15、`AQUACULTURE_COST` ×1.18 |

**発現曲線の検算**（`calculateEventIntensity`、`ds1-vn-raw-shock`）:
`T6 = 0`（予兆Newsのみ・効果ゼロ） / `T7,8,9,10 = 1.0` / `T11 = 0.67` / `T12 = 0.33` / `T13 = 0`
→ 指示 §8「T6 時点ではまだ国内 < 輸入」と §9「T7〜9 で逆転」を厳密に満たす。

### 3.3 ⚠ 設計上の禁止事項（実測に基づく）

**T7〜9 の VN ショック期に EC/IN の増産を重ねてはならない。**
Phase1 §6.3-4 の実測（lever G/I）で、輸入国の増産は世界基準価格を下げ、
平均回帰と国別価格スプレッド制約を通じて **VN_FOB も一緒に引き下げてしまう**ことを確認済み。
Ecuador 拡張は指示どおり T13 開始とし、**T12 以前に一切前倒ししない**。

### 3.4 期待される原料価格 path（実測値・USD/HOSO換算kg）

`scripts/dynamicScenario1ProcurementSwitchProbe.ts`（控除額 0.45 系）

| 局面 | VN_FOB | **VN国内** | IN着地 | EC着地 | 差（VN − 最安輸入） | 調達判断 | 指示 |
|---|---|---|---|---|---|---|---|
| T1–4 豊漁・コスト0.94 | 3.557 | **2.750** | 3.946 | 4.481 | **−30.3%** | 国内圧勝 | §7 ✓ |
| T5–6 中立 | 3.776 | 2.90 前後 | 3.99 | 4.54 | −27% 前後 | 国内有利（予兆Newsのみ） | §8 ✓ |
| **T7–10 ショック** | 5.589 | **5.139** | 4.247 | 4.869 | **+21.0%** | **輸入有利** | §9 ✓ |
| T13+ 主漁期 Q3 | 3.815 | **2.919** | 3.480 | 3.881 | **−16.1%** | 国内有利 | §17「安いTurn」✓ |
| T13+ 端境期 Q1 | 4.239 | **3.751** | 3.567 | 3.981 | **+5.2%** | **輸入有利** | §17「高いTurn」✓ |

**4条件すべてが engine 無改変で同時成立する。**

---

## 4. 市場 × 商品 path — **D1（productLifecycleOverrides）必須**

### 4.1 `productLifecycleOverrides` candidate

| market | pd initial | pd mature | pd accel | pd dur | pd base成長/Q | vap initial | vap mature | vap accel | vap dur | vap base成長/Q |
|---|---|---|---|---|---|---|---|---|---|---|
| **JP** | 0.34 | 0.42 | 6 | 8 | 0.002 | 0.10 | **0.32** | **7** | 10 | 0.001 |
| **US** | 0.30 | 0.40 | **9** | 10 | 0.002 | 0.06 | 0.24 | 12 | 10 | 0.001 |
| **EU** | 0.26 | 0.36 | **10** | 12 | 0.002 | 0.05 | 0.16 | 14 | 12 | 0.001 |
| **OTHER** | 0.20 | 0.36 | **17** | **4** | 0.002 | 0.03 | **0.24** | **17** | **4** | 0.001 |
| **CN** | **0.05** | 0.30 | **25** | 8 | **0.0005** | **0.008** | 0.14 | **25** | 8 | **0.0005** |

（現行 `PRODUCT_LIFECYCLE_PARAMETERS_V1` からの変更点を太字。`assertLifecycleParametersValid` の
`pd.mature + vap.mature < 0.95` は全市場で充足: JP 0.74 / US 0.64 / EU 0.52 / OTHER 0.60 / CN 0.44）

### 4.2 指示との突合（構成比 × 市場規模で検算）

**§14「China PD/VAP は T25 頃まで Japan より小さい」**

| | CN share | CN 市場規模 | CN 絶対量 | JP share | JP 市場規模 | JP 絶対量 | 判定 |
|---|---|---|---|---|---|---|---|
| T24 PD | 0.0615 | 500k | **30.8k** | 0.42 | 106k | **44.5k** | CN < JP ✓ |
| T24 VAP | 0.0195 | 500k | **9.8k** | 0.32 | 106k | **33.9k** | CN << JP ✓ |
| T32 PD | 0.290 | 560k | **162k** | 0.42 | 115k | 48k | CN >> JP ✓（premiumization） |
| T32 VAP | 0.135 | 560k | **75.6k** | 0.32 | 115k | 36.8k | CN >> JP ✓ |

**現行 baseline は T1 時点で既に CN PD 45.6k > JP PD 30.6k であり、指示 §14 を最初から破っている。**
`CN.pd.initialShare 0.12 → 0.05`・`accelStartTurn 16 → 25` の変更が必須。

**§19「Others は T16 まで小規模、T17〜20 で実は大きく成長」**

| | T16 | T20 | 倍率 |
|---|---|---|---|
| OTHER pd share | 0.230 | **0.340** | 1.48× |
| OTHER vap share | 0.045 | **0.209** | **4.6×** |

News には数字を書かず、「家庭用冷凍水産食品の販売拡大」という定性ヒントのみ（指示 §19 遵守）。

**§11 Japan**: VAP 加速開始 T7（指示「Turn7頃 Japan VAP growth 開始」）、T8〜16 で 0.10 → 0.30 超へ。
**§12 US**: PD 加速開始 T9（指示「Turn9頃から PD demand 成長」）、mature 0.40 で中盤の principal PD market。
**§13 EU**: PD 加速開始 T10、initial 0.26（HOSO 比率が高い前半）→ mature 0.36。

---

## 5. 市場需要 path — **D2（ラチェット修正）必須**

### 5.1 `REGIONAL_DEMAND` trends（HOSO換算トン。水準として世界需要・産地配分へ効く）

| market | T1 | T8 | T12 | T16 | T20 | T24 | T28 | T32 |
|---|---|---|---|---|---|---|---|---|
| CN | 380,000 | 420,000 | 445,000 | 470,000 | 480,000 | 500,000 | 530,000 | 560,000 |
| US | 320,000 | 335,000 | 355,000 | 380,000 | 385,000 | 400,000 | 420,000 | 440,000 |
| EU | 260,000 | 265,000 | 275,000 | 290,000 | 293,000 | 300,000 | 312,000 | 325,000 |
| JP | 90,000 | 96,000 | 100,000 | 104,000 | 105,000 | 106,000 | 110,000 | 115,000 |
| OTHER | 150,000 | 156,000 | 160,000 | 165,000 | 185,000 | 192,000 | 200,000 | 210,000 |

### 5.2 `ECONOMIC_INDEX` trends（**consumerInventory では複利**。中立 = 1.000）

⚠ Phase1 §8.2 のとおり、この変数は
①世界需要式では**水準**、②consumerInventory では**毎期の乗数（複利）**という二重のセマンティクスを持つ。
以下は複利側を基準に設計している。

| market | T1–7 | T8–16 | T17–20 | T21 | T22–24 | T25–32 |
|---|---|---|---|---|---|---|
| CN | 1.006 | 1.016 | （event） | 1.000 | （event） | 1.014 |
| US | 1.005 | 1.015 | （event） | 1.000 | （event） | 1.012 |
| EU | 1.003 | 1.012 | （event） | 1.000 | （event） | 1.009 |
| JP | 1.002 | 1.010 | （event） | 1.000 | （event） | 1.008 |
| OTHER | 1.005 | 1.013 | （event） | 1.000 | （event） | 1.013 |

### 5.3 Events（需要側）

| eventId | type | 対象 market | start/ramp/dur/recov | 実効ターン | effects |
|---|---|---|---|---|---|
| `ds1-consumer-boom` | ECONOMIC_BOOM | CN,US,EU,JP,OTHER | 7 / 2 / 6 / 3 | T9–T15 満額、T16–18 減衰 | `REGIONAL_DEMAND` ×1.06、`ECONOMIC_INDEX` ×1.008 |
| `ds1-covid-demand-shock` | DEMAND_SHOCK | CN,US,EU,JP | 16 / 1 / 3 / 1 | **T17–T20 満額、T21 = 0** | `ECONOMIC_INDEX` ×0.94、`REGIONAL_DEMAND` ×0.85 |
| `ds1-others-retail-growth` | DEMAND_SHOCK | OTHER | 16 / 1 / 6 / 4 | T17–T23 満額、T24–26 減衰 | `REGIONAL_DEMAND` ×1.18、`ECONOMIC_INDEX` ×1.02 |
| `ds1-reopening-boom` | ECONOMIC_BOOM | CN,US,EU,JP,OTHER | 21 / 1 / 3 / 4 | **T21 = 0（信号のみ）、T22–T25 満額、T26–28 減衰** | `ECONOMIC_INDEX` ×1.05、`REGIONAL_DEMAND` ×1.12 |

**`ds1-covid-demand-shock` は OTHER を対象から外す**（指示 §19「Others hidden opportunity」）。
プレイヤーには「主要4市場が崩れる中、Others だけが崩れない」という差分だけが見える。

### 5.4 China HOSO price spikes（指示 §15・年2回・T13以降）

CN の HOSO 価格は Scenario から直接書けない（Scenario は価格を計算しない）ため、
**`REGIONAL_DEMAND[CN]` の1ターン・スパイク**で世界需給を締めて価格を動かす。

| eventId | start | ramp/dur/recov | 四半期 | magnitude | 想定原因（News） |
|---|---|---|---|---|---|
| `ds1-cn-hoso-spike-y4q1` | 13 | 0/1/1 | Q1 | ×1.30 | 春節 stocking |
| `ds1-cn-hoso-spike-y4q3` | 15 | 0/1/1 | Q3 | ×1.20 | importer buying |
| `ds1-cn-hoso-spike-y6q1` | 21 | 0/1/1 | Q1 | ×1.22 | 規制緩和後の再開見込み買い |
| `ds1-cn-hoso-spike-y6q3` | 23 | 0/1/1 | Q3 | ×1.30 | 外食再開 + 在庫復元 |
| `ds1-cn-hoso-spike-y7q1` | 25 | 0/1/1 | Q1 | ×1.30 | 春節 stocking |
| `ds1-cn-hoso-spike-y7q3` | 27 | 0/1/1 | Q3 | ×1.22 | 産地不作による代替買付 |
| `ds1-cn-hoso-spike-y8q1` | 29 | 0/1/1 | Q1 | ×1.28 | 春節 stocking + 物流逼迫 |
| `ds1-cn-hoso-spike-y8q3` | 31 | 0/1/1 | Q3 | ×1.20 | domestic shortage |

**T17〜T19 にはスパイクを置かない**（需要ショック期。指示 §18 と矛盾させない）。
毎回同じ倍率にせず ×1.20〜1.30 で散らし、プレイヤーに「読み切られる」ことを避ける。

---

## 6. Turn 1〜32 一覧表（指示 §28 の要求列）

凡例: **RM** = raw material、**→imp** = 輸入有利、**→dom** = 国内有利

| T | Ph | market | product | demand mod | price圧力 | RM origin | RM supply mod | RM price mod | 外部供給 | News headline（要旨） | News type | effect 期間 | 学ばせたいこと |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A | 全市場 | HOSO主体 | 基準 | 中立 | **→dom** | VN util 0.90 | VNコスト 1.00 | 基準 | 世界のエビ需給は安定、ベトナム産地は良好な作柄 | Current | — | 出発点の把握 |
| 2 | A | 全市場 | HOSO主体 | +0.5% | やや軟 | **→dom** | VN util 0.92 | VNコスト 0.98 | 基準 | メコンデルタで収穫順調、国内集荷価格は軟調 | Structural | T1–4 | Sales を増やせば売れる |
| 3 | A | US/JP | PD/VAP微増 | +0.5% | 軟 | **→dom** | VN util 0.92 | VNコスト 0.96 | 基準 | 国内原料は前年比で下落、加工各社の採算改善 | Current | T1–4 | 安い国内原料で作れば儲かる |
| 4 | A | 全市場 | — | +0.5% | 軟（最安） | **→dom −30%** | VN util 0.92 | **VNコスト 0.94（底）** | 基準 | 主要輸入国の在庫は低水準、輸入業者の引き合い強い | Leading | T5〜 | **翌期分まで contract を積むのが有利** |
| 5 | A | 全市場 | — | +0.5% | 中立 | →dom | VN util 0.88 | VNコスト 0.95 | 基準 | 稼働率上昇、加工能力の逼迫を指摘する声 | Leading | T5〜 | capacity pressure の自覚 |
| 6 | A | 全市場 | — | +0.5% | 中立 | **→dom（まだ）** | VN util 0.85 | VNコスト 0.98 | 基準 | ①メコンデルタ一部で疾病報告 ②中国 buyer のベトナム原料買付が増加 ③集荷量不足の観測 | **Leading ×3** | **効果ゼロ** | **先読みした者だけが import へ切り替えられる** |
| 7 | A | 全市場 | — | +0.5% | **急騰** | **→imp +21%** | **VN 供給 −50%** | **VNコスト ×1.60** | 基準 | ベトナム南部で疾病拡大を確認、集荷価格が急騰 | **Current** | **T7–10** | **固定売価 backlog の margin collapse** |
| 8 | A/B | 全市場 | — | +0.5% | 高止まり | →imp | VN 供給 −50% | VN ×1.60 | 基準 | ①原料高が続く、加工各社は輸入原料へ切替 ②主要市場の消費は堅調 | Current + Leading | T7–10 / T9〜 | 調達の多角化 |
| 9 | B | 全市場 | **US PD 加速開始** | **+6%** | 高 | →imp | VN 供給 −50% | VN ×1.60 | 基準 | 米国で加工エビ（PD）の需要が拡大 | **Structural** | **T9–15** | 経営修正すれば復活できる |
| 10 | B | 全市場 | **EU PD 加速開始** | +6% | 高→軟化 | →imp | VN 供給 −50% | VN ×1.60 | 基準 | 欧州小売でむき身製品の取扱いが増加 | Structural | T10– | 市場別の商品構成が違う |
| 11 | B | 全市場 | JP VAP 拡大中 | +6% | 軟化 | →dom 回復 | VN 供給 −33% | VN ×1.40 | 基準 | ベトナムの池入れ回復、集荷量は持ち直しへ | Current | T11–12 減衰 | ショックは終わる |
| 12 | B | 全市場 | — | +6% | 中立 | **→dom** | VN 回復 | VNコスト 1.04 | 基準 | エクアドルで大規模な養殖池拡張が進行との報 | **Leading** | **T13〜** | **次の構造変化の予兆** |
| 13 | B | **CN スパイク** | — | +6% / **CN ×1.30** | **CN HOSO 急騰** | →dom（端境期で接近） | **VN util 0.68** | VNコスト 1.06 | **EC 拡張開始** | ①春節向け stocking で中国の HOSO 買付が急増 ②ベトナムは端境期入り | Current ×2 | T13 / T13〜 | **HOSO へ張った会社が稼ぐ** |
| 14 | B | 全市場 | — | +6% | 中立 | →dom | VN util 0.82 | VNコスト 1.09 | EC 拡張 | エクアドル産の輸出量が前年比で大幅増 | Structural | T13– | global 調達の必要性 |
| 15 | B | **CN スパイク** | — | +6% / CN ×1.20 | CN 高 | **→dom（主漁期・最安）** | **VN util 1.00** | VNコスト 1.12 | EC 拡張 | ①輸入業者の buying で中国相場が上昇 ②ベトナム主漁期、集荷価格は下落 | Current ×2 | T15 | **安い時に買う procurement timing** |
| 16 | B | 全市場 | **OTHER 加速開始** | +6% 減衰 | 中立 | →dom | VN util 0.88 | **VNコスト 1.16** | **EC +20% / IN +10%** | ①エクアドル増産で国際相場に下押し圧力 ②外食向け出荷にかげりとの指摘 | Structural + **Leading** | T13– / **T17〜** | **ベトナム原料が相対的に割高に** |
| 17 | **C** | CN/US/EU/JP **−15%** | **OTHER PD/VAP 加速** | **−15%** | **急落** | **→imp（端境期）** | VN util 0.68 | VNコスト 1.18 | EC 拡張 | ①主要市場で外食需要が急減、契約が取りにくい ②一方で家庭用冷凍水産食品の販売は拡大 | **Current + Leading** | **T17–20** | **初めての守りの経営** |
| 18 | C | 主要4市場 −15% | OTHER 成長中 | −15% | 低 | →dom | VN util 0.82 | VNコスト 1.20 | EC 拡張 | 輸入業者が在庫調整、新規成約は低調 | Current | T17–20 | 在庫・現金の保全 |
| 19 | C | 主要4市場 −15% | OTHER 成長中 | −15% | 低 | →dom（主漁期） | VN util 1.00 | VNコスト 1.22 | EC 拡張 | 稼働率低下で加工各社は減産・人員調整へ | Current | T17–20 | restructuring / 縮小の判断 |
| 20 | C | 主要4市場 −15% | **OTHER VAP 4.6倍** | −15% | 低 | →imp（Q4） | VN util 0.88 | VNコスト 1.24 | EC 拡張 | 小売向け・アジア都市部の販売は堅調との報告 | Structural | T17–23 | **Others に残した会社が生き延びる** |
| 21 | C | **回復シグナル** | — | 0（効果なし） | 底打ち | →imp（端境期） | VN util 0.68 | VNコスト 1.25 | EC 拡張 | ①レストラン営業再開の動き ②輸入業者が在庫復元を開始 ③規制緩和が進む | **Leading ×3** | **効果ゼロ** | **T22 を見越した先行準備** |
| 22 | C | 全市場 **+12%** | — | **+12%** | **急騰** | →dom | VN util 0.82 | VNコスト 1.25 | EC 拡張 | 世界需要が急回復、供給が追いつかず相場上昇 | **Current** | **T22–25** | **capacity を維持した会社が稼ぐ** |
| 23 | C | **CN スパイク** | — | +12% / CN ×1.30 | 高 | →dom（主漁期） | VN util 1.00 | VNコスト 1.26 | **IN 輸出障害** | ①中国の外食再開で HOSO 相場が高騰 ②インドで輸出通関の遅延 | Current ×2 | T22–25 / T23–24 | 調達先の分散 |
| 24 | C | 全市場 +12% | — | +12% | 高 | →imp（Q4） | VN util 0.88 | VNコスト 1.27 | IN 障害 | 日本のプレミアム市場も回復、高付加価値品の引き合い強い | Current | T22–25 | boom を取り切る |
| 25 | **D** | **CN スパイク** | **CN PD/VAP 加速開始** | +12% 減衰 / CN ×1.30 | 高 | →imp（端境期） | VN util 0.68 | VNコスト 1.27 | 基準 | ①中国都市部で調理済み・むき身製品の消費が拡大 ②春節 stocking | **Structural + Current** | **T25–33** | **China premiumization の起点** |
| 26 | D | 全市場 | CN PD/VAP 成長 | +8% | 中立 | →dom | VN util 0.82 | VNコスト 1.28 | 基準 | 中国の量販店でエビ加工品の棚が拡大 | Structural | T25– | HOSO 先行組の Cash 活用 |
| 27 | D | **CN スパイク** | CN PD/VAP 成長 | +6% / CN ×1.22 | 高 | →dom（主漁期） | **VN 疾病 −12pt** | **VNコスト ×1.15** | 基準 | ①ベトナム一部地域で疾病、集荷価格が上昇 ②産地不作で中国が代替買付 | Current ×2 | **T27–28** | 好況下の risk |
| 28 | D | 全市場 | CN PD/VAP 成長 | +6% | 中立 | →imp | VN 疾病継続 | VN ×1.15 | 基準 | 原料高で加工各社の採算は圧迫 | Current | T27–28 | 規模の優位 |
| 29 | D | **CN スパイク** | CN PD/VAP 成長 | +6% / CN ×1.28 | 高 | →imp（端境期） | VN util 0.68 | VNコスト 1.30 | **EC 疾病予兆** | ①春節 stocking と物流逼迫 ②エクアドルで生育不良の報告 | Current + **Leading** | T29 / **T30〜** | 調達先の再分散 |
| 30 | D | 全市場 | CN PD/VAP 成熟へ | +6% | 高 | →dom | VN util 0.82 | VNコスト 1.30 | **EC 疾病 −15pt** | エクアドルで疾病、輸出量が減少 | **Current** | **T30–31** | 業界再編の圧力 |
| 31 | D | **CN スパイク** | — | +6% / CN ×1.20 | 高 | →dom（主漁期） | VN util 1.00 | VNコスト 1.31 | EC 疾病 | ①中国国内の供給不足で相場上昇 ②エクアドル減産の影響が国際相場へ | Current ×2 | T30–31 | 集約の最終局面 |
| 32 | D | 全市場 | CN PD 0.29 / VAP 0.135 | +6% | 高 | →imp（Q4） | VN util 0.88 | VNコスト 1.31 | 回復 | 世界需要は拡大基調を維持、産地の再編が進む | Structural | — | （終了ターンはプレイヤーに告知しない） |

**⚠ 指示 §5 遵守**: 32 が終了ターンであることを示唆する News・効果は一切置かない。
T32 の News も「拡大基調を維持」という継続を示す内容とし、
Scenario 側にも AI 側にも「残りTurn」の概念を持ち込まない。

---

## 7. News 一覧（Turn 別・型別）— Phase 4 の骨格

**総数 candidate: 48件**（Current 24 / Leading 12 / Structural 12）。
1ターンあたり 1〜3件（指示 §25 充足）。全ターンに最低1件。

### 7.1 News と effect の同期規約（指示 §25「必ず同期」）

| News type | `availableFromTurn` | `isRumor` | `confidence` | effect との関係 |
|---|---|---|---|---|
| **Leading Indicator** | effect 開始ターン **− 1〜2** | `true` | 0.30–0.45 | **この時点で効果はゼロ**（`calculateEventIntensity` = 0 を検証テストで担保） |
| **Current Event** | effect 開始ターン **と同一** | `false` | 0.80–0.95 | 満額発現の初回ターン |
| **Structural Trend** | trend の変曲ターン | `false` | 0.60–0.80 | `relatedEventId` なし（trend 由来） |

### 7.2 数値開示の規約（指示 §25「内部parameter値を直接書かない」）

- `structuredFacts` には**定性的な事実のみ**（地域・品目・方向）
- 量的情報は `estimateRange` で**幅**として示す（例: `{low: -0.15, high: -0.05}`）
- `magnitude`・`share`・`accelStartTurn` 等の内部値は **`gm` / `postGameTruth` レベルにのみ**置く
- 指示 §19 の Others は特に厳格: 「家庭用冷凍水産食品の販売が拡大」まで。**成長率も市場規模も書かない**

### 7.3 Leading Indicator の配置（プレイヤーが先読みできる唯一の手掛かり）

| News | 出るターン | 予告する effect | 開始ターン | 猶予 |
|---|---|---|---|---|
| メコンデルタ疾病報告 / 中国 buyer 買付増 / 集荷量不足 | **T6** | `ds1-vn-raw-shock` | T7 | **1ターン** |
| 主要輸入国の在庫低水準 | T4 | `ds1-consumer-boom` | T9 | 5ターン |
| エクアドル養殖池拡張 | T12 | `ds1-ecuador-expansion` | T13 | 1ターン |
| 外食向け出荷にかげり | **T16** | `ds1-covid-demand-shock` | T17 | **1ターン** |
| 家庭用冷凍水産食品の販売拡大 | T17 | `ds1-others-retail-growth` | （T17 同時） | 0（同期） |
| レストラン再開 / 在庫復元 / 規制緩和 | **T21** | `ds1-reopening-boom` | T22 | **1ターン** |
| エクアドル生育不良 | T29 | `ds1-ec-disease-y8` | T30 | 1ターン |

**T6 / T16 / T21 が本シナリオの3つの「先読み判断点」。**
いずれも「News は出るが effect はゼロ」というターンとして設計されている
（`ds1-vn-raw-shock` は `startTurn 6, rampUpTurns 1` により T6 の強度が数学的に 0 になる）。

---

## 8. Scenario 専用テストの計画（Phase 3 で書く）

| # | 検証内容 | 方法 |
|---|---|---|
| T1 | `validateScenarioDefinition` が pass する | 既存 validation |
| T2 | 予兆 News のターンで effect 強度が厳密に 0 | `calculateEventIntensity` を T6 / T16 / T21 で assert |
| T3 | News の `availableFromTurn` と effect 開始ターンの同期 | 全 event × 全 information の対応表を機械検査 |
| T4 | T1–4 は国内 < 輸入、T7–10 は国内 > 輸入 | `calculateMarketQuarter` + `calculateLandedPrice` |
| T5 | T13 以降、主漁期は国内有利・端境期は輸入有利 | 同上（Q別） |
| T6 | CN PD/VAP 絶対量が T24 まで JP 未満 | `computeMarketProductMix` × `REGIONAL_DEMAND` |
| T7 | OTHER PD/VAP が T16→T20 で大きく成長 | 同上 |
| T8 | `canonical` mode で乱数を消費しない（完全再現性） | 既存規約 |
| T9 | 32Q 通しで例外なく完走 | `scripts/scenarioSmoke.ts` に alias 追加 |
| T10 | 既存5シナリオの結果がビット単位で不変 | 回帰テスト（`productLifecycleOverrides` 未指定時） |

---

## 9. #04 への確認事項（この Phase の停止点）

| # | 論点 | 選択肢 | 影響 |
|---|---|---|---|
| Q1 | `productLifecycleOverrides`（D1）を承認するか | 承認 / 否決 | 否決なら **§4 全部** と §5 の商品列を落とす |
| Q2 | 需要ラチェット修正（D2）を承認するか、方式は | B-1 / B-2 / B-3 / 否決 | 既存5シナリオの 32Q 挙動が変わる。Standard AI benchmark の再取得が要る |
| Q3 | `vietnamProcessingEconomics` 控除額 | **0.45** / 0.60 / 1.10 | 0.45 で §7/§9/§17 が全部成立。5社の原料コストは +$0.6/kg |
| Q4 | T7 ショック強度 | 供給 −50% + コスト×1.60（+21%） / −45%+×1.40（+2%） | 弱いと輸入転換が起きない。強いと破綻リスク |
| Q5 | T17 需要ショック深度 | ×0.94×4Q（≈−20%） / ×0.90（≈−34%） | 「自動破綻させない」の許容ライン |
| Q6 | `ECONOMIC_INDEX` の複利セマンティクスを許容するか | 許容 / `demandShockFactor` 配線 | 許容しない場合 Phase1 §7-E が必要 |
| Q7 | China HOSO spike の倍率レンジ | ×1.20〜1.30 / より強く | 「HOSO 戦略の明確な収益機会」（§15）の強さ |
| Q8 | branch 名 | `feature/v2-dynamic-scenario-1` へ変更 / 現行のまま | harness 指定は現行名 |
| Q9 | `ALL_SCENARIO_DEFINITIONS` への追加時期 | Phase 3 完了時 / Phase 5 完了時 | 追加した瞬間に company-lab / console の選択肢に出る |

**Q1・Q2 の回答が出るまで Phase 3 の実装には着手しない。**
Q1/Q2 が否決でも、**§3（原料 path）と §7（News）は engine 変更なしで着手可能**。
