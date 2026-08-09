# ShrimpX V2 — Vision 駆動の戦略成長と新工場建設判断

作成日: 2026-08-09 ／ 対象ブランチ: `feature/v2-32q-management-console`

---

## 1. このPhaseで何を変えたか

Standard AI に「この会社は、そもそもどんな会社になりたいのか」という**志（Vision）**を
外から与え、その志と現在地の差に反応して**新工場建設**を検討できるようにした。

これまでの Standard AI は「今期このラインが足りているか」という**戦術**しか持たず、
新工場（2,200万USD・建設3四半期・稼働まで4四半期）は
`STANDARD_AI_PROPOSABLE_CAPEX_TYPES` に含まれておらず、**構造的に一度も提案されなかった**。

### 役割分担（最重要）

| | 誰が決めるか | 何を決めるか |
|---|---|---|
| Vision | **人間の経営者** | 8年後にどんな会社になりたいか |
| Standard AI | 経営スタッフ | その志のもとで、今期の合理的な判断 |

Standard AI が自分で「8年後に売上を2倍にしたい」と発明することはない。
UI の文言もこの役割分担を明示している。

### Vision は quota ではない

`targetScaleTonsPerQuarterAtQ32` は aspiration であり、達成義務ではない。
ゲーム結果をこの数値へ強制する仕組みは実装に存在しない。**達成できないことはバグではない。**

---

## 2. 既定 Vision の校正（§4への対応）

当初案（MASS 70,000 / BAL 60,000 / JPQ 50,000〜55,000 / CONSV 45,000〜50,000 /
VAP 25,000〜35,000 t/四半期）を、現行の初期状態・需要と突き合わせて検証した。

### 実測（`scripts/visionBaselineCalibration.ts`、32Q baseline）

| 項目 | Q1 | Q32 |
|---|---:|---:|
| ベトナム5社が獲得対象にできた TRUE 需要 | 174,888 t/期 | 266,642 t/期 |
| 5社の合計成約 | 57,628 t/期 | 66,100 t/期 |
| 他産地等へ流れた量 | 117,260 t/期 | 200,542 t/期 |

| 会社 | 設備能力（3品目計） | Q1 生産 | Q32 生産 | 工場数 | Q32 現金 | Q32 負債 | 工場スペース残 |
|---|---:|---:|---:|---:|---:|---:|---:|
| BAL | 17,100 → 17,399 | 15,741 | 12,996 | 1 | 321.3M | 0 | 15,650 |
| MASS | 18,810 → 19,109 | 16,878 | 13,763 | 1 | 134.1M | 0 | 15,500 |
| JPQ | 17,955 | 13,311 | 13,197 | 1 | 291.0M | 0 | 16,650 |
| VAP | 17,100 | 11,219 | 12,728 | 1 | 227.0M | 0 | 16,500 |
| CONSV | 16,245 | 14,832 | 12,625 | 1 | 273.5M | 0 | 15,900 |

### 見つかった不整合

当初案の合計は 250,000〜270,000 t/四半期であり、これは **Q32時点で5社が獲得対象に
できる需要の総量（266,642t）とほぼ同じ**である。つまり「5社が世界の対ベトナム需要を
100%取り切る」ことを全社が同時に志す形になり、算術的に同時成立しない。
その状態では戦略ギャップが全社で恒常的に最大へ張り付き、Vision の違いが判断に出なくなる。

### 調整（会社間の比率は変えていない）

当初案の比率（70 : 60 : 52.5 : 47.5 : 30）をそのまま保ち、全体を **4/7 へ縮尺**した。

| 会社 | 当初案 | 採用値 | 成長意欲 | 目指す会社像 | 工場建設 | 財務リスク許容 |
|---|---:|---:|---|---|---|---|
| MASS | 70,000 | **40,000** | HIGH | LARGE_VOLUME | HIGH | HIGH |
| BAL | 60,000 | **34,000** | HIGH | LARGE_INTEGRATED | HIGH | MEDIUM |
| JPQ | 50,000〜55,000 | **30,000** | HIGH | QUALITY_SCALE | MEDIUM | MEDIUM |
| CONSV | 45,000〜50,000 | **27,000** | MEDIUM | LARGE_INTEGRATED | MEDIUM | LOW |
| VAP | 25,000〜35,000 | **17,000** | LOW | VALUE_SPECIALIST | LOW | MEDIUM |
| 合計 | 250,000〜270,000 | **148,000** | | | | |

148,000 t/期は Q32 TRUE需要の約55%、現在の5社合計成約の約2.2倍であり、
極めて野心的だが算術的には成立しうる。この水準でも MASS は現在能力 19,109t に対し
40,000t を志すため、既存工場内の増設だけでは届かず、新工場の検討が必然的に発生する
（＝新工場判断が「起きるが自明ではない」水準）。

---

## 3. Strategic Growth Layer

`app/lib/v2/companyLab/vision/strategicGrowth.ts`

```
strategicScaleGap = 参考成長軌道上の当期規模 − 現在の持続可能規模
growthPressure    = f(gap比率 × 成長意欲の感度)  → LOW / MODERATE / HIGH / URGENT
```

- 「現在の持続可能規模」は既存の `standardAi/targetScale.ts` の
  `currentSustainableScaleTons` をそのまま使う（新しい規模算定式を作っていない）。
- **未来の TRUE WORLD は引数に存在しない。** 将来の需要・価格・シナリオイベントを
  受け取れないシグネチャにしてある。
- 成長意欲の感度（HIGH 1.2 / MEDIUM 1.0 / LOW 0.7）は「未来予測の精度」ではなく
  「経営者の性格」を表す。同じ遅れでも VAP は焦らず、MASS は焦る。

---

## 4. 新工場の判断（`standardAi/decision/newFactory.ts`）

**単なる CAPEX type list への追加ではない。** 既存増設（戦術）とは独立した戦略評価を持つ。

### ゲート（すべて評価し、通ったものも落ちたものも記録する）

| # | ゲート | 落ちたときの理由コード |
|---|---|---|
| A | VISION_PRESENT — Vision が与えられているか | `NEW_FACTORY_NOT_NEEDED` |
| B | VISION_GROWTH_GAP — 志に対して遅れているか | `VISION_ON_TRACK` / `NEW_FACTORY_NOT_NEEDED` |
| C | GROWTH_PRESSURE — 志の強さ・工場への前向きさから見た段階 | `GROWTH_PRESSURE_LOW` / `NEW_FACTORY_MONITORING` |
| D | NO_PENDING_NEW_FACTORY — すでに建設中でないか | `NEW_FACTORY_MONITORING`（状態は APPROVED） |
| E | FACTORY_LIMIT — 工場数上限（4）に達していないか | `NEW_FACTORY_NOT_NEEDED` |
| F | EXISTING_SPACE_FIRST — 既存工場の増設余地を先に使う | `NEW_FACTORY_DEFERRED_EXISTING_SPACE` |
| G | EXISTING_EXPANSION_FIRST — 当期の既存増設の効果を先に見る | `NEW_FACTORY_DEFERRED_EXISTING_EXPANSION` |
| H | EXISTING_CAPACITY_IN_USE — 既存能力が実際に使われているか | `NEW_FACTORY_DEFERRED_MARKET` |
| I | DEMAND_PULL — 当期の生産必要量が能力に迫っているか | `NEW_FACTORY_DEFERRED_MARKET` |
| J | RAW_MATERIAL_SUPPORT — 前期の国内原料市場に余裕があるか | `NEW_FACTORY_DEFERRED_RAW` |
| K | LABOR_SUPPORT — 労働が逼迫していないか | `NEW_FACTORY_DEFERRED_LABOR` |
| L | FINANCIAL_FEASIBILITY — 資金・財務健全性 | `NEW_FACTORY_DEFERRED_FINANCE` |

全通過で `NEW_FACTORY_PROPOSED`。

### 重要な設計判断

- **既存増設優先だが、大きな gap では併走を許す。** 戦略ギャップ比率が 30% を超えたら、
  既存工場にスペースが残っていても新工場の検討を止めない
  （志が桁違いに大きいとき、既存増設だけを待つのは合理的でない）。
- **稼働率の分母は「商品別ライン合計」と「共通前処理」の小さい方。**
  共通前処理（25,650t）だけを分母にすると、商品別ライン合計（17,100t）がそれより
  小さい現在の工場設計では理論上の最大稼働率が 0.67 程度になり、どんな閾値にも
  算術的に到達できない（`decision/capex.ts` の Test16 修正と同じ落とし穴）。
- **「現金 > 投資額」だけでは通さない。** 必要現金は
  `最低現金バッファ + 投資額 × 財務リスク許容度別係数（HIGH 0.6 / MEDIUM 0.85 / LOW 1.1）`。
  加えて借入圧力 < 1 も要求する。
- **原料は「不明」を「安全」と読み替えない。** 前四半期の国内市場清算結果が観測できない
  turn では、原料を理由に肯定も否定もしない（そのことも記録に残る）。
- **`factoryCount = 3` のような決め打ちをしない。** 工場数・上限はすべて観測値
  （`observation.factoryCount` / `maxFactoriesPerCompany`）から読む。

---

## 5. 修正した既存の欠陥：建てた工場が Standard AI から見えなかった

`standardAi/observation.ts` は `fixture.factories` ＋ ライン増設ぶんの手計算だけを見ていた。
そのため **稼働開始した新工場（`newFactoryConstruction`）が Standard AI からは一切見えず**、
「建てたのに能力が増えていないと認識し続ける」状態になりえた。

能力算出を `capex/factoryConstruction.ts` の `computeEffectiveFactories`
（runner・simulation engine・AI Analysis Pack が使うのと同一の関数）へ統一した。
加算規則も HOSO 能力上限もエンジン本体と完全に同一になる。

あわせて観測へ追加した項目:
`factoryCount` / `maxFactoriesPerCompany` / `pendingNewFactoryProjectCount` /
`prospectiveFactoryCount` / `factorySpaceTotalUnits` / `factorySpaceUsedUnits` /
`factorySpaceRemainingUnits`。

§57 の事後監査に対応する回帰テストを `vision/__tests__/newFactoryVisibility.test.ts` に置いた。

- 稼働開始した新工場は観測に現れ、工場数と実効能力が増える
- 新工場はスペース総量を増やすが、既存工場の使用量には影響しない
- 建設中（未稼働）の新工場は能力へ一切先食いされない
- **新工場にワーカーは自動で付いてこない**（人員は別システムが管理する）

---

## 6. UI

| 場所 | 内容 | 既定 |
|---|---|---|
| Company Inspector | **Vision Card**（志・narrative・Q32規模・性格） | 常に表示 |
| Company Inspector | **Strategic Outlook**（参考規模／持続可能規模／ギャップ／成長圧力） | 常に表示 |
| Company Inspector | **Investment Thinking**（新工場の状態・止まったゲート・理由コード） | 折りたたみ |
| Console | Vision と成長圧力（5社サマリー） | 折りたたみ |
| `/v2/management/analysis/strategy` | 独立URL。Vision カード＋参考軌道vs持続可能規模チャート＋全32Qの判断表 | — |

既定画面は軽いままに保っている（Console 起動直後に情報を積み上げない）。
`?run=` / `?company=` を URL に持つため、会社別に別タブで同時に開ける。

---

## 7. AI Analysis Pack への追加

- `companies[].turns[].strategy` に Vision・参考成長軌道・戦略ギャップ・成長圧力・
  新工場の全ゲート評価を記録する。**提案しなかった四半期も必ず記録される。**
- Excel: `14c_Vision_Strategy` / `14d_New_Factory_Gates`
- Data Dictionary: Vision 関連6項目（quota ではないことを明記）
- reading guide: 「Vision は aspiration であり、達成できないことをバグとして報告するな」
- **PARTIAL RUN の明示（§45/§46）**: `run.isPartialRun` / `run.runCompletenessLabel` を追加し、
  Markdown 冒頭の警告ブロック・Excel の `00_Run_Summary` 先頭行・reading guide の
  3か所から一目で分かるようにした。途中実行も export できるが、残りの四半期は
  「ゼロ」ではなく「存在しない」ことを明示する。

保存物サイズ（32Q・5社・実測）: 3,576 KB（うち packCapture 682 KB）。
Pack 生成時間 1,966 ms、ZIP 1,398 KB。

---

## 8. 32Q ベンチマーク結果と ENVIRONMENT_CANDIDATE（§58）

`scripts/visionStrategyProbe.ts` で 32Q を回した結果、**5社とも新工場を一度も提案しなかった。**
ただしこれは機能が動いていないのではなく、各ターンの判断がすべて記録されている。

### 会社別の到達段階（代表値）

| 会社 | Q1〜6 | Q7〜18 | Q19〜32 |
|---|---|---|---|
| BAL | NOT_CONSIDERED（志より先行） | DEFERRED（既存スペース優先） | DEFERRED（稼働率／需要不足） |
| MASS | 同上 | 同上 | DEFERRED（稼働率 0.73〜0.74、閾値 0.75） |
| JPQ | 同上 | 同上 | DEFERRED（稼働率／需要不足） |
| VAP | NOT_CONSIDERED（志の軌道に乗っている。Q32まで一貫） | | |
| CONSV | 同上 | DEFERRED | DEFERRED（需要不足） |

Q32 時点の戦略ギャップは MASS 52.2% / BAL 48.8% / JPQ 40.2% / CONSV 39.8% / VAP −0.6%。
成長圧力は VAP を除く4社が URGENT に達している。

### ENVIRONMENT_CANDIDATE（#04向け。今回バランスは変更しない）

止まったゲートは一貫して **需要側**である。

- 既存能力の稼働率が 0.73〜0.78 にとどまり、閾値 0.75 前後を行き来している。
- 当期の生産必要量 ÷ 実効能力（demand pull）が 0.75〜0.82 で、閾値 0.95 に届かない。
- ベトナム5社が獲得対象にできる需要は 32Q で +52%（174,888 → 266,642 t/期）伸びているのに、
  5社の合計成約は 57,628 → 66,100 t/期（+15%）にとどまり、**シェアが 33% → 25% へ低下**している。
  伸びたぶんはすべて他産地へ流れている。
- 各社は Q32 に 134M〜321M USD の現金・**負債ゼロ**で終わる。財務は制約になっていない。

つまり現状の環境では、律速は生産能力ではなく**商業側（需要の獲得力）**である。
この状況で 20,520 t/期の新工場を建てるのは経営判断として不合理であり、
Standard AI が建てないのは正しい挙動である。

以下を #04 向けの環境候補として報告する（今回は一切変更していない）。

1. ベトナム5社の獲得シェアが 8年で単調に低下する構造（他産地の競争力・供給弾力性）
2. 営業人員が 60 → 111〜130 人へ増えても成約量が増えない（営業投入の限界生産性）
3. 生産量が 32Q を通じて減少傾向にあり、能力に対する稼働率が 0.75 前後で頭打ちになる

これらのいずれかが緩和されれば、新工場判断は同じロジックのまま自然に発火する
（ゲートは需要側で止まっているだけであり、財務・原料・労働・スペースの各ゲートは通っている）。

---

## 9. 将来拡張の受け皿

`NewFactoryStrategyParameters` と `StrategicGrowthParameters` は独立した定数として
外に出してある。将来 `PRODUCTIVITY_RND` / `PD_MECHANIZATION` / `VAP_AUTOMATION` /
`QUALITY_RND` / `PRODUCT_DEVELOPMENT` / `MARKETING_BRAND` を戦略投資候補として
追加する場合も、`decision/newFactory.ts` と同じ形（Vision → gap → 専用ゲート →
理由コード）で並べられる。今回はこれらのルール自体は一切実装していない。

`CompanyVisionDocument` は `effectiveFromTurn` を持つ履歴であり、
「Q1〜10 は高成長、Q11以降は保守的」といった将来のプレイヤー編集に対応できる。
`defaultVisionDocumentFor()` を差し替えるだけでよい。
