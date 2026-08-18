# ShrimpX V2 — Standard AI配当ポリシー（Phase DIV-3 / DIV-4）実装記録

対象ブランチ: `feature/v2-32q-management-console`
設計出典: `docs/v2/design/standard_ai_dividend_policy_div3_proposal.md`（DIV-3）／
DIV-4実装指示「Flow-Based Annual Dividend Policy」
前提: `docs/v2/dividend_shareholder_return_phase_div1_eval1.md`（DIV-1 / DIV-2 / EVAL-1 / TSV正式化）

## 1. 目的と経緯

DIV-1ではStandard AIの配当を`dividendDecision: undefined`固定（＝常に0）としていたため、
TSV評価における「配当タイミングの最適化」というレバーがPlayerにしか存在しなかった。

- **DIV-3**（commit `3d86f4d`）: 安全ゲート・`computeMaxDividendUsd` clamp・Playerと同一の
  runner経路・diagnostics・profile biasアーキテクチャ・benchmark harnessを実装。
  ただし配当額を `distributableEarnings（累計利益stock）× payoutRatio` で算定していた。
- **DIV-4**（本記録）: 上記の骨格は維持したまま、**配当額の算定baseを当期純利益（flow）へ変更**し、
  **配当頻度を年1回（年度末Q4のみ）へ変更**した。

DIV-3の算定方式は「過去利益を毎四半期一定割合ずつ繰り返し取り崩す」挙動になり、
period payout policyの基準として正しくなかった（ratio=10%以上で会社の運転資金が
枯渇することをベンチマークで実測）。DIV-4はこれを設計レベルで解消する。

## 2. DIV-4の仕様

### 2.1 配当額の算定（flow基準）

```
baseDividendUsd = max(0, currentQuarterNetIncomeUsd) × effectivePayoutRatio
appliedUsd      = min(baseDividendUsd, computeMaxDividendUsd(financeState))
```

`distributableEarnings`は **配当額の算定baseではなく、配当可能額の上限** としてのみ働く
（`computeMaxDividendUsd = min(Cash, distributableEarnings)` 経由）。

### 2.2 当期純利益のsingle source

`CompanyOwnState.lastFinancialResult.profitAndLoss.netIncome`（新規フィールド）。
runner.tsが既に確定させ`state.history`へ保存済みの`CompanyFinancialQuarterResult`を
1件そのまま渡すだけで、独自のNet Income計算はしない。Operating Profit・Cash Flowで
代用もしない。

**"current quarter"の意味**: Turn Nの意思決定時点でTurn Nの損益は未確定である
（DIV-1の「当Turn利益の先取り配当はできない」）。したがってStandard AIが参照できる
当期純利益は直近確定四半期（Q4に判断する場合は同年Q3）のNet Incomeであり、
診断には実際に参照した四半期（`netIncomeSourcePeriod`）を必ず残している。

### 2.3 年1回の配当判定

既存の`PeriodV2`表現（`core/period.ts`の`toYearQuarter`）だけを使い、`quarter === 4`を
決定論的に判定する。`lastDividendTurn`等の新規stateは一切追加していない。
Q1〜Q3は無条件で`DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD`になるため、
「Q4で見送った年度の配当が翌Q1へ繰り越されて即実行される」ことは構造的に起こらない。

### 2.4 最終Dividend Gate

| # | Gate | 診断コード（不成立時） |
| --- | --- | --- |
| A | 年度末（Q4）であること | `DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD` |
| B | `financialHealth.primary === "healthy"`（`null`＝未確定は不成立） | `DIVIDEND_SKIPPED_NOT_HEALTHY` |
| C | Crisis State が `NORMAL` | `DIVIDEND_SKIPPED_CRISIS` |
| D | 当期の新規CAPEX提案 = 0（Crisis Gate適用後） | `DIVIDEND_SKIPPED_CAPEX_PLANNED` |
| E | 直近確定四半期の当期純利益 > 0 | `DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS` |
| F | `distributableEarnings` > 0 | `DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS` |
| G | `computeMaxDividendUsd` > 0 | `DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS` |

成立時は`DIVIDEND_PROPOSED`。クランプ時は`DIVIDEND_LIMITED_BY_MAX`、うち
分配可能利益が上限を決めた場合は`DIVIDEND_LIMITED_BY_DISTRIBUTABLE_EARNINGS`も併記する。

### 2.5 Player配当ロジックは非変更

`finance/dividend.ts`・`resolveDividendDecision`・`evaluationSemantics.ts`等の
Player/game-common側は一切変更していない。「Standard AIは年1回」と
「ゲームルール上は毎Turn配当入力可能」は別レイヤーであり、テスト`DIV-FLOW-12`で
この分離を固定している。

### 2.6 Management Profile bias（DIV-3から不変）

| 会社 | プロファイル | dividendPropensityRatio |
| --- | --- | --- |
| BAL | balanced | 0 |
| MASS | growth | -0.05 |
| JPQ | opportunistic | 0（根拠なく符号を追加しない） |
| VAP | valueAdded | -0.05 |
| CONSV | conservative | +0.05 |

## 3. payout ratio スイープ（Benchmark 3・4、seed=`div3-ai-dividend-001`）

Turn32時点のTSVを、AI配当OFF（ratio=0）比の変化率で見たもの。

| Company | 5% | 10% | 15% | 20% | 25% |
| --- | --- | --- | --- | --- | --- |
| BAL | +0.2% | +0.1% | +0.3% | -0.5% | -0.9% |
| MASS | -0.7% | +16.7% | +16.1% | +1.6% | -1.6% |
| JPQ | +0.3% | +0.4% | +0.7% | +1.2% | +1.5% |
| VAP | +0.5% | -23.0% | -22.7% | -22.3% | -22.0% |
| CONSV | +0.1% | +0.1% | +0.2% | +0.3% | +0.4% |

**支配戦略化していない**: payout ratioに対しTSVが単調増加したのは5社中1社（JPQ、
しかも最大+1.5%）のみ。BALは高ratioでマイナス、VAPは-22%台、MASSは非単調である。
配当有利／再投資有利が会社によって分かれており、実装指示§12の望ましい状態にある。

**配当頻度**（5社×8年度＝理論上限40回）:

| ratio | 配当発火回数 | 累計配当(5社計) | CAPEX完了 | 生産0四半期 | distress四半期 |
| --- | --- | --- | --- | --- | --- |
| 0% | 0 | 0.00M | 49件 | 0 | 4 |
| 5% | 23 | 17.06M | 49件 | 0 | 4 |
| 10% | 25 | 36.27M | 47件 | 0 | 4 |
| **15%（採用）** | **24** | **52.29M** | 47件 | 0 | 4 |
| 20% | 25 | 73.47M | 47件 | 0 | 4 |
| 25% | 24 | 89.15M | 47件 | 0 | 4 |

各社あたり年8回のうち4〜6回の配当であり、実装指示§13の想定どおりDIV-3の
「32Turn中20〜25回発火」状態は解消された。

## 4. seed頑健性（Benchmark 5・既存CCI-9と同一条件）

| ratio | 4seedの結果 |
| --- | --- |
| 0% / 5% / 10% / **15%** / 20% | 4/4 PASS |
| 25% | 3/4 PASS + 1件が最小現金 -0.00USD（丸め誤差レベル。実額の資金枯渇ではない） |

DIV-3で15%が引き起こしていた `phase6c-regression` の崩壊（生産0四半期14期・
最小現金 -143.4M USD）は完全に解消した。

## 5. 既存挙動への影響

- 配当が発火しないTurnは`dividendDecision: undefined`となり、DIV-1と完全に同一。
- `ratio=0`にすれば配当ポリシー全体がOFFになる（別フラグ・別分岐を作っていない）。
- **DIV-3で更新した`newFactoryWorkforceRowDisplay.test.ts`の前提定数を、DIV-3以前の値へ
  差し戻した。** DIV-3では累計利益の取り崩しでMASSの資金推移が大きく変わり、
  新工場の稼働開始が Turn25→Turn28、Factory IDが`MASS-NEWF-MASS-CAPEX-5`→`-4`へ
  ずれていた。DIV-4のflow基準・年1回配当では配当額が小さく、実測で
  Turn25・`MASS-NEWF-MASS-CAPEX-5`という **DIV-3導入前とまったく同じ値** に戻ったため、
  テストを元の内容へ復元した（この差し戻しにより、DIV-3で行った既存regressionの
  書き換えは残っていない）。

## 6. 残存リスク・未解決事項

1. **VAPのTSVが10%以上で約-22%へ落ちる。** 単調ではなく10%で階段状に落ちて以降ほぼ
   横ばいであり、配当額そのものの大きさ（VAPの累計配当は5〜13M USD）では説明が
   つかない。年度末の配当が特定Turnの投資判断ゲート（現金水準）を跨がせ、CAPEX完了が
   11→10件へ減った経路依存的な影響と考えられる。単一seedの観測であり、
   複数seedでの追加確認を推奨する。
2. **`dividendPropensityRatio`の効き幅**は依然として小さい（±5%は配当額を±5%動かす
   のみ）。5社の配当行動の差の大半は、実装指示§8が期待するとおり
   CAPEX頻度・financial health・profitabilityの違いから自然に生じている
   （例: CAPEX完了6件のCONSVは安定して年4回配当、CAPEX完了11件のBALも4回）。
3. **"current quarter" が直近確定四半期（Q3）であること**は、DIV-1の
   「当Turn利益の先取り配当はできない」制約から不可避だが、
   「年度末に、その年度Q4の利益を配る」という直感とは1四半期ずれている。
   年度合計利益（過去4四半期のNI合計）を基準にする案は、指示§2の
   `currentQuarterNetIncomeUsd` という定義から外れるため採用していない。
4. **JPQ（opportunistic）の符号方向**は指示§7どおり0のまま。
