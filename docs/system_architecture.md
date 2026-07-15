# システムアーキテクチャ

最終更新: 2026-07-15
対象コミット: `main` = `3ae9485`、`claude/turn-processing-engine` = `036b4dd`

> **最重要の前提**：このリポジトリには2026-07-15時点で以下の2ブランチが存在し、実装範囲が大きく異なります。
> - **`main`**：ゲームセッション管理・GMコンソール・意思決定フォームの保存まで。**ターン処理（決算計算）は未実装**。
> - **`claude/turn-processing-engine`**（未マージ、PRなし）：`main`に加えてターン処理エンジン（決算計算）、結果表示、GM管理画面、プレイヤー画面の実データ反映を追加。
>
> 本ドキュメント群は、両ブランチの内容を区別して記載します。「（turn-processing-engineのみ）」という注記がない項目は`main`にも存在します。読む際は自分が見ているブランチと照合してください。

## 1. 技術スタック

- Next.js 16.2.10（App Router、Turbopack）
- React 19.2.4 / React DOM 19.2.4
- TypeScript 5系（`strict: true`）
- Tailwind CSS 4系（`@tailwindcss/postcss`）
- ESLint 9系 + `eslint-config-next`
- データストア: Upstash Redis（`@upstash/redis` ^1.34.9）

出典: `package.json`, `tsconfig.json`, `eslint.config.mjs`

## 2. ディレクトリ構成（コード部分）

```
app/
  page.tsx                                トップ画面（ゲームコード参加 / GMコンソールへのリンク）
  layout.tsx                              ルートレイアウト（メタデータ設定のみ）
  globals.css                             グローバルスタイル
  gm/
    page.tsx                              GMコンソール（ゲーム作成・過去ゲーム一覧）
    [gameCode]/page.tsx                   GM向けゲーム管理画面（turn-processing-engineのみ）
  lobby/
    [gameCode]/page.tsx                   ロビー（会社選択）
  company/
    [id]/page.tsx                         会社ページのサーバーコンポーネント（データ受け渡し）
  components/
    CompanyDashboard.tsx                  会社ダッシュボード本体（クライアントコンポーネント）
  lib/
    gameData.ts                           会社A〜E初期値、フェーズ0〜6の定義
    gameTypes.ts                          型定義（GameSession, CompanyState 等）
    redis.ts                              Upstash Redisクライアント初期化
    gameEngine.ts                         ターン処理ロジック（turn-processing-engineのみ）
  api/
    game/route.ts                         POST（ゲーム作成） / GET（一覧）
    game/[gameCode]/route.ts              GET（セッション + 会社状態取得）
    game/[gameCode]/decisions/route.ts    POST（意思決定保存） / GET（当四半期の意思決定一覧）
    game/[gameCode]/process-turn/route.ts POST（ターン処理実行、turn-processing-engineのみ）
    game/[gameCode]/results/route.ts      GET（ターン結果取得、turn-processing-engineのみ）
```

## 3. 主なページとURL

| URL | ファイル | 内容 |
|---|---|---|
| `/` | `app/page.tsx` | ゲームコード入力→ロビーへ遷移。GMコンソールへのリンク |
| `/gm` | `app/gm/page.tsx` | ゲーム作成フォーム（タイトル・A〜E担当者設定）、過去ゲーム一覧（最大20件） |
| `/gm/[gameCode]` | `app/gm/[gameCode]/page.tsx` | （turn-processing-engineのみ）提出状況確認、ターン処理実行、結果表示 |
| `/lobby/[gameCode]` | `app/lobby/[gameCode]/page.tsx` | ゲームコード・年度四半期表示、人間担当会社の選択ボタン、AI担当会社の一覧表示 |
| `/company/[id]?game=[gameCode]` | `app/company/[id]/page.tsx` → `CompanyDashboard.tsx` | 会社ダッシュボード（財務表示、フェーズ0〜6の意思決定フォーム、提出） |

`generateStaticParams`により`/company/A`〜`/company/E`は静的パラメータとして事前定義されている（`app/company/[id]/page.tsx`）。`game`クエリパラメータがない場合、`COMPANIES`（`gameData.ts`）の初期値のみが表示され、Redis上の実データとは連動しない。

## 4. Redisデータ設計

Upstash Redisをキーバリューストアとして使用。すべて`redis.set(key, JSON.stringify(obj))`で保存し、`@upstash/redis`は**保存時にJSON文字列として、取得時に自動でJSONデシリアライズ**を行う（`automaticDeserialization`のデフォルトはtrue。`redis.get()`は文字列ではなく既にパース済みのオブジェクトを返す。詳細は `app/lib/redis.ts` の `parseStored` ヘルパーのコメント参照）。

| キーパターン | 型 | 内容 | 書き込み箇所 |
|---|---|---|---|
| `game:{gameCode}` | `GameSession` | ゲームセッション本体 | `POST /api/game`（作成時）、`POST /api/game/[gameCode]/process-turn`（ターン処理後、turn-processing-engineのみ） |
| `game:{gameCode}:company:{id}` | `CompanyState` | 会社ごとの財務状態（A〜E） | `POST /api/game`（初期化）、`POST /api/game/[gameCode]/process-turn`（更新、turn-processing-engineのみ） |
| `game:{gameCode}:decisions:{year}Q{quarter}:{id}` | `CompanyDecision` | 当該四半期・会社の意思決定 | `POST /api/game/[gameCode]/decisions` |
| `game:{gameCode}:results:{year}Q{quarter}` | `TurnResult` | 四半期処理結果（turn-processing-engineのみ） | `POST /api/game/[gameCode]/process-turn` |
| `games` | Redisリスト（文字列） | 作成済みゲームコードの一覧（`lpush`） | `POST /api/game` |

- ゲームの識別子は6桁のランダム英数字コード（`Math.random().toString(36).substring(2, 8).toUpperCase()`、`app/api/game/route.ts`）。衝突チェックは行われていない（**要確認**：低確率だが既存ゲームを上書きする可能性がある）。
- `GET /api/game`は`redis.lrange("games", 0, 19)`で**直近20件のみ**を返す（`app/api/game/route.ts`）。それ以前に作成されたゲームは一覧に出ないが、`game:{gameCode}`キー自体は削除されないため、ゲームコードを直接知っていれば`/lobby/[gameCode]`からアクセス可能（**未実装**：一覧のページネーションや全件検索）。
- Redisキーの有効期限（TTL）は設定されていない（コード上に`expire`等の呼び出しなし）。**要確認**：データが無期限に残り続ける設計になっている。
- `game:{gameCode}:decisions:...`および`:results:...`キーは、四半期が進んでも削除されない。全期間分が蓄積される設計だが、それらを一覧で取得するAPIは`results`のみ実装（`decisions`は当四半期分のみ取得可能）。

## 5. ターン処理の流れ（turn-processing-engineのみ・未実装機能を含む）

`main`branchにはターン処理APIが存在しないため、以下は`claude/turn-processing-engine`ブランチのみの動作です。

1. 各プレイヤーが`/company/[id]?game=...`でフェーズ0〜6を入力し、「意思決定を提出する」を押す
2. `POST /api/game/[gameCode]/decisions`が`game:{gameCode}:decisions:{currentYear}Q{currentQuarter}:{companyId}`に保存
3. GMが`/gm/[gameCode]`で提出状況（5社中何社提出済みか）を確認
4. GMが「ターン処理を実行する」を押すと`POST /api/game/[gameCode]/process-turn`が呼ばれる
5. サーバー側処理（`process-turn/route.ts`）:
   - `game:{gameCode}`からセッション取得
   - `game:{gameCode}:company:{A〜E}`から各社の現在の財務状態を取得
   - `game:{gameCode}:decisions:{currentYear}Q{currentQuarter}:{A〜E}`から当四半期の意思決定を取得（未提出の会社は`undefined`）
   - 会社ごとに`resolveCompanyTurn()`（`app/lib/gameEngine.ts`）を実行し、新しい財務状態と結果を算出
   - 各社の新しい`CompanyState`を`game:{gameCode}:company:{id}`に上書き保存
   - `TurnResult`を`game:{gameCode}:results:{year}Q{quarter}`に保存
   - セッションの`currentYear`/`currentQuarter`を次の四半期に進め、`currentPhase`を0にリセットし、`history`配列に処理済み四半期キーを追加して`game:{gameCode}`を上書き保存
6. レスポンスとして更新後セッションと`TurnResult`を返し、GM画面がそれを表示
7. プレイヤーが再度ダッシュボードを開く（または「更新」ボタンを押す）と、`GET /api/game/[gameCode]`で最新の`CompanyState`を取得して画面に反映し、四半期が進んでいれば意思決定フォームをリセットする

**未実装（要確認/TODO）**：
- 全社が意思決定を提出したことを検知して自動でターン処理を促す仕組みはない（GMが手動でボタンを押すのみ）
- 同一四半期に対する`process-turn`の二重実行を防ぐガードはない（連続でボタンを押すと、2回目は次の四半期の意思決定（通常は空）で処理されてしまう）
- ゲームの終了条件・最終ターンの判定は存在しない（`currentYear`は際限なく増加し続ける）

## 6. 環境変数

| 変数名 | 用途 | 参照箇所 |
|---|---|---|
| `KV_REST_API_URL` | Upstash Redis REST APIのURL | `app/lib/redis.ts` |
| `KV_REST_API_TOKEN` | Upstash Redis REST APIのトークン | `app/lib/redis.ts` |

上記2つ以外に`process.env`を参照している箇所はコード全体を検索した限り存在しない。実際の値（トークン等）は本ドキュメントおよびリポジトリのいかなる場所にも記載しない。

## 7. Vercelとの関係・デプロイ方法

- リポジトリ内に`vercel.json`は存在しない。README.mdはcreate-next-appの標準テンプレートのままで、「Vercelへのデプロイが推奨」という一般的な記述のみ（プロジェクト固有のデプロイ設定の記載なし）。
- **要確認**：実際にVercelにデプロイされているか、デプロイ済みのURL、Upstash Redisとの連携（Vercel Marketplace経由か手動設定か）はコード上から確認できない。KV_REST_API_URL/TOKENという変数名はVercelのKV（Upstash連携）統合が使う命名規則と一致するが、これは推測であり確定情報ではない。
- CI/CD設定ファイル（GitHub Actions等）はリポジトリ内に存在しない。

## 8. データの読み書きの流れ（全体像）

```
[ブラウザ/クライアントコンポーネント]
   │  fetch()
   ▼
[Next.js API Route (app/api/**/route.ts)]
   │  redis.get() / redis.set() / redis.lrange() / redis.lpush()
   ▼
[Upstash Redis (REST API経由)]
```

- 認証・認可の仕組みはない。ゲームコードを知っていれば誰でも該当ゲームの閲覧・意思決定の提出・（turn-processing-engineブランチでは）ターン処理の実行が可能（**要確認**：本番運用を想定する場合はアクセス制御の検討が必要）。
- サーバーサイドでの入力値検証（バリデーション）はほぼ行われていない。`resolveCompanyTurn`内で一部の数値（養殖投入量の上限、VAP比率の0〜100範囲、返済額の残債務上限）はクランプされるが、それ以外（外部調達量の上限など）は未検証（詳細は`docs/parameter_spec.md`）。
