# Standard企業（BAL相当）Mission/Vision/Strategic Principles/Operating Policies ドラフト

2026-08-04 Cowork #05（AI設定）実施

**注記**: 本文書はまだコードの数値変更ではない。既存Profile値（`managementProfile.ts`のbalanced・`orientationProfile.ts`のbalancedGeneralist）が表現している経営思想を人間が読める形に翻訳する作業である。

## 1. Mission

ベトナムの社会および世界経済の発展に貢献するため、生産されたエビを加工し、消費国の人々に食べやすい形で提供することで、エビ全体の消費拡大に貢献する。

## 2. Vision

5〜7年で事業規模を倍増し、年間税引後利益80M USDを目指す。

## 3. Strategic Principles（Missionから自然に導けるもの）

- 現状維持を基本とせず、持続可能な成長を志向する。
- 5〜7年で規模倍増を目指すため、毎期の意思決定は中期成長経路と整合させる。
- 数量成長だけでなく、税引後利益80Mという収益性目標を同時に追う。
- エビを「食べやすい形」に加工して消費拡大へ貢献するというMissionから、PD/VAP等の付加価値加工能力育成にも意味を持たせる。
- ベトナム国内の産業発展への貢献を意識し、合理性がある範囲で国内原料・国内加工能力への投資を重視する。
- 一方で、Missionを理由に採算性を無視した調達や投資は行わない。
- 成長投資のためにCashや借入余力を使うことは許容するが、財務破綻を避ける。
- 単一四半期の利益最大化ではなく、5〜7年の成長経路全体で判断する。

## 4. Operating Policies（既存Profile値との対応）

| Policy | Standard企業の現在の値（BAL=balanced×balancedGeneralist） | 対応する既存フィールド |
|---|---|---|
| Growth | 中立（バイアス無し） | `ManagementProfile.salesAggressivenessRatio=0` |
| Liquidity / leverage | 中立（安全ガードは全社共通） | 安全ガード自体は`ManagementProfile`の対象外 |
| Sales | 全市場中立（1.0） | `CompanyOrientationProfile.marketMultipliers`（全て1.0） |
| Product mix | 全商品中立（1.0） | `CompanyOrientationProfile.productMultipliers`（全て1.0） |
| Inventory | 中立（在庫是正反応バイアス無し） | `ManagementProfile.inventoryResponsivenessRatio=0` |
| Raw procurement | 中立（輸入依存・養殖自給バイアス無し） | `ManagementProfile.importRelianceRatio=0`／`aquacultureSelfSufficiencyRatio=0` |
| Labor | 中立（採用ペースバイアス無し） | `ManagementProfile.headcountPaceRatio=0` |
| Capex | 中立（PD/VAP前倒しバイアス無し） | `ManagementProfile.valueAddedCapexTimingAbsolute=0` |
| Profitability | 中立（成長トレンド応答度0.5、中庸） | `CompanyOrientationProfile.growthTrendResponsiveness=0.5` |

**解釈**: Standard企業（BAL）は、現在すべてのOperating Policyが「中立」であり、これは他4社との差分基準として設計されたゼロプロファイルである。今回のMission/Vision（規模倍増・利益80M・付加価値化重視・国内産業貢献）を踏まえると、将来的にはGrowth Policyをやや積極側へ、Product mix Policyをやや付加価値（PD/VAP）側へ動かす余地があるが、**今回はこの値を変更していない**（三宅さんの指示どおり、本ラウンドはProfile数値変更を行わない）。

## 5. Vision Progress Diagnosis 将来設計（実装なし、設計のみ）

### 5.1 Vision達成帯（単一CAGRにしない）

「5〜7年で規模倍増」を、5年ライン（CAGR≈3.5%/四半期、正確な値は $2^{1/(5×4)}-1$ で計算）〜7年ライン（CAGR≈2.5%/四半期、$2^{1/(7×4)}-1$）の**達成帯**として扱う。現在の実績成長ペースがこの帯に対してどこにあるかで、次の3区分で評価する。

- 5年ラインより速い → **Ahead**
- 5〜7年ラインの帯内 → **On Track**
- 7年ラインより遅い → **Behind**

正確な四半期CAGRはコード上で`Math.pow(2, 1/(years*4)) - 1`として計算する（固定値をハードコードしない）。

### 5.2 二大指標（Trailing 4 Quarters）

単一四半期ではなく、直近4四半期のトレーリング値で評価する。

- 事業規模: Trailing 4Q販売量（年間換算）
- 収益力: Trailing 4Q税引後利益

### 5.3 4分離指標（単一スコアへ潰さない）

- **Scale trajectory gap**: Trailing 4Q販売量 ÷ 達成帯上の期待販売量（Vision開始期からの経過四半期数に応じた期待軌道）。
- **Profit trajectory gap**: Trailing 4Q税引後利益 ÷ 達成帯上の期待利益。
- **Future capacity readiness**: Business Scale ProfileのProduction/Labor軸の`leadTimeQuarters`と、Vision達成帯までの残り四半期数を比較し、「今から投資・採用を始めても間に合うか」を診断。
- **Financial readiness**: Business Scale ProfileのFinance軸（`supportedScaleTonsWithinTargetBuffer`）が、Vision達成帯上の期待規模を支えられるかを診断。

この4指標は、三宅さんの例示（「売上規模はVisionより遅れているが利益はVisionより進んでいる。設備は2年後の成長には不足。財務には投資余力あり」）をそのまま表現できる構造になっている。

### 5.4 入力として渡すべきBusiness Scale Profileの指標（三宅さんの指示§11）

- current sustainable sales scale（Sales軸の`supportedScaleTons`）
- current production readiness（Production軸の`supportedScaleTons`とbinding constraint）
- labor readiness（Labor軸の`supportedScaleTons`）
- finance readiness（Finance軸の`supportedScaleTonsWithinTargetBuffer`）
- future capacity lead-time risks（各軸の`expansionOptions`の`leadTimeQuarters`）

これらは今回実装したBusiness Scale Profileの`axes`から直接取得可能であり、Vision Progress Diagnosisモジュールを実装する際に新たなobservationを追加する必要はない見込みである。
