# ShrimpX 32Q Management Console — Phase 1

作成日: 2026-08-09
branch: `feature/v2-32q-management-console`
base: `feature/v2-test16-balance-foundation` (06705b3)

---

## 1. Branch topology（実測）

`git fetch --all` 後に祖先関係を確認した結果、**Test16 が他系統をすべて含む一直線の系統**だった。

```
develop/v2 (90d67bc)
   └─ …109 commits… ─→ feature/v2-test16-balance-foundation (06705b3)
feature/v2-test15-integration (1bd8db6)
   └─ …24 commits…  ─→ 同上
feature/v2-standard-ai-market-aware-sales (71cc788)
   └─ …17 commits…  ─→ 同上
```

検証コマンドと結果:

| 確認 | 結果 |
|---|---|
| market-aware sales は Test16 の祖先か | **YES**（既に取り込み済み） |
| Test15 integration は Test16 の祖先か | **YES** |
| develop/v2 は Test16 の祖先か | **YES** |
| develop/v2 に Test16 が持たないコミットはあるか | **なし**（0件） |

### 判断: merge / cherry-pick / rebase は**不要**

Test16 HEAD が唯一の最新点であり、そこから分岐するだけで
「最新Test16ゲーム環境」と「market-aware Standard AI」の両方が揃う。
競合リスクが無いため、停止せずそのまま作業した。

```
feature/v2-32q-management-console  ← feature/v2-test16-balance-foundation (06705b3)
```

develop/v2・main へは merge していない。

---

## 2. Architecture

```
app/lib/v2/companyLab/simulation/
  types.ts    SimulationRun / SimulationSession / stopReason
  engine.ts   createSimulationSession / advanceSimulationTurn / advanceSimulationTurns
  series.ts   buildCompanySeries / buildCompanyInspectorSnapshot（表示用の抽出のみ）

app/lib/v2/companyLab/strategyProfile/
  types.ts    Mission / Vision / StrategyProfile / effectiveFromTurn

app/v2/management/
  page.tsx                       経営管制室
  components/ManagementConsole.tsx  Run Control + Overview + Inspector
  components/TrendChart.tsx         インラインSVGの折れ線（新規依存なし）
  components/CompanyInspector.tsx   会社詳細
  components/MarketSummary.tsx      市場サマリー（TRUE WORLD 明示）
  analysis/page.tsx / AnalysisShell.tsx   Analysis（Phase 1 は Overview のみ）
```

### fast-run 専用ロジックを作っていない

1ターンの処理は通常ゲームとまったく同じ経路だけを通る。

```
buildPublicMarketInfo
  → buildCompanyOwnState（会社ごと）
  → generateStandardAiDecisionWithDiagnostics（会社ごと）
  → advanceCompanyLabQuarter（環境進化・生産・財務クローズ）
```

1 Turn / 4 Turns / 32 Turns は、この処理を**その回数だけ**繰り返すだけである。
テスト `CONSOLE-14` で、手書きループで回した履歴と Console 経由の履歴が
**完全に一致する**ことを検証している（Console が介入していない証明）。

### 実行場所

エンジンは純粋 TypeScript で Node 専用 API に依存しないため、**ブラウザ内で実行**する。

- 1ターンごとに再描画 → 進捗が実測値になる（水増しなし）
- STOP はクライアント側のループが次ターンへ入る前に止まる（本物の中断）
- サーバ状態・Redis を使わないため、既存 Player 系の永続化に一切影響しない

実測: **32Q が約0.7秒**（desktop / tablet とも）。

---

## 3. SimulationRun

```ts
simulationRunId / scenarioId / scenarioVersion / seed
gameParameterVersion / standardAiVersion / strategyProfileVersion
startingTurn / requestedTurns / completedTurns
startedAt / completedAt / stopReason / errorMessage / failedAtTurn
```

- `gameParameterVersion` = production + finance の parametersVersion を連結
- `standardAiVersion` = StandardAiParameters に版番号フィールドが無いため、
  再現性に効く主要パラメータから決定論的な指紋を作る（**存在しない項目を捏造しない**）
- `stopReason` は `running / completed / stopped_by_user / error / scenario_end` を区別する

---

## 4. UI layout

```
TOP BAR : Scenario / Turn N/32 / Simulation Run ID / [1 Turn][4 Turns][32 Turns][STOP][Reset][Analysis]
          progress: "Running Turn 7 / 32"（実測）
LEFT 65%: Revenue Trend / Operating Profit Trend / Market Summary / 5社サマリー
RIGHT 35%: Company Inspector（会社選択・Mission/Vision・Strategy・財務・操業・
           ボトルネック・Standard AI 状況診断・主要意思決定・判断根拠）
```

会社ごとの線色は固定（BAL 青 / MASS 赤 / JPQ 緑 / VAP 紫 / CONSV 橙）。
選択中の会社の線を強調し、他社を淡くする。

---

## 5. Run control / STOP / エラー

| 動作 | 実装 |
|---|---|
| 1 Turn | `advanceSimulationTurn` を1回 |
| 4 Turns | 同じ処理を4回 |
| 32 Turns | 同じ処理を32回 |
| STOP | 次ターンの処理**前**に停止。完了済みターンは保持、処理中ターンは保存しない |
| エラー | `Simulation stopped at Turn N` を表示し、`completedTurns = N-1`、失敗ターンは成功扱いにしない |

---

## 6. 既存の再利用データ

Company Inspector はすべて既存の state / history / Standard AI diagnostics の再利用で、
**生成AIを呼ばない**。

| 項目 | 出所 |
|---|---|
| Revenue / Op.Profit / Net Income | `financialResults[].profitAndLoss` |
| Cash | `financialResults[].balanceSheet.cash` |
| Debt | `financingResults[].endingShortTermLoansUsd + endingLongTermLoansUsd` |
| Sales Headcount | `state.salesForceHiringState` |
| 生産量 | `companySummaries[].hosoProduced / pdProduced / vapProduced` |
| 能力 | `computeEffectiveFactories` + `calculateFactoryEffectiveCapacity`（能力計算の唯一の情報源） |
| ボトルネック | `companySummaries[]` の raw / equipment / labor shortfall の最大値 |
| 状況診断 | `diagnostics.situationDiagnosis`（primary / secondary constraint） |
| 主要意思決定 | `decision` の営業採用・販売計画・生産計画・調達・Worker・capex・借入 |
| 判断根拠 | `diagnostics.entries`（procurement / capex / finance） |

---

## 7. Market data availability（§11・§12 の調査結果）

実データを走らせて確認した。**架空値は作っていない。**

| 項目 | STATUS | 出所 |
|---|---|---|
| market × product の demand volume | **AVAILABLE** | `salesRecord.allocations[].targetDemand` |
| market × product の price | **AVAILABLE** | `salesRecord.allocations[].basePrice` |
| observed demand（観測値） | **AVAILABLE** | Standard AI observation の `markets[].observedDemandByProduct`（観測遅延つき） |
| 消費国の在庫・消費・購買圧力 | **AVAILABLE** | `consumerMarketRecords[]`（5市場） |
| 国別 HOSO 価格・輸出可能供給 | **AVAILABLE** | `marketResult.hosoPrices[EC/IN/ID/VN]`（`exportableSupply` / `allocatedDemand` / `utilizationRatio`） |
| **国別 supply share（世界全体）** | **DERIVABLE** | `hosoPrices[country].exportableSupply` の構成比として算出可能 |
| **market × country の supply share** | **NOT_AVAILABLE** | どの生産国がどの消費市場へ供給したかを**モデルが追跡していない**。`worldSupply` はスカラー（1,800,000）で国別内訳を持たない |

**market × country の supply share は存在しないため、UIに出していない。**
必要なら供給フローの国別追跡をエンジンへ追加する設計判断が要る（Phase 2以降）。

### TRUE WORLD / OBSERVABLE の区別

Market Summary には `TRUE WORLD` バッジを付け、
「Standard AI はこの値を直接見ず、観測遅延のある observation だけを使う」旨を画面に明記した。
**Standard AI へ TRUE WORLD を流す配線は追加していない。**

---

## 8. AI Decision Trace の可用性（§18）

新しい巨大 logging system は作っていない。既存 history からの可用性:

| 段階 | STATUS | 出所 |
|---|---|---|
| OBSERVED | **AVAILABLE** | `buildCompanyOwnState` / `buildStandardAiObservation`（再実行で再現可能。純粋関数） |
| DIAGNOSED | **AVAILABLE** | `diagnostics.situationDiagnosis` + `diagnostics.entries` |
| WANTED | **AVAILABLE** | `decision` の各希望量（販売希望・生産希望・国内買付希望・借入申請） |
| CONSTRAINED | **AVAILABLE** | `financingResults[].procurementConstraint`（scaleRatio 等）、`productionAllocation.entries[].stage*Limited`、`capexResults[].rejectedProposals` |
| DECIDED | **AVAILABLE** | `record.decisions`（エンジンが実際に受け取った意思決定） |
| RESULT | **AVAILABLE** | `companySummaries` / `financialResults` / `financingResults` |

**6段階すべて既存データから構成可能**。Phase 2 で画面化すればよく、新規ロギングは不要。

---

## 9. Strategy Profile integration points

Phase 1 では**表示と保存構造のみ**。Standard AI の数値判断へは接続していない。

- `strategyProfile/types.ts` は `standardAi/` を一切 import しない（テスト `CONSOLE-15` で検証）
- Mission / Vision の既定値は**空**。archetype からそれらしい文言を生成していない
- `effectiveFromTurn` により戦略転換（Turn1 VAP focused → Turn12 HOSO/China focused …）を保持できる
- 将来の接続点は `standardAi/policy.ts` の各 decision ビルダーの引数になる想定だが、
  設計は #05 と次フェーズで行う

### 既存 Mission / Vision の調査結果

**存在しなかった。** 会社の性格付けは `CompanyFixture.archetype`（5種）と
`description`（GM向け説明文）だけで表現されていた。今回 Mission / Vision は新設である。

---

## 10. Future Analysis plan

Phase 1 は Overview のみ実装。未実装タブは「Phase 2 以降で実装します」と明示し、
**空の器を中身があるように見せていない**。

タブ: Overview / Market / Product / Operations / Sales / Profitability /
Investment / Finance / Bottleneck / Strategy / Scenario / AI Trace

---

## 11. Risks

### (a) ブラウザ内実行のため、リロードで実行結果が消える

Phase 1 は「回して観察する」ことが目的なので許容している。
永続化が要るなら Phase 2 で `SimulationRun` を Redis へ保存する（構造は用意済み）。

### (b) 32Q の結果が1画面に収まりきらない

Overview のテーブルは32列になるため横スクロールする。
Phase 2 で集計粒度（年次など）の切替を入れるとよい。

### (c) Analysis 画面が Console と状態を共有しない

現状は Analysis 側でもう一度32Qを回す。Phase 2 で SimulationRun の共有が必要。

### (d) market × country supply share が存在しない（§7）

Phase 2 の Market 分析で country share を出すなら、エンジン側に供給フローの
国別追跡を足す設計判断が要る。**現状で代替値を作ってはいけない。**

---

## 12. Phase 2 recommendation

優先順位順:

1. **SimulationRun の永続化と共有**（Console ↔ Analysis、リロード耐性）
2. **AI Decision Trace 画面**（§8 のとおり既存データで6段階すべて構成可能。新規ロギング不要）
3. **Market / Bottleneck タブ**（§7 の AVAILABLE 項目だけで作れる）
4. **Strategy Profile → Standard AI 接続の設計**（#05 と仕様確定してから実装）
5. Excel export（32Q × 5社）

country supply share は 1〜4 の後に、エンジン変更の是非を含めて判断するのが安全。
