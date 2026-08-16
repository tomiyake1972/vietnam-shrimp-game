# Dynamic Scenario 1 — Testplay 手順（staging Preview）

対象ブランチ: `feature/v2-ds1-testplay-integration`
（`feature/v2-ui-procurement-planning` の UI 改装 ＋ `claude/v2-dynamic-scenario-1-v4bx8v` の DS1）

production の既定シナリオは **baseline のまま**。DS1 はタイトルに `— Development` を付けた
選択肢として並んでいるだけで、既定にはしていない。

---

## 0. 2つの経路の違い（AI経営会議を使うなら Company Lab 経路）

DS1 は2つの経路で遊べる。**AI経営会議（AI Management Meeting）を使いたい場合は
Company Lab 経路を選ぶこと。**

| | Management Console 経路 | Company Lab 経路 |
| --- | --- | --- |
| 入口 | `/v2/management/setup` | `/v2/company-lab/play/new` |
| 個社画面 | `/v2/management/player?run=…&company=…` | `/v2/company-lab/play/<labId>` |
| 状態の置き場 | ブラウザのタブ内（`liveSessionRegistry`） | Redis 上の Lab |
| 5社を横断で見る | できる | プレイヤー会社1社 |
| シナリオNews | 出る（Console 左カラム） | 出る（Player 画面の期初情報） |
| **AI経営会議** | **使えない** | **使える** |

Management Console の PLAYER Company Workspace で AI経営会議が使えないのは、
不具合でも消したのでもなく、その画面が設計上 Lab を作らない（会社状態がブラウザの
タブ内にしか無い）ため。AI会議 API は Redis 上の Lab を読む前提で作られている。
詳細は下の「AI経営会議」節を参照。

## 1. 入口（Management Console）

| 画面 | パス |
| --- | --- |
| ゲーム条件設定（Run 作成） | `/v2/management/setup` |
| Management Console（全体管理） | `/v2/management` |
| 個社画面（PLAYER Company Workspace） | `/v2/management/player?run=<simulationRunId>&company=<companyId>` |

`companyId` は `BAL` / `MASS` / `JPQ` / `VAP` / `CONSV` の5社。

## 2. Run の作り方（既存の初期化方法をそのまま使う）

1. `/v2/management/setup` を開く。
2. **1. Scenario** で `Dynamic Scenario 1 — Development（動的シナリオ1：8年間の構造変化）`
   のカードを選ぶ（32ターン）。
3. **2. Seed** はそのまま（`management-console-32q`）でよい。同じ Scenario ＋ 同じ Seed なら
   何度でも同じ展開を再現できる。
4. **3. 会社ごとの経営モード** で、自分で操作したい会社を `自分で操作`（PLAYER）にする。
   残りは `Standard AI` のままでよい。
5. `この条件でゲーム開始` を押す。`/v2/management?run=<simulationRunId>` へ遷移する。

`simulationRunId` はこのときブラウザ側で採番される。個社画面の URL はこの Run ID を含むため、
Run を作る前に URL を確定させることはできない。

## 3. Console → 個社画面

Console 右側の **Company Inspector** で、PLAYER にした会社の `この会社を操作` を押すと
`/v2/management/player?run=…&company=…` へ遷移する。

## 4. シナリオ News の読み方

Console 左カラム、Market Summary の下に `シナリオNews（Turn N）` という折りたたみがある。

- 表示されるのは「そのターンまでに公開されている記事」だけ。未来の記事は情報公開エンジン
  （`scenario/informationEngine.ts`）が構造的に落とすので、先読みはできない。
- `観測・噂` と `確報` のラベルが付く。噂は外れることもある。
- Turn 1 で 2件、Turn 6 で 14件（うち新着4件）、Turn 7 で 16件（うち新着2件）読める。
  Turn 6 の疾病の噂 → Turn 7 の確報、という並びが最初の分かりやすい山。

News は Run が始まっていないと出ない（`view` が無い＝まだ Run が無いため）。
`この条件でゲーム開始` を押した直後、Turn 1 の状態で既に読める。

## 5. Redis 保存について

Console の Run 保存は staging の管理セッションを使う。保存が 403 で失敗すると
Console 上部に赤いバナーが出るので、そこから `/v2/company-lab/play/login` で
管理トークンを入れて再ログインする。ログインしないままでもターンは進むが、保存されない。

## 6. AI経営会議（Company Lab 経路）

### 使い方

1. `/v2/company-lab/play/new` を開く（staging 管理トークンでのログインが要る）。
2. シナリオで `Dynamic Scenario 1 — Development（動的シナリオ1：8年間の構造変化）` を選ぶ。
   ターン数は 32 が自動で入る。
3. プレイヤー操作会社（BAL / MASS / JPQ / VAP / CONSV）を選んで `作成する`。
4. `/v2/company-lab/play/<labId>` の Decision Studio ヘッダー右端に
   **`AI Management Meeting を開く`** ボタンが出る。押すと右側にパネルが開く。

### 実装の所在（今回は一切変更していない）

| 層 | 場所 |
| --- | --- |
| ロジック | `app/lib/v2/companyLab/aiManagementMeeting/` |
| API | `POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages` |
| UI | `app/v2/company-lab/components/decisionStudio/AuxiliaryPanel.tsx` |
| Server Action | `app/v2/company-lab/play/[labId]/actions.ts` |
| 設計書 | `docs/v2/ai_management_meeting_mvp.md` |

入口の出し分けは `DecisionStudio.tsx` の `labId !== undefined` だけ。Company Lab の
Player 画面（`PlayerScreenClient.tsx`）は `labId={viewModel.labId}` を渡すのでボタンが出る。
Management Console の PLAYER Workspace は labId を持たないので出ない。

### AI会議へ渡っている context

`buildExplanationContext` 経由で `scenarioId` / `turn` / `year` / `quarter` / `companyId` /
fixture / ownState / publicInfo / Standard AI diagnostics が渡る。API は
`turn !== viewModel.currentTurn` を 404 で弾くので、常に「今のターン」の会議になる。

**シナリオNews は AI会議へは渡っていない。** `briefing.ts` は informationReleases を
参照しない。News を会議 context へ入れるには新規配線が要るため、今回は実装していない。

### ANTHROPIC_API_KEY が無い場合

500 にはならない。`generateMeetingResponse` が `missing_api_key` を返し、API は
**HTTP 200 ＋ `available: false` ＋ `unavailableReason`** を返し、AuxiliaryPanel が
赤いインライン注記を出す。ゲーム状態には一切影響しない（このAPIは書き込み経路を持たない）。
モデルの指定は `AI_MANAGEMENT_MEETING_MODEL`（任意）。

## 7. 今回触っていないもの

- `main` / `develop/v2` へは merge していない。
- Production deploy はしていない（deploy 先は staging プロジェクトの Preview のみ）。
- Production の既定シナリオは変更していない。
- Player 画面（`/v2/company-lab/play/...`）のレイアウトは UI 改装ブランチのものをそのまま
  維持している（DS1 側の古い画面で上書きしていない）。
