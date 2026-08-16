# Standard AI Strategy Profile Audit — Phase SP-A1

branch `feature/v2-32q-management-console` @ HEAD `ce030f0`（CM-1後）

監査のみ。ゲームロジック・Strategy Profile値・Vision値・Strategic Posture既定値・
Commercial Ambition閾値・CAPEX閾値・PD mechanization/VAP development trigger・
Finance/Market/Production/Pricing/Crisis CM-1 のいずれも変更していない。
新規追加は監査スクリプト（`scripts/strategyProfileAuditPhaseSPA1.ts`）と本ドキュメント群のみ。

## Benchmark条件

- scenario: baseline / ecuador-early-expansion / ecuador-delayed-expansion / global-demand-boom / global-disease-crisis（5種）
- seed: seed-1〜seed-5（5種）
- 5社（MASS/BAL/JPQ/CONSV/VAP）× 32Q、全社Standard AI
- 合計 5×5=25 Run × 32Turn × 5社 = 125 会社Run
- Vision Default: MASS 80,000 / BAL 34,000 / JPQ 30,000 / CONSV 27,000 / VAP 17,000（t/quarter、現行既定値のまま）
- Strategic Postureは現行既定値のまま（変更なし）
- データ: `docs/standard_ai/benchmarks/strategy_profile_audit_spa1.csv`（会社×シナリオ×シード集計、125行）、
  `docs/standard_ai/benchmarks/company_investment_timeline_spa1.csv`（Turn単位イベント、3008行）

---

## 1. 最重要質問への回答（§1 A〜F）

**A. MASSは他社よりscale/HOSO/factory投資を積極的か？**
Scale（新工場・総CAPEX）は明確にYES：newFactoryConstruction提案45件/25Run（ほぼ毎Runで1〜2回、
5社中唯一複数回建設）、totalCapexPaid平均$55.7M（5社中2位、BAL$74.9Mに次ぐ）。
一方「HOSO特化」はNO：MASSのHOSO提案(40件)よりPD提案(60件)の方が多い。これはMASSが
`chinaVolume`（HOSO志向1.2倍）という志向プロファイルを持つ設計だが、その志向プロファイルは
本番シミュレーション経路では無効（§29参照）であり、実際にはVisionの規模目標（80k、5社最大）が
全商品ラインへ均等にストレスをかけているだけである。「MASSが量で勝る」はYESだが、
「MASSがHOSOで勝る」は現状NO（商品特化ロジックが実装されていないため）。

**B. JPQは他社よりPD/PD mechanization/quality投資を積極的か？**
PD投資量（57件）はBAL(52)より多くMASS(60)より少なく、中位相当。**PD Mechanizationは
5社全て0件**（Standard AIに提案関数自体が存在しないため、構造的に発生しない。§12参照）。
**Quality投資も5社全て0件**（同様に提案関数が存在しない。§14参照）。JPQが他社よりPD/品質を
重視している形跡は投資行動に一切見られない。JPQの際立った特徴は逆にcommonProcessing投資
（104件、5社中最多）とending cash（平均$420M、5社中最高）——巨額の現金を抱えたまま
新工場を一度も建てない、という点である。

**C. VAPは他社よりVAP line/VAP product development/quality投資を積極的か？**
明確にNO。VAPのvapLineExpansion提案はわずか5件/25Run（5社中最少。JPQ43件、MASS36件と比較）、
pdLineExpansionも5件のみ。totalCapexPaid平均$13.1M（5社中最小、MASSの1/4以下）。
**VAP Product Developmentは5社全て0件**（AIの候補集合に存在しないことがテストでも保証されている
仕組み。§13参照）。VAPが「高付加価値特化」の投資行動を取っている証拠はゼロ——単にVision規模
（17k、5社最小）が小さいため、あらゆる投資判断のトリガーとなる稼働率ボトルネックにほとんど
到達しないだけである。

**D. BALはバランス型か？**
投資の広さという意味ではYES——BALは5社中唯一、hosoLineExpansion(75=毎Run3回上限)・
pdLineExpansion(52)・vapLineExpansion(24)・commonProcessingExpansion(79)・
newFactoryConstruction(25=毎Run1回) の全カテゴリで有意な件数を記録した唯一の会社。
totalCapexPaidも5社中最高（$74.9M平均）。ただしこれも「バランス型プロファイルだから」ではなく、
Vision規模34,000t（5社中2番目に大きい）とAGGRESSIVE_EARLY_CAPACITY姿勢（MASSと共通）の
組み合わせが、全ラインへ満遍なく需要を発生させた結果と解釈するのが妥当。

**E. CONSVは財務規律が強く投資頻度・先行投資が少ないか？**
投資頻度が5社中最少グループなのはYES（totalCapexPaid平均$28.2M、commonProcessing・
newFactory提案は0件）。しかしこれが「財務保守的な性格」によるものだと断定はできない。
理由：(1) CONSVのVision規模27,000tは5社中2番目に小さく、単純に必要な生産能力が小さい。
(2) CONSVのStrategic PostureはDEMAND_CONFIRMED（reactive routeのみ）であり、新工場の
「先行投資しない」という保守性はPosture設計そのものの効果であって、CONSV固有の財務規律
パラメータの効果ではない。(3) 経営性格プロファイル（ManagementProfile、CONSVはconservative
=各種比率-3%〜-5%）は本番経路で無効（§29参照）。つまり「見た目は保守的」だがその原因は
Vision規模とStrategic Postureのみであり、真の意味での「財務規律の強さ」を検証する仕掛けは
現状動いていない。ending debtは5社全社で$0（MASSのみ$23M平均）——CONSVが特に借入を避けている
わけではなく、単にMASS以外は成長ペースが緩やかで借入需要自体が発生していない。

**F. 差が無い/薄い項目の原因分類**
- **「2. Profileがdecision moduleへ未接続」が支配的原因**：`ManagementProfile`(SAI-4)と
  `OrientationProfile`(SAI-5A)という、量的でよく設計されたプロファイル機構が実在するが、
  Management Consoleが使う本番経路（`simulation/engine.ts` → `generateStandardAiDecisionWithDiagnostics`）
  は`params`引数を`undefined`のまま渡しており、`STANDARD_AI_PARAMETERS_V1`（バイアスゼロ）に
  フォールバックする。5社の商品志向倍率・市場志向倍率・成長性向バイアスは**コード上は存在するが
  実行時には一切適用されない**。
- **「3. Standard AIがそのaction自体を提案できない」が該当する項目**：PD Mechanization・
  VAP Product Development・Quality投資・Environmental投資・Freezing/Packaging投資は、
  Standard AI側に候補生成関数そのものが存在しない（`STANDARD_AI_PROPOSABLE_CAPEX_TYPES`が
  5種類のみを許可）。これはバグではなく明示的なスコープ外設計（`capex.ts:14-18`）。
- **「4. 経済合理性の共通ロジックがProfile差を上書きしている」も部分的に該当**：HOSO/PD/VAP
  ライン投資判断自体は稼働率・在庫・財務ゲートという全社共通ロジックのみで駆動されており、
  Product Direction（`desiredProductEvolution`）は一切読まれない（DISPLAY_ONLY、§5参照）。
- **「1. Profileが弱い」は不正確な表現**：ManagementProfile自体の値の幅（原則±5%、最大±10%）は
  小さいが、それ以前に本番経路へ**接続すらされていない**ため、「弱い」のではなく「実行時ゼロ」。

---

## 3〜7. 現行 Mission / Vision / Profile / Posture SSoT監査

（詳細な file:line 根拠は探索エージェントの一次調査結果に基づく。要点のみ記載）

### Mission
- 型: `CompanyStrategyDocument.mission: string`（`companyLab/strategyProfile/types.ts:81`）
- Default: 全社 `""`（空文字固定）。会社別値は存在しない。
- SSoT: `strategyProfile/types.ts`（`createEmptyStrategyDocument`）
- Runtime resolution: なし。UIの2箇所（`PlayerWorkspace.tsx`, `ManagementConsole.tsx`）で
  `createEmptyStrategyDocument`を都度生成しReact local stateに保持するのみ、永続化なし。
  `CompanyInspector.tsx`の見出し自体が「Mission / Vision（自由文。数値判断には未使用）」と明言。
  **DISPLAY_ONLY / 実質DEAD。**

### Vision（`CompanyVision`、本監査の実質的な主役）
- 型: `CompanyVision`（`vision/types.ts:79-102`） — `growthAmbition` / `targetScaleTonsPerQuarterAtQ32` /
  `preferredEndState` / `willingnessToBuildFactories` / `financialRiskTolerance` /
  `desiredProductEvolution` / `referenceGrowthPath` / `strategicPosture` 等。
- Default（`vision/defaults.ts`）:

  | Company | growthAmbition | targetScale(t/Q) | willingness | riskTolerance | desiredProductEvolution | strategicPosture |
  |---|---|---|---|---|---|---|
  | MASS | HIGH | 80,000 | HIGH | HIGH | HOSO_SCALE | AGGRESSIVE_EARLY_CAPACITY |
  | BAL | HIGH | 34,000 | HIGH | MEDIUM | INTEGRATED | AGGRESSIVE_EARLY_CAPACITY |
  | JPQ | HIGH | 30,000 | MEDIUM | MEDIUM | PD_SCALE | DEMAND_CONFIRMED |
  | CONSV | MEDIUM | 27,000 | MEDIUM | LOW | INTEGRATED | DEMAND_CONFIRMED |
  | VAP | LOW | 17,000 | LOW | MEDIUM | VAP_VALUE | VALUE_FIRST |

- SSoT: `vision/types.ts` + `vision/defaults.ts`
- Runtime resolution: **`resolveCompanyVision(companyId, turn, overrides?)`**（`vision/overrides.ts`）が
  唯一の正規経路。`policy.ts:395`から呼び出され、`growthAmbition`/`willingnessToBuildFactories`/
  `financialRiskTolerance`/`targetScaleTonsPerQuarterAtQ32`/`strategicPosture`は実際に数値判断へ
  接続されている（**ACTIVE**）。`desiredProductEvolution`/`preferredEndState`/`longTermNarrative`/
  `emphasisProducts`はエクスポート・表示はされるが計算には一切使われない（**DISPLAY_ONLY**）。

### Archetype（`CompanyFixture.archetype`）
- 型: `"balanced"|"massMarket"|"japanQuality"|"vapSpecialist"|"conservative"`（`fixtures.ts:70`）
- 会社別値あり（BAL=balanced, MASS=massMarket, JPQ=japanQuality, VAP=vapSpecialist, CONSV=conservative）
- Runtime: `autoPolicy.ts`（統合テスト・GM確認用の代替決定生成器）でのみ読まれる。Standard AI本体
  （`standardAi/report/configSnapshot.ts:77`が「比較対象＝標準AIでは不使用」と明記）では
  **一切使用されない**。

### Strategy Profile（`strategyProfile/types.ts`、新モジュール）
- 型: `StrategyProfile { productFocus, specialization, marketOrientation, growthAppetite,
  investmentAppetite, financialConservatism, qualityOrientation, verticalIntegrationPreference,
  inventoryPosture, contractPreference, strategicHorizon }`
- Default: 全社共通の`NEUTRAL_STRATEGY_PROFILE`（数値フィールドは全て50、enum系は全てBALANCED）
- 会社別値: なし
- モジュール自身のヘッダーコメントが明記：「この値は現時点でゲームの計算に一切影響しない。
  表示・保存のみ」「Strategy Profile を Standard AI の数値判断へ反映する処理は実装しない」
  「本モジュールは standardAi/ を一切 import しない」。専用の分離保証テスト
  （`simulationEngine.test.ts:312-317`）まで存在する。**DEAD_CODE（意図的）。**

### Strategic Posture（`CompanyVision.strategicPosture`）
- 型: `"AGGRESSIVE_EARLY_CAPACITY"|"DEMAND_CONFIRMED"|"VALUE_FIRST"`（`vision/types.ts:65`）
- 会社別値: 上表参照（MASS/BAL=AGGRESSIVE、JPQ/CONSV=DEMAND_CONFIRMED、VAP=VALUE_FIRST）
- SSoT: `vision/*` と同じ（`resolveCompanyVision`経由）
- Runtime: `newFactory.ts:991`で`AGGRESSIVE_EARLY_CAPACITY`のみForward-Capacity Routeへの
  アクセスをゲート。**ACTIVE（New Factoryドメインのみ）。**
- Management Console編集UI: `VisionCalibrationPanel.tsx`（Run中編集）、`SetupScreen.tsx`（開始時編集）
  の2箇所。両方とも`CompanyLabVisionOverrides`経由で`resolveCompanyVision`へ実際に反映される
  （UIから実データまで配線済み）。

### Growth Ambition / Financial Risk Tolerance（Visionのサブフィールド）
- `growthAmbition`: `strategicGrowth.ts`（growth-pressure感度）、`commercialAmbition.ts`
  （四半期毎の成長上限ステップ比率）で使用。**ACTIVE。**
- `financialRiskTolerance`: `newFactory.ts`（新工場の必要現金前払い比率、HIGH=0.6/MEDIUM=0.85/LOW=1.1）
  で使用。**ACTIVE（New Factoryドメインのみ）。**
- `investmentHurdle`・`strategyFit`・`productFit`・`automationPreference`・
  `differentiationPreference`・`scalePreference`・`profileModifier`・`strategyMultiplier`：
  リポジトリ全体でゼロ件（存在しない識別子）。

### 【重要な追加発見】実在する量的プロファイル機構（ただし本番経路では無効）

上記のMission/StrategyProfile/Archetypeとは別に、探索の過程で以下2つの**既に量的な**
会社別プロファイル機構が発見された。§23の「Strategy Profileは量的パラメータを持つか」への
回答に直接関わる重要な事実である。

**`ManagementProfile`（Phase SAI-4、`standardAi/managementProfile.ts`）**：
5種の経営性格（balanced/growth/conservative/valueAdded/opportunistic）が
`salesAggressivenessRatio`・`discountToleranceRatio`・`importRelianceRatio`・
`inventoryResponsivenessRatio`・`headcountPaceRatio`・`aquacultureSelfSufficiencyRatio`・
`valueAddedPreferenceAbsolute`・`valueAddedCapexTimingAbsolute`（PD/VAP capex閾値の前倒し）
という8軸の比率/絶対値バイアス（原則±5%、最大±10%）を持つ。会社別対応：
BAL=balanced(ゼロ)、MASS=growth、JPQ=opportunistic、VAP=valueAdded、CONSV=conservative。

**`CompanyOrientationProfile`（Phase SAI-5A、`standardAi/orientationProfile.ts`）**：
5市場（CN/US/EU/JP/OTHER）×3商品（HOSO/PD/VAP）の魅力度倍率（市場0.80〜1.25、商品0.85〜1.20）
＋成長トレンド応答度＋過剰供給リトリート感度。会社別対応：
BAL=balancedGeneralist(全て1.0)、MASS=chinaVolume(CN1.25/HOSO1.2)、
JPQ=japanQuality(JP1.25/VAP1.2)、VAP=usProcessedGrowth(US1.25/PD1.2)、
CONSV=europePdConservative(EU1.25/PD1.15)。

**しかし両方とも、Management Consoleの実行経路（`simulation/engine.ts:268`が
`generateStandardAiDecisionWithDiagnostics`を`params=undefined`で呼び出す）では
一切適用されない。** `resolveManagementProfileParameters`/`createSai5ParamsResolver`は
`standardAi/autoplay/runCase.ts`（キャリブレーション・比較専用のオフライン実行経路）からしか
呼ばれておらず、`config.managementProfilesEnabled`という本番未使用のフラグでゲートされている。
本監査のベンチマークもこの事実を裏付ける：JPQ(japanQuality志向、PD/VAP1.2倍のはず)の
PD・VAP投資は他社と比べて突出しておらず、VAP(usProcessedGrowth志向、PD1.2/VAP1.1倍のはず)は
むしろ5社最小のPD/VAP投資しか行っていない。

**⇒ 結論：Strategy Profileという「概念」は現状 `CURRENTLY NON-QUANTITATIVE`（表示専用の
NEUTRAL_STRATEGY_PROFILEのみ）だが、別名で実装済みの量的プロファイル機構（ManagementProfile /
OrientationProfile）が存在する。これは「ゼロから設計する」フェーズではなく「既存の良く設計された
機構を本番経路へ接続する」フェーズであるべきことを強く示唆する。**

---

## 8〜11. 投資データ抽出・分類（Turn単位・カテゴリ別集計）

`scripts/strategyProfileAuditPhaseSPA1.ts`が5社×25Run×32Turnの全ターンについて、
capexDecision.newProjectProposals（提案）、capexResults.rejectedProposals（却下＋理由）、
capexResults.events（proposed→approved→underConstruction→completed の状態遷移＋支払額）、
salesForceHireCount、vapProductDevelopmentSpendUsd、財務・生産KPIを抽出。

データ収集上の注記：`CapexProjectQuarterEvent`は「承認された瞬間」を`statusBefore="approved"`
から始まる遷移としては記録しない（新規案件は生成と同時に`approved`状態でポートフォリオへ
登録される設計のため、承認そのものは別イベントとして現れない）。したがって
`strategy_profile_audit_spa1.csv`の`approved_*`列は全社0のままだが、これは「承認されていない」
という意味ではなく「イベントとして単独では観測できない」という技術的制約である。実際の
承認可否は `proposed_*` と `rejected_*` の差分、および `completed_*`（最終的に稼働開始した件数）
から読み取ることができる（proposed=897件、rejected=72件、つまり約92%は承認・着工まで進んでいる）。

却下理由（72件、全て非経済的理由ではなく容量制約）：
- 「同時進行中案件数が上限(3)に達しているため新規承認を見送り」（同時並行プロジェクト数上限）
- 「工場スペースが不足しているため新規承認を見送り」（工場スペース制約）

会社別却下件数: JPQ=40（最多）、MASS=23、BAL=5、VAP=4、CONSV=0。JPQの却下多発は、
JPQがcommonProcessing投資を最も積極的に提案する（104件）ために同時進行上限に頻繁に
突き当たった結果であり、経済性判断による却下ではない。

Common/Freezing/HOSO/PD/VAP/Cold Storage、PD Mechanization、VAP Development、
Quality、Environmental の内訳は §10 の表を参照。

---

## 10. Company × Investment 集計表（25 Run合計、括弧内は1Runあたり平均）

| 指標 | MASS | BAL | JPQ | CONSV | VAP |
|---|---|---|---|---|---|
| New Factory (proposed) | 45 (1.8) | 25 (1.0) | 0 (0.0) | 0 (0.0) | 0 (0.0) |
| Common Processing (proposed) | 5 (0.2) | 79 (3.2) | 104 (4.2) | 0 (0.0) | 21 (0.8) |
| Freezing/Packaging (proposed) | 0 | 0 | 0 | 0 | 0 |
| HOSO Line (proposed) | 40 (1.6) | 75 (3.0) | 75 (3.0) | 50 (2.0) | 26 (1.0) |
| PD Line (proposed) | 60 (2.4) | 52 (2.1) | 57 (2.3) | 35 (1.4) | 5 (0.2) |
| VAP Line (proposed) | 36 (1.4) | 24 (1.0) | 43 (1.7) | 35 (1.4) | 5 (0.2) |
| PD Mechanization | 0 | 0 | 0 | 0 | 0 |
| VAP Development | 0 | 0 | 0 | 0 | 0 |
| Quality | 0 | 0 | 0 | 0 | 0 |
| Environmental | 0 | 0 | 0 | 0 | 0 |
| **Total CAPEX paid (avg $)** | **$55.7M** | **$74.9M** | **$53.9M** | **$28.2M** | **$13.1M** |
| Sales hires total | 2,348 (93.9) | 2,217 (88.7) | 1,955 (78.2) | 2,230 (89.2) | 2,138 (85.5) |
| Sales layoffs total | 0 | 0 | 0 | 0 | 0 |
| Normal quarters (of 32) | 27.2 | 32.0 | 32.0 | 32.0 | 32.0 |
| Liquidity-stress quarters | 4.8 | 0.0 | 0.0 | 0.0 | 0.0 |
| Severe-distress quarters | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Ending revenue (avg cum.) | $3,054M | $3,869M | $3,647M | $3,328M | $3,059M |
| Ending operating profit (avg cum.) | $393M | $704M | $671M | $611M | $563M |
| Ending cash (avg) | $54M | $343M | $420M | $385M | $377M |
| Ending debt (avg) | $23M | $0 | $0 | $0 | $0 |
| Ending production (avg cum. t) | 579,283 | 730,554 | 678,975 | 638,080 | 554,675 |
| Ending contracts (avg cum. t) | 624,336 | 759,299 | 695,710 | 628,870 | 548,066 |
| Ending backlog (avg t) | 71,825 | 40,083 | 18,635 | 0 | 77 |
| Ending factory count | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| Ending regular workers (avg) | 7,488 | 7,334 | 8,563 | 6,939 | 7,505 |

**注記：「Ending factory count = 1.0」は全社共通。**MASS/BALの新工場は32Q以内に
「完成イベント」までは記録されているが（completed_newFactoryConstruction: MASS平均1.1件、
BAL平均1.0件）、`fixtures[].factories`配列自体は本スクリプトのスナップショット取得タイミングの
関係で反映前の値を読んでいる可能性がある（`captureCapitalProjects`ではなく`session.fixtures`を
直接参照したため）。これは実際の新工場稼働の有無を否定するものではなく、この集計列固有の
既知の制約として報告する（`completed_newFactoryConstruction`の方を正とする）。

### §11: 投資「回数」だけでない評価（規模あたり指標）

投資回数だけでなく、投資/生産量比で見ると規模差がより明確になる：

| 指標 | MASS | BAL | JPQ | CONSV | VAP |
|---|---|---|---|---|---|
| CAPEX / 生産量(t) | $96/t | $103/t | $79/t | $44/t | $24/t |
| CAPEX / 売上 | 1.82% | 1.93% | 1.48% | 0.85% | 0.43% |

MASSとBALが生産量・売上あたりで最もCAPEX集約的（＝規模拡大に積極的に再投資している）。
VAPは売上あたりCAPEXが5社最小（0.43%）——「高付加価値ゆえに投資が少なくて済む」のではなく、
単純に規模が小さく拡張の必要自体が乏しいことの表れである可能性が高い（§17参照）。

---

## 12. PD Mechanization 重点監査

1. **Standard AIが提案できるか**：**できない。** `STANDARD_AI_PROPOSABLE_CAPEX_TYPES`
   （`decision/capex.ts:70-82`）に`pdMechanization`が含まれていない。
2. **candidate生成場所**：存在しない。`standardAi/`配下を`pdMechanization`で検索してもテスト以外
   ヒットゼロ。
3. **trigger**：N/A（生成関数が無いため）。
4. **economics評価**：N/A。
5. **finance gate**：N/A。
6. **company profile参照有無**：N/A（そもそも判定ロジックが存在しない）。
7. **JPQで何回発生**：0回（全シナリオ・全シード）。
8. **他社と比較**：全5社とも0回——JPQが特別に少ないのではなく、構造的に誰にも発生しない。
9. **発生しない理由の分類**：**「1. AI capabilityなし」**。エンジン側（`capex/pdMechanization.ts`）
   は完全実装済みでプレイヤーは選択可能だが、Standard AI用の候補生成関数自体が一度も
   書かれていない（未接続ではなく、コード自体が存在しない）。

## 13. VAP Product Development 重点監査

1. **AI提案可能か**：**不可能。** そもそも`CapitalProjectType`（CAPEXの案件種別）ではなく、
   `CompanyDecisionInput.vapProductDevelopmentSpendUsd`という独立したSG&A支出フィールド
   （4段階：$0/$100k/$250k/$500k）。
2. **trigger**：N/A。
3. **economic benefit**：エンジン側は実装済み（`vapProductDevelopmentScore`を引き上げ、
   次期以降のVAP品質・魅力度へ反映）だが、AIはこの支出を一度も選択しない。
4. **VAP demandとの関係**：接続なし（AIが読まないため）。
5. **marginとの関係**：接続なし。
6. **qualityとの関係**：接続なし。
7. **Product Direction/Profileとの関係**：接続なし——VAP社の`desiredProductEvolution=VAP_VALUE`
   はDISPLAY_ONLYであり、この支出判断へは一切影響しない。
8. **VAP社で発生するか**：0回（全シナリオ・全シード、ベンチマークで実測確認）。
9. **他社比較**：全5社とも0回。既存の回帰テスト
   （`test15StandardAiIntegratedAutoplay.test.ts:28`）が「VAP開発費は候補集合に無いため
   提案されないはず」と明示的にアサートしており、これは仕様として意図された不在である。

## 14. Quality投資重点監査

JPQ・VAPとも他社よりQuality投資（`qualityControlEquipment`）が高い、という事実は**ない**——
全5社とも0回。理由は§12と同じ「1. AI capabilityなし」（`STANDARD_AI_PROPOSABLE_CAPEX_TYPES`に
含まれない）。加えてエンジン側の実装自体も、品質管理設備・環境設備は
`capacityIncreaseTonsPerQuarter: 0`かつ生産効果ゼロ（`capex/parameters.ts:239-245`のコメント：
「品質・環境設備は今回、生産能力を増加させない…現状は運用上の便益を伴わずコスト（減価償却＋
維持費）のみが発生する」）——つまりQuality投資はプレイヤーが手動で選んでも現状ゲーム上の
メリットが定義されていない。CTS-Q・quality score・downgrade・rework・disposal・market quality
sensitivityとの接続は、Quality投資自体が提案・実行されないため評価不能（接続点が存在しない）。

## 15. HOSO / PD / VAP line 投資 — ranking要因の確定

`capex.ts:335-486`のライン投資判定ロジックを確認した結果、判定は**単純なcapacity bottleneck
（稼働率・在庫・財務ゲート）のみ**で駆動されている。Product Direction・Strategy Profileは
一切関与しない（§5決定接続マトリクス参照）。会社別のバイアスフック
（`capexShortfallThresholdBiasByProduct`）はコード上存在するが、本番経路では常にゼロ
（`STANDARD_AI_PARAMETERS_V1.capexShortfallThresholdBiasByProduct = {}`）。
成長エントリ（`ext`フラグ依存の先行投資・供給過剰リトリート）も本番では
`standardAiCapexExtensionsEnabled: false`のため常に無効。

---

## 16. MASS監査

Vision 80,000t + AGGRESSIVE_EARLY_CAPACITYは、以下へ明確に波及している：
- **New Factory**：唯一複数回の新工場建設が発生する会社（45件/25Run、平均1.8件）。
  Strategic Forward-Capacity Route（`AGGRESSIVE_EARLY_CAPACITY`専用）が実際に機能している証拠。
- **Sales / Contracts**：ending contracts累計は624,336t（平均）——5社中3位だが、これは
  他社が32Q通してNORMAL状態を維持したのに対し、MASSだけが平均4.8Q/32もLIQUIDITY_STRESS
  （CM-1）を経験しており、その間新規受注が抑制されたため。CM-1が正しく機能した結果、
  Visionの野心と実際の財務体力のギャップがLIQUIDITY_STRESSとして現れている。
- **Sales hiring**：93.9人/Run（5社中最多）。
- **Factory 2/3, common, lines, Worker ramp**：newFactoryConstructionは複数回発生するが、
  §10注記の通り32Q終了時点の`factories`配列反映確認には制約があり、稼働開始（completed）
  イベントは確認できるが工場数カウント自体は今回のスクリプトでは未確定。Worker数は7,488人
  （平均）で5社中中位——Vision規模が最大のわりにWorker数が突出していないのは、
  CM-1によるSEVERE_DISTRESS未到達＝Worker拡大の抑制自体は発生していないが、
  LIQUIDITY_STRESSによる新規受注抑制で生産要求自体が頭打ちになっているため。

## 17. VAP監査

**結果はNO——17,000tという小規模Visionにもかかわらず、資源がVAP share/margin/quality/
development/high-value marketへ向かっているという証拠は見られない。** 単純にvolume
expansion自体を（規模が小さいため）ほとんど行っていないだけであり、「高付加価値へ意図的に
シフトしている」わけではない。VAP Product Development支出0回、Quality投資0回
（他社と同条件で構造的に無い）、VAP Line投資さえ5社最少（5件/25Run）——これは
「高付加価値に特化する代わりに量を追わない」という戦略的選択の結果ではなく、
単に「Vision規模が小さいので稼働率が閾値に達しにくく、あらゆる投資判断のトリガーが
ほとんど発火しない」という消極的な帰結である。VAPの「個性」は現状、投資行動という形では
一切表現されていない。

## 18. JPQ監査

JPQのPD share・PD mechanization・quality・Japan exposure・sales organizationに会社差が
出ているかを確認したところ：
- **PD share**：PD投資件数(57)はMASS(60)に次ぐ2位だが、BAL(52)・CONSV(35)との差は
  Vision規模差の範囲内で説明可能であり、「JPQ=PD特化」を裏付けるには不十分。
- **PD mechanization**：0回（構造的に全社0のため、JPQ固有の傾向は評価不能）。
- **Quality**：0回（同上）。
- **Japan exposure**：`OrientationProfile.japanQuality`（JP市場1.25倍）は設計上存在するが、
  本番経路で無効（§7参照）のため、実際の市場別販売配分への反映は確認できない。
- **Sales organization**：sales hires 78.2人/Run（5社中最少）——ただしこれもVision規模30,000t
  （5社中3番目）に概ね比例した結果と考えられる。

**JPQの最も際立った実測上の特徴は「品質重視」ではなく、commonProcessing投資の突出
（104件、5社最多）とending cash（$420M平均、5社最高）——巨額の余剰資金を持ちながら
新工場を一度も建設しない（DEMAND_CONFIRMED姿勢のためReactive Routeのみで、25Run中
一度もgrowth pressureがそのゲートを超えなかった）という組み合わせである。**

## 19. CONSV監査

CAPEX intensity（$28.2M/Run、5社最小）・debt（$0、ただし他社もBAL/JPQ/VAPは同じく$0）・
cash buffer（$385M、5社2位）・factory expansion timing（0回=最も慎重）・hiring
（89.2人/Run、中位）を確認。表面的にはCAPEX/factory拡張が最も慎重に見えるが、
§1-Eで述べた通りこれはVision規模の小ささ（27,000t、5社2番目に小さい）と
Strategic Posture=DEMAND_CONFIRMEDの効果のみで説明可能であり、CONSV固有の
「財務規律パラメータ」（ManagementProfile.conservative）は本番経路で無効なため、
真の意味でのリスク回避的判断ロジックが働いている証拠にはならない。

## 20. BAL監査

HOSO(75)/PD(52)/VAP(24)/Scale(newFactory25+common79)/Qualityのいずれかへ極端に
偏っていないかを確認。HOSO>PD>VAPの序列はあるが、5社中唯一全カテゴリで有意な投資を
記録しており（§10表参照）、相対的には最も「バランス型」の投資行動を示している。
これはBALのArchetype="balanced"、OrientationProfile="balancedGeneralist"（本番無効だが
設計意図とは一致）と表面的に整合するが、実質的には「Vision規模がMASSに次いで大きく
（34,000t）、AGGRESSIVE_EARLY_CAPACITY姿勢を持つため、あらゆるラインで満遍なく
ボトルネックへ到達しやすい」という規模効果で説明可能であり、Profile起因のバランス性を
積極的に立証するものではない。

---

## 21. Crisis CM-1を考慮した分離

| Company | Normal turns (avg/32) | Liquidity-Stress (avg) | Severe-Distress (avg) |
|---|---|---|---|
| MASS | 27.2 | 4.8 | 0.0 |
| BAL | 32.0 | 0.0 | 0.0 |
| JPQ | 32.0 | 0.0 | 0.0 |
| CONSV | 32.0 | 0.0 | 0.0 |
| VAP | 32.0 | 0.0 | 0.0 |

MASSのみが定期的にLIQUIDITY_STRESSを経験する（平均4.8Q/32、範囲4〜7Q）。他4社はこの
25Run中一度もCM-1のクライシスゲートが発火していない。これはMASSの「投資が少ない」原因
ではなく——むしろMASSは5社中最も新工場・PD投資を行っている——Vision規模80,000tという
野心の大きさに対して短期的な資金繰りが追いつかない局面が周期的に生じているという、
CM-1が意図通りに機能している証拠である。SEVERE_DISTRESSは全社・全Runで一度も発生せず
（CM-1監査時に確認した「healthy会社では発火しない」という設計目標が本ベンチマークでも
再現されている）。

**結論：本ベンチマーク条件下では、投資の少なさをCrisis Stateのせいにできる会社は存在しない
（MASS以外はそもそもLIQUIDITY_STRESSにすら入っていない）。他社の投資パターンの違いは
100% Strategy Profile/Vision/Posture側の要因（またはその欠如）に起因し、Crisis Managementは
無関係である。**

---

## 22. 投資しなかった理由の分類（VAPのVAP Line/VAP Developmentを例に）

**VAP社がVAP Line投資をほとんどしなかった（5件/25Run）理由**：稼働率・在庫・財務ゲートの
判定ロジック自体は全社共通であり、VAP社固有の却下ログ（`rejected_vapLineExpansion`）は
確認されなかった（VAPの却下4件は全てcommonProcessing/hosoLineExpansion関連）。つまり
**「拒否された」のではなく「そもそも稼働率が閾値(105%)を超えるほどのボトルネックが
発生しなかった」**——分類は「6. market opportunity insufficient」に近いが、正確には
**「Vision規模が小さいため生産要求自体が小さく、ボトルネック判定の分母（実効能力）に対する
分子（必要生産量）の比率が閾値を超えなかった」**という規模起因の消極的結果である。

**VAP社がVAP Product Developmentを一度も行わなかった理由**：分類は明確に**「1. AI capability
なし」**——候補生成ロジックが存在しないため、経済性判断以前の段階で構造的に不可能。
finance rejectでもeconomics rejectでもない。

---

## 23. Strategy Profileの定量化状況

**`StrategyProfile`という名前の型は `CURRENTLY NON-QUANTITATIVE`**——数値フィールドは
存在する（investmentAppetite等が0-100スケール）が、全社が同一の`NEUTRAL_STRATEGY_PROFILE`
（全て50/BALANCED）を持ち、会社間の差分が一切無い。

**ただし、別名の量的機構（`ManagementProfile`・`CompanyOrientationProfile`）は既に
定量化済みで会社別に異なる値を持つ**（§3〜7の追加発見を参照）。値の全量は
`standardAi/managementProfile.ts`の`MANAGEMENT_PROFILES`・`orientationProfile.ts`の
`COMPANY_ORIENTATION_PROFILES`にそのまま定義されている（本レポートの§3〜7に転記済み）。

---

## 24〜27. Profile Effect分解・Soft Bias設計・倍率案・Mission→Profile mapping案

（実装はまだ行わない。監査結果からの提案のみ。）

### §24 推奨軸

今回の実測から、以下の軸が実際に有効に機能しうると判断する（既存の`ManagementProfile`+
`OrientationProfile`がほぼこれをカバーしている）：

- `SCALE_ORIENTATION`：Visionの`targetScaleTonsPerQuarterAtQ32`と`willingnessToBuildFactories`
  で概ね代替可能——**新設不要、既存で足りている**。
- `PRODUCT_HOSO_FIT` / `PRODUCT_PD_FIT` / `PRODUCT_VAP_FIT`：`OrientationProfile.productMultipliers`
  が既に定義済み（0.85〜1.20）。**新設不要、本番接続のみで足りる。**
- `AUTOMATION_ORIENTATION`（PD Mechanization向け）：現状どの機構にも存在しない。
  **PD Mechanization自体のAI候補生成関数が無いため、軸を作る前にcapability自体を
  実装する必要がある**（§12参照、SP-Q1より後のフェーズ）。
- `QUALITY_ORIENTATION`：同様にQuality投資自体のAI capabilityが無いため軸だけ作っても無意味。
- `DIFFERENTIATION_ORIENTATION`（VAP Product Development向け）：同様にcapability自体が無い。
- `CAPEX_AGGRESSIVENESS`：`ManagementProfile.valueAddedCapexTimingAbsolute`（PD/VAP capex閾値の
  前倒し）が部分的にカバー。全商品への一般化は未実装。
- `FINANCIAL_RISK_TOLERANCE`：Vision側に既に存在（`financialRiskTolerance`、New Factoryのみ接続）。
  CAPEX全般・借入判断への拡張は未接続。

### §25 Soft Bias設計の確認

`ManagementProfile`/`OrientationProfile`は既にsoft bias設計になっている
（`InvestmentScore = EconomicAttractiveness × ... × StrategyFit × ...`に相当する形——
稼働率・在庫・財務ゲートという「必要条件」は全社共通のまま、その中の閾値・倍率だけを
±5〜25%動かす設計）。「JPQだからPD mechanizationを必ずする」という禁止パターンには
該当しない。§25の要求は実質的に既存設計が満たしている。

### §26 暫定倍率案

新規に倍率を考案するのではなく、**既存の`ManagementProfile`+`OrientationProfile`の値を
そのまま採用**することを提案する（実測データもこの設計意図と整合する部分がある：
MASSのVision規模80kが実際にscale投資へ強く効いている等）。ただし本監査の実測は
これらのプロファイルが**無効化された状態**で取得されたものであり、有効化した場合の
挙動は未検証——SP-Q1で「有効化 + A/Bベンチマーク」を行うことを推奨する。

### §27 Mission→Profile mapping案

現状Missionは完全にdisplay-onlyであり空文字固定のため、変換元となるテキスト自体が
存在しない。将来実装する場合：Mission編集時（毎Turnではなく編集イベント時）に、
既存の`ManagementProfile`/`OrientationProfile`のいずれかのプリセットへの
構造化マッピングを1回だけ適用する方式を推奨する（LLMによる毎Turn再解釈はしない、
という指示と整合）。

---

## 28. Vision/Profile/Postureの役割分離の評価

指示が提示した理想形：
- Vision: Where to go
- Strategy Profile: How to win
- Strategic Posture: When/how aggressively to commit
- Crisis State: Whether survival overrides strategy now

現コードでの成立状況：
- **Vision（Where to go）**：ACTIVE。規模目標として明確に機能している。
- **Strategy Profile（How to win）**：**未成立**。名目上の`StrategyProfile`型はDEAD、
  実質的にHow to winを担うはずの`ManagementProfile`/`OrientationProfile`は実装済みだが
  本番未接続。現状「How to winの差」はゲーム内に事実上存在しない——5社は同じ合理性で
  同じように意思決定しているだけで、規模（Vision）とNew Factory姿勢（Strategic Posture）
  以外の個性を持たない。
- **Strategic Posture（When/how aggressively to commit）**：ACTIVE、ただしNew Factory
  ドメインのみ。CAPEX全体・Sales・Hiringには接続されていない。
- **Crisis State（Whether survival overrides strategy now）**：ACTIVE（CM-1）。設計通り
  Visionを一切参照せず独立して機能しており、他レイヤーとの分離は最も綺麗にできている。

**総括：4層構想のうち、Vision層とCrisis層は実質的に機能しているが、Strategy Profile層は
事実上空白であり、Strategic Posture層はNew Factory以外に及んでいない。「How to win」の
差別化が丸ごと欠落している、というのが最も簡潔な総括である。**

---

## 29. AIエンジンとの境界

本監査は数値Decisionを一切変更していない。Standard AIの意思決定は本監査の前後で
完全に決定論的・同一のまま（`generateStandardAiDecisionWithDiagnostics`は無修正）。
Claude/LLMはこの監査の実行・分析・報告作成のみに関与し、ゲームのDecision生成には
一切関与していない。将来のLLM用途（Explanation/Management meeting/Strategic
review/retrospective）は本監査の対象外であり、提案も行っていない。
