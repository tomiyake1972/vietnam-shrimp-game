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

## Tests
- `npx tsc --noEmit -p .` : エラー0
- `npm test`（3508件）: 全pass
- `npx eslint`（変更ファイル）: エラー0

## Preview URL
（本セッションではVercel CLI/gh CLI非搭載のため未生成。push後にVercel側で自動生成される想定）
Preview: NOT VERIFIED

## Smoke Test結果
未実施（Preview未生成のため）。
