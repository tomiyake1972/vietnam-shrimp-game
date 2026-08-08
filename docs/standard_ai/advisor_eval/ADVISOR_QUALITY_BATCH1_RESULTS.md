# 相談役AI 品質強化 Batch 1 実施結果

作成日: 2026-08-08
ブランチ: `feature/v2-management-advisor-ai-mvp`
対象: 相談役AI（Management Advisor AI）と、そのknowledge / retrieval層のみ
優先順位（指示どおり）: 1. 応答完走率 → 2. 推論品質 → 3. 根拠追跡可能性 → 4. ハルシネーション耐性 → 5. 速度 → 6. コスト

---

## 0. 最初に — 実行できなかったこと

**実APIによる Q1–Q12 の実行・Haiku との比較・レイテンシ/トークンの実測は、
この作業セッションでは行えていない。** 作業環境に `ANTHROPIC_API_KEY` が無く、
Claude APIへ到達できないためである。

したがって本書には **回答例・品質スコア・レイテンシ分布・トークン分布・
モデル比較結果を一切記載していない。** 推測で埋めない。

質問セットと評価フォームは `ADVISOR_SONNET5_QA_SAMPLES.md` に用意してあり、
APIキーのある環境でそのまま実行して追記できる。

以下に書いてあるのは、**実際にコードとして入れた変更と、その根拠**だけである。

---

## 1. 応答完走率（優先度1）

### 1.1 timeout の再設計

| | 変更前 | 変更後 |
|---|---|---|
| 1試行あたり | 40,000ms（Explanation層の定数を参照） | **120,000ms（独立定数）** |
| 全体予算（初回＋リトライ） | なし（最悪 40s×2 = 80s） | **150,000ms** |
| リトライ開始の下限 | なし | 残り予算 **20,000ms** 未満なら開始しない |
| Vercel Function | 未設定（既定値） | **maxDuration = 240秒** |
| クライアント | 90,000ms | **180,000ms** |

**Explanation / Standard AI Q&A のtimeoutは40秒のまま。**
これまで `ADVISOR_CLAUDE_TIMEOUT_MS = EXPLANATION_CLAUDE_TIMEOUT_MS` という
エイリアスだったため、相談役だけを延ばすには切り離しが必須だった。
回帰テストで「両者が別値であること」「Explanationが40秒のままであること」を固定している。

**全体予算を入れた理由**: per-attempt timeout だけでは、リトライ込みの最悪値が
Functionのタイムアウトを超えうる。超えると利用者から見て「何も返らないまま切れる」
という最悪の失敗になる。2回目の試行は「残り予算」をtimeoutとして使う。

**maxDuration を2か所に置いた理由（重要）**: 相談役AIは2経路から呼ばれる。

- `/api/.../advisor` … REST API経路
- `/v2/company-lab/play/[labId]` … 画面のServer Action（`askAdvisorAction`）経路 ← **UIが実際に使うのはこちら**

Server Action は「そのページのFunction」の中で実行されるため、
API route にだけ設定しても UI 経路には効かない。両方に設定した。

**240秒という値について（検証済み）**: Vercelの許容上限はプランに依存し、
超えると **ビルドが明示的に失敗する**。したがってビルドの成否がそのまま検証になる。

- deployment: `dpl_ANLjMfquYx3k21U5bERjf3FUPjp8`（commit `2af0089`）
- 結果: **READY**（ビルド成功）→ 240秒はこのプランの上限内である
- 副次的な観測: `lambdaRuntimeStats` が `{"nodejs":2}` → `{"nodejs":4}` へ増えた。
  Vercelは `maxDuration` の異なるルートを別Functionとしてbundleするため、
  `maxDuration=240` を設定した2ルートが分離されたことと整合する
  （＝設定が実際に効いていることの傍証）。
- Preview URL: `https://vietnam-shrimp-game-staging-git-feature-v2-mana-bf6594-tomiyake.vercel.app`

### 1.2 max_tokens

3,072 → **4,096**。

Sonnet 5 は `thinking` を指定しない場合 adaptive thinking が既定で有効で、
**thinkingトークンが max_tokens を回答本文と共有する**。
回答本体の見込みが 1,600〜2,400tok なので、3,072 では
「本文が完成する前に上限へ到達する」余地が構造的に残っていた。
max_tokens打ち切りは 2026-08-08 に Explanation層で実際に事故を起こしている
（回答が途中で切れ、tool_use の JSON が壊れて schema_mismatch になる）。

6,144 にはしていない。打ち切りはまだ**実測されていない**ため、
実測なしに最大値へ飛ばさない。`stopReason=max_tokens` はログに出るので、
観測されたら根拠付きで上げられる。

---

## 2. 推論品質（優先度2）

### 2.1 現行実装コードのretrievalを追加

`sourcePolicy` が最上位に置く「現行実装コード」を、実際には一度も参照していなかった。
最上位の根拠が空のまま「現行実装では〜」と語れる状態だった。

Option A（軽量MVP）として実装した。詳細は `ADVISOR_SOURCE_CODE_RETRIEVAL_DESIGN.md`。

- 151ファイル / 1,986 chunks / 約1.80MB（whitelistディレクトリのみ）
- 既存のキーワード検索を corpus 差し替えで再利用（**新しい依存もインフラも0**）
- promptへ入るのは最大3件×1,200文字 ＝ 約4KB（構造的な上限）
- 経営相談では引かない（設計・仕様・「なぜ」系のときだけ）

### 2.2 副次的に見つかった既存の不具合

`outputFileTracingIncludes` が advisor の **APIルートにしか** 設定されていなかった。
UI は Server Action 経由で呼ぶため、本番の Server Action 経路では
**`docs/` が同梱されておらず、開発記録を読めていなかった可能性が高い**。
今回、play page 側にも追加した。

---

## 3. 根拠追跡可能性（優先度3）

### 3.1 evidenceRefs（数値の出所）

`sections[].evidenceRefs` を追加。数値を述べた節では、
その数値が context のどのフィールド由来かをパスで書かせる
（例: `liveGameState.financials.current.operatingIncomeUsd`）。

**厳密なパス照合はまだ行っていない。** context は入れ子のJSONで、
モデルが書くパス表記は完全一致しないことがある。厳密照合を先に入れると
正しい回答を誤って落とすリスクのほうが大きい。
今回は「必ず書かせる」＋「数値を含む FACT 節で空だった件数をログへ出す」までで、
**UIに「検証済み」とは書いていない**（検証していないものを検証済みと表示しない）。

### 3.2 ログ拡張

追加した項目: `questionId` / `retrievedExcerpts` / `answerSourceDocs` /
`answerReasonCodes` / `fabricatedReasonCodes` / `fabricatedSourcePaths` /
`factSectionsMissingEvidence` / `timeoutMs`（試行ごとの実際の値）。

`questionId` により、初回とリトライを1つの質問として追跡できる。
質問文・回答本文はログに入れていない（利用者の入力を残さない方針の維持）。

**取得できない値は出していない。** cache read/write とthinkingトークンは
この SDK（0.65.0）の usage からは取れないため、ログ項目に作っていない
（0で埋めると「0だった」と誤読される）。

### 3.3 UI

`sections[].evidenceRefs` を「数値の参照元（相談役AIの申告）」として表示。
「申告」と明記しているのは、サーバー側で照合していないためである。

---

## 4. ハルシネーション耐性（優先度4）

### 4.1 理由コードのサーバー側検証

これが本Batchで最も直接的なハルシネーション対策である。

`relatedReasonCodes` は UI 上「Standard AI が実際にそう判断した」という強い主張として読まれる。
ところがモデルは、それらしい命名規則（例: `LABOR_SHORTAGE_DETECTED`）を自分で作れてしまう。

対策を3段構えにした。

1. **prompt**: 使ってよいコードの全集合を `<available_reason_codes>` として
   独立ブロックで明示（これまでは深い入れ子のJSONの中にしか無かった）
2. **検証**: 応答後、`diagnosticEntries[].code` に実在しないコードを機械的に検出。
   1つでもあれば **1回だけ再生成**
3. **除去**: 再生成後も残る場合、回答は返すが**実在しないコードは落とす**

**回答ごと失敗にしない理由**: 本文は正しいのにコードが1つ余計、という場合に
回答全体を捨てると応答完走率（優先度1）が下がる。除去で目的は達成でき、
落としたことはログに残るので品質評価もできる。

同じ検証を `sections[].sources[].path` にも適用している
（渡していない文書パスを出所として挙げた場合も除去）。

### 4.2 検証しないもの

`evidenceRefs` の欠落は「捏造」ではなく「情報不足」なので、再生成の理由にしていない。
これで再生成すると、無駄な待ち時間とコストが増えるだけである。

---

## 5. UX（§18〜§21）

### 5.1 二重送信

クライアントは送信ごとに `requestId` を発行する。サーバー側は2段構え。

- 同一プロセス内で処理中の同じ `requestId` は、同じ Promise へ合流させる
- 直前に**成功**した `requestId` の再送は、Claudeを呼ばずに保存済み回答を返す

**限界を隠さない**: Vercelはインスタンスが複数ありうるため、
「同時・別インスタンス」の重複だけは通りうる。これは既知の残課題として記録した。

### 5.2 失敗をキャッシュしない（§20）

会話に記録するのは `lastSucceededRequestId`（**成功したIDだけ**）。
失敗したIDを覚えると「同じ質問を再送する」ボタンが永久に同じ失敗を返すようになる。
これは既存Explanation層で実際に起きた失敗キャッシュ問題であり、再導入しない。
回帰テストで「失敗経路で `lastSucceededRequestId` を書かないこと」を固定した。

### 5.3 進捗表示（§19）

生成中は **経過秒数（実測）** と、経過に応じた一般的な説明文だけを出す。
サーバーの内部工程を進行中であるかのように見せる表示（fake progress）は出さない。
回帰テストで、禁止文字列がパネルのソースに存在しないことを機械的に検査している。

---

## 6. 速度・コスト（優先度5・6）

品質を優先したため、**両方とも意図的に悪化させている**。

- max_tokens 3,072 → 4,096（1回あたりの上限コスト増）
- 理由コード捏造時の再生成（該当時のみ、最大1回）
- 現行実装コードの抜粋が prompt に加わる（該当質問のみ、最大約4KB）

一方で無駄は増やしていない。

- 問題が無ければ再生成しない（回帰テストで API 呼び出しが1回であることを固定）
- 経営相談ではコードも仕様文書も引かない（`currentImplementation` / `formalSpecification` が `null`）
- 残り予算が足りないリトライは開始しない
- 二重送信は Claude を呼ばずに保存済み回答を返す

§23 の context 圧縮は **行っていない**。品質を落とす aggressive compression は
やらない方針であり、かつ prompt が肥大しているという実測が現時点で無いためである
（`inputTokens` はログに出しているので、実測が出てから判断できる）。

---

## 7. 変更していないもの（§26 の確認）

- Standard AI の decision logic
- sales / procurement / production / labor / finance / capex / market の各エンジン
- game parameters
- Test15 の decisions・保存データ
- formal game mechanics
- Standard AI Explanation の内容・model（Haiku 4.5）・timeout（40秒）・max_tokens
- Standard AI Explanation Chat の内容・model（Haiku 4.5）

変更したのは相談役AIと、そのknowledge / retrieval層のみ。

---

## 8. テスト

| | 変更前 | 変更後 |
|---|---|---|
| advisorAi の回帰テスト | 49件 | **63件** |
| リポジトリ全体 | — | **2,553件 すべてpass** |
| `tsc --noEmit` | — | エラーなし |
| `eslint` | — | エラーなし |
| `next build` | — | 成功 |

---

## 9. 次にやるべきこと

1. **`ANTHROPIC_API_KEY` のある環境で Q1–Q12 と反論2件を実行**し、
   `ADVISOR_SONNET5_QA_SAMPLES.md` の評価フォームを埋める。
   ここまでやって初めて「品質が上がったか」を言える。
2. ~~プレビューデプロイで `maxDuration = 240` がプラン上限内か確認する~~ → **確認済み（ビルド成功）**。
3. 実測ログから判断する項目:
   - `stopReason=max_tokens` が出るか → 出れば max_tokens を 6,144 へ
   - `elapsedMs` の分布 → 120秒/150秒が過大なら下げる
   - `fabricatedReasonCodes` の頻度 → 高いなら prompt をさらに強める
   - `factSectionsMissingEvidence` の頻度 → 高いなら evidenceRefs の指示を強める
4. Haiku 4.5 との比較（`STANDARD_AI_ADVISOR_MODEL` 環境変数で切り替え可能）。
5. 検索精度の改善（ファイル名・ディレクトリ名一致の重み付け）。vector DB は不要。
