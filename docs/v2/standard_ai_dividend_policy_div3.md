# ShrimpX V2 — Standard AI配当ポリシー（Phase DIV-3）実装記録

対象ブランチ: `feature/v2-32q-management-console`
設計出典: `docs/v2/design/standard_ai_dividend_policy_div3_proposal.md` §4「案C＋案Bのハイブリッド」
前提: `docs/v2/dividend_shareholder_return_phase_div1_eval1.md`（DIV-1 / DIV-2 / EVAL-1 / TSV正式化）

## 1. 目的

DIV-1では「評価mechanic導入直後にAIが不適切な大量配当をするのを避ける」ため、
Standard AIの配当を`dividendDecision: undefined`固定（＝常に0）としていた。その結果、
TSV評価（Dividend Value年率15%複利＋Enterprise Value 10年10%DCF）において
「配当タイミングの最適化」というレバーがPlayerにしか存在しないという非対称性が残った。

DIV-3は、①AIも一定の配当を行い比較の土台を作る ②過度に強い配当AIにしない、の
2要請を両立させる最小の仕組みを実装する。

## 2. 実装したもの

### 2.1 基準配当ルール（提案書§3案B相当の安全側フィルタ）

`app/lib/v2/companyLab/standardAi/decision/dividend.ts`（新規）。
次の3条件を **すべて** 満たすTurnにだけ配当する。条件は全社完全に同一であり、
経営性格による差は一切付けない（安全ガードは全社同一という既存原則）。

1. 前Turnの`FinancialHealthStatus.primary === "healthy"`
   （`null`＝Turn1等の未確定は「healthyと確認できていない」ため配当しない）
2. 当期の新規設備投資提案（既存増設＋新工場、Crisis Gate適用後）が0件
3. 前Turnまでに確定した`distributableEarnings > 0`

配当額 = `distributableEarnings × dividendBasePayoutRatio`。
上限は必ずPlayerと同じ`finance/dividend.ts`の`computeMaxDividendUsd`
（`min(Cash, distributableEarnings)`）でクランプする。AI専用の上限式は作らない。

クランプを必ず通すのは、`resolveDividendDecision`が上限超過を「部分執行せず全額拒否」
する仕様のため。クランプしないと上限を僅かに超えただけで配当がまるごと消える不安定な
挙動になる。クランプにより、AIの配当は構造的に「拒否されない範囲でのみ実行される」。

診断コード（`reasonCodes.ts`へ追加、domain=`finance`）:
`DIVIDEND_PROPOSED` / `DIVIDEND_SKIPPED_NOT_HEALTHY` / `DIVIDEND_SKIPPED_CAPEX_PLANNED` /
`DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS` / `DIVIDEND_LIMITED_BY_MAX`。

### 2.2 経営性格バイアス（提案書§3案C相当）

`StandardAiParameters.dividendBasePayoutRatio`（新規）と、
`ManagementProfile.dividendPropensityRatio`（新規、既存の比率バイアスとまったく同じ
`applyRatio`／±5%・最大±10%の自動チェックを通る）を追加した。

| 会社 | プロファイル | dividendPropensityRatio | 意味 |
| --- | --- | --- | --- |
| BAL | balanced | 0 | 基準（バイアスなし） |
| MASS | growth | -0.05 | 再投資優先 |
| JPQ | opportunistic | 0 | 提案書が符号方向を示していないため置かない |
| VAP | valueAdded | -0.05 | PD/VAP能力への再投資優先 |
| CONSV | conservative | +0.05 | 投資へは慎重・稼いだ利益は株主へ配るCFO視点 |

このバイアスが動かせるのは配当額だけであり、発火条件そのものには一切影響しない。

### 2.3 会計・評価ロジックは無変更

`finance/dividend.ts`・`companyLab/evaluation/evaluationSemantics.ts`は
1行も変更していない。配当の実行・仕訳・拒否判定は、Playerとまったく同じ
`runner.ts` → `resolveDividendDecision` / `applyDividendToFinanceState` の経路を通る。

## 3. `dividendBasePayoutRatio`の初期値: 5%（提案書の初期候補15%を採らなかった）

提案書§5論点1は初期候補として15%を挙げ、「ベンチマークで調整」と明記している。
その調整を`scripts/tsvLeaderboardBenchmark.ts`（Benchmark 3〜5、出力は
`docs/v2/reports/tsv_leaderboard_benchmark_output.txt`）で実施した結果:

| ratio | CCI-9頑健性（4seed） | 備考 |
| --- | --- | --- |
| 0%（OFF） | 4/4 PASS | DIV-1と完全に同一の挙動 |
| 1% | 4/4 実質PASS | seed-aの最小現金 -0.00USD は丸め誤差レベル |
| 2% | 4/4 PASS | |
| **5%（採用）** | **4/4 PASS** | |
| 10% | 3/4 PASS | phase6c-regression: 生産0四半期12期・最小現金 -121.3M USD |
| 15% | 3/4 PASS | phase6c-regression: 生産0四半期14期・最小現金 -143.4M USD |

CCI-9は既存の頑健性回帰（`companyLab/vision/__tests__/commercialCommitmentIntegration.test.ts`、
「複数seedでも生産停止ゼロ・現金負ゼロ・在庫発散なし」）である。

### なぜ15%が「少額配当」にならないのか（設計側への確認事項）

`distributableEarnings`は四半期利益の **フロー** ではなく、game-start以降の累計利益から
配当実行分を引いた **ストック** である。そのストックの15%を、条件を満たす四半期のたびに
繰り返し取り崩すため、実質的には提案書が想定していた「少額配当」よりはるかに大きい
現金流出になる。5%という値はこの制約下での安全域であり、
「配当基準を累計ストックではなく当期フローに変えるべきか」は未決事項として残っている。

## 4. 支配戦略化していないか（提案書§5論点4・TSV正式化§24と同じ観点）

Turn32時点のTSVを、AI配当OFF（ratio=0）比の変化率で見ると
（`docs/v2/reports/tsv_leaderboard_benchmark_output.txt` Benchmark 4）:

| Company | 1% | 2% | 5% | 10% | 15% |
| --- | --- | --- | --- | --- | --- |
| BAL | +1.3% | -41.7% | -26.4% | +21.7% | +66.5% |
| MASS | -18.3% | -14.5% | -70.6% | -37.0% | -25.5% |
| JPQ | +1.0% | +4.2% | +7.5% | +13.2% | +2.3% |
| VAP | -16.0% | -19.9% | -14.5% | -0.8% | -2.1% |
| CONSV | +2.0% | +4.6% | +10.1% | +13.8% | +1.9% |

配当を増やすほどTSVが単調に上がるという関係にはなっておらず（会社によっては大幅な
マイナス）、「配当が常に最適解」という支配戦略にはなっていない。ただしこの非単調性は
シミュレーション自体の経路依存性も含むため、TSV評価そのものの妥当性の証明ではない。

## 5. 既存挙動への影響

- 配当が発火しないTurnは`dividendDecision: undefined`となり、DIV-1と完全に同一。
- `ratio=0`にすれば配当ポリシー全体がOFFになる（別フラグ・別分岐を作っていない）。
- 全社の資金推移が変わるため、Standard AIの投資タイミングは動く。`management-console-32q`
  seedでMASSの2工場目の稼働開始が Turn25 → Turn28、新設Factory IDが
  `MASS-NEWF-MASS-CAPEX-5` → `MASS-NEWF-MASS-CAPEX-4` へ変わった
  （`app/v2/company-lab/__tests__/newFactoryWorkforceRowDisplay.test.ts`の前提定数を
  実測値へ更新。CM-1・CE-3でも同じ理由で更新された経緯がある定数であり、この
  テストの目的はWorker入力欄の表示バグ固定でありターン自体の固定ではない）。

## 6. 未解決事項

1. **配当基準をストック（累計distributableEarnings）からフローへ変えるか**（§3参照）。
2. **発火頻度**: 現行ルールは32Turn中 概ね20〜25Turnで発火する（5社計で約100Turn/160）。
   「小さい額を高頻度」で配る形になっており、「時々配当する」という提案書§3案Bの
   想定とは質が異なる。ratioを下げても発火頻度は変わらない（頻度はゲート側が決める）。
3. **`dividendPropensityRatio`の効き幅**: ±5%は配当額を±5%動かすだけであり、5社の
   配当行動の差の大半はゲート（healthy期間・CAPEX提案の有無）の違いから生じている。
   ±10%制約の中では、このバイアス軸単独で大きな差は作れない。
4. **JPQ（opportunistic）の符号方向**: 提案書が明示していないため0のまま。
