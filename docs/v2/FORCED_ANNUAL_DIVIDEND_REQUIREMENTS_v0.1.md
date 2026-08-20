# 強制配当性向（Forced Annual Dividend Payout Ratio）要求仕様 v0.1

- 起案: #08 Scenario & Balance Control
- 状態: **要求仕様。実装前。** #04 / #05 / #07 の担当間合意を待つ。
- 対象branch: `feature/v2-dynamic-scenario-3`
- 今回の運転資金融資感応度テストでは**実装しない**。

---

## 0. この文書の位置づけ

本書は #08 が提示する要求仕様であり、設計・実装は #04（Engine・Finance）、
#05（Standard AI）、#07（UI・Management Console）へ引き渡す。
承認前に独自実装しないこと。

以前に #08 が事前報告で示した以下の案は **誤りであり撤回する**。

- 配当額 = 直近確定四半期の当期純利益 × 配当性向 → 誤り
- 支払可能額へクランプして「配当条件を達成した」と扱う → 誤り
- 強制モードでも Standard AI の既存 Q4 判定経路をそのまま流用する → 不十分

---

## 1. 配当性向の定義（最重要）

配当性向 50% とは、**その事業年度の税引後利益の 50% を配当する**という意味である。

### 使用しない算定方法

- 直近1四半期の当期純利益 × 50%
- Q4 意思決定時点の直近4四半期利益 × 50%
- ローリング4四半期利益 × 50%

### 正しい算定基礎

そのゲーム内事業年度に属する Q1〜Q4 の税引後利益合計。

```
annualNetIncomeUsd =
    Q1 netIncome + Q2 netIncome + Q3 netIncome + Q4 netIncome

requiredAnnualDividendUsd =
    max(0, annualNetIncomeUsd) × fixedAnnualPayoutRatio
```

### 例

| 四半期 | 税引後利益 |
| --- | --- |
| Q1 | 20M |
| Q2 | 30M |
| Q3 | 10M |
| Q4 | 40M |
| 年間 | 100M |

固定配当性向 50% → 必要年間配当額 = **50M**。

Q4 利益 40M だけに 50% を掛けて 20M とする実装は誤りである。

### 「税引後利益」の実体

`FinancialResult.profitAndLoss.netIncome`（= `profitBeforeTax − incomeTax`）。
`operatingProfit` や Cash Flow で代用してはならない。

---

## 2. 事業年度と実行タイミング

ゲーム内 Period は Turn 1 = 2015Q1（`scenarioEngine.ts` の `turnToPeriod`）。
したがって事業年度は暦年と一致し、Turn 4 / 8 / 12 / 16 / 20 / 24 / 28 / 32 が
各年度末（Q4）である。

### 処理順序

1. Q4 の通常営業処理を実行
2. Q4 の営業利益・金利・税金・当期純利益を確定
3. 当該年度 Q1〜Q4 の税引後利益を合計
4. 必要年間配当額を算定
5. **Q4 決算処理の最後に**強制配当を実行
6. 配当後の Cash / Retained Earnings / Total Equity を **Q4 末 B/S へ反映**

---

## 3. 既存実装との構造的な衝突（#04 の要判断事項）

現行 `companyLab/runner.ts`（Phase DIV-1 §4 / §8 / §9）は、配当を
**Turn の先頭**で、**前 Turn までに確定した** `CompanyFinanceState`
（`rawPrevFinance`）に対して解決している。

```ts
const dividendResolution = resolveDividendDecision(decision.dividendDecision, rawPrevFinance);
const prevFinance = applyDividendToFinanceState(rawPrevFinance, dividendResolution.appliedUsd);
```

これは「配当した Cash はその Turn の経営に使えなくなる」（調達能力低下・
CAPEX 余力低下・借入必要額増加）を既存の与信・調達ロジックへ自然に伝播させる
ための意図的な設計である。

本要求仕様の §2 は「Q4 決算処理の**最後**に実行し、Q4 末 B/S へ反映」であり、
この既存順序と直接衝突する。**単一の配当適用点を移動させてはならない**
（FREE モードの既存挙動が変わるため）。

必要なのは、`closeQuarterWithFinancing` の**後**に置く第2の配当適用点である。

- FREE モード: 現行の Turn 先頭の経路をそのまま使う（挙動不変）
- FIXED_ANNUAL_PAYOUT_RATIO モード: Q1〜Q3 は配当なし。Q4 決算確定後に
  強制配当を適用し、Q4 末 B/S へ反映する

この配置であれば、B/S 帰属は年度末（仕様どおり）となり、かつ Cash が減る
効果は翌 Q1 の期首現金へ及ぶため、運転資金へのトレードオフも保たれる。

---

## 4. モードと設定

```ts
// CompanyLabConfig（app/lib/v2/companyLab/types.ts）へ optional で追加
readonly dividendPolicy?: {
  readonly mode: "FREE" | "FIXED_ANNUAL_PAYOUT_RATIO";
  /** mode === "FIXED_ANNUAL_PAYOUT_RATIO" のときのみ必須。0.0〜1.0。 */
  readonly fixedAnnualPayoutRatio?: number;
};
```

- 既定値: `FREE`
- 適用対象: **Player を含む全5社**
- 設定未指定 run・既存 run は `FREE` として現行挙動を維持する

### 固定モード中の不変条件

- Q1〜Q3 には配当しない
- Q4 決算後に年間配当を自動算定する
- 経営性格（ManagementProfile）による ±5% 補正を行わない
- CAPEX 提案を理由に配当を停止しない
- Player または Standard AI の任意判断で減額・中止できない
- 配当のためだけの自動借入は行わない
- `fixedAnnualPayoutRatio` は 0.0〜1.0

---

## 5. 資金・分配可能利益が不足する場合

`requiredAnnualDividendUsd` は**減額しない**。これは「株主に支払うべき配当額」である。

```
requiredAnnualDividendUsd     = max(0, annualNetIncomeUsd) × payoutRatio
actualPaidDividendUsd         = 実際に支払えた配当額
mandatoryDividendShortfallUsd = requiredAnnualDividendUsd − actualPaidDividendUsd
```

不足時に、単純に支払可能額へクランプして「固定配当条件を達成した」と扱っては
ならない。現行 `computeMaxDividendUsd`（= `max(0, min(cash, distributableEarnings))`）
への無条件クランプは、この要求では使えない。

### 会計処理（#04 が比較・推奨すること）

| 案 | 内容 |
| --- | --- |
| 案A | 未払配当として負債計上し、翌期以降に支払う |
| 案B | 支払可能額だけ支払い、未達額を強制配当条件違反として記録する |
| 案C | 支払不能を payment default または財務制限条項違反として扱う |

#04 は既存の B/S・配当・延滞・default 処理との整合性を調査し、推奨案を提示すること。
**承認前に独自実装しないこと。**

調査時に必ず確認すべき既存資産:

- `app/lib/v2/finance/dividend.ts`
  （`computeMaxDividendUsd` / `resolveDividendDecision` / `applyDividendToFinanceState`）
  現行は「上限超過なら部分執行せず全額拒否」。案B/案Cはこの分岐と衝突しうる。
- `app/lib/v2/finance/types.ts` の `payables` / `otherLiabilities`
  （案A の未払配当をどこへ計上するか）
- `app/lib/v2/financing/types.ts` の `FinancialHealthStatus`
  （`paymentArrears` / `paymentDefault` / `covenantBreach`。案Cはここへ接続する）
- `app/lib/v2/financing/parameters.ts` の `covenant`
  （`minEquityRatio 0.15` / `maxDebtToAssetsRatio 0.85`。強制配当は自己資本を
  直接削るため、covenant 違反を誘発しうる）

---

## 6. 監査ログ・画面表示（最低要件）

- 対象年度
- 年度 Q1〜Q4 税引後利益（4四半期それぞれ）
- 年間税後利益
- 設定配当性向
- 必要年間配当額
- 実際支払額
- 未払／未達額
- 配当条件 達成／未達
- 配当後 Cash
- 配当後 Retained Earnings
- 配当後 Total Equity

---

## 7. Standard AI への要求（#05）

Standard AI は、Q4 決算時の強制配当を**事前に見込んで** CAPEX・原料調達・借入・
Cash reserve を判断する必要がある。ただし、**配当支払いだけを目的とする自動借入は
行わない**。

現行 `standardAi/decision/dividend.ts`（Phase DIV-4）は
「直近確定四半期の純利益 × `dividendBasePayoutRatio`・年1回・CAPEX 提案があれば無配・
性格バイアス ±5%・上限クランプ」であり、固定モードでは**この経路を通さない**。
固定モードでは Standard AI は配当額を決めない（額は決算から機械的に決まる）。
Standard AI の責務は、年度内の資金計画にその額を織り込むことに変わる。

---

## 8. 未決事項（担当間合意が必要）

1. §5 の 案A / 案B / 案C の選択（#04）
2. Game End が Q4 以外の Turn で発生した場合の期中年度の扱い
   （END-1〜END-4。強制配当を行うか、按分するか、行わないか）
3. TSV（Total Shareholder Value）への影響。
   `getDividendTimeWeight` による時間加重配当価値が評価式に入っているため、
   強制配当は TSV 順位を構造的に変える（#04 / #07）
4. Player の配当入力欄の扱い（固定モード中は読み取り専用にするか）（#07）
5. `validateCompanyLabConfig`（`companyLab/persistence/schema.ts`）は allowlist 方式。
   `dividendPolicy` の登録漏れは Redis 往復で**無言で脱落**する
   （SAI-5B の `standardAiProfileMode` で同じ事故の実績あり）。
   JSON 往復テストを必ず1件追加すること（#07 / #04）
