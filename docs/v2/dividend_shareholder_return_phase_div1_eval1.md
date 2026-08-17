# ShrimpX V2 — 配当（Dividend）と株主還元評価の基盤（Phase DIV-1 / DIV-2 / EVAL-1）

対象ブランチ: `feature/v2-32q-management-console`

## 目的

単純な「累積利益ランキング」から一歩進み、「稼ぐ → 再投資する → 財務を守る →
株主へ還元する → 会社価値を保つ」という資本配分ゲームの土台を作る。今回の
Phaseで完成させるのは配当メカニクスと評価基盤のみであり、株主価値の正式な
算定式（Current Shareholder Value）はまだ決定していない。

## DIV-1: 配当の意思決定・会計反映・履歴

- `app/lib/v2/finance/dividend.ts` — 配当エンジン本体（純粋関数群）。
  - `computeMaxDividendUsd`: `min(Cash, distributableEarnings)`。
  - `resolveDividendDecision`: 要求額の検証（0円可・全額拒否方式・構造的誤用のみ例外）。
  - `applyDividendToFinanceState`: Cash・distributableEarnings・retainedEarningsを同額減算。P&Lは一切変更しない。
  - `getDividendTimeWeight` / `computeWeightedDividendValueUsd`: 32Turn想定の段階係数（T1-8=1.5/T9-16=1.3/T17-24=1.15/T25-32=1.0）。`scenarioLength`引数でTurn数に依存しない設計。
  - `buildDividendQuarterResult`: 履歴レコード（累積配当・累積加重配当価値）を構築。
- `CompanyFinanceState.distributableEarnings`（新フィールド）: ゲーム開始後に稼いだ利益だけを積み上げる。既存の`retainedEarnings`（初期残差を含む大きな値になりうる）とは別管理とすることで、ゲーム開始直後に初期剰余金を配当してしまう問題を回避。
- `runner.ts`: 各社の`prevFinance`を配当反映後の値へ差し替えてから、その四半期の調達・資金調達計算へ渡す。これにより配当は「その四半期の資金繰りを実際に圧迫する」形で反映される（別立てのCash調整をしない）。
- Standard AIの配当は今回 常に0（`dividendDecision: undefined`）。AI配当ポリシーの設計は次Phaseへ明示的に持ち越し。

## DIV-1 UI: Player Finance（配当入力）

`DecisionEditor.tsx`に「株主還元（配当）」セクションを追加（Finance/Decisionタブ内、3画面共通コンポーネント経由でManagement Console PLAYER Workspace・Company Lab単体画面・Redis版Company Lab playルートすべてに反映）。表示項目: 前期確定分配可能利益・現在Cash・配当可能上限・配当入力・配当後Cash見込み・累積配当・累積加重配当価値・時間加重係数。上限超過時はソフト警告（送信はブロックしない。エンジン側が全額拒否する仕様と整合）。

## DIV-2: 他社への配当公開

`PublicDividendSummary.tsx`（新規）: 当期配当・累積配当・累積加重配当価値のみを他社に公開する（Cash・借入枠・CAPEX計画は同画面に一切含まれない）。PLAYER Workspace（Marketタブ）とGM Management Console（新規Collapsibleセクション）の両方に配置。

## EVAL-1: 任意Turn評価サービスの基盤

`app/lib/v2/companyLab/evaluation/evaluationSemantics.ts`（新規）:

- `computeCompanyKpiSnapshot(history, companyId, asOfTurn)`: 累積営業利益・累積売上高・累積販売数量・平均営業利益率・現金・借入残高・売上/利益成長率（暫定定義）・財務不健全Turn数・累積配当を、既存の`CompanyQuarterRecord`履歴（`financialResults`/`financingResults`/`companySummaries`/`dividendResults`）から集計する純粋関数。新しい永続化状態は追加しない。
- `computeCompanyEvaluationSnapshot`: 上記KPI＋加重累積配当価値（`dividendResults`の確定値をそのまま読む、再計算しない）＋Current/Total Shareholder Valueの暫定プレースホルダー（`shareholderValueModelVersion: "pending-v1"`、`totalShareholderValueStatus: "not_finalized"`）。
- **Turn数非依存**: `asOfTurn`以下のTurnだけを集計するため、Runが16Turnで終わっても32Turn走っても同じ関数・同じ結果になる（テストで、同一Turnの評価がその後何Turn続いたかに関わらず一致することを確認済み）。
- GM Management Consoleに読み取り専用プレビューパネル（`EvaluationSummaryPanel.tsx`）を追加。「今このTurnで終了したら」という体で表示するのみで、実際にRunを終了させるミューテーションは実装していない（`SimulationRun`の版管理された永続化スキーマへの変更が必要になるため、今回はサービス層の基盤のみとし、UIは意図的に読み取り専用に留めた）。

## 保存互換性

- `CompanyFinanceState.distributableEarnings`: 深いバリデーションを行う`schema.ts`側で `undefined → 0` のデフォルト補完を追加（companyLab/persistence・persistence両方）。
- `CompanyDecisionInput.dividendDecision` / `CompanyQuarterRecord.dividendResults`: 既存の浅いバリデーション（必須キー存在チェックのみ）にそのまま乗るため、追加のスキーマ変更は不要。
- `evaluationSnapshot`は永続化していない（EVAL-1では毎回履歴から計算するプレビューのみ）。

## 未実装・次Phaseへの持ち越し

- Current Shareholder Valueの正式な算定式（EVAL-2）。
- Standard AIの本格的な配当ポリシー（DIV-3相当）。
- 「End Game」を実際に実行するミューテーション（SimulationRunの状態遷移・確認ダイアログ）。
- Awards（表彰）の正式スコア化。
