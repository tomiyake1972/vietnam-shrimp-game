# Dynamic Scenario 1 — Testplay 手順（staging Preview）

対象ブランチ: `feature/v2-ds1-testplay-integration`
（`feature/v2-ui-procurement-planning` の UI 改装 ＋ `claude/v2-dynamic-scenario-1-v4bx8v` の DS1）

production の既定シナリオは **baseline のまま**。DS1 はタイトルに `— Development` を付けた
選択肢として並んでいるだけで、既定にはしていない。

---

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

## 6. 今回触っていないもの

- `main` / `develop/v2` へは merge していない。
- Production deploy はしていない（deploy 先は staging プロジェクトの Preview のみ）。
- Production の既定シナリオは変更していない。
- Player 画面（`/v2/company-lab/play/...`）のレイアウトは UI 改装ブランチのものをそのまま
  維持している（DS1 側の古い画面で上書きしていない）。
