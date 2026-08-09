# ShrimpX Simulation Run — AI Analysis Pack 設計

32Q＝8年間の Simulation Run が終わったあと、その1本を ZIP としてダウンロードし、
ChatGPT / Claude へ添付して「この8年間で何が起きたのか」を議論できるようにする仕組み。

**人間向けの Management / Analysis UI とは目的が違う。**

| | 目的 |
|---|---|
| Management / Analysis UI | 人間が見て操作するための分析環境 |
| AI Analysis Pack | AI がゲームを理解・再構成・監査するための machine-readable / human-readable な記録 |

---

## 1. 最重要原則

Pack の目的は「数字をたくさん出す」ことではない。**因果を Turn 単位で再構成できること**である。

```
World
 ↓ Company State（期首）
 ↓ Available Information（Standard AI が実際に見られた情報）
 ↓ Standard AI Diagnosis
 ↓ Desired Action（制約適用前にやりたかったこと）
 ↓ Constraints（何がそれを止めたか）
 ↓ Actual Decision（実際に提出したもの）
 ↓ Execution
 ↓ Financial Result
 ↓ Ending State
```

この並びを `companies[companyId].turns[]` の1要素がそのまま持つ。

### 絶対規約

1. **TRUE WORLD と OBSERVABLE を絶対に混ぜない。** `trueWorld` / `standardAiObservable` を別オブジェクトにし、
   前者に観測フィールドを、後者に真値フィールドを一切入れない（テスト PACK-3 が構造で検査）。
2. **存在しないデータを空想で埋めない。** `dataAvailability` に
   `AVAILABLE / DERIVED / NOT_RECORDED / NOT_AVAILABLE` で理由つきに記載する。
3. **生成AIを一切呼ばない。** Pack 生成は完全に決定論的な記録出力である
   （テスト PACK-28 が `aiPack/` 配下に AI SDK・`fetch(` が現れないことを検査）。
4. **秘密情報を含めない**（トークン・認証情報・接続情報。テスト PACK-23）。
5. **完了ターンだけを出力する。** 16/32 で STOP した run は Q1〜16 のみ。Q17〜32 をゼロ埋めしない。

---

## 2. アーキテクチャ

### 2.1 ブラウザで生成する（設計判断）

| 観点 | 判断 |
|---|---|
| データの所在 | 出力対象の Simulation Run は既にこのブラウザ（localStorage）にある。サーバーから取り直す必要がない。 |
| 秘密情報 | サーバーを経由しないため、環境変数・トークンが Pack へ混ざる経路が**構造的に存在しない**。 |
| Vercel function 制限 | 32Q の ZIP は実測 約1.3MB。これを serverless 応答へ載せずに済む。 |
| 依存関係 | `exceljs` / `jszip` は**既にこのプロジェクトの直接依存**であり、どちらもブラウザで動く。新しい依存は1つも増やしていない。 |
| ブラウザメモリ | JSON 約4MB ＋ xlsx 約1.1MB。生成時間は実測 1.6〜1.9秒で、問題になる規模ではない。 |

### 2.2 モジュール構成

```
app/lib/v2/companyLab/simulation/aiPack/
  types.ts          Pack スキーマ（AI_ANALYSIS_PACK_SCHEMA_VERSION）
  capture.ts        実行中に拾う per-turn 記録（engine から呼ぶ）
  context.ts        保存済み run → AI Context JSON
  changeLog.ts      決定論的な Major Change Log（CSV も）
  summary.ts        01_Run_Summary.md
  dataDictionary.ts 05_Data_Dictionary.md
  workbook.ts       03_Analysis.xlsx（ExcelJS）
  pack.ts           ZIP 組み立て（JSZip）＋ 進捗ステージ
app/v2/management/components/ExportPackButton.tsx   出力UI
```

**新しい simulation engine は作っていない。** Phase 2/3 で作った SimulationRun 永続化・
analytics dataset・AI Trace・Standard AI diagnostics をそのまま再利用している。

### 2.3 なぜ実行中に capture が要るのか

期首・期末状態、実効能力、工場スペース、借入残高、進行中の投資案件は
確定履歴（`CompanyQuarterRecord`）に**残らない導出値**である。あとから復元するには
その時点の `CompanyLabState` を見るしかないため、`advanceSimulationTurn` の中で
ターン処理の**前後**に必要な値だけを正規化して拾う。

- 能力は `computeEffectiveFactories` / `calculateFactoryEffectiveCapacity`
- スペースは `production/factorySpace.ts`
- 借入は融資ポートフォリオ（`financing`）

いずれもゲーム本体と同じ唯一の情報源を通しており、Pack 用の別式は作っていない。
`CompanyLabState` を丸ごと複製することはしない（capture は実測 327KB）。

保存スキーマは `CURRENT_SIMULATION_RUN_PERSISTED_VERSION` を **1 → 2** へ上げた。
追加的変更のみでマイグレーション不要。v1 の保存データは `packCapture` を持たないため
`NOT_RECORDED` として扱い、推測で埋めない（テスト PACK-27）。

---

## 3. ZIP の内容

```
ShrimpX_Run_<simulationRunId>_AI_Analysis_Pack.zip
  01_Run_Summary.md          入口。読み方の説明・Run Identity・開始/終了比較・主要イベント
  02_AI_Context.json         ★ Pack の中心。全ターンの因果記録
  03_Analysis.xlsx           人間＋ChatGPT の定量確認用
  04_Event_Change_Log.csv    決定論的な変化ログ
  05_Data_Dictionary.md      フィールド定義・単位・出所・層・閾値
```

### 実測（32Q × 5社）

| 項目 | 値 |
|---|---|
| 32Q 実行 | 約 530 ms |
| Pack 生成 | 約 1.6〜1.9 秒 |
| `02_AI_Context.json` | 3.9 MB |
| `03_Analysis.xlsx` | 1.14 MB |
| `04_Event_Change_Log.csv` | 40 KB（978行） |
| `01_Run_Summary.md` / `05_Data_Dictionary.md` | 12 KB / 10 KB |
| **ZIP 合計** | **約 1.32 MB** |
| 保存物（run + dataset + capture） | 3.15 MB |

JSON が大きいのは Standard AI の理由コードとメッセージが 32Q×5社ぶん入っているため。
**詳細を落として小さくするのではなく、冗長な重複（null キー・全ゼロ行）を削る**方針を採っている。

---

## 4. JSON スキーマ

`schemaVersion: "shrimpX-ai-analysis-pack-v1"`

```
{
  schemaVersion, readingGuide[],
  run { simulationRunId, scenarioId, scenarioVersion, seed,
        gameParameterVersion, standardAiVersion, strategyProfileVersion,
        startingTurn, completedTurns, requestedTurns,
        startedAt, completedAt, stopReason, exportedAt,
        sourceBranch, sourceCommit },        // 不明なら "UNKNOWN"
  companySummaries[],                        // 開始→終了の要約
  world { turns[] },                         // trueWorld / standardAiObservable / scenarioEvents
  companies { <companyId>: { turns[] } },    // 因果の中心
  majorChanges[],
  standardAiProposableCapexTypes[],          // コード上の事実
  gameCapexTypes[],
  dataAvailability[],
  sourceMap {}                               // どの値がどこから来たか
}
```

`companies[].turns[]` の1要素:
`beginningState / observed / diagnosis / wanted / constraints / decision / execution / financialResult / endingState / capitalProjects`

期首と期末は**同じ形**にしてあるので、前ターンの `endingState` と当ターンの
`beginningState` が連続することを検査できる（テスト PACK-7）。

`sourceBranch` / `sourceCommit` は Vercel のビルド時変数（`VERCEL_GIT_COMMIT_REF` /
`VERCEL_GIT_COMMIT_SHA`）を `next.config.ts` の `env` で写しただけで、秘密情報は含まない。
ローカルビルドでは `UNKNOWN`。

---

## 5. true / observable の方針

| | 出所 | 意味 |
|---|---|---|
| `trueWorld.marketProducts[].trueDemandTons` | `salesRecord.allocations[].targetDemand` | 実際に成立した対象需要 |
| `standardAiObservable.marketProducts[].observableDemandTons` | `marketDemandObservation.ts` | Standard AI が見られた**2四半期前**の実績 |

`readingGuide` に「後知恵で間違って見える判断も、当時 observable だった情報の下では
合理的だったかもしれない。判断は observable 層に対して評価すること」と明記している。

観測値の `sourceTurn` は必ず当期より前であることをテスト（PACK-4）で検査する。

---

## 6. 存在しないデータ

| フィールド | availability | 理由 |
|---|---|---|
| `marketCountrySupplyShare` | **NOT_AVAILABLE** | 市場×産地国の供給行列がエンジンに存在しない。市場側は `targetDemand`、産地国側は世界合計の `exportableSupply` / `allocatedDemand` しか持たない。**シェアを作らなかった。** |
| `candidateActions` | **NOT_RECORDED** | 「評価したが却下した投資候補」の明示的な一覧をエンジンが保存していない。ただし Standard AI の理由コード（`CAPEX_PROPOSED` / `CAPEX_DEFERRED` / `CAPEX_DEFERRED_OVERSUPPLY`）と、その `keyValues` に入る各ゲートの合否は記録されており、そこから追える。 |
| `decision.productionPlanTonsByProduct` / `priceAdjustmentUsdPerKg` | NOT_RECORDED | analytics dataset に載せていない。実績生産量は `execution` にある。 |
| `financialResult` の COGS / 粗利 / CF / 借入枠 | NOT_RECORDED | エンジンには存在するが dataset に載せていない。売上・営業利益・純利益・限界利益・固定費は利用可能。 |
| `beginningState` / `endingState` | AVAILABLE（v1 保存なら NOT_RECORDED） | schemaVersion 2 以降で capture 済み。 |

---

## 7. 「新工場を建てなかった理由」を追えること

今回の具体的ユースケース。Pack だけで次を確認できる。

- `standardAiProposableCapexTypes` … Standard AI が提案しうる種別（コード上の定数を読む）
- `gameCapexTypes` … エンジンに存在する種別
- `endingState.factorySpaceRemainingUnits` / `capacityTonsByProduct` / `cashUsd` / `debtUsd`
- `diagnosis.commercialBottleneck`（実績としての律速）と `primaryConstraint`（AI の認識）
- `diagnosis.reasonCodes`（`CAPEX_*` を含む）
- `capitalProjects` / `execution.capexEvents` / `capexRejectedProposals`

### 実行して分かった事実（この設計で明らかにできること）

32Q の実測 run では **新工場建設イベントは0件**だった。その理由の一端は
Pack が記録するコード上の事実で説明できる。

```
standardAiProposableCapexTypes:
  hosoLineExpansion, pdLineExpansion, vapLineExpansion, commonProcessingExpansion

エンジンに存在するが Standard AI が一度も提案しない種別:
  freezingPackagingExpansion, coldStorageExpansion, qualityControlEquipment,
  environmentalEquipment, newFactoryConstruction, pdMechanization
```

つまり `newFactoryConstruction` は**構造的に一度も提案されない**。
これは「この run でたまたま建てなかった」のではなく Standard AI のコードの性質であり、
Pack はその区別ができる形で記録している（Run Summary にも明示される）。
**export 側で「だから問題だ」といった評価は書かない。** 分類と評価は人間と AI が行う。

### 実装中に見つけて直した欠落

AI Trace の理由コードには保存量の上限があり、当初は**件数で切り捨てて**いた。
その結果 `CAPEX_*` が末尾に並ぶターンで投資判断の理由が Pack から消えていた。
**コードは全件残し、上限を超えた分はメッセージだけを省略する**方式へ変更した
（テスト PACK-15 が「投資判断の理由コードが1件以上ある」ことを検査する）。

---

## 8. Major Change Log

前ターンとの差分から決定論的に生成する（生成AIによる要約ではない）。

| 対象 | 閾値 |
|---|---|
| 営業人員・市場別配置 | 絶対 1人以上 |
| 能力（トン） | 絶対 100t 以上 |
| 現金・借入 | 相対 10% **かつ** 絶対 100,000 USD 以上 |
| 市場価格 | 相対 5% 以上 |
| 市場需要 | 相対 10% 以上 |
| 律速の切り替わり / 投資イベント / シナリオイベント | 閾値なし（必ず記録） |

閾値は `MAJOR_CHANGE_THRESHOLDS` に一元化し、Data Dictionary に同じ値を記載する。
**生の数値は world / companies の timeline に全ターンぶん残っている**ので、
閾値で落ちるのは「変化ログに載るかどうか」だけである。

---

## 9. Excel（03_Analysis.xlsx）

Analysis sheet と Raw sheet に分ける。Raw は long-format：
`simulationRunId / turn / company / market / product / metric / value / unit`。
32Q を横に何百列も並べる構造にはしない。

00_Run_Summary / 00b_Company_Summary / 01_Company_Quarterly / 02_Market_Product_Demand /
03_Market_Product_Price / 04_Product_Economics / 05_Sales_Headcount / 06_Sales_Allocation /
07_Contracts_Sales / 10_Factory_Capacity / 11_Factory_Space / 12_Inventory_Backlog /
13_Fixed_Cost / 14_Investment / 14b_Capital_Projects / 15_PL / 16_BS / 18_Bottleneck /
19_AI_Decision / 20_AI_Diagnostics / 22_Scenario_Events / 23_Major_Changes /
90_Raw_Company / 91_Raw_Market / 91b_Raw_Producer_Country / 92_Raw_AI / 99_Metric_Labels

---

## 10. Markdown（01_Run_Summary.md）

テンプレートに記録値を差し込むだけ。冒頭に AI 向けの読み方説明を置き、
末尾に人間が ChatGPT へ投げられる質問例（テンプレート）を置く。**回答は export 時に生成しない。**

**勝手に評価しない。** 「MASS は誤った経営をした」ではなく
「MASS の営業利益が X 四半期にわたり赤字だった」という事実まで。
テスト PACK-20 が評価語が混ざらないことを検査する。

---

## 11. UI

Management Console と Analysis Home の両方に `[AI Analysis Pack を出力]` を置く。

- 出力前に **Simulation Run ID / Scenario / Seed / Completed Turns を必ず表示**する
- 押下時に、表示中の ID で run を読み直し、ID が一致しない場合は出力を中止する（run の取り違え防止）
- 進捗は実際の処理段階（`Preparing data… → Building JSON… → Building Excel… → Creating ZIP… → Ready`）。
  **fake progress を出さない**
- 主導線は ZIP 1個の自動ダウンロード。JSON / Excel / Markdown / CSV の個別ダウンロードリンクも併置

---

## 12. セキュリティ

Pack に含まれるのは Simulation Run の記録だけ。生成関数は環境変数・Cookie・
リクエストヘッダーの類に一切触れない。テスト PACK-23 と Playwright の両方で、
`STAGING_ADMIN_TOKEN` / `KV_REST_API*` / `ANTHROPIC_API_KEY` / `Bearer ` /
セッション Cookie 名が Pack のどのテキストにも現れないことを検査している。

`sourceCommit` / `sourceBranch` はコミットSHAとブランチ名のみで、秘密情報ではない。

---

## 13. 保存容量への影響

capture 追加により保存物が 2.2MB → **3.15MB** になった。localStorage の一般的な上限
（オリジンあたり約5MB）を踏まえ、**ブラウザ側の保持本数を 2 → 1 本**へ変更した
（2本入れると保存に失敗し、結局古い方を捨てて入れ直すことになるため）。
複数 run を保持したい場合はサーバー保存（Redis、上限20本）を使う。
保存に失敗した場合は理由を画面に出す（黙って握りつぶさない）。

---

## 14. 品質ゲートの結果

| 項目 | 結果 |
|---|---|
| `npm test` | **2,640 pass / 0 fail**（Phase 3 時点 2,612 → 新規28件） |
| `tsc --noEmit` | 0 error |
| `eslint .` | 0 error（既存 warning 7件のみ） |
| `next build` | 成功 |

### ブラウザ検証（Playwright / production build）

| 確認項目 | 結果 |
|---|---|
| Export 対象の表示 | Run ID / Scenario / Seed / Completed Turns がボタンの前に表示される |
| 進捗ステージ | `Building Excel… → Creating ZIP… → Ready`（Preparing / Building JSON は数十msで通過） |
| Export 所要時間 | 1.6〜1.7 秒 |
| ZIP | 1,349,334 bytes、5ファイルすべて含む |
| JSON | schemaVersion 一致、runId 一致、completedTurns 32、world.turns 32、5社すべて 32 ターン |
| Analysis Home からの出力 | 同じ run・同じファイル名 |
| 途中停止 run | turnCounter 15 = completedTurns 15 = world.turns 15 = company.turns 15、stopReason `stopped_by_user` |
| reload 後 | 復元され、そのまま export 可能 |
| 秘密情報 | 0件 |
| `pageerror` | 0件 |

### §59 実機テスト（答えるための記録があるか）

| 質問 | Pack 内の根拠 |
|---|---|
| Q1 誰も新工場を建てなかったか | `execution.capexEvents` に `newFactoryConstruction` が0件。`standardAiProposableCapexTypes` に含まれない |
| Q2 能力不足だったか | `diagnosis.commercialBottleneck` と `shortfallTons` が全ターン記録 |
| Q3 検討した形跡 | `diagnosis.reasonCodes` に `CAPEX_PROPOSED` / `CAPEX_DEFERRED`（keyValues に各ゲートの合否） |
| Q4 資金制約か | `endingState.cashUsd` / `debtUsd`、reason code の `financialGate` |
| Q5 工場スペース制約か | `endingState.factorySpaceRemainingUnits`（実測で余剰あり） |
| Q6 どこへ投資したか | `capitalProjects` / `14b_Capital_Projects` |
| Q7 営業人数の変化 | `majorChanges` の `SALES_HEADCOUNT` 95件 |
| Q8 市場変化への反応 | `standardAiObservable` × `decision.salesAllocationByMarket`、価格変化 21件 |
| Q9 律速判断の変化 | `PRIMARY_BOTTLENECK` 遷移 16件 |
| Q10 8年間の経営結果 | `companySummaries` 5社 |

---

## 15. ゲームへの影響

- ゲームルール・Standard AI 判断ロジック・シナリオ・財務計算のいずれも変更していない
- engine が追加で行うのは「既に計算済みの状態から値を写す」capture だけ
- export した run と export しなかった run の結果は同一（capture は決定論的で、判断へ戻らない）
- `npm test` 全2,640件が通っている

---

## 16. 今後の拡張余地

- `financialResult` の COGS / 粗利 / CF / 借入枠を dataset へ載せる（現在 NOT_RECORDED）
- 生産計画・提示価格調整の意思決定詳細を dataset へ載せる
- 評価済み投資候補の明示的な一覧をエンジン側で保存する（現在は理由コードから推定するしかない）
- 市場×産地国の供給行列（#04 への環境モデル申し送り。これが入れば `NOT_AVAILABLE` が解消する）
