# INT-1 統合候補 — 取り込み元と ancestry の対応表

更新: 2026-10-07 JST

## 1. 「取り込んだ commit」と「差分として含めた成果」の区別

統合候補は **Crowding の最新 HEAD を基点に checkout し、D1 と O1 は RC からの差分を適用**して作った。
そのため Git ancestry に含まれるのは Crowding の 5 commit だけで、D1 と O1 の commit は ancestry に**含まれない**。
以下は `git merge-base --is-ancestor <sha> HEAD` の実測結果である。

| 成果 | commit | 取り込み方法 | HEAD の ancestry |
| --- | --- | --- | --- |
| Crowding | `ee65ac7` 市場集中による価格下落（Crowding Markdown）Engine を追加する | 基点として checkout | **含まれる** |
| Crowding | `222207c` ATP除外要素の根拠を是正し、会社数非依存の混雑性質をテストで固定する | 基点として checkout | **含まれる** |
| Crowding | `c317c3e` 納期別 clearing price を完全分離する（X'方式） | 基点として checkout | **含まれる** |
| Crowding | `b8f2a86` V2.00 正式 Crowding policy（P1）を versioned 定数として定義する | 基点として checkout | **含まれる** |
| Crowding | `a79ec99a477c0f13765856cf63666436fac8e014` 正式P1 を salesModelId へ接続し診断を Persistence v9 で保存する | 基点として checkout（= HEAD） | **含まれる** |
| O1 | `a697758f0f38eca7461e14478a2f6c93eb0e010f` prevent player submissions from stale persistence writes | `git diff RC..O1` を適用 | **含まれない**（差分として反映） |
| O1 | `408c3ddf5116cbce6bb8740b1d6cdb2e52511636` persist promoted simulation run parts | `git diff RC..O1` を適用 | **含まれない**（差分として反映） |
| D1 | `c55b81ec23c9396e420c90ed59f2770d44da5003` apply admin annual dividends to player companies | `git diff RC..D1` を適用 | **含まれない**（差分として反映） |

基準RC: `integration/v2-rc-20260830` = `728b3416028dabd44556a55de3f8abd84726817d`
（Crowding・O1・D1 はいずれも RC の子孫であり、RC は HEAD の ancestry に含まれる。）

### 差分適用で内容が一致していることの確認方法
非重複ファイル（Crowding 36 / O1 15 / D1 13）は、それぞれの出所 branch の内容と
`cmp` でバイト単位一致を確認済み（不一致 0 件）。
重複 2 ファイルは手統合しており、内訳は本文書 §2 と `docs/int1/candidate_identity.md` に記載。

### 正式統合時の注意
ancestry を残したい場合は、差分適用ではなく `git merge` で取り込む必要がある。
実測した衝突範囲は次のとおり（`git merge-tree --write-tree`）。

| 組合せ | 結果 |
| --- | --- |
| Crowding + O1 | 衝突なし |
| Crowding + D1 | 衝突なし（`runner.ts` は auto-merge され、本候補の内容とバイト一致） |
| O1 + D1 | `app/v2/management/player/PlayerWorkspace.tsx` のみ衝突 |

## 2. 重複ファイルの手統合内容

| ファイル | 触った成果 | 統合方法 |
| --- | --- | --- |
| `app/lib/v2/companyLab/runner.ts` | D1 × Crowding | git の3way auto-merge 結果とバイト単位で一致（手修正なし） |
| `app/v2/management/player/PlayerWorkspace.tsx` | D1 × O1 | O1版へ D1 の3箇所（import 2行 / `annualDividendGuidance` の useMemo / DecisionStudio への prop）を加えた。さらに INT-1 で提出前検証の呼び出しと `workspace-turn` testid、未確定下書きの注意書きを追加 |
