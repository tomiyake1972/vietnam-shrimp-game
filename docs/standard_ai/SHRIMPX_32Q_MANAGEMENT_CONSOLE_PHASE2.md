# ShrimpX 32Q Management Console — Phase 2 設計と実装

Phase 1（commit `674643b`）で残っていた2つの課題を解消し、Analysis 画面に
Overview / Market / Bottleneck / AI Trace の中身を実装した記録。

**今回もゲームルール・Standard AI の判断ロジックは変更していない。**
engine が Standard AI を呼ぶ回数・引数・戻り値の使い方は Phase 1 と同一であり、
追加したのは「Standard AI が既に計算していた診断値を捨てずに保持する」ことだけである。

---

## 0. Phase 1 の残課題と、その原因

| 課題 | 症状 | 原因 |
|---|---|---|
| A | ブラウザをリロードすると Simulation 結果が消える | 実行結果が React の state にしか存在せず、どこにも保存されていなかった |
| B | Management Console と Analysis が別々の結果を見ている | Analysis 画面が自分でもう一度32Qを回していた |

両方とも根は同じで、**「1回の実行が simulationRunId を持つ1つの保存物になっていなかった」**
ことにある。Phase 2 はまずこの構造を作った。

---

## 1. 全体構造

```
engine.ts（実行）
   │ 1ターンごとに
   │   ・Standard AI が既に計算した診断値を抜き出す（extractAiTurnTrace）
   │   ・そのターンに公開されていた観測需要を写す（captureObservedDemand）
   │   ・期末の営業人員数・実効能力を拾う
   ▼
SimulationSession
   │ buildDatasetFromSession
   ▼
SimulationAnalyticsDataset（long-format の事実表）
   │ StoredSimulationRun = { schemaVersion, run, dataset, savedAt }
   ▼
simulationRunStore（クライアント）
   ├─ localStorage（必ず保存）
   └─ /api/v2/simulation-runs → Redis（可能なら保存）
   ▼
Management Console ／ Analysis
   どちらも simulationRunId で同じ StoredSimulationRun を読む
```

**Console も Analysis も、描画に使うのは常に `dataset` である。**
実行直後もリロード後も同じ経路であり、「実行中は state から、復元後は dataset から」
という二重経路は作っていない。これが A と B の再発防止になっている。

---

## 2. 何を保存し、何を保存しないか

保存するのは次の2つだけ。

1. `SimulationRun`（再現に必要な条件：scenarioId / seed / パラメータ版 / 停止理由など）
2. `SimulationAnalyticsDataset`（確定済み実績から導いた事実表）

**`CompanyLabState` をそのまま保存していない。**
会社ラボ本体の `CompanyLabRuntimeSnapshot` が「history をスナップショットへ絶対に含めない」
という設計で保存量の二次関数的増大を防いでいるのと同じ理由である。

### 実測（`scripts/simulationRunPayloadSize.ts`、32Q・5社）

| | サイズ |
|---|---|
| 保存物（run + dataset） | **2,220 KB** |
| 参考：`CompanyLabState` 全体 | 12,378 KB |
| 削減率 | **82.1 %** |

内訳（KB）: aiTrace 1,177 / marketMetrics 310 / salesTrace 350 / companyMetrics 284 /
producerCountry 49 / hiring 25 / bottleneck 22 / investment 1。

保存量を抑えるために入れた工夫（いずれも意味を変えない）:

- `AiTraceItem` の `value` / `unit` / `text` を optional にし、値の無いキーを持たせない
- 値の無い会社指標は行そのものを作らない（行の不在＝記録が無い）
- 販売トレースは希望・計画・成約がすべて0の市場×商品の行を作らない
- 理由コードは1段階あたり12件を上限とし、**超過分は「省略N件」として明示する**（黙って切らない）

### 既存 turn history の利用

`dataset` の値はすべて `CompanyQuarterRecord`（会社ラボが既に持っている確定履歴）から
取り出している。engine へ新しく記録を足したのは、記録に残らず消えてしまう次の4つだけ。

| 追加した記録 | なぜ必要か |
|---|---|
| `aiTurnTraces` | Standard AI の診断は戻り値として捨てられていた（再現には AI の再実行が要る） |
| `observedDemand` | そのターンに公開されていた観測需要は `PublicMarketInfo` にしか無い |
| `salesHeadcountByTurn` | `salesForceHiringState` は現在値のみで、ターンごとの値が残らない |
| `capacityByTurn` | 実効能力は fixtures + capexState からの導出値で、記録に残らない |

いずれも会社数ぶんの小さな値であり、四半期ごとに二次関数的に増えることはない。

---

## 3. 保存先（2系統）と、その選び方

| | 内容 |
|---|---|
| `browser` | このブラウザの localStorage。**必ず**書く。上限2本（1本 約2.2MB、localStorage の一般的上限 約5MB に対する余裕） |
| `server` | `/api/v2/simulation-runs` → Redis（`v2:simulationRun:*`）。上限20本 |

サーバー保存は既存の会社ラボ API と同じ認証方針で、
`Authorization: Bearer {STAGING_ADMIN_TOKEN}` **または** Company Lab UI のセッションCookie を要求する
（本番環境では常に403）。認証が無い環境ではサーバー保存が403で失敗するが、
**その事実を握りつぶさず画面に出す**：

```
保存先: サーバー（Redis）＋このブラウザ
保存先: このブラウザのみ（サーバー保存に失敗しました（HTTP 403））
```

localStorage が容量超過した場合も、古い実行を消して1回再試行し、
それでも入らなければ理由（サイズつき）を画面へ出す。

### Redis キー空間

```
v2:simulationRun:index                （production。保存順ZSET）
staging:v2:simulationRun:index        （staging）
v2:simulationRun:{simulationRunId}
v2:simulationRun:{simulationRunId}:summary
```

会社ラボ（`v2:companyLab:*`）・本番ゲーム（`v2:game:*`）とは完全に別の名前空間で、
`assertAllowedSimulationRunKeys` が書き込み前に prefix を検証する（テスト P2-21 / P2-22）。
保存は「本体SET + 要約SET + indexへZADD + 上限超過分の追い出し」を1本の Lua で行う。
一覧は要約キーだけを読むため、dataset 本体を毎回読まない。

---

## 4. Active / Selected Simulation Run と A/B 比較

- **Console**: `localStorage` の active run を選択状態として持つ。起動時にそれを復元する。
- **Analysis**: URL の `?run=<simulationRunId>` を最優先し、無ければ active run を使う。

Console から Analysis へのリンクには常に `?run=` が付く。
選択状態が URL 側にあるため、**2つのタブで別々の実行を並べても互いを壊さない**
（A/B比較のための最低条件）。Run selector は保存が新しい順に
`Current / Previous 1 / Previous 2 …` として並べる。

**Analysis は Simulation を実行しない。**
これは規約ではなく構造で担保しており、テスト P2-23 が
`app/v2/management/analysis/` 配下の import 行に `simulation/engine` /
`companyLab/runner` / `standardAi/policy` が現れないことを機械的に検査する。

### 保存物に途中状態を含めない、という判断

保存物は「実行し終えた結果」であり、続きから進めるための状態ではない。
保存済み実行を表示している状態で実行ボタンを押すと、**新しい実行として開始する**
（画面にもその旨を出す）。途中から再開できるふりをしないための意図的な設計である。

---

## 5. 共有 analytics layer（将来の xlsx exporter を想定）

`app/lib/v2/companyLab/simulation/analytics/`

| ファイル | 役割 |
|---|---|
| `types.ts` | long-format の事実表の型・指標キー・ラベル・単位 |
| `dataset.ts` | 確定記録 → 事実表（**再計算しない・捏造しない**） |
| `aiTrace.ts` | Standard AI の診断 → 6段階トレース |
| `views.ts` | 事実表 → 画面用の系列・ヒートマップ |

選択の軸は **SimulationRun / Company / Turn / Market / Product / Metric / Visibility** に統一してある
（`AnalyticsSelector`）。1行1事実の形なので、Excel の1シートへそのまま流せる。
xlsx exporter 自体は本Phaseでは実装していないが、この型を変えずに後から足せる。

---

## 6. TRUE WORLD と OBSERVABLE

| | 出所 | 意味 |
|---|---|---|
| TRUE WORLD | `salesRecord.allocations[].targetDemand` | その四半期に実際に成立した対象需要 |
| OBSERVABLE | `companyLab/marketDemandObservation.ts` | プレイヤーと Standard AI が見ている**2四半期前の実績** |

この2つは「同じ量を精度違いで測ったもの」ではなく**時点が違う**。
同じ系列として誤解されないよう、3重に区別している。

1. 既定では片方だけを表示する（TRUE / OBSERVABLE / 両方を重ねる の3択）
2. 重ねたときは OBSERVABLE を**破線**にし、凡例のラベルにも `（OBSERVABLE・2Q遅行）` と書く
3. チャートの上に、時点が違うことを明記した注記を常時表示する

**Standard AI へ TRUE WORLD を流していない。**
analytics layer は意思決定経路に一切登場せず、engine は従来どおり
`buildPublicMarketInfo` 経由の観測値だけを Standard AI へ渡す。

価格は配分結果の `basePrice` をそのまま表示する（analytics 用の独自価格計算はしない）。

---

## 7. GLOBAL PRODUCER DATA と、#04 への申し送り

Market タブの GLOBAL PRODUCER DATA は**産地国（VN / EC / IN / ID）の生産・輸出データ**であり、
「どの消費市場を、どの産地国が何％取ったか」（consumer-market supply share）**ではない**。
画面上にもその旨を明記している。

### ENVIRONMENT CANDIDATE（#04 への申し送り）

市場×産地国の供給フロー／シェアは、現在のゲームエンジンに**存在しない**。

- 市場側は `targetDemand`（ベトナム産5社が獲得対象にできた需要）しか持たない
- 産地国側は `exportableSupply` / `allocatedDemand`（世界合計に対する配分）しか持たない
- 両者を結ぶ行列がどこにも定義されていない

したがって今回、その数字は作らなかった。環境モデル候補として #04 へ申し送るのは次の1点である。

> 各市場の需要を産地国別に配分する行列を市場モジュールへ導入し、その結果として
> `targetDemand` がベトナム産の取り分として導かれる構造にするかどうか。
> 導入すると、産地国の品質・信頼性・価格差が市場ごとのシェアへ効く因果が表現できる。

この申し送りは Market タブの画面上（折りたたみ）にも同じ内容で置いてある。

---

## 8. Bottleneck

### ヒートマップ（5社 × 32Q）

- 色 = 主要因（原料不足 / 設備能力不足 / 労働力不足 / 律速なし）
- 濃さ = **その会社の中での**相対的な不足量
  （会社ごとに規模が違うため、全社共通の絶対スケールにすると小さい会社の律速が潰れる）

**生成AIによる分類をしていない。**
判定は `companySummaries` に既にある3つの不足量の大小比較だけで決まり、
同点のときは 原料 → 設備 → 労働 の順で決める（実行ごとに揺れない）。テスト P2-8 で固定。

### 遷移ビュー

「Q3 で BAL の律速が 原料不足 → 設備能力不足 に変わった」という切り替わり点だけを一覧する。
変化しなかったターンは行にしない（テスト P2-9）。

---

## 9. AI Trace（6段階）

**新しい巨大な logging system は作っていない。**
Standard AI は `generateStandardAiDecisionWithDiagnostics` の中で
observation / pressures / situationDiagnosis / salesWish / decision を**既に計算している**。
Phase 1 はその `diagnostics` を捨てていたので、捨てずに保持するようにしただけである
（Standard AI を2回呼ぶようなことはしていない）。

| 段階 | 出所 |
|---|---|
| ① OBSERVED | `pressures`（前期稼働率・想定原料価格・最低現金バッファ・市場価格順） |
| ② DIAGNOSED | `situationDiagnosis`（主要制約・第2の制約・各充足率）＋圧力スコア |
| ③ WANTED | 営業工数制約**前**の販売希望量・基本生産必要量・必要原料・理論必要Worker・希望借入額 |
| ④ CONSTRAINED | 希望と提出値の差・能力余力・Worker余力・**AI自身が付けた理由コード** |
| ⑤ DECIDED | 実際にゲームへ提出した意思決定そのもの |
| ⑥ RESULT | 確定後の `companySummaries` / `financialResults` |

**生成AIで理由を補完していない。** 記録に無い項目は「－」と表示する。
`situationDiagnosis` の各 `*Ratio` は算出不能時に NaN を保持する規約のため、
対応する `*State`（`"unknown"`）で判定してから表示する（NaN を数値として出さない。テスト P2-14）。

下に販売トレース（希望 → 計画 → 成約）／採用トレース／投資トレースを並べる。

### Company Inspector も同じ記録を見るようにした

Phase 1 の Company Inspector は、表示のたびに Standard AI をその場で呼び直していた
（画面専用の実行経路）。Phase 2 では実行時に記録した AI Trace だけを見る。これにより

- 画面の表示と、実際にゲームへ提出された判断が食い違わない
- 保存済み実行をリロード後に開いても同じ内容が出る

の2点が同時に満たされる。

---

## 10. Strategy Profile

**今回も Standard AI の数値判断へは接続していない。** 表示のみ。
Mission / Vision は既定が空で、それらしい文言を自動生成していない。

---

## 11. 品質ゲートの結果

| 項目 | 結果 |
|---|---|
| `npm test` | **2,590 pass / 0 fail**（Phase 1 時点 2,558 → 新規32件） |
| `tsc --noEmit` | 0 error |
| `eslint .` | 0 error（既存 warning 7件のみ） |
| `next build` | 成功 |

新規テスト: `simulationPersistence.test.ts`（P2-1〜P2-27）、
`app/api/v2/simulation-runs/_lib/__tests__/handlers.test.ts`（API-1〜API-5）。

### ブラウザ検証（Playwright / production build）

デスクトップ 1440×900・タブレット 1024×768。

| 確認項目 | 結果 |
|---|---|
| 32Q 実行 | `32 / 32`、`Simulation Complete — 32 / 32 Turns` |
| 32Q の所要時間 | **1,148 ms**（うちエンジン処理 約630ms、残りは 2.2MB の保存とチャート再描画） |
| **リロード後**（課題A） | `32 / 32` が残り、`simulationRunId` も同一 |
| **Analysis が同じ run**（課題B） | 同じ `simulationRunId`、BAL 売上 Console `77.0M` = Analysis `77.0`（百万） |
| Analysis タブ4種 | Overview / Market / Bottleneck / AI Trace すべて描画 |
| TRUE / OBSERVABLE | 実線5系列・破線5系列、重ねると凡例に両方のラベル |
| GLOBAL PRODUCER DATA | 「消費市場シェアではない」注記を確認 |
| AI Trace 6段階 | OBSERVED / DIAGNOSED / WANTED / CONSTRAINED / DECIDED / RESULT |
| Run selector | 2本を保存し、前の実行へ切り替えると `32 / 32` へ戻る |
| STOP の保存 | `Stopped by user — Completed 16 / 32 Turns` → リロード後も `16 / 32` |
| 横スクロール（1024px） | 0px |
| `pageerror` | 0件 |

備考: この検証環境には `STAGING_ADMIN_TOKEN` を設定していないため、サーバー保存は
期待どおり HTTP 403 となり、画面には
`保存先: このブラウザのみ（サーバー保存に失敗しました（HTTP 403））` と表示された
（＝失敗を握りつぶしていないことの実地確認にもなっている）。

---

## 12. 通常ゲームへの影響

- ゲームルール・Standard AI の判断ロジックは変更していない
- `advanceCompanyLabQuarter` / `buildPublicMarketInfo` / `generateStandardAiDecisionWithDiagnostics`
  の呼び出し方は Phase 1 と同一
- 会社ラボの永続化スキーマ（`CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION = 7`）は変更していない
- 追加した Redis キー空間は会社ラボ・本番ゲームと分離している
- `npm test` 全2,590件が通っている（既存2,558件の期待値を書き換えていない）

---

## 13. 本Phaseで実装していないこと（正直な残り）

- Analysis の Product / Operations / Sales / Profitability / Investment / Finance /
  Strategy / Scenario タブ（器のみ。中身が無いことを画面に明記している）
- xlsx exporter（analytics layer は流し込める形にしてあるが、出力処理自体は未実装）
- 保存済み実行の「続きから再開」（保存物に途中状態を含めない設計のため）
- 市場×産地国の供給フロー（§7 のとおり、エンジンに存在しないため作らなかった）
- Strategy Profile の Standard AI 判断への接続
