# UI-TRIAL-1 — 予行演習前の Player UI 整理

対象: ShrimpX V2 / 基点 `d45b0bfe52cffb8f0f8031a4f7205b7dd7896cae`（BW-1 を含む）
branch: `integration-prep/v2-int1-training-candidate`
作成: 2026-10-09（JST）

目的は「どこを入力するか」「何を提出するか」が分かる Player 画面にすること。
範囲は 3 点（営業配員の整理 / 入力と参照の区別 / 提出前の最終確認）に限定し、
ゲーム計算・新しい予測機能は追加していない。

---

## 1. 営業配員の入力単位（市場ごとに 1 つ）

修正前は市場×商品の 1 枚の表で、全 15 行（5 市場 × 3 商品）それぞれに営業人員の
入力欄があった。同一市場の 3 行は常に同じ値へ同期される仕様
（`syncMarketSalesForceHeadcount`）なので値は壊れていないが、同じ人数を 3 回見せて
3 回編集できる形だった。

修正後:

- 市場ごとのブロックへ組み替え、営業配員の編集欄は市場ごとに 1 つだけ。
- その下に HOSO / PD / VAP の販売数量・価格調整を並べる（市場×商品単位のまま）。
- 営業人員の総数・配員済み・未配員／超過を 1 か所にまとめ、超過時は警告を出す。
- 「配員人数（当期の割り振り）」と「採用人数（次期から効く）」を文言で区別。
- 配員可能人数・超過判定・採用上限は既存の共有ロジックの結果をそのまま表示する
  （`summarizeSalesForceAllocation` / `summarizeSalesForceHiring` /
  `computeMaxSalesHiresPerQuarter`）。画面独自の算式は作っていない。
- 編集は既存の `syncMarketSalesForceHeadcount` をそのまま呼ぶため、提出データの形
  （市場×商品の全行が同じ人数を持つ）は変わらない。
- 狭い画面向けに、市場ブロックの見出しに加えて各商品行へ市場を併記する
  （例「HOSO（CN）」）。入力欄には対象込みの読み上げ名を付けた。

---

## 2. 入力欄と参照情報の区別（全入力画面）

既存の色の取り決め（`panelStyles.ts` の `AREA_TONES`、入力＝青／情報＝灰）はそのまま使い、
色だけに頼らない表現を共通部品 `components/FieldAnnotations.tsx` に 1 か所だけ用意した。

- `DecisionAreaHeading` … 入力エリアの先頭に「今期の意思決定」と対象 Turn／四半期。
  すでに進行済みの四半期では出さない。
- `AiInitialProposalNote` … 「AI提案を初期入力済み」「まだ提出していません」。
  項目ごとの AI 由来／手動由来は、変更履歴を保存していないため推測表示しない
  （その旨も画面に書く）。
- `ReferenceValue` / `ReferenceBadge` … 参照値に種別を付ける。
  種別は 前期実績 / 現在の状態 / 参考値 / 自動計算値 の 4 つだけ。
- `ColumnHeader` … 入力列と読み取り専用列が混ざる表で、見出しにどちらかを書く。
- `InputFieldLabel` … 入力欄に 項目名・単位・対象（市場／商品／工場／全社）を書く。

適用した画面:

| 画面 | 主な適用箇所 |
|---|---|
| SALES | 市場ブロックの配員欄、商品行、採用・減員、前Turn基準価格／参考提示 |
| WORKER | 工場別の表の列見出し（増減員・臨時人数・残業率が入力、他は参照） |
| PRODUCTION | 生産計画の表の列見出し（商品別能力＝現在の状態、生産希望量・優先度＝入力） |
| PROCUREMENT | 国内買付・輸入・養殖の入力欄のラベル、輸入の表の列見出し、価格/参考情報の種別 |
| INVESTMENT | PD省人化の工場別の表（全列が参照）、対象工場・VAP商品開発費のラベル、ポートフォリオ等の種別 |
| FINANCE | 既存借入の表（全列が現在の状態）、借入希望額・期間・期限前返済・種別・返済方式・配当額のラベル |

借入と配当の入力欄には、入力欄のすぐそばに「申請額です。実行額ではありません」を書いた。

---

## 3. 提出前の最終確認画面

両経路とも 入力 →「意思決定を確認」→ 最終確認画面 →「この内容で確定／提出」。
画面は共通コンポーネント 1 つ（`DecisionConfirmationScreen.tsx`）で、文言だけ経路ごとに変える。
一覧の組み立ては純粋関数 `decisionSummary.ts` が行い、下書き（と管理者指定配当の既存契約）
以外は参照しない。

確認画面を開いただけではサーバーへ何も送らない（この component は `fetch` も `useEffect` も
`setInterval` も持たない。テストで機械的に確認している）。

### 3-1. 実際の提出値との照合（実測にもとづく）

実測スクリプト: `scripts/int1/probeSalesForceZeroRows.ts`

**(a) 数量 0 の販売行に営業配員を入れた場合**

営業配員は `salesPlans` の各行が持つ値として提出される。
`buildDecisionInputFromDraft` は数量 0 以下の行を落とすため:

| 条件 | 提出される配員 | engine が数える合計 |
|---|---|---|
| その市場の商品行が 1 つでも数量 > 0 | 提出される（市場ごとに 1 回） | 含まれる |
| その市場の全商品行が数量 0 | **提出されない**（行自体が消えるため） | 含まれない |

実測値（BAL・配分可能 60 人・下書きの配員 CN11/US20/EU15/JP8/OTHER6）:

- CN の全商品を 0 にして配員 9 人 → 提出される市場は US/EU/JP/OTHER のみ。
  engine が数える合計は **49 人**。画面の「配員済み」は下書きの合計 58 人で食い違う。
- CN の HOSO だけ 100 t にすると CN の 1 行が提出され、配員 9 人も提出される。
  engine が数える合計は **58 人**。

→ 確認画面では、全商品が 0 の市場の配員を「提出されません」と理由付きで示し、
合計も「提出される営業配員 合計」に変えて、入力の合計との差を注記するようにした。

**(b) トップレベルのキーだけでなく重要な内訳**

工場×商品ごとの **生産の優先順位** を一覧へ追加した（能力が足りないときの処理順）。
未入力は提出時に 1 として扱われる旨も書く。数量 0 で落ちる行は優先順位も提出されない。

**(c) 管理者指定配当と PLAYER 自身の配当指示**

- PLAYER の行は「配当 希望額（PLAYERの指示）」。管理者指定がある場合は
  「下の管理者指定（年度末の自動精算）とは別の指示で、互いを打ち消しません」と書く。
- 管理者指定の行は「管理者指定の配当性向（PLAYERの入力ではありません）」とし、
  提出対象ではない（`submitted: false`）ものとして扱う。区分も 申請 と 確定済み で分ける。

### 3-2. 提出フィールドの棚卸し

`buildDecisionInputFromDraft` が返す全キーと確認画面の行の対応を、単体テスト
（`uiTrial1Confirmation.test.ts` UIT1-C1）が機械的に検査する。提出フィールドを増やして
確認画面へ出し忘れるとテストが落ちる。

---

## 4. 工場操作（休止・再稼働・売却）の残件

指示どおり「Decision Studio にない」と「PLAYER がどの経路でも操作できない」を区別して調査した。
**この版では新しい工場操作 UI は実装していない。**

### 4-1. 基点 `d45b0bf` に存在するもの

| 層 | 状態 |
|---|---|
| Engine | **あり**。`capex/factoryLifecycle.ts`（状態遷移・妥当性判定）、`capex/factoryDisposal.ts`（維持費・売却損益） |
| 受け口 | **あり**。`CompanyDecisionInput.factoryLifecycleDecisions`、`runner.ts` が取り込む |
| 保存 | **あり**。`persistence/schema.ts` が `MOTHBALL_FACTORY` / `REACTIVATE_FACTORY` / `SELL_FACTORY` を検証 |
| 読み取り側 | **あり**。export DTO・processingForecast・investmentPlanning の各 view model が lifecycle 状態を反映 |
| Standard AI | 容量認識はするが、**決定は生成しない** |

### 4-2. 決定を作る経路

| 経路 | 状態 |
|---|---|
| Decision Studio（PLAYER の入力画面） | **無い** |
| GM Console | **無い**（`app/v2/management/**` に工場操作 UI は存在しない） |
| API | **無い**（`app/api/**` に `factoryLifecycleDecisions` を受ける口は無い） |
| 自動方針・Standard AI | **生成しない** |
| 検証用スクリプト・テスト | あり（`scripts/factoryLifecycle*Probe.ts` 等が直接 `CompanyDecisionInput` を組み立てる） |

→ **結論: この版では PLAYER はどの経路でも工場操作を提出できない。**
「Decision Studio に無い」だけでなく「他の経路も無い」。

### 4-3. 未統合の成果

remote branch **`feature/v2-player-factory-actions`**（`a65a61cd359f604b087727b9ba24fbdefafdad6a`）に、
まさにこの機能の実装が 1 commit 入っている。

```
commit  a65a61cd359f604b087727b9ba24fbdefafdad6a
件名    feat(player): Independent Player FlowへFactory Lifecycle操作を接続（Phase 1）
基点 d45b0bf に無い commit   1 本
この branch に無い commit   43 本
merge-base                  35e259fba8522f5b62cbb23c03948b78dcdc963e
```

含まれるもの（commit メッセージと差分より）:

- `CompanyDecisionDraft.factoryLifecycleDecisions` の新設と `buildInitialDraft` /
  `buildDecisionInputFromDraft` への接続
- `app/v2/company-lab/factoryLifecycleDraftActions.ts`（1 工場につき 0/1 件の選択を管理）
- `app/v2/company-lab/factoryOperationsViewModel.ts`（帳簿価額・見込代金・見込損益・維持費を
  既存 Engine 関数から組み立てる表示専用の純粋関数）
- `InvestmentPlanningScreen.tsx` へ工場ごとの状態・候補操作・確認情報を出す新セクション
- 新規ユニット/統合テスト 22 件、Independent Player Flow 経由の Playwright E2E

→ **「未実装」ではなく「未統合」**。ただし基点より 43 commit 遅れているため、
そのまま取り込むことはできず、再統合の作業が要る。今回はその判断材料までを報告し、
取り込みは行っていない。

### 4-4. 確認画面の説明

確認できた範囲の事実だけを書く。未統合 branch の話は利用者の操作に関係しないため画面には出さない。

> 工場の一時休止・再稼働・売却は、この版では提出できません。PLAYER画面にもGM画面にも
> 入力欄が無く、どの経路からも提出されません（ゲームの処理側には受け口がありますが、
> 決定を作る画面がありません）。この確認画面にも提出対象として表示しません。

---

## 5. 報告の訂正（日時）

前回報告の末尾「2026年10月09日 00:15 JST」は誤り。
この作業環境のローカル時刻は UTC（`/etc/timezone` = `Etc/UTC`）で、その 00:15 を JST と誤記していた。

- 正しくは **2026-10-09 09:15 JST**（UTC 00:15）。
- 各ログに埋めた時刻（`### DATE: 2026-10-09 09:11 JST` など）は `TZ=Asia/Tokyo` で生成しており正しい。
- BW-1 の commit は `2026-10-08 23:23 UTC` ＝ **2026-10-09 08:23 JST**、
  Preview の READY は 08:26 JST。UI-TRIAL-1 の報告（09:15 JST）はその後であり、時系列は整合する。

---

## 6. 検証結果と残件

### 6-1. 実行した検証（この環境での実測。司令塔が再実行したものではない）

| 検証 | 結果 | ログ |
|---|---|---|
| 型チェック `npx tsc --noEmit -p .` | 0 件 | `logs/uitrial1-tsc.log` |
| Lint `npx eslint`（変更/新規 .ts・.tsx 31 件） | 0 件 | `logs/uitrial1-eslint.log` |
| UI-TRIAL-1 単体テスト 4 ファイル | 41/41 成功 | `logs/uitrial1-unit-tests.log` |
| 全体 `npm test` | 4523/4523 成功 | `logs/uitrial1-npm-test.log` |
| 全体 Playwright E2E | 40 成功 / 2 失敗 | `logs/uitrial1-e2e-full.log` |
| 営業配員の実測 probe | — | `logs/uitrial1-sales-force-zero-rows-probe.log` |
| 既存flakinessの基点対照 | 基点でも同じ失敗 | `logs/uitrial1-e2e-flaky-base-control.log` |

`npm run build` は CLAUDE.md 記載の既知事象（V1既存route の `STAGING_KV_REST_API_URL` 未設定で停止）のため、
型チェックと E2E 用 dev server で代替している。

### 6-2. E2E の残り 2 件の失敗（UI-TRIAL-1 の変更によるものではない）

失敗したのは `e2e/managementSalesModelSelector.e2e.ts` の 2 件
（`:54` MC-SALES-E2E、`:166` MC-SALES-E2E-crowding）。どちらも同じ症状で、
GM が Turn を進めたあと `turn-counter` が `1 / 32` のまま 120 秒タイムアウトする。

切り分け:

1. 同じファイルを単体で実行すると 5 件すべて数秒で成功する
   （`logs/uitrial1-e2e-regression.log`: 6.1s / 1.5s / 2.0s / 2.0s / 2.8s）。
2. **INT-1 承認基点 `e7c92839ab26b21bf98d029cdd52e37e7c34c419`**（BW-1 も UI-TRIAL-1 も
   入っていない tree）を別 worktree に checkout し、同じファイルを `--repeat-each 3` で
   実行すると、`MC-SALES-E2E-crowding` が **同一の症状で失敗**する（1 failed / 14 passed）。
   `playwright.config.ts` の workers は 1 なので、並列負荷ではなく逐次実行で再現している。

→ この失敗は UI-TRIAL-1 でも BW-1 でもなく、**INT-1 基点から存在する既存の不安定さ**。
根本原因は未特定。UI-TRIAL-1 の範囲外の残件として記録する。

なお、UI-TRIAL-1 の作業中に E2E ヘルパー側の本物の競合を 1 件見つけて直している
（`e2e/_lib/decisionFlow.ts`。クリック直後に `count()` を見て「確認画面が出ていない＝検証エラー」と
誤判定し、何も押さずに戻っていた）。これは修正済みで、修正により全体E2Eの失敗は 2 件のうち 1 件減った
（残ったのが上記の既存flakiness）。

### 6-3. 残件

- `managementSalesModelSelector.e2e.ts` の既存flakiness（上記 6-2）。
- 工場操作（休止・再稼働・売却）の UI。未統合 branch `feature/v2-player-factory-actions` の
  再統合判断が必要（上記 4-3）。
- BW-1 §5 の共有 Staging 実機プレイ検証。Upstash の再開待ちで未実施。
