# Standard AI Strategy Profile Quantification — Phase SP-Q1

branch `feature/v2-32q-management-console` @ HEAD（本フェーズ実装後）
前提HEAD `6306c59`（SP-A1監査完了時点）

## 目的

SP-A1監査で発見した既存の量的Profile機構（ManagementProfile / SAI-4、
CompanyOrientationProfile / SAI-5A）を、Management Console本番経路
（`simulation/engine.ts`）へ正式に接続し、PROFILE OFF vs PROFILE ON を
A/B実測した。新しいProfile値の考案・既存値のcalibrationは一切行っていない。

## 接続方式（SSoT）

- `CompanyLabConfig.standardAiProfileMode?: "OFF" | "ON"`（新規追加、未指定=OFF）
- `standardAi/orientationProfile.ts` の `resolveStandardAiProfileForMode(companyId, mode)` が
  唯一の解決入口。OFF（未指定含む）は `STANDARD_AI_PARAMETERS_V1` を**参照レベルで同一の
  オブジェクト**として返す（SPQ1-3で検証）。ONは既存の
  `resolveManagementProfileParameters` → `applyOrientationProfile` を順に適用する
  （createSai5ParamsResolverと同じ適用順・非干渉性）。
- `simulation/engine.ts` は会社ごとにこの解決結果を`generateStandardAiDecisionWithDiagnostics`の
  `params`引数へ渡す。バイアスが1件でも適用された場合は基準パラメータでの再評価
  （baselineDecision）も計算し、`StandardAiQuarterDiagnostics.managementProfile`
  （既存フィールド、SAI-4で用意されていたが今回まで未使用）へ記録する。
- `PackStrategy.profile`（新規）にmode・managementProfileId・orientationProfileId・
  appliedBiasItemsを記録（Analysis Pack）。
- `PROFILE_BIAS_APPLIED`理由コード（新規、domain="profile"）をAI Trace用に1件追記。
- Management Console `CompanyInspector` に読み取り専用の「Strategy Profile」カードを追加
  （mode=ONの時のみ表示、名前のみ、editor/toggleは無し）。

## Benchmark

5 scenarios × 5 seeds × 5 companies × 32Q × {OFF, ON} = 250 company-runs。
`scripts/strategyProfileQuantificationSPQ1.ts` で実行、
`docs/standard_ai/benchmarks/strategy_profile_spq1_{summary.md,company.csv,investments.csv,product_mix.csv}` へ出力。

## 主要結果（詳細は`strategy_profile_spq1_summary.md`参照）

### BAL（balanced + balancedGeneralist、ゼロバイアス想定）
全KPIでOFF≈ON（HOSO/PD/VAP構成比の差は±0.0pt、CAPEX-0.2%、crisis quarters 0→0）。
**これは意図通り**——balancedプロファイルは定義上バイアスゼロであり、ON/OFFがほぼ
恒等になることは実装の内部整合性を裏付ける強い検証結果である。

### JPQ（opportunistic + japanQuality）
HOSO -7.4pt、PD +3.9pt、VAP +3.6pt——§15仮説（PD比率上昇・PD line優先・
Japan/quality寄りcommercial mix）を方向として支持。Sales hiringが+47.3%
（78.2→115.2人）と最大級の増加——japanQuality志向の日本市場倍率(1.25倍)が
商業機会全体を押し上げた結果と考えられる。

### VAP（valueAdded + usProcessedGrowth）
HOSO -11.7pt（5社中最大の下げ幅）、PD +7.1pt、VAP +4.6pt——§16仮説
（volumeでなく高付加価値寄りになるか）を最も明確に支持する結果。
CAPEX総額+284.8%（$13.1M→$50.3M）、PD Line提案5→163件、VAP Line提案5→112件——
SP-A1で「投資しない会社」と報告したVAPが、Profile接続後は最も活発にPD/VAP
ラインへ投資する会社に転じた。

### CONSV（conservative + europePdConservative）
HOSO -8.3pt、PD +6.2pt——PD志向自体は方向として現れているが、§17仮説
（CAPEX intensity低下・慎重な成長）は**支持されない**：CAPEX総額はむしろ
+137.5%（$28.2M→$67.0M）に増加、PD Line提案35→190件・VAP Line提案35→110件と
急増した。原因はManagementProfile.conservativeがCAPEXしきい値自体を一切
バイアスしない設計（触るのは販売積極性・値引き許容度・在庫是正ペース・
人員調整ペースのみ）であるため、OrientationProfileのPD倍率(1.15)が
純粋に需要側を押し上げ、その結果ボトルネック判定が繰り返し発火した
ことによる。「財務保守性」と「PD/HOSO志向」は別軸であり、前者を反映する
バイアスフィールドが現状CAPEX判断には接続されていない、という構造的な
ギャップを示す実測結果。

### MASS（growth + chinaVolume）
§14仮説（scale志向強化・HOSO/PD volume型・investment早期化）は**支持されない**、
むしろ逆方向：CAPEX-24.8%、Sales hiring-14.0%、Ending cash-51.5%、
Crisis quarters 4.8→6.2（悪化）。chinaVolume志向は中国市場を1.25倍優遇する
一方、米欧日3市場を0.80〜0.85倍に割り引く設計であり、MASSの実際の市場構成が
中国へ十分集中していない場合、正味では商業機会が縮小する可能性がある。
加えてgrowthプロファイルの`importMixRatio+0.05`（輸入依存度上昇）が、
CM-1で既に確認済みの資金繰り周期的ストレスをやや悪化させた可能性がある
（Crisis quarters増加と整合）。5社中唯一、既存仮説と逆方向の結果が出た
ケースであり、次フェーズでの詳細調査が必要（§32remaining risksへ記載）。

## Effect sizeが大きすぎる/歪んでいる可能性のあるケース（§20）

VAP・CONSVのPD/VAP Line投資件数が22〜38倍（5→163件、5→112件、35→190件、
35→110件）に跳ね上がった。倍率自体は既存設計の範囲内（productOrientationMultipliers
0.85〜1.20）だが、`decision/capex.ts`のボトルネック判定が閾値型（shortfallRatio >
threshold）であるため、需要側のわずかな底上げが32Q×複数シナリオ・シードを通じて
繰り返し閾値を超え、投資「件数」としては非線形に大きな差になって現れている。
$ベースのCAPEX総額差（+137.5%〜+284.8%）はまだ許容範囲内だが、件数ベースの差は
今回**値を調整せず**、次フェーズ（Profile calibration検討時）向けの重要な観測事項として
報告する。

## Effect sizeが小さすぎるケース（§21）

該当なし。BAL（ゼロバイアス基準）を除く全社で、production mix・CAPEX・sales hiringの
いずれかに明確な変化（1pt〜38倍の範囲）が観測された。「profile consumerが弱い」
「downstream gateが支配的で効かない」という懸念は、少なくとも今回の5社では
該当しない。

## Crisis Gateとの関係（§11、SPQ1-7で検証）

Profile=ON（MASSのgrowthプロファイル、非ゼロバイアス確認済み）でも、
SEVERE_DISTRESS注入下では新規CAPEX提案0件・営業採用0人が維持されることを
統合テストで確認した。CM-1のCrisis GateはProfileの影響を受けない
（設計通り、Profileより優先度が高い階層として機能している）。

## regression（§27、最重要）

`resolveStandardAiProfileForMode(companyId, undefined)` および `"OFF"` は、
`STANDARD_AI_PARAMETERS_V1`を**同一オブジェクト参照**として返す（SPQ1-3で検証）。
これにより、`standardAiProfileMode`を指定しない全ての既存呼び出し元・既存テストは
実行前と数学的に同一のparamsを使い続ける。既存の全2959テスト（SP-A1時点）に
新規9件（SPQ1-1〜9）を加えた2968件が全てpassし、既存テストの結果は一切変化していない。
