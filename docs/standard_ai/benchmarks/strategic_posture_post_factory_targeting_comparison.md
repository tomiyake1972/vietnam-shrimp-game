# Standard AI Strategic Posture — Factory Targeting修正 Before/After比較

Before HEAD: `0a619ca`（複数工場CAPEX Targeting修正前・Phase H結果）
After HEAD: `4d952ee`（複数工場CAPEX Targeting修正後）

同一matrix（5 scenarios × 5 seeds × {BAL, MASS} × {AGGRESSIVE_EARLY_CAPACITY, DEMAND_CONFIRMED} = 100 runs, 50 pairs, seed `management-console-32q`系列を含む）で
`scripts/strategicPostureQuantBenchmark.ts` を再実行し、run-level CSVを行単位で突き合わせた。

## 結果: 100行中、変化した行は0件

比較したフィールド: `cumulativeOperatingProfitUsd`, `productionQ32`, `maxBacklogTons`,
`postFactoryUtilQ1`, `postFactoryUtilQ4`, `minimumCashUsd`, `peakDebtUsd`。

- `firstFactoryProposalTurn` / `decisionRoute` / `strategicLeadTurns`: 全行で修正前と完全一致（§25の期待どおり。Strategic Posture自体は今回変更していない）。
- 上記7つの財務・生産・稼働率フィールド: **全100行で修正前と完全一致（差分0）**。

## 原因（実測で確認済み。推測ではない）

BAL（baseline、seed=management-console-32q）の実際のCAPEX案件履歴を投資対象Factory込みで
トレースしたところ、Factory-specificなCAPEX案件（hoso/pd/vapライン増設・共通前処理増設）は
**すべてturn 2〜20の間に提案されており、新工場（BAL-F2、strategic routeでturn 25に提案・
turn 27〜29頃completed）が完成する前に完結していた**。turn 21以降、BALはF1・F2いずれに
対しても新規のFactory-specific CAPEXを一度も提案していない（新工場自体の建設案件を除く）。

つまり、今回のFactory Targeting修正（`targetFactoryId`を正しく解決してその対象Factoryへ
能力・スペースを適用する）は**正しく動作しているが、この100 runでは一度も「新工場へ
追加投資する」という提案自体が発生しなかったため、修正の効果を観測する機会が無かった**。
バグ自体は実在した（前回セッションのroot cause監査で確認済み）が、この特定のscenario/seed
matrixでは新工場完成後に二回目の増設判断が発生しないため、Phase Hのcumulative OP/稼働率
問題への寄与は今回**測定できなかった**。

## §41の結論: B（Factory targetingを直してもAGGRESSIVEのOP/稼働問題はほぼ残った）

Phase Hで観測された「AGGRESSIVEがOP面で一度も優位にならない」「新工場完成後の稼働率が
低下傾向」という結果は、**Factory Targeting不備が主因ではない**（そもそも今回のmatrixでは
新工場への追加投資が一度も試みられていないため、Factory Targetingバグが実害を及ぼす場面が
無かった）。

## 新たに確認された、より根本的な疑い（次のご判断のため報告のみ。今回は修正していない）

turn 21以降、BALが新工場（F2）に対して一度も追加のFactory-specific CAPEXを提案しない理由を
`decision/capex.ts`のゲート構造から確認したところ、投資要否を判定するボトルネック検知
（`isBottleneck`/`sustained`）が今も**会社全体で集計された`observation.totalEffectiveCapacityByProduct`
等**を分母に使っている（`selectTargetFactoryId`は「投資すると決めた後にどのFactoryへ置くか」
だけを解決し、「そもそも投資するかどうか」の判定には関与しない設計にした。今回の指示§18でも
明示的に「戦略ロジックは変更しない」とされていたため意図した範囲内）。そのため、F1+F2の
会社全体の実効能力が志・需要に対して足りていれば、F2単体が低稼働・未活用でも新規投資は
一切トリガーされない。これは「新工場を建てたのに追加投資で育てられない」という、Phase Hで
観測された稼働率低下傾向の、より説明力のある候補原因である可能性がある。

Phase Iの検討候補（今回は一切変更していない）:
- ボトルネック検知自体をFactory単位に分解する（observation.factoriesのper-factoryデータは
  既に存在するため、新しい計測は不要。判定式の分母をどう扱うかの設計判断が必要）。
- または、新工場完成後に限定した「Activation投資」の別ゲートを追加する。

いずれも「何に投資するか」の戦略ロジック変更にあたるため、今回のFactory Targeting修正の
範囲外として、指示どおり実施していない。
