# FOT-1 GM Console 保存通信量の削減 — 実測記録

- 作成日: 2026-10-15
- 対象: `app/v2/management/lib/simulationRunStore.ts` の保存経路（ブラウザ→サーバー）
- 背景: 2026-10-12 の staging 自動テストプレイで Vercel Fast Origin Transfer が
  1日8.2GB・30日累計15.4GB に達し、Hobby 上限10GB を超えてアカウントが停止した。

---

## 1. 計測条件（改修前後で共通）

| 項目 | 値 |
|---|---|
| シナリオ | `baseline` |
| 販売市場モデル | `tiered-v200-crowding-v1` |
| 会社 | BAL / MASS / JPQ / VAP / CONSV の5社すべて `PLAYER` |
| seed | `fot1-measure` |
| ターン数 | 32 |
| 1Turn あたりの保存回数 | 6回（PLAYER意思決定の確定5回 + Turn完了1回） |

計測スクリプト（いずれも共有 Redis へ接続しない）:

- 改修前: `scripts/int1/measureSavePayload.ts` — 送っていた JSON の実バイト数
- 改修後: `scripts/int1/measureSaveTransferAfter.ts` — 実物の
  `simulationRunStore.saveSimulationRun` を、実物と同じプロトコルを話す
  フェイクサーバーへ走らせ、受信バイト数を数える

---

## 2. 改修前（ベースライン）

1回の保存で送っていたバイト数:

| Turn | dataset | resume | pack | manifest | 合計 | 合計(MB) |
|---|---|---|---|---|---|---|
| 1 | 122,926 | 531,135 | 44,310 | 912 | 699,283 | 0.67 |
| 16 | 1,983,174 | 2,565,445 | 773,965 | 913 | 5,323,497 | 5.08 |
| 32 | 4,002,162 | 3,075,443 | 1,682,483 | 937 | 8,761,025 | 8.36 |

1Run（5社PLAYER×32Turn）の合計: **1,027,566,090 B = 979.96 MB**

パート別の寄与:

| パート | 合計 | 比率 |
|---|---|---|
| resume | 454.00 MB | 46.3% |
| dataset | 374.73 MB | 38.2% |
| pack | 151.06 MB | 15.4% |
| manifest | 0.17 MB | 0.0% |

**pack は依頼書で「未計測」だったが、T32 で 1,682,483 B（1.68MB）・
全体の 15.4% を占めていた。**

参考（改修前の値を gzip しただけの場合）: 1Run 103.17 MB、圧縮率 10.3〜12.1%。

---

## 3. 改修後

実際に送ったバイト数:

| Turn | PLAYER確定（5回合計） | 同（1回あたり） | Turn完了（1回） |
|---|---|---|---|
| 1 | 39,597 | 7,919 | 84,876 |
| 16 | 1,496,844 | 299,369 | 483,015 |
| 32 | 1,819,923 | 363,985 | 710,886 |

Run開始時の保存: 8,275 B

1Run の合計: **59,851,551 B = 57.08 MB**

同じスクリプトを2回走らせると合計が数十〜百数十バイト変動する
（1回目 59,851,680 B / 2回目 59,851,551 B）。保存attemptごとの `writeToken` が
時刻と乱数を含み、圧縮後の長さがわずかに変わるためである。削減率には影響しない。

---

## 4. 削減率（受け入れ条件との対照）

### 4-1. 1回あたりの保存送信量

| Turn | 保存の種類 | 改修前 | 改修後 | 削減率 |
|---|---|---|---|---|
| 1 | PLAYER確定 | 699,283 | 7,919 | **98.9%** |
| 1 | Turn完了 | 699,283 | 84,876 | 87.9% |
| 16 | PLAYER確定 | 5,323,497 | 299,369 | **94.4%** |
| 16 | Turn完了 | 5,323,497 | 483,015 | **90.9%** |
| 32 | PLAYER確定 | 8,761,025 | 363,985 | **95.8%** |
| 32 | Turn完了 | 8,761,025 | 710,886 | **91.9%** |

目標「1回の保存で90%以上削減」は、6回の保存のうち5回（PLAYER確定）では
全ターンで達成している。Turn完了の保存は T16 / T32 で達成するが、
**Turn 1 だけ 87.9% で未達**である。理由は、Turn 1 では dataset の中身が
すべて新規であり、圧縮しか効かないため（後述のとおり dataset には
差分追記を採用していない）。

### 4-2. 1Run の合計送信量

| | 値 |
|---|---|
| 改修前 | 979.96 MB |
| 改修後 | **57.08 MB** |
| 削減率 | **94.2%** |

目標「1Run 合計 100MB 未満」は達成（57.08 MB）。

---

## 5. 何をしたか（3つだけ）

保存形式（Redis 上の正規キーに完全な JSON を置く形）は**一切変えていない**。
変えたのは送り方だけである。

1. **gzip 圧縮して送る**
   `CompressionStream('gzip')` で圧縮し、`x-shrimpx-body-encoding: gzip` を付ける。
   サーバー側 `parseJsonBody` が展開する。ヘッダが無ければ従来どおり素の JSON を
   受け付ける（後方互換）。

2. **変わっていないパートは送らない（reuse）**
   `reuseFromRevision` を送ると、サーバーが公開済みのパートを **Redis 内で**
   staging キーへコピーする（Lua の GET→SET。値が Redis と関数のあいだを
   往復しない）。5社PLAYERでは1Turnの6回の保存のうち5回が dataset / pack を
   変更しないため、ここが最大の削減。

3. **pack は増えた turn の行だけ送る（append）**
   `appendFromRevision` + 差分を送ると、サーバーが turn キーでマージして
   完全な値を作る。

### 5-1. dataset に差分追記を採用しなかった理由

`mergeAnalyticsDatasets` でマージした dataset は、行の**集合**としては全量ビルドと
完全に一致するが、`marketMetrics` の**行順**が変わる（全量ビルドは visibility 単位で
まとめ、マージは turn 単位で積む）。`aiPack/workbook.ts` は
`dataset.marketMetrics` を並べ替えずに Excel の行へ落とすため、行順が変わると
AI Analysis Pack の出力が改修前と一致しなくなる。

実測（`scripts/int1/probeDeltaEquivalence.ts`）:

```
dataset: Turn 2 で初めて不一致（行の集合は一致。full-only 0件 / merged-only 0件）
pack   : 全32Turnで一致
```

このため dataset は「変わっていなければ reuse、変わったら全量（圧縮あり）」とし、
pack だけ append を使う。

### 5-2. pack を「出力時・完走時の1回だけ」にしなかった理由

依頼書の改修内容1は「pack は出力ボタンか Run完走時の1回だけ」だったが、
`ExportPackButton.tsx` の `findStaleness` が
`packMaxTurn < run.completedTurns` を検知して **export を明示的にブロックする**
既存ガードを持っている。また `restoreSessionFromResumePayload` は
`stored.packCapture` から pack を復元するため、保存済み pack が遅れていると
resume 後のセッションの pack が欠ける。

そのため「Turn完了時に差分だけ送る（他5回は reuse）」とした。
pack は常に `completedTurns` に追いついたまま保たれ、送信量は 1/6 以下になる。

### 5-3. 保存回数の削減（デバウンス）

待たない保存（経営モード変更・Vision override）を 600ms でまとめて1回にした
（`CONSOLE_PERSIST_DEBOUNCE_MS`）。Turn完了・ゲーム終了の保存は呼び出し側が
`await` して「保存できたら次へ進む」を判断しているため、**まとめない**。
`persist()` の先頭でまとめ待ちを破棄し、古い内容が後から着地しないようにしている。
画面を離れるときは取りこぼさないよう即時に送る。

---

## 6. 受け入れ条件の確認

| 条件 | 結果 | 根拠 |
|---|---|---|
| 改修前後の T1/T16/T32 と 1Run の実測を報告 | 済 | 本書 §2〜§4 |
| 既存の保存済みRunを読み込める（旧形式との後方互換） | 済 | 保存形式を変えていないため migration 不要。`loadRun` は未変更。旧形式（manifest埋め込み）の読み出しは `simulationRunSplitStorage.test.ts` が従来どおり通る |
| 同一seed・同一入力で改修前とTurn結果が一致 | 済 | `measureSavePayload.ts` を改修後に再実行し、dataset / resume / pack のバイト数が改修前と**完全一致**（T1 122,926/531,135/44,310、T16 1,983,174/2,565,445/773,965、T32 4,002,162/3,075,443/1,682,483）。エンジン・analytics のファイルは1つも変更していない |
| 型チェック・Lint・npm test | 済 | §7 |
| AI Analysis Pack の出力結果が改修前と同じ | 済 | Pack は `StoredSimulationRun` から作られる。`measureSaveTransferAfter.ts` が、32Turn 走らせたあとの公開済み dataset / pack が全量送信時と **JSON文字列として一致**することを確認（「dataset: 一致 / pack: 一致」）。入力が同一なら出力も同一 |

### 止める条件には該当しなかった

- エンジン（ゲーム計算）側の変更は不要だった（1ファイルも触っていない）。
- Redis の保存形式は変更していないため、既存Runの破損リスクは発生しない。

---

## 7. 品質ゲート

| ゲート | 結果 |
|---|---|
| `npx tsc --noEmit -p .` | 通過 |
| `npx eslint <変更ファイル>` | 通過 |
| `npm test` | 4,662 tests / 4,662 pass / 0 fail |

新規テスト:

- `app/lib/v2/companyLab/simulation/__tests__/fot1SavePayload.test.ts`（FOT-1〜11）
  送り方の判定、差分抽出、reuse/append で中身が変わらないこと、
  土台がずれているときに正本化しないこと、gzip の往復と後方互換。
- `app/lib/v2/player/__tests__/submit.test.ts` の SUBMIT-FOT-1
- `app/v2/management/lib/__tests__/simulationRunStore.test.ts`
  フェイクサーバーを実物と同じプロトコル（gzip・reuse・append）へ更新。

実Redis検証（`scripts/int1/fot1IsolatedRedisReuse.ts`、隔離ローカル Redis 7.0.15）:

```
PASS  FOT-R1  公開済みパートのコピー dataset=true pack=true
PASS  FOT-R2  reuse した dataset / pack が全量送信時と同一
PASS  FOT-R3  revision=2 / resume のみ更新
PASS  FOT-R4  昇格後の正規キーにTTLが無い dataset PTTL=-1 pack PTTL=-1
PASS  FOT-R5  差分マージ後の最大turn=5
PASS  FOT-R6  append 後の pack が全量ビルドと同一
PASS  FOT-R7  古いrevision(1)からの reuse は false
PASS  FOT-R8  存在しないRunからの reuse は false
```

FOT-R4 は、このコードベースに記録されている落とし穴（RENAME は残りTTLを
引き継ぐため、昇格直後に PERSIST しないと正本が1時間で消える）を
reuse 経路でも踏んでいないことの確認である。

---

## 8. 副次的な効果

### 8-1. request body 上限への余裕

送信前のサイズ検査（`PERSISTENCE_PAYLOAD_TOO_LARGE_THRESHOLD_BYTES` = 4MB）は、
圧縮後のバイト数で判定するようにした。改修前は dataset が T32 で
4,002,162 B（閾値 4,194,304 B の 95.4%）に達しており、**あと数ターンで
保存が止まる状態だった**。圧縮後は T32 で 332,695 B（7.9%）になる。

### 8-2. 受講者の提出経路（`app/lib/v2/player/submit.ts`）

受講者が `/v2/play/workspace` から提出する経路は、ブラウザからは意思決定だけを
送るため Fast Origin Transfer の問題は無い。ただしサーバー側で、変わっていない
dataset / pack を読んだまま Redis へ書き戻していた（T32 で約5.7MB×提出回数）。
今回作った reuse 機構へ切り替え、Redis への書き戻しを無くした
（SUBMIT-FOT-1 で固定）。以前 Redis の帯域上限超過で停止した経緯があるため、
同じ機構で併せて直した。

---

## 9. 残っている削減余地（未実施）

改修後 57.08 MB の内訳は **resume がほぼ全部**である（1Turnに6回、毎回全量）。
resume は提出のたびに実際に変わるため reuse は使えないが、中の
`evaluationHistory` と `publicCompetitorTurns` は turn 追記型で trim されない
配列であり、これらを別パートへ切り出して append にすれば、さらに
数分の1へ下げられる見込みである（**未実測**）。
今回の目標（1Run 100MB未満）は達成しているため、実施していない。
