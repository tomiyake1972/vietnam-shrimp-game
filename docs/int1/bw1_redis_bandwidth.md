# BW-1 — Redis 帯域超過への対応（転送量削減と、停止中DBの再開手順）

対象: ShrimpX V2 / 受入済み INT-1 の上の変更
作成: 2026-10-08
事象: Staging の Redis が Upstash Free の月間帯域 10 GB を使い切り、2026-10-07 12:54 JST に停止。
Staging の保存・読み込みが `ERR This database has reached current Fixed plan limits` で失敗する。

**ゲーム計算・保存形式・保存競合対策（CAS）は変更していない。**

---

## 0. 基点（受入済み基準の上の変更であること）

```
受入済み基準       e7c92839ab26b21bf98d029cdd52e37e7c34c419
                   integration-prep/v2-int1-training-candidate
ローカル HEAD      e7c92839ab26b21bf98d029cdd52e37e7c34c419（同一）
merge-base         e7c92839ab26b21bf98d029cdd52e37e7c34c419
追加 commit        0 本（BW-1 は未commitの作業差分）
```

参考: `claude/shrimpx-v2-ui-audit-aypqr4`（origin: `8c986a71f2c6d71df09f85baaa130f7eb31a06d8`）は
受入済み基準に対して **ahead 1 / behind 330**。ahead の1本は docs のみの commit。
BW-1 はこの branch 上には無い。**push・配備には使わない。**
出力は `docs/int1/attachments/BW1_GIT_BASIS.txt`。

---

## 1. 原因（実測で特定）

Run の保存物は 4 つのキーに分かれている。

| パート | 役割 | 8Turn 時点の実サイズ |
|---|---|---|
| `manifest` | run metadata と公開中 revision | 771 B |
| `dataset` | 分析用データセット | 976,641 B |
| `resume` | 続きからプレイするための状態 | 2,265,058 B |
| `pack` | AI Analysis Pack | 計測では代替値（本番はもっと大きい） |

`loadRun` はこの 4 つを必ず全部読む作りだった。そのうえで、

1. **GM Console の Seat 一覧**（5秒ごと）が `loadRun` を呼んでいた。
   この一覧は `dataset` も `pack` も使わないのに、毎回 3.2 MB を読んでいた。
2. **Independent Player の意思決定画面**（4秒ごと）も毎回 `loadRun` を呼んでいた。
   保存物が変わっていなくても毎回 3.2 MB を読み直していた。
3. どちらも `setInterval` で無条件だった。非表示タブ・通信失敗中・前の取得が
   終わっていない状態でも等間隔で叩き続ける。
4. **保存のたびに全パートを読む検査が 4 回走っていた。**
   `handleSaveSimulationRunPart` / `handleSaveSimulationRun` の
   「もう終了した Run か？」判定（`checkNotAlreadyFinished`）と
   「PLAYER は提出済みか？」判定（`checkPlayerSeatsSubmittedForAdvance`）は
   `run.gameEndedAt` と `run.completedTurns` だけを見るのに `loadRun` 全パートを読んでいた。
   この2つの値は `manifest` に入っている。PLAYER 提出は内部で保存ハンドラを
   4 回呼ぶため、ここが最も重かった。

誰も操作していない状態（GM 1 ＋ PLAYER 5 がタブを開いて放置）で **16,140 MB/時**。
Free の 10 GB は **0.63 時間**で尽きる。実際に 26 GB で上限へ達した事実と整合する。

---

## 2. 修正（6点）

1. `loadRun(id, options?)` に「読むパートの選択」を足した（`SimulationRunLoadOptions.include`）。
   既定（省略時）は従来どおり全パート。`dataset: false` でも「パート欠落」エラーにはしない。
   Redis 実装とインメモリ実装を同じ意味論にそろえた（テストが誤用を見逃さないため）。
2. **GM Seat 一覧**は `dataset` と `pack` を読まない。さらに `knownRevision` と
   `knownSeatsVersion`（Seat の指紋）を受け取り、どちらも変わっていなければ
   `manifest` だけ読んで `unchanged: true` を返す。
   **Seat は Run の revision とは独立に変わる**（参加link発行・再発行・失効・参加・代理提出）ため、
   revision が同じでも指紋が変われば必ず完全な一覧を返し直す。
3. **Player 意思決定context**も `knownRevision` を受け取り、変わっていなければ
   `manifest` だけ読んで `unchanged: true` を返す。提出・Turn進行はどちらも revision を上げる。
4. **保存経路の検査を manifest だけで行う**ようにした（上記 1-4）。
5. **Player 提出 route の入力検証**も `dataset` / `pack` を読まない
   （見るのは `run.gameEndedAt` と `resumePayload` だけ）。
   実際の保存は `submitPlayerDecision` の CAS ループが最新を読み直して行うので、**CAS 経路は未変更**。
6. **ポーリングの作法**を `visiblePollingLoop.ts`（判断の核）と
   `useVisiblePolling.ts`（React への接続）に分けて集約した。
   - 非表示タブでは取得しない。表示へ戻った瞬間に1回だけ取得する。
   - 前の取得が終わるまで次を始めない（重複取得の防止）。
   - 失敗が続くあいだは間隔を倍々に延ばす（上限60秒）。成功したら戻す。
   - 401/403 を受け取ったら自動取得を止め、タイマーも購読も解除する。
   - PLAYER の入力中 draft は従来の `seededTurnRef` の保護をそのまま維持し、上書きしない。
     `unchanged` の回は draft に一切触れない。

判断の核を React から切り離したのは、上の4点を偽のクロックで実際に検証できるようにするため。

---

## 3. 実測値

計測環境: このリポジトリ用に起動した空のローカル Redis ＋ Upstash REST 互換シム ＋
本物の API route（`next dev`）。実際の HTTP で測った。
**停止中の共有DB（Staging / Production）へは一度も接続していない。**
再現: `STAGING_ADMIN_TOKEN=<任意の値> ./scripts/int1/runBw1Propagation.sh`
修正前の値は、`include` の指定だけを元に戻した同条件の実行（negative control）で実測。

### 3-1. HTTP 1回ごとの Redis 読み取り量（8Turn 進行後の Run）

| 操作 | 修正前 | 修正後 |
|---|---|---|
| GM Seat 一覧（変化なし） | 3,251,246 B | **771 B** |
| GM Seat 一覧（変化あり） | 3,251,246 B | 2,272,517 B |
| Player 意思決定context（変化なし） | 3,251,636 B | **1,161 B** |
| Player 意思決定context（変化あり） | 3,251,636 B | 3,251,636 B（全パートが必要） |
| PLAYER 提出 1回 | 19,504,358 B | **5,526,813 B** |
| Turn 進行の保存 1回（part×3 ＋ manifest commit） | 16,289,622 B | **4,992 B** |

### 3-2. 待機時（誰も操作していない。GM 1 ＋ PLAYER 5、タブ表示中）

| | 修正前 | 修正後 |
|---|---|---|
| 1時間あたり | 16,140.4 MB | **2.5 MB** |
| 削減率 | — | 99.985 %（6537 分の1） |
| Free 10 GB に到達するまで | 0.63 時間 | 173 日 |

非表示タブでは取得しないため、実際にはこれよりさらに減る。

### 3-3. 実プレイ時（修正後。PLAYER 5社 ＋ GM 1 で 1Turn を実際に通した実測）

| 内訳 | 読み取り量 |
|---|---|
| 提出 5回（保存側の読み取り） | 27,701,950 B |
| 提出による取り直し（他PLAYER 4人＋GM）×5回 | 76,706,745 B |
| Turn 進行の保存 | 6,909 B |
| Turn 進行による取り直し（PLAYER 5＋GM） | 19,161,212 B |
| **1Turn 合計** | **123,576,816 B ＝ 117.9 MB** |
| 32Turn 換算 | **3.68 GB** |
| 1Turn のコマンド数 | 431 回（32Turn 換算 13,792 回） |

別途、研修の最初に1回だけ発生するもの: 参加link発行＋参加（5社）11,338,781 B。

**待機時の 2.5 MB/時と実プレイ時の 117.9 MB/Turn は桁が違う。**
費用を考えるときは実プレイ時の値を使うこと（3-2 の値から全体を見積もらない）。
取り直しは「提出・Turn進行で保存物が実際に変わったぶん」であり、
取りこぼしを無くすために必要な取得である。ここを削ると反映が遅れる。

計測の注意: `pack` は計測用の小さい代替値を使っている。本番の `pack` は
これより大きいので、実際の値は上記より増える。

---

## 4. 更新の取りこぼしが無いことの検証

### 4-1. 本物の API route 経由（39/39 PASS）

`scripts/int1/verifyBw1Propagation.ts`（ログ: `logs/bw1-propagation-after.log`）

- 変化が無ければ `unchanged` を返し、大きいパートを読まない
- **参加link発行**: Run の revision は変わらないのに、同じ known で再取得すると
  `unchanged: false` になり `joinIssued` が一覧へ現れる
- **PLAYER 参加**: GM の一覧へ現れる
- **PLAYER 提出**: revision が 1→2 へ上がり、PLAYER 自身の画面と GM の一覧の両方へ現れる
- **Turn 進行**: 新しい Turn（9→10）が両方へ現れ、提出状況が未提出へ戻る
- **参加取り消し（失効）**: 同じ known で再取得すると一覧へ現れる
- 存在しない Run は部分読みでも 404 のまま

### 4-2. 単体テスト（44/44 PASS。ログ: `logs/bw1-unit-tests.log`）

| ファイル | 件数 | 何を固定しているか |
|---|---|---|
| `app/lib/v2/companyLab/simulation/__tests__/bw1PartialLoad.test.ts` | 8 | `include` の意味論、部分読みと全読みの一致、保存すれば必ず revision が上がる、404 判定、**部分読みしたものを保存しても既存パートを消さない（BW1-7・BW1-8）** |
| `app/api/v2/management/player-seats/__tests__/seatsFingerprint.test.ts` | 8 | 不変なら同じ指紋／並び順では変わらない／発行・再発行・参加・失効・提出で必ず変わる／secret hash を含めない |
| `app/v2/lib/__tests__/visiblePollingLoop.test.ts` | 7 | **非表示タブ停止・復帰時の即時取得・重複防止・backoff と上限・成功で復帰・認証切れで完全停止・例外でも継続** |
| `app/api/v2/simulation-runs/_lib/__tests__/bw1SavePathSafety.test.ts` | 5 | **保存経路の検査が manifest だけを読むこと（include が全パート false であることを記録して検証）／そのうえで終了済み Run 保護（part・manifest 両方）・Turn 進行 gate・CAS が効くこと** |
| `app/api/v2/simulation-runs/_lib/__tests__/handlers.test.ts`（既存） | 16 | END-LOCK-1〜5・Turn 進行 gate。BW-1 後も全件 PASS |

### 4-3. negative control（意図的に壊すと落ちること）

- `include` を無視させる → BW1-2 / BW1-4 が FAIL
- Seat 指紋を `claimedSessionId` だけにする → BW1-S4 / S6 / S7 が FAIL
- `include` 指定だけを元に戻した実行でも反映検証は 39/39 PASS
  （＝ `include` は挙動を変えず転送量だけを変えている）

---

## 5. 品質ゲート

| ゲート | 結果 | ログ |
|---|---|---|
| `npx tsc --noEmit -p .` | 0 件 | `logs/bw1-tsc.log` |
| `npx eslint <変更/新規19ファイル>` | 0 件 | `logs/bw1-eslint-changed.log` |
| `npm test`（全体） | 4482 / 4482 pass / 0 fail | `logs/bw1-npm-test.log` |
| 隔離環境 反映検証 | 39 / 39 PASS | `logs/bw1-propagation-after.log` |

`npm run build` は未実行。既知の環境事象として、TypeScript コンパイル成功後に
V1既存route `/api/game/[gameCode]/admin/clone` が `STAGING_KV_REST_API_URL` 未設定で
停止する（ローカルに値が無いため）。今回の変更とは無関係。
**この件数はこの作業環境での実行結果であり、再実行した値ではない。**

---

## 6. DB の同一性（Production と Staging）— 同一で確定

結論: **Production と Staging は同一の Redis データベースを共有している。**
対象 DB は `upstash-kv-lime-arrow`（AWS us-east-1 / Free / 月間帯域超過で一時停止中）。
再開・プラン変更の対象はこの1つだけ。

### 根拠（3つが独立に一致）

1. **DB が1つしか存在しない（2026-10-08 三宅さん目視）**
   Vercel 経由の Upstash コンソールの Redis データベース一覧に
   `upstash-kv-lime-arrow` の1件のみ。Upstash 個人アカウント側の Redis 一覧は 0 件。
   Vercel の Storage 一覧にあるのもこの1つだけ。
   （エンドポイント名は確認済みだが、接続文字列の一部なのでここには記載しない。）

2. **環境変数の束縛（Vercel REST API の読み取り。値は取得していない）**

   | Vercel プロジェクト | Redis の環境変数 | API から分かること |
   |---|---|---|
   | `vietnam-shrimp-game`（Production、本番ブランチ `main`） | `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `KV_URL` / `REDIS_URL` / `KV_REST_API_READ_ONLY_TOKEN` | 5変数すべてに `contentHint` があり `storeId = store_dWq3rBUjQTXYltGG`（Upstash 連携 `oac_V3R1GIpkoJorr6fqyiwdhl17` / 製品 `iap_gpfB8wWHssmOi6P1` / 設定 `icfg_40n0ZxVQYPOAjPaL9yS2KjGB`）に紐づく。対象は production と preview |
   | `vietnam-shrimp-game-staging`（本番ブランチ `feature/staging-test-environment`） | `STAGING_KV_REST_API_URL` / `STAGING_KV_REST_API_TOKEN` | `contentHint` 無し＝手入力。store への紐づけ情報を持たない。`type: "sensitive"` のため値は読めない |

   Staging の実行時エラーは `ERR This database has reached current Fixed plan limits` で、
   Staging が**固定枠プランの DB** を参照しているのは確実。
   固定枠プランの DB は1つしか存在しない（根拠1）ので、消去法で同一に決まる。

3. **コード側の設計記述が同一共有を明言している**
   - `app/lib/env.ts:18-19`
     「本番Redisとテスト環境が同一データベースを共有する設計（staging:プレフィックスによる
     論理分離）に変更したため、VERCEL_ENV=production への自動フォールバックはもう使わない」
   - `app/lib/redis.ts:24`
     「このため、キーのプレフィックス（staging:）による論理分離が唯一の分離手段となり」

   つまり同一 DB 共有は事故ではなく、意図した設計である。

### 同一であることから生じること

- **データは混ざらない。** キーは `prefixFor(appEnv)` で `staging:` と本番に分かれる
  （論理分離は既存のまま。BW-1 で変更していない）。
- **帯域と使用量は共有。** Staging の消費がそのまま Production を止める。
  今回 Staging が 26 GB を使って停止させたとき、同じ DB を使う Production も止まっている。
- **再開・プラン変更・予算上限は、この1つの DB に対する1回の操作で両環境に効く。**
  Production 用に別途何かする必要はない。
- **帯域を食っていたのは Staging（V2）側だけ。** Production プロジェクトの
  最新 Production 配備は `dpl_AgDj98oJn7udHSK7yFdKoxpiP8QB`（2026-07-13 22:52 JST、
  commit `3ae948528ecc3af80ac1588d5d1077fa5aac7c84` ＝ `origin/main` の先端）で、
  この commit には V2 の Console / Player 画面（`app/v2/management/components/PlayerSeatPanel.tsx`）が
  **存在しない**。したがって Production 側に今回のポーリング問題は無い。
  **BW-1 を `main` へ入れなくても、消費源である Staging 側の配備だけで帯域は収まる。**

## 7. 料金（待機時と実プレイ時を分ける）

Upstash Redis の公開料金（2026-10-08 時点）。
**upstash.com はこの作業環境の egress 制限で直接取得できなかったため、検索結果経由の値である。
操作前に必ず画面の表示金額で確認してください。**

| | Free | Pay-as-you-go |
|---|---|---|
| 月額基本料 | $0 | $0（アイドル時は課金なし） |
| 帯域 | 10 GB/月で停止 | 月 200 GB まで無料、超過 $0.03/GB |
| コマンド | 500K/月 | $0.20 / 100K コマンド |
| 保存容量 | 256 MB | 最初の 1 GB 無料、以降 $0.25/GB（上限 100 GB） |

上の単価を 3-2・3-3 の実測値に当てた計算（**計算値であり、請求実績ではない**）。

| 区分 | 実測の根拠 | PAYG での費用 |
|---|---|---|
| 待機（タブを開いて放置、GM1＋PLAYER5） | 2.5 MB/時 | 1か月つけっぱなしで約 1.8 GB。無料帯域の内。 |
| 実プレイ 1Turn（PLAYER5＋GM） | 117.9 MB / 431 コマンド | 帯域は無料枠内。コマンドは約 $0.0009 |
| 実プレイ 32Turn ＝ 研修1回ぶん | 3.68 GB / 13,792 コマンド | 帯域は無料枠内。コマンドは約 **$0.03** |
| 無料帯域 200 GB で回せる研修回数 | 200 GB ÷ 3.68 GB | **約 54 回/月**。これを超えた分は $0.03/GB |

読み取り方:
- **研修を月に数回なら、帯域もコマンドも無料枠の内側で収まる見込み。**
- 費用が増えるのは回数が増えたとき。月 54 回を超えたあたりから帯域の超過課金が始まる。
- Free プランのままでは、10 GB ＝ 研修 **約 2.7 回ぶん**しか回せない（3.68 GB × 2.7 ≈ 10 GB）。
  待機ぶんも乗るので実際はさらに少ない。**だから Free では研修を回せない。**
- 上記は `pack` が小さい代替値での計測なので、実際の消費はこれより増える。
- 保存容量は Run 1本あたり約 3.3 MB で、無料枠 1 GB に対して十分小さい。
- 上の実測はすべて V2（Staging プロジェクト）の経路。同一 DB を使う Production は
  V1 のみで、その消費は測っていない（V2 の Console / Player 画面が無いため、
  今回のポーリング問題の対象外。§6 参照）。

---

## 8. 配備計画（統一した順番）

```
修正版の監査 → 承認 → Staging 配備 → DB 再開 → 新規 Run で確認
```

### 8-1. DB 停止は build を阻害しない（実測根拠あり）

心配されたのは「DB が止まっていると配備できず、順番を入れ替える必要があるのではないか」。
**実際には阻害しない。** 根拠:

- Staging プロジェクトのデプロイ `dpl_9d95uHfgd7s4Z8NqR3KZmyRRz3pB` は
  **2026-10-08 12:38 JST** に作成され、state は **READY**。
  DB の停止は **2026-10-07 12:54 JST** なので、**停止後に build と配備が成功している**
  （commit は `e7c92839ab26b21bf98d029cdd52e37e7c34c419`、Vercel REST API で確認）。
- コード側も、Redis クライアントは `createDefaultCompanyLabRedisClient` の動的 import で
  **リクエスト時にしか生成されない**。build 時に接続しない。

よって上の順番をそのまま使う。代替順序は不要。

### 8-2. 旧版タブの扱い（再開前に閉じる）

旧版のタブが開いたままだと、そのタブは**古い JS を持っているので旧ポーリングを続ける**。
DB を再開した直後にそれが残っていると、再開した帯域を旧版が食い始める。

1. **DB 再開の前に**、GM Console と Player 意思決定画面のタブを**すべて閉じる**
   （開いたまま放置されている可能性があるものも含めて。他の端末・スマホも）。
2. DB を再開する。
3. **再開後は、配備した修正版のデプロイ URL から入り直す。**
   古い URL やブラウザの履歴・ブックマークから入ると古いデプロイに当たり得るため、
   その時点の最新デプロイ URL を確認して開く。
4. 入り直した後、Upstash の使用量グラフが毎時数 MB 程度で推移していることを見る
   （修正前は毎時十数 GB。ここが戻っていれば修正版で動いている）。

### 8-3. 三宅さんが操作する画面

対象 DB は `upstash-kv-lime-arrow` の1つだけ（§6 で確定）。
**この1つへの操作で Production と Staging の両方に効く。** 別途 Production 用の操作は不要。

| 手順 | 画面 | 操作 |
|---|---|---|
| 1 | Vercel → `tomiyake` → Storage → `upstash-kv-lime-arrow` | プランを Free → Pay-as-you-go。支払い方法の登録を求められたら登録する |
| 2 | Upstash コンソール → 対象 DB の設定 | 月額の上限（Budget / Max Monthly Cost）に $1〜$5 程度を入れる。項目名と有無は画面で確認してください（API からは取得できませんでした） |
| 3 | Upstash コンソール → 対象 DB | 状態が `active` に戻っていることを確認 |

済: DB 一覧の確認（2026-10-08 三宅さん）。1件のみ＝同一 DB で確定（§6）。

Free のまま月初のリセットを待つ選択もあるが、翌月までは Staging も Production も
使えない（同一 DB のため）。研修日程が今月中なら選べない。

---

## 9. 別件（今回は変更しない）

Production プロジェクト `vietnam-shrimp-game` の `APP_ENV` が Production 対象に無い。
記録: `docs/int1/separate_issue_production_app_env.md`。
なお Production は V1 のみ（`main` に V2 コードが無い）ため、今回の帯域問題とは無関係。

---

## 10. まだ行っていないこと

- commit / push / PR / merge / deploy
- 有料化（プラン変更）
- 環境変数の変更
- DB の作成・削除・移行
- 共有 Redis への接続（読み取りも含め、一切していない）
