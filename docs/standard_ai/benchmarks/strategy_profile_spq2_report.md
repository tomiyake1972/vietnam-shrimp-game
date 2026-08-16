# Standard AI Strategy Profile Calibration — Phase SP-Q2

branch `feature/v2-32q-management-console` @ HEAD（本フェーズ実装後）
前提HEAD `1432a01`（SP-Q1完了時点）

## 目的

SP-Q1のPROFILE ON実測で発見した4件の未解決事項を、値の調整より先に**原因確定**を行い、
確定した原因のみを対象に最小限のcalibrationを行った。

- A. `standardAiProfileMode`のSave/Resume persistence欠落
- B. MASS PROFILE ON逆方向結果の厳密なroot cause
- C. VAP/CONSVのCAPEX提案件数急増の厳密なmechanism
- D. CONSVの「財務保守性」がCAPEX判断へ未接続の構造的ギャップ

---

## A. Persistence修正

**根本原因**：`simulation/persistence/resume.ts`の`restoreSessionFromResumePayload`が、
`SimulationSession`のトップレベル`config`を`run.scenarioId/seed/requestedTurns`だけから
再構築しており、`visionOverrides`・`standardAiProfileMode`が黙って失われていた。
**これはSP-Q2で新規に作った不具合ではなく、visionOverridesについても以前から存在していた
既存のバグ**（`session.state.config`側はengine.tsの意思決定ループが読むため実際のゲーム
挙動には影響しなかったが、`session.config`側は`applyVisionOverrideToSession`等の書き込み
系関数が参照する設計であり、resume直後にトップレベルconfigだけが古いままなのは潜在的な
不整合だった）。

**修正**：`resumePayload.state.config`（`trimStateForResume`が一切変更しないフィールド）を
単一の情報源として、トップレベル`config`を再構築するよう変更。`resumePayload.state`が
欠落した壊れたペイロードに対する既存の「アクセス時に初めて例外になる」設計
（SAVE-10で検証済み）を壊さないよう、`resumePayload.state?.config?.X`とoptional chaining
で読む。

## B. Resume test

SPQ2-PERSIST-1〜5（`standardAiProfileModePersistenceSPQ2.test.ts`、全5件pass）：
ON保存→resume→ON、OFF保存→resume→OFF、legacy Run（未指定）→resume→undefined維持、
visionOverridesとの共存、既存resumePayload構造の非破壊、を確認。既存のSAVE-1〜10・
PERSIST-1〜15（`simulationResume.test.ts`等）も全件pass、回帰なし。

## C-D. MASS first divergence Turn / field

**Turn**：baseline/seed-1でTurn10（軽微な差）〜Turn12（明確な分岐）。
**field**：`domesticPurchaseQuantity`（国内買付実績）が、ON側でTurn12にゼロへ落ち込む
（OFF=5,520t、ON=0t）。これに連動して`procurementConstraint.scaleRatio`がON側で0.679→0.000
へ張り付き、production（生産実績）がOFF側の半分以下（hoso: OFF 6,616t→ON 3,074t）に
崩れ、以降Turn13でSEVERE_DISTRESSへ突入。OFF側はTurn19まで一貫してhealthyのまま。
（詳細な全Turn比較ログ: `scripts/spq2MassTurnByTurn.ts baseline seed-1 importMix`の出力）

## E. MASS root cause

`scripts/spq2MassAblation.ts`でMASSのgrowth×chinaVolumeを8軸へ分解しablation実行した結果：

| variant | cash($M) delta | OP($M) delta | crisisQ delta |
|---|---|---|---|
| A: marketOrientation単独 | +70.6% | -9.6% | +1 |
| B: productOrientation単独 | -21.1% | +7.9% | -2 |
| **C: importMixRatio単独** | **-500.8%** | **-192.6%** | **+20** |
| D: salesAggressiveness単独 | -7.6% | +1.4% | 0 |
| E: discountTolerance単独 | 0% | 0% | 0 |
| F: headcountPace単独 | -19.6% | -2.0% | 0 |
| ON（全軸結合） | -312.4% | -164.6% | +17 |

**importMixRatio単独が崩壊のほぼ全てを再現する**一方、他の軸（市場/商品志向・販売積極性・
値引き許容度・人員ペース）は穏やかで、むしろ一部プラスの効果すらある。

## F. chinaVolume contribution

**軽微〜中立**。市場志向単独（A）はcash+70.6%・OP-9.6%と、むしろ良化する場合が多い
（中国市場への再配分自体は破壊的ではない）。商品志向単独（B）もOP+7.9%とプラス。
SP-Q1で観測されたHOSO構成比の上昇（+2pt程度）は商品志向の設計通りの効果であり、
崩壊の原因ではない。

## G. ManagementProfile contribution

**importRelianceRatio（輸入依存度+5%）が支配的な単一要因**。他のManagementProfile軸
（salesAggressivenessRatio・discountToleranceRatio・headcountPaceRatio）は個別にも
結合時にも穏やかな効果に留まる。importMixRatioの微小な変化（0.15→0.1575、+0.75pt）が、
CM-1監査で既知の`domesticPurchaseCashAllocationRatio`由来のboom-bust cycle（健全な会社
でも正常に発生する周期的なscaleRatio変動）の中で、たまたま国内買付がゼロに近づく
タイミングと重なり、自己強化型の崩壊（一度procurementConstraint.scaleRatioが0に
張り付くと、Standard AIの調達意思そのものはCM-1により意図的に減らされないため
—「調達意思は据え置き」という設計—、財務が回復しない限り抜け出せない）へ倒れることを
確認した。

## H. MASS calibration変更

**変更した**：`ManagementProfile.growth.importRelianceRatio` を `0.05` → `0` へ変更（撤去）。

- before: `importRelianceRatio: 0.05`（importMixRatio 0.15→0.1575）
- after: フィールド自体を削除（`ZERO_PROFILE_BIASES`の`0`のまま）
- reason: 上記E-Gの通り、単一で崩壊のほぼ全てを再現する要因であり、Financeのしきい値・
  boom-bust周期自体（指示§29で変更禁止）には一切触れずに解消できる、最も的を絞った修正。
- effect size（baseline/seed-1、importMixRatioバイアスのみ除去したフルON構成）：
  cash $-76.3M→$19.9M、OP $-195.3M→$294.4M（ほぼOFF基準の$302.0Mに回復）、
  capex $0M→$34M、sales hires 0→113（OFF基準と同一）、crisisQ 23→4（OFF基準6より少ない）。

## I. VAP CAPEX amplification root cause

**「重複提案」「rejectedの再提案ループ」ではない。** 実測（`strategy_profile_spq2_investments.csv`）：
VAP pdLineExpansion ON: proposed=163, **rejected=0**, completed=149。vapLineExpansion ON:
proposed=113, rejected=0, completed=100。全25 run（5 scenario × 5 seed）で件数はほぼ一様
（PD 6〜7件/run、VAP 4〜5件/run）——erraticな重複や却下ループの痕跡は無い。

**真の原因は統計的錯覚**：OFF基準がほぼゼロ（PD 0.2件/run、VAP 0.2件/run、SP-A1監査で
確認済みの「VAPはほぼ投資しない会社」という実態）だったため、ON化による絶対的には
穏当な増加（0.2→6.5件/run、0.2→4.5件/run）が、%表記では「22〜32倍」という劇的な数字に
見えていただけである。$ベースのCAPEX増加（+284.8%〜+285.3%）も同じ理由で、絶対額は
$13.1M→$50.3Mと、5社中もっとも投資額の小さい会社が中位程度になっただけ。

## J. CONSV CAPEX amplification root cause

同じく統計的錯覚が主要因（OFF基準が1.4件/run→ON 7.6件/run）。ただしCONSVはVAPと異なり
**却下が一定数発生している**：pdLineExpansion ON: proposed=190, rejected=18 (9.5%),
completed=171。vapLineExpansion ON: proposed=106, rejected=12 (11.3%), completed=80。
却下理由は「同時進行中案件数が上限(3)に達しているため」「工場スペースが不足しているため」
であり、経済性・財務による却下ではない（SP-A1監査時と同じ理由）。9〜11%程度の却下率は
パイプライン制約が正常に機能している範囲であり、バグではない。

## K. duplicate proposals有無

**無い。** I・Jの実測（rejectedカウントの分離）により、"proposed"件数の大部分が"completed"
（VAP: 149/163=91%、106中100/113=88%、CONSV: 171/190=90%、80/106=75%）まで到達しており、
「何度も同じ案件を出しては却下される」というループパターンは確認されなかった。

## L. threshold amplification定量

I・Jの通り、非線形増幅・閾値の異常な感度増幅は確認されなかった。件数の変化は
productOrientationMultipliers（0.85〜1.20の小幅倍率）が需要側を穏やかに動かし、
それがOFF基準の極端な低さ（ほぼゼロ）と組み合わさって相対的に大きく見えていた、
という単純な算術の帰結であることを確認した。

## M. CAPEX bias適用位置

既存の`capexShortfallThresholdBiasByProduct`（PD/VAP限定・「前倒し」方向、valueAddedのみ
使用）とは別に、`capexCurrentShortfallRatioThreshold`（HOSO/PD/VAP全ライン＋Common
Processingが共通で読む基準しきい値）へ比率バイアスを掛ける方式を採用した
（新設フィールド`capexHurdleBiasRatio`、§N参照）。既存のcandidate生成ロジック
（`decision/capex.ts`）自体は一切変更していない——`params.capexCurrentShortfallRatioThreshold`
という既存の入力値を、Profile解決層（`managementProfile.ts`）側で微調整しているだけ。

## N. CONSV conservatism wiring

**既存ManagementProfileに接続先が無いことを確認した（指示§16の監査結果）**：
`conservative`プロファイルの既存フィールド（salesAggressivenessRatio・
discountToleranceRatio・importRelianceRatio・inventoryResponsivenessRatio・
headcountPaceRatio・aquacultureSelfSufficiencyRatio）はいずれもCAPEX投資判断の
しきい値には触れていなかった。`capexShortfallThresholdBiasByProduct`
（valueAdded専用）は「PD/VAP限定・前倒し方向」という異なる意味であり転用不可。

指示§17に基づき、最小の新フィールド`capexHurdleBiasRatio`を`ManagementProfile`へ追加した：
- 意味：`capexCurrentShortfallRatioThreshold`（HOSO/PD/VAP/Common全ての投資判断が読む
  唯一の基準しきい値）への比率バイアス。正の値ほどしきい値が上がり投資が発動しにくくなる。
- 適用範囲：`conservative`のみ`+0.05`（他4プロファイルは`0`のまま、`MAX_BIAS_RATIO`
  ±10%の範囲内）。
- Finance側（現金バッファ・借入健全性しきい値・銀行審査ゲート）は一切変更していない
  （指示§18のFinance Gate不可侵）。既存のcandidate生成ロジック・安全ガード
  （cashAndBorrowingSafe等）も無変更。
- 単体検証：hurdle=0（未接続）で$65.6M・vapCount=4・commonCount=2 →
  hurdle=0.05で$57.2M（-13%）・vapCount=2（-50%）・commonCount=0（-100%）——
  実際に投資頻度を下げる方向へ働くことを確認済み。

## O. 新field追加有無

**追加した**：`ManagementProfile.capexHurdleBiasRatio: number`（比率バイアス、
`±MAX_BIAS_RATIO=0.10`の既存許容範囲内、`conservative`のみ`0.05`を設定）。
既存の`capexShortfallThresholdBiasByProduct`（PD/VAP限定・前倒し方向）とは
適用対象・方向とも異なり、意味の重複はない。

## P. Profile value changes（変更一覧）

| Profile | Field | Before | After | Reason | Effect size |
|---|---|---|---|---|---|
| growth (MASS) | importRelianceRatio | 0.05 | **0**（撤去） | procurement/finance boom-bust cycleとの連鎖的崩壊のroot cause（単独で再現、他軸は穏やか） | baseline/seed-1: OP $-195.3M→$294.4M、crisisQ 23→4（32Q平均: OP -19.1%→-3.2%、crisisQ 4.8→6.2から4.8→4.2へ） |
| conservative (CONSV) | capexHurdleBiasRatio（新設） | 0（存在せず） | **0.05** | CAPEX投資判断への財務保守性の接続先が既存フィールドに無かった構造的ギャップ | 単体検証: CAPEX $65.6M→$57.2M(-13%)、vapLineExpansion 4→2件(-50%) |

他のProfile値（BAL/JPQ/VAPの全フィールド、MASS/CONSVの他フィールド）は変更していない。

---

## 32Qベンチマーク再実行（250 company-runs、post-calibration）

`scripts/strategyProfileCalibrationSPQ2.ts`。5 scenarios × 5 seeds × 5 companies × 32Q ×
{OFF, ON}。全出力は`docs/standard_ai/benchmarks/strategy_profile_spq2_{summary.md,
company.csv, investments.csv, product_mix.csv}`。

### Q. MASS OFF/ON after

HOSO production share: 57.3%→59.3%(+2.1pt、量産志向は健在)。CAPEX -21.4%
（calibration前-24.8%とほぼ同水準——importMixRatio単独の寄与は小さく、他軸の穏やかな
効果が主）。**Sales hires -12.4%(前回-14.0%とほぼ同水準)。OP -3.2%（前回-19.1%から
大幅改善）。Cash -30.2%（前回-51.5%から改善）。Crisis quarters 4.2（前回6.2から改善、
かつOFF基準4.8よりも少ない）。**

### R. BAL OFF/ON after

全KPIでOFF≈ON（HOSO±0.0pt、CAPEX-0.1%、crisisQ 0→0）、calibration前と実質変化なし。
ゼロバイアスプロファイルのcontrol性は維持されている。

### S. JPQ OFF/ON after

HOSO -7.4pt、PD +3.8pt、VAP +3.6pt、Sales hires +47.0%。calibration前
（-7.4pt/+3.9pt/+3.6pt/+47.3%）とほぼ完全に一致——JPQはSP-Q2の変更対象外であり、
方向性は無傷で維持されている。

### T. VAP OFF/ON after

HOSO -11.7pt、PD +7.1pt、VAP +4.6pt、CAPEX +285.3%。calibration前
（-11.7pt/+7.1pt/+4.6pt/+284.8%）とほぼ完全一致。VAP自体の値は変更していないため、
方向性・強度とも維持。件数の大きい%表記は統計的錯覚（§I参照）であり、実際の投資行動
（proposed→completed 91%到達、rejected=0）は健全。

### U. CONSV OFF/ON after

HOSO -8.3pt、PD +6.2pt、CAPEX +137.2%（capexHurdleBiasRatio導入前+137.5%からほぼ不変）。
**§25の成功条件（CAPEX intensityが慎重型と整合すること）は32Q平均では未達成のまま**——
単体検証（§N）ではhurdle=0.05が-13%の効果を示したが、25シナリオ×シード平均では
productOrientationMultipliers（PD1.15倍）由来の需要増効果の方が圧倒的に大きく、
+5%のhurdleでは相殺しきれていない。この点は正直に未解決として報告する（§remaining risks参照）。

### V. product mix（HOSO/PD/VAP）

MASS/JPQ/CONSV/VAPともcalibration前とほぼ同一の方向性・強度を維持（§Q・S・T・U参照）。
BALは引き続き中立。

### W. market mix

`strategy_profile_spq2_product_mix.csv`にはproduction/sales desiredの商品別内訳のみを
含み、市場別（CN/US/EU/JP/OTHER）内訳は今回のCSVには含めていない（既存のSP-Q1と同じ
スコープ、今回新設していない）。市場志向自体の効果はablation監査（§E variant A）で
個別に確認済み（MASSでcash+70.6%・OP-9.6%、破壊的ではないことを確認）。

### X. CAPEX proposal/start/completion counts

`strategy_profile_spq2_investments.csv`にproposedCount/rejectedCount/completedCountを
分離して記録した（指示§28）。VAP/CONSVの詳細は§I・J参照。

### Y. OP

MASS -3.2%（前回-19.1%から大幅改善）。BAL +0.3%。JPQ -3.2%。CONSV +0.5%。VAP +1.6%。
5社中MASSのみ軽度のマイナスだが、CM-1のLIQUIDITY_STRESS由来の新規受注抑制という
既知の正当な効果であり、破滅的な崩壊ではない。

### Z. Cash/Debt

MASS cash -30.2%（前回-51.5%から改善）。他4社はcash±12%以内。debtは全社$0のまま
（MASSのみ非ゼロ、$23.4M→$45.4M程度の増加——CM-1由来の一時的な借入増でOFF基準でも
発生する現象の範囲内）。

### AA. Crisis

MASS: liquidity+severe合計 4.8Q(OFF)→4.2Q(ON)、**calibration後はONの方がOFFより
少ない**（importRelianceRatio撤去の直接効果）。他4社は0Qのまま変化なし。

---

## BB. Analysis Pack resume確認

SPQ2-PERSIST-4（`standardAiProfileModePersistenceSPQ2.test.ts`）で、`PackStrategy.profile`
（mode/managementProfileId/orientationProfileId/appliedBiasItems）自体はresume処理
（`restoreSessionFromResumePayload`）が`packCompanyTurns`をpackCaptureからそのまま
復元する設計のため、resumeの前後で値は変化しない（既存設計のまま）。今回の修正対象は
`session.config`/`session.state.config`の`standardAiProfileMode`であり、これは次Turn以降の
Profile解決（`resolveStandardAiProfileForMode`の呼び出し元）に使われる値である
（過去Turnの記録済みPackStrategyを書き換えるものではない）。SPQ2-PERSIST-1で
resume後も`standardAiProfileMode`が正しく引き継がれ、次Turn以降も同じProfileが
継続して適用されることを確認した。

## tests

新規11件（SPQ2-PERSIST-1〜5 + SPQ2-6〜11）全pass。既存2968件（SP-Q1時点）と合わせて
**2979/2979 pass**（回帰ゼロ）。

## tsc / eslint

`npx tsc --noEmit`: clean。`npx eslint`: 既存11件の無関係warningのみ（0 errors）。

## 推奨次Phase

SP-Q2の結果は分岐**A寄り**（既存Profileだけで会社差は概ね十分）に近いが、CONSVの
CAPEX intensityだけは分岐**B**（方向は正しいが弱い）に該当する。次フェーズ候補：

1. **CONSVのcapexHurdleBiasRatio再calibration**（今回0.05→さらに引き上げるか、
   あるいはproductOrientationMultipliers.pd自体をやや弱めるか、の二択を#05・三宅さんと
   協議のうえ決定）。
2. その後、指示の想定通り**Capability Expansion Phase**（PD Mechanization・
   VAP Product Development・Quality investment のStandard AI接続）へ進むのが妥当
   （SP-A1・SP-Q1・SP-Q2を通じて、既存Profile機構は「商品/市場志向」レベルでは
   十分機能することが実証されたため、次の差別化はcapability自体の拡張が効果的）。

## remaining risks

1. **CONSVのCAPEX intensity「慎重型」整合は未達成のまま**。capexHurdleBiasRatio=0.05では
   productOrientationMultipliers由来の需要増効果を相殺しきれない（32Q平均+137.2%）。
   MAX_BIAS_RATIO=0.10まで引き上げる余地はあるが、単体検証でhurdle=0.05と0.10が
   同一結果だった（baseline/seed-1では既に飽和）ため、より大きな値でも全シナリオ平均が
   十分下がるとは限らない。#04/#05との協議のうえ次フェーズで再検討が必要。
2. **MASSの市場別（CN/US/EU/JP/OTHER）内訳を今回のCSVに含めていない**。市場志向の
   contribution（§E variant A）はablation監査で個別確認済みだが、32Qベンチマークの
   product_mix.csvには反映していない。
3. **`standardAiProfileMode`はServer authoritative save/resumeの完全な統合テスト
   （実際のAPI経路・Redis経路）までは検証していない**。単体テスト（SPQ2-PERSIST-1〜5）は
   `buildResumePayload`/`restoreSessionFromResumePayload`とJSON往復のみを対象にしており、
   `app/v2/management/lib/persistRun.ts`・APIルート経由の統合テストは既存のSAVE-*/PERSIST-*
   テスト群でカバーされている範囲に留まる（新規のE2Eテストは追加していない）。
4. **importRelianceRatio撤去がFinance側の未解決課題（procurementConstraint.scaleRatio=0
   からの回復経路の有無）を修正するものではない**。CM-1監査時に#04へ送付済みの
   Finance設計課題は依然として未解決のまま（今回はMASSがその崖に近づく確率を
   下げただけで、崖自体は残っている）。
