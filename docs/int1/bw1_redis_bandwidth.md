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
| 32Turn 換算（線形・訂正あり → §10-2） | 3.68 GB |
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
   | `vietnam-shrimp-game`（Production、本番ブランチ `main`） | `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `KV_URL` / `REDIS_URL` / `KV_REST_API_READ_ONLY_TOKEN` | 5変数すべてに `contentHint` があり `storeId = store_…（ID省略）`（Upstash 連携 `oac_…（ID省略）` / 製品 `iap_…（ID省略）` / 設定 `icfg_…（ID省略）`）に紐づく。対象は production と preview |
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
| 実プレイ 32Turn ＝ 研修1回ぶん | **約 4.93 GB（見積り）** / 13,792 コマンド | 帯域は無料枠内。コマンドは約 **$0.03** |
| 無料帯域 200 GB で回せる研修回数 | 200 GB ÷ 4.93 GB | **約 40 回/月**。これを超えた分は $0.03/GB |

読み取り方:
- **研修を月に数回なら、帯域・コマンド・容量のどれも Pay-as-you-go の無料枠の内側で収まる見込み。**
- 費用が増えるのは回数が増えたとき。月 54 回を超えたあたりから帯域の超過課金が始まる。
- Free プランのままでは、帯域 10 GB ＝ 研修 **2 回ぶん**しか回せない（4.93 GB × 2 ≈ 9.9 GB）。
  待機ぶんも乗るので実際はさらに少ない。**だから Free では研修を回せない。**
  Free で先に尽きるのは帯域であって、コマンド（500K ÷ 13,792 ≒ 36 回ぶん）と
  容量（256 MB ÷ 6.4 MB ≒ 40 本ぶん）はそれより余裕がある（§10-3）。
- 上記は `pack` が小さい代替値での計測なので、実際の消費はこれより増える。
- 保存容量は Run 1本あたり 8Turn 時点で約 3.2 MB、32Turn 時点で約 6.4 MB（§10-2 の実測）。
  Pay-as-you-go の無料枠 1 GB、Free の 256 MB のどちらに対しても十分小さい。
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

## 10. 訂正（2026-10-09・司令塔の指摘による）

BW-1 は commit `d45b0bfe52cffb8f0f8031a4f7205b7dd7896cae` としてコード監査 ACCEPTED。
そのうえで、報告の次の4点を訂正する。**コード自体の訂正は無い**（全て記述と見積りの訂正）。

### 10-1. 配備の段階（3つを区別する）

Vercel REST API で直接確認した事実（2026-10-09）。

| 段階 | 状態 | 根拠 |
|---|---|---|
| Staging プロジェクトの **Preview 配備** | **済**。`dpl_DRWgcZMZwv7h6RqZd647nKPwEjEH` / project `vietnam-shrimp-game-staging` / state `READY` / target `null`（＝Preview） / commit `d45b0bf` / branch `integration-prep/v2-int1-training-candidate` / 2026-10-09 08:23 JST 作成 | `list_deployments(sha=d45b0bf)` |
| **固定 Staging への昇格** | **未実施**。固定 Staging（staging プロジェクトの target `production`）の現行は `dpl_GdVFUEENm1fb9nPGvwoQNTMDz33x` / commit `77bedace3ca43cc720e105d77f46ba961167172f` / branch `feature/staging-test-environment` / 2026-08-01 14:27 JST。BW-1 も INT-1 も入っていない | `list_deployments(app=vietnam-shrimp-game-staging, target=production)` |
| **実機（共有DB）での動作確認** | **未実施**。共有 DB `upstash-kv-lime-arrow` が帯域超過で停止中のため | — |

予行演習前の確認には、上の **Preview** を使う方針（司令塔決定）。
固定 Staging の URL から入ると BW-1 の入っていない古い版に当たるため、
入口は Preview の URL に限る。

付随して判明した事実: 同じ commit は Production プロジェクト `vietnam-shrimp-game` でも
Preview build が走り、**失敗している**（`dpl_EuEZeGwTAJbwBQHA9anS5312jkHg` / state `ERROR` /
target `null`）。これは Production 環境そのものではなく Preview の build。
Production プロジェクトに V2 の環境変数が揃っていないことが原因と見られ、
`separate_issue_production_app_env.md` の別件と同じ性質。今回は変更しない。

### 10-2. 「32Turn 3.68 GB」は実測ではなく線形換算だった

§3-3 の 117.9 MB は「**8Turn 進行後の Run** で 1Turn ぶんを実測した値」であり、
3.68 GB はそれを単純に 32 倍した換算値。32Turn を通した実測ではない。

1Turn ぶんの転送量は「保存物の大きさ × その Turn で全体を取り直す回数（研修では一定）」で
ほぼ決まる。保存物は Turn とともに増えるため、8Turn の値で 32 倍すると**過小**になる。
増え方を実測した（`scripts/int1/probeRunGrowth.ts`。共有 DB も HTTP も使わず、
engine と保存物の組み立てだけを呼ぶ。`pack` は §3-3 と同じく含めない）。

| Turn | dataset | resume | 合計 | 8Turn 比 |
|---|---|---|---|---|
| 1 | 121,912 B | 521,911 B | 643,823 B | — |
| 8 | 963,876 B | 2,255,541 B | 3,219,417 B | 1.000 |
| 16 | 1,957,174 B | 2,407,192 B | 4,364,366 B | 1.356 |
| 24 | 2,930,597 B | 2,520,198 B | 5,450,795 B | 1.693 |
| 32 | 3,931,193 B | 2,744,229 B | 6,675,422 B | **2.073** |

- Turn1..32 の保存物の総和: 137,939,780 B
- 8Turn 固定で 32 倍した場合: 103,021,344 B
- 補正係数: **1.339**

→ 32Turn の見積り: 117.9 MB × 32 × 1.339 ＝ **約 4.93 GB**。
**これも見積りであり、32Turn を通した実測ではない。** 実測するには共有DBまたは
隔離環境で 32Turn を実際に通す必要があり、未実施。
また `pack` は計測用の小さい代替値なので、本番の実際の消費はこれより増える。

### 10-3. 無料運用の可否は帯域・コマンド・容量の3つで見る

1研修（32Turn・PLAYER5＋GM1）あたりの実測/見積り:
帯域 約 4.93 GB（見積り） / コマンド 13,792 回（実測 431回/Turn × 32） /
容量 6.4 MB（32Turn 時点の実測。`pack` 除く）。

| 軸 | Free の枠 | 1研修あたり | Free で何回ぶんか | Free で先に尽きるか |
|---|---|---|---|---|
| 帯域 | 10 GB/月で停止 | 約 4.93 GB | **約 2.0 回** | **これが最初に尽きる** |
| コマンド | 500K/月 | 13,792 回 | 約 36 回 | 尽きない |
| 容量 | 256 MB | 6.4 MB/Run | 約 40 本 | 尽きない |

- Free で制約になるのは**帯域だけ**。コマンドと容量はそれより1桁余裕がある。
- ただし帯域が 2 回ぶんしかないため、**Free プランでの研修運用は成り立たない**と判断する。
  待機ぶん（1.8 GB/月）と本番 `pack` のぶんが上に乗るので、実際は 2 回より少ない。
- 「月1〜2回なら Free で可能」とは**断定しない**。1回で約半分を使い、
  予行演習・やり直し・待機が加われば1回で尽き得る。
- Pay-as-you-go では帯域の無料枠が 200 GB/月になり、約 40 回/月ぶん。
  超過は $0.03/GB、コマンドは1研修あたり約 $0.03。
- 上記の単価は検索結果経由の値（§7 冒頭の注記のとおり）。操作前に画面の表示金額で確認が必要。

### 10-4. テスト件数がどの差分に対応するか

| 件数 | 対応する差分 | 実行日時 | ログ |
|---|---|---|---|
| **4,482 件 / 4,482 成功** | **commit `d45b0bf` そのもの（BW-1・ACCEPTED 対象）** | 2026-10-08 18:20 JST | `logs/bw1-npm-test.log` |
| 4,523 件 / 4,523 成功 | `d45b0bf` ＋ **UI-TRIAL-1 の未commit差分** | 2026-10-09 12:37 JST | `logs/uitrial1-npm-test.log` |

差 41 件は UI-TRIAL-1 で新規追加した単体テストの件数と一致する
（`uiTrial1SalesStaffing` 8 ＋ `uiTrial1InputVsReference` 8 ＋
`uiTrial1Confirmation` 20 ＋ `uiTrial1AllScreensAnnotation` 5 ＝ 41）。

→ **ACCEPTED 対象 `d45b0bf` の件数は 4,482 件**。4,523 件は UI-TRIAL-1 を含んだ別の状態の値で、
ACCEPTED 対象の証跡としては使えない。いずれもこの作業環境での実行結果であり、
司令塔が再実行したものではない。

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
