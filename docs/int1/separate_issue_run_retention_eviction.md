# 別件（重大）: 新しい Run を1本保存すると、最古の Run が自動削除される

記録: 2026-10-09
発見の経緯: BW-1 の実機検証で検証用 Run を1本保存したところ、既存の Run が1本消えた。

---

## 1. 起きたこと（実際の損失）

BW-1 §5 の実機検証（`scripts/int1/verifyBw1Live.ts`、配備済み Preview ＋ 共有 Redis）で、
**新しい検証用 Run を1本保存した。既存 Run は読むだけで、書き換えも削除もしていない。**
にもかかわらず、**既存の Run 1本（保存日が最も古いもの）が自動削除された。**

実測の経過（`logs/bw1-live-verify-1st.log` / `logs/bw1-live-verify.log`）

| 時刻（JST） | 操作 | Run 一覧の件数 |
|---|---|---|
| 18:04:55 | 検証開始前の一覧取得（読み取りのみ） | **20** |
| 18:04:57 | 検証用 Run を保存（manifest commit） | （21本目 → 上限超過で最古1本が退避削除） |
| 18:05:00 | 検証用 Run を削除（後片付け） | — |
| 18:05:57 | 2回目の検証開始前の一覧取得 | **19** |

→ **差し引き1本が恒久的に失われた。** 現在残っている最古は `savedAt` が
`2026-08-21T12:08:40.588Z` のもの。失われたのはそれより古い1本。

**どの Run が消えたかは特定できない。** 検証開始前に Run の ID 一覧を保存していなかった。
これは手順の不備であり、記録しておく。

2回目の検証では一覧が19本だったため、保存しても 19+1=20 で上限内に収まり、
追加の退避削除は起きていない（**失われたのは1本だけ**）。

## 2. 原因（コードで確認した事実。推測ではない）

`app/lib/v2/companyLab/simulation/persistence/repository.ts:112`

```
export const SIMULATION_RUN_RETENTION_LIMIT = 20;
```

`app/lib/v2/companyLab/simulation/persistence/redisRepository.ts` の manifest 保存 Lua:

```
redis.call('ZADD', indexKey, score, runId)
local total = redis.call('ZCARD', indexKey)
local excess = total - limit
...
local evicted = redis.call('ZRANGE', indexKey, 0, excess - 1)
for i = 1, #evicted do
  redis.call('ZREM', indexKey, evicted[i])
  result[#result + 1] = evicted[i]
```

続く TS 側（同ファイル 309-320 付近）が、退避対象の
`manifest` / `summary` / `dataset` / `resume` / `pack` キーを実際に `DEL` する。

つまり **Run を 21 本目として保存した瞬間に、保存日が最も古い 1 本が削除される。**
`savedAt` の昇順（zset の score）で選ばれるため、「古い＝不要」とみなす設計。

確認した安全性（こちらは問題なし）
- `deleteRun` は渡された `simulationRunId` だけを対象にする（`ZREM` も単一メンバー）。
  他の Run を巻き込む経路は無い。今回の削除は `deleteRun` ではなく保存時の退避による。

## 3. 影響

- 研修や検証で Run を新規作成するたびに、20本を超えた分の最古の Run が黙って消える。
- **画面にも応答にも警告が出ない。** 保存 API は成功（200）を返すだけで、
  何が退避されたかを呼び出し側へ知らせない。
- 予行演習・本番研修では Run を何本も作るため、過去の研修記録が気づかないうちに失われる。
- 20本という上限は保存容量の制約から来るものではない。
  1本あたり 32Turn 時点で約 6.4 MB（`bw1_redis_bandwidth.md` §10-2 の実測）なので、
  20本で約 128 MB。Upstash Free の 256 MB、Pay-as-you-go の無料枠 1 GB に対して、
  上限を上げる余地は十分にある。

## 4. 復旧について

アプリ側からは復旧できない（manifest・summary・各パートが削除済み）。
Upstash 側のバックアップ／ポイントインタイム復元が使えるかは、
**Upstash コンソールの該当 DB の画面で確認が必要**（プランによって有無が異なる。
この作業環境からは確認できなかった）。契約変更は行っていない。

## 5. 対応案（今回は実装しない）

1. **上限を上げる。** `SIMULATION_RUN_RETENTION_LIMIT` を 20 から増やす
   （容量の実測から見て 100 本＝約 640 MB までは Pay-as-you-go の無料枠 1 GB 内）。
2. **黙って消さない。** 退避が起きたら保存 API の応答に含め、GM Console に
   「古い Run を削除しました」と出す。
3. **保護する。** 名前付き（`runName` のある）Run や完走した Run は退避対象から外す、
   または GM が明示的に削除するまで残す。
4. **検証用 Run を退避の分母に入れない。** 検証・デバッグ用の Run に別の名前空間を与える。

いずれも仕様の変更にあたるため、指示を待つ。

## 6. 今回とった措置

- 追加の実機検証は行わない（これ以上 Run を作らない）。
- 検証用 Run はいずれも後片付けで削除済み（`deleted:true` と削除後 404 を確認）。
- 今後この種の検証を行う場合は、**開始前に Run の ID 一覧を保存**してから行う。
