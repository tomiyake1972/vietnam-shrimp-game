# ShrimpX V2 — CURRENT INTEGRATION 2026-08-18

## Branch / HEAD
- Integration branch: `integration/v2-current-20260818`
- Base: `origin/feature/v2-game-end-final-results` @ `087c441`
- Merged: `origin/feature/v2-32q-management-console` @ `3abf982`（conflict 0件）

## Included commits（baseに無く今回入ったもの）
- `3d86f4d` DIV-3: Standard AI配当ポリシー
- `3abf982` DIV-4: Flow-Based Annual Dividend Policy（最終仕様）
- `f8795cf` AI Meeting M2.5/M2.6/M2.7 を simulation-runs 経路へ配線

base側に既に含まれていたもの: ds1系43commit（DS1/DS2/Decision Studio/Procurement/
Scenario News/Save-Resume/AI Analysis Pack）、AMM M2.1〜M2.7、DIV-1/DIV-2、EVAL-1、
TSV正式化、`59d9f8a` AI Meeting両architecture再接続、`087c441` Game End/Final Results。

## Included features
- Dynamic Scenario 1 / 2、Scenario News
- Decision Studio 7タブ、Procurement Planning
- AI Management Meeting M2.1〜M2.7（**Player経路で全て有効**）
- Standard AI 配当 DIV-4（年度末Q4のみ・当期純利益×payout・healthy/Crisis/CAPEX gate）
- Player 配当 DIV-1/DIV-2、TSV評価（tsv-dcf-v1）
- Game End / Final Results、Databook / AI Analysis Pack download
- Save / Resume

## Known issues
- `npm run build` は既知の `STAGING_KV_REST_API_URL` 未設定でpage data収集時に停止。
  変更前HEAD(`087c441`)でも同一エラーを確認済み（本統合起因ではない）。
- M2.8: 独立commitが存在せず受入記録も特定できないため `ACCEPTANCE UNKNOWN`。
  本統合の停止理由にはしない。
- Databook 正式受入commit: 特定できず `ACCEPTANCE UNKNOWN`。実装・download経路は存在。
- Opening Brief UI は simulation-runs 経路のみ配線（Company Lab経路はAPIのみで従来どおり）。

## 追加修正（統合後）
- `621db2a` / `620ebec` hotfix: Opening Executive Brief を必ず日本語で生成（fallback文言も共有定数化）
- `c192673` fix(INT-NA): Turn 8 の `Usd金額が有限の数値ではありません: NaN` 停止を修正
  - 原因: DIV-1導入前に保存されたRunのstateには `financeState.companies[].distributableEarnings`
    が無く、`restoreSessionFromResumePayload` が保存payloadのstateをそのまま返していたため
    `undefined` のままエンジンへ渡っていた。DIV-4がQ4（Turn 8）で
    `computeMaxDividendUsd = max(0, min(cash, undefined)) = NaN` を得て、`NaN <= EPS` が
    常にfalseであることから Gate F/G が素通りし、`usd(NaN)` で停止した。
  - 修正: (1) resume時にDIV-1の規約どおり0で補完（`normalizeRestoredStateForForwardCompatibility`）、
    (2) Standard AI配当判定で非有限入力は `DIVIDEND_SKIPPED_INVALID_FINANCIAL_INPUT` で明示的にskip、
    (3) `resolveDividendDecision` が非有限の要求額・上限を `DividendValidationError` で弾く。
  - DIV-4の仕様（Q4のみ・確定Net Income基準・NI<=0はskip・15% payout・上限クランプ）は不変。

## Tests
- `npx tsc --noEmit -p .` : エラー0
- `npm test`（3513件）: 全pass
- `npx eslint`（変更ファイル）: エラー0
- INT-NA-1..4（`app/lib/v2/companyLab/__tests__/legacyStateNanRegression.test.ts`）:
  旧保存stateから復元して baseline / management-console-32q が32Turn完走し、
  履歴・財務stateに非有限の数値が残らないことを確認。

## Preview URL
- Branch Preview（常に最新）: https://vietnam-shrimp-game-staging-git-integration-v2-e698f5-tomiyake.vercel.app
- Management Console: https://vietnam-shrimp-game-staging-git-integration-v2-e698f5-tomiyake.vercel.app/v2/management
- Deployed commit: `c192673`

## Smoke Test結果
- ローカル（engine直接）: 旧保存state再現→Turn 8/9通過→32Turn完走、非有限値0件。
