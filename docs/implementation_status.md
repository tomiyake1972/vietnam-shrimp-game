# 実装状況

最終更新: 2026-07-15
対象コミット: `main` = `3ae9485`、`claude/turn-processing-engine` = `036b4dd`（未マージ、PRなし）

状態は以下のいずれかで統一：**実装済み** / **一部実装** / **未実装** / **要確認** / **不具合の可能性**

「関連ファイル」列のブランチ表記がない項目は`main`にも存在します。「（engine）」は`claude/turn-processing-engine`ブランチのみに存在することを示します。

| 機能 | 状態 | 関連ファイル | 確認方法 | 次の作業 |
|---|---|---|---|---|
| トップ画面 | 実装済み | `app/page.tsx` | `/`にアクセスし、ゲームコード入力欄とGMコンソールへのリンクを確認 | - |
| GMコンソール（一覧・作成画面） | 実装済み | `app/gm/page.tsx`, `app/api/game/route.ts` | `/gm`にアクセスし作成フォームと過去ゲーム一覧を確認 | 一覧が直近20件までしか出ない制限への対応検討（`system_architecture.md` §4） |
| ゲーム作成 | 実装済み | `app/gm/page.tsx`, `POST /api/game` | GMコンソールでゲーム作成→ゲームコード発行を確認 | ゲームコード衝突チェックの追加検討 |
| 過去ゲーム一覧 | 一部実装 | `GET /api/game` | `/gm`で一覧表示を確認 | 直近20件制限の解消、ページネーション実装 |
| ロビー | 実装済み | `app/lobby/[gameCode]/page.tsx` | `/lobby/[gameCode]`にアクセスし会社選択ボタンを確認 | - |
| 会社選択 | 実装済み | `app/lobby/[gameCode]/page.tsx` | 人間担当会社のみボタン表示されることを確認 | AI担当会社への直接URLアクセス制御の検討（`game_manual.md` §6） |
| 全員AIテスト | 未実装 | - | GM画面で全社AI設定にしても意思決定は誰も行わない | AI意思決定ロジックの実装（`ai_company_spec.md`） |
| フェーズ0（情報確認） | 一部実装 | `CompanyDashboard.tsx`（`PhaseForm`, phase.id===0） | フェーズ0タブで固定テキストが表示されることを確認 | `confirmedOrders`との連動実装（`game_manual.md` §5の「注意」） |
| フェーズ1（設備投資） | 一部実装 | 同上、phase.id===1 | 入力→保存はされるが効果なし | ターン処理エンジンへの反映実装 |
| フェーズ2（生産計画） | 実装済み（engine） | 同上phase.id===2、`gameEngine.ts` | ターン処理後の`rawMaterialAvailable`等で確認 | 上限のUI側バリデーション追加検討 |
| フェーズ3（調達） | 実装済み（engine） | 同上phase.id===3、`gameEngine.ts` | 同上 | 上限（0〜3000t）の強制実装検討（`finance_spec.md` §3） |
| フェーズ4（加工） | 実装済み（engine） | 同上phase.id===4、`gameEngine.ts` | `productOutput`で確認 | - |
| フェーズ5（販売） | 一部実装（engine） | 同上phase.id===5、`gameEngine.ts` | `salesByMarket`で確認 | 「価格」入力がgameData.tsの説明文と食い違う点の解消（`parameter_spec.md` §6） |
| フェーズ6（財務） | 実装済み（engine） | 同上phase.id===6、`gameEngine.ts` | `stateAfter`の`cash`/`equity`変化で確認 | 増資先による条件差の実装検討 |
| 意思決定の保存 | 実装済み | `POST /api/game/[gameCode]/decisions` | 提出後、Redisキー`game:{code}:decisions:{Y}Q{Q}:{id}`を確認 | - |
| 提出状況 | 実装済み（engine） | `app/gm/[gameCode]/page.tsx`, `GET /api/game/[gameCode]/decisions` | `/gm/[gameCode]`で提出数カウントを確認 | `main`ブランチへの反映（GM側に提出状況確認UIがない） |
| ターン進行 | 実装済み（engine） / **未実装（main）** | `POST /api/game/[gameCode]/process-turn` | `/gm/[gameCode]`でターン処理実行→四半期が進むことを確認 | `main`へのマージ判断、二重実行防止ガードの追加（`system_architecture.md` §5） |
| 決算計算 | 実装済み（engine） / **未実装（main）** | `app/lib/gameEngine.ts` | `docs/finance_spec.md` | 税金・減価償却・配当等の追加検討 |
| P&L | 一部実装（engine） | `CompanyTurnResult`（`gameTypes.ts`） | `/gm/[gameCode]`の処理結果表示で確認 | 正式なP&L様式への整形（`finance_spec.md` §12） |
| BS | 一部実装（engine） | `CompanyState` | ダッシュボードの「期初バランスシート」表示で確認 | 勘定科目別内訳の追加検討 |
| CF | 未実装 | - | 該当コードなし | CF計算書の設計・実装 |
| 結果表示 | 実装済み（engine） | `app/gm/[gameCode]/page.tsx`, `CompanyDashboard.tsx`（前回ターン結果） | ターン処理後、GM画面・会社ダッシュボード双方で確認 | - |
| AI自動意思決定 | 未実装 | - | `ai_company_spec.md`参照 | 実装方針の検討 |
| イベント | 未実装 | - | `event_spec.md`参照 | 実装方針の検討 |
| 顧客信頼スコア（信用スコア） | 実装済み（初期値はmain、更新はengine） | `gameData.ts`（初期値）, `gameEngine.ts`（更新式） | ダッシュボードの信用スコアバー、`finance_spec.md` §11 | スコア変動要因の追加検討（現状は純利益・現金・D/E比率の3要因のみ） |
| 意思決定ログ | 一部実装 | `CompanyDecision`（`submittedAt`のみ記録） | Redisの`decisions`キーで確認 | 変更履歴・複数回提出時の扱いの明確化（現状は上書き保存のため、提出のたびに前回分が消える） |
| システム投資 | 未実装 | - | フェーズ1の「工場新設・拡張」は効果なし（上記参照） | フェーズ1の効果実装 |
| レポート生成 | 未実装 | - | 該当コードなし。GM画面での結果表示はあるが、出力・エクスポート機能はない | レポート様式・出力形式の検討 |

## 不具合の可能性として個別に記載する項目

| 項目 | 内容 | 関連ファイル |
|---|---|---|
| `main`ブランチのRedisデシリアライズ | `redis.get()`は`@upstash/redis`の自動デシリアライズにより既にパース済みオブジェクトを返すが、`main`ブランチの各APIルートは`JSON.parse(data as string)`を無条件に実行しており、実データでは例外が発生する可能性が高い（`claude/turn-processing-engine`ブランチでは`parseStored()`ヘルパーで修正済み） | `app/api/game/route.ts`, `app/api/game/[gameCode]/route.ts`, `app/api/game/[gameCode]/decisions/route.ts`（mainブランチ時点のコード） |
| `GameSession.currentPhase`の不使用 | フィールドは存在するが、`CompanyDashboard.tsx`は独自のローカルstateでフェーズ切替を管理しており、`GameSession.currentPhase`と同期していない | `app/lib/gameTypes.ts`, `app/components/CompanyDashboard.tsx` |
| ゲームコード衝突 | 6桁ランダムコード生成時に既存コードとの衝突チェックがない | `app/api/game/route.ts` |

## 検証方法についての注記

本ドキュメント作成時点では、Upstash Redisの実認証情報（`KV_REST_API_URL`/`KV_REST_API_TOKEN`）が本環境に設定されていないため、実データでのエンドツーエンド動作確認（ブラウザ操作によるゲーム作成〜ターン処理）は行っていない。上記「確認方法」列はコードリーディングおよび`claude/turn-processing-engine`ブランチ作業時に実施した以下の検証に基づく：

- `npx tsc --noEmit`（型チェック）
- `npm run lint`（ESLint）
- `npm run build`（Next.jsビルド）
- `resolveCompanyTurn()`単体をNode.js上で直接呼び出したサンプル入力での動作確認（実Redis接続なし）

ブラウザでの実操作確認は**未実施（要確認）**。
