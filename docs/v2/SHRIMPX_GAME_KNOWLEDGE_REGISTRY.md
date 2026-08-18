# ShrimpX V2 — Shared Game Knowledge Registry（Phase M2.8）

AI Management MeetingがShrimpX固有の基本ルールを正しく答えられるようにするための、
共有ゲーム知識レイヤー。将来 ChatSense / Analysis Agent からも同じ知識を再利用できる
pure domain layer として実装している。

## 1. 背景（なぜ作ったか）

実プレイで、Playerが「営業一人当たりの販売能力は？」と質問したところ、
Commercial Directorが「営業60人で3,100tの受注なので約52t/人」と回答した。

3,100 ÷ 60 は **当期実績の単純除算**であり、営業能力のゲームルールではない。
AI Meetingが (a) ShrimpX固有のルールを知らず、(b) 一般的なビジネス知識と
当期実績で空白を埋めてしまう、という2つの問題が同時に出ていた。

## 2. Architecture

```
app/lib/v2/gameKnowledge/          ← pure domain layer（React/Redis/SDKに非依存）
  types.ts          Knowledge schema・intent・role・version
  entries.ts        ルール本体（21 entries）
  dynamicValues.ts  現在のparameterから {{key}} を解決
  estimators.ts     deterministicな目安計算（営業能力・必要Worker）
  retrieval.ts      keyword/domain/role/intent による軽量検索
  index.ts          公開API

app/lib/v2/companyLab/aiManagementMeeting/knowledgeInjection.ts
  ↑ AI Meeting 2経路（company-labs / simulation-runs）が共通で使う薄い接続層
```

`companyLab/` の外に置いたのは、companyLab以外（ChatSense Agent・Analysis Context・
Audit Workbookのdocumentation）からも再利用できるようにするため（実装指示§26）。

## 3. Knowledge Entry schema

| field | 意味 |
| --- | --- |
| `id` | `DOMAIN.NAME` 形式の安定ID（例 `FINANCE.AR_SETTLEMENT`）。変更しない |
| `domain` | SALES / LABOR / PRODUCTION / CAPACITY / PROCUREMENT / CONTRACT / FINANCE / CAPEX / QUALITY_TRUST / STANDARD_AI |
| `title` / `summary` / `explanation` | 説明。`{{key}}` で動的値を参照できる |
| `ruleType` | DEFINITION / FORMULA / TIMING / CONSTRAINT / INTERPRETATION / EXAMPLE |
| `sourceType` | CODE / PARAMETER / FORMAL_SPEC / MANUAL / DERIVED |
| `sourceReference` | 実装ファイルパス等（provenance。実装指示§32） |
| `appliesToRoles` | CEO / CFO / COO / COMMERCIAL |
| `keywords` | 日英両方。retrievalのキー |
| `dynamicValues` | この entry が使うプレースホルダ名の宣言 |
| `semanticWarnings` | AIが誤読しやすい点への警告 |
| `version` | knowledge version |

## 4. Truth hierarchy（拡張後）

AI Meeting system prompt に以下の9段として明記している。

1. Engine / ExecutiveBriefingPacket の事実
2. Structured diagnostics
3. **gameKnowledge の code/parameter 由来の現在値**
4. **gameKnowledge の formal game rule の意味論**
5. プレイヤーの明示的な方針・訂正
6. Run Advisory Memory の preference / strategic intent
7. Standard AI の提案
8. 他役員の発言
9. 一般的な business knowledge

**一般的なbusiness knowledgeでShrimpXルールの空白を埋めない。**
Registryにも briefing にも無ければ「ShrimpXの現行ルール上、この情報は確認できません」と答える。

## 5. Source policy — 数値をhardcodeしない

変わり得る数値は説明文へ書かず `{{key}}` として残し、実行時に**現在のparameter**から解決する。

```
「VAPはHOSOより高い労務負荷を持つ。現在の係数は {{vapLaborCoefficient}}。」
```

これにより、parameterを変えるとKnowledgeが自動的に追随し、
「Manualには3.0と書いてあるが実装は2.5」という乖離が構造的に起こらない。
解決できないキーは値を捏造せず `(値を取得できませんでした)` になる。

現在の動的値の取得元: `sales/parameters.ts`, `production/parameters.ts`,
`finance/parameters.ts`, `rawMaterials/parameters.ts`,
`companyLab/standardAi/parameters.ts`, `sales/salesCapacityModel.ts`。

## 6. Domains（21 entries）

| domain | entries |
| --- | --- |
| SALES | SALESPERSON_CAPACITY / CAPACITY_VS_ACTUAL / MARKET_AND_PRODUCT_ASSIGNMENT / COVERAGE_VS_CAPACITY |
| LABOR | WORKER_PRODUCTIVITY / UTILIZATION_SEMANTICS |
| FINANCE | AR_SETTLEMENT / AP_SETTLEMENT / ACCOUNTING_SEMANTICS / DIVIDEND_POLICY |
| PROCUREMENT | DOMESTIC_TIMING / IMPORT_TIMING / AQUACULTURE_TIMING / TERMINOLOGY |
| CONTRACT | BACKLOG_SEMANTICS |
| CAPACITY | POOL_SEMANTICS |
| CAPEX | PROJECT_SEMANTICS / NEW_FACTORY |
| QUALITY_TRUST | SEMANTICS |
| STANDARD_AI | ROLE / SALES_HEADCOUNT_LOGIC |

## 7. Role filtering（実装指示§27）

| role | 担当domain |
| --- | --- |
| COMMERCIAL | SALES / CONTRACT / QUALITY_TRUST |
| COO | PRODUCTION / LABOR / CAPACITY / PROCUREMENT / CAPEX |
| CFO | FINANCE / CAPEX |
| CEO | 全domain（横断要約役のため） |

`appliesToRoles` との AND で絞るため、CFOへ営業能力の詳細が流れることはない。

## 8. Retrieval（実装指示§28・§29）

Embedding/RAGは使わない。keyword一致スコア + role/domainフィルタの
**決定論的な軽量検索**。同じ質問には常に同じ知識が返る（再現性・監査性）。

質問意図は `GAME_RULE` / `CURRENT_STATE` / `STRATEGY` / `MIXED` に分類する。

Top N は既定6件。超過分は `truncatedCount` として返る。全文Manualは絶対に入れない。

実測: 「営業一人当たりの販売能力は？」の注入サイズは約4KB（テストで12KB上限を固定）。

## 9. Deterministic estimators（実装指示§8・§10）

Claudeに暗算させない。質問に具体的な数量が含まれる場合だけ、engineの関数と
現在のparameterでserver側が計算し、caveatsと一緒に渡す。

- `estimateSalesCapacity(headcount)` — 営業N人の工数能力と商品別の販売可能トン目安
- `estimateSalesHeadcountForTons(tons, product)` — 逆算（漸近上限に達する場合はnull）
- `estimateWorkerRequirement(tons, product)` — 必要常用Worker数（残業あり/なし）

いずれも「これは上限の目安であり、需要・価格・信頼・生産能力で変わる」という
caveatsを必ず同梱する。

## 10. Auditability（実装指示§32・§33）

structured response で3つを**別々に**保持する。

| field | 意味 |
| --- | --- |
| `factsUsed` | current run data（このRunの実際の数値） |
| `knowledgeUsedIds` | game rule（ShrimpX固有の恒常的なルール） |
| `memoryUsedIds` | player-specific preference（このRunでの方針・訂正） |

`knowledgeUsedIds` は、実際に注入したidでフィルタしてから記録する
（Claudeが存在しないidを返しても記録に残さない）。

## 11. Manual integration（実装指示§24・§25）

現時点では、GitHub上にこのRegistryの転記元として追跡できる
**versioned な正式Manual artifact が存在しない**。存在しないバージョン番号を
捏造しないため、`GAME_KNOWLEDGE_REGISTRY_VERSION.manualVersion = "NOT_TRACKED"` としている。

Google Drive等の外部Manualをruntimeで読む設計にはしていない。
数値は常に code/parameter が優先であり、Manualは自然言語説明の出所としてのみ使う。

## 12. Update procedure（実装指示§43）

Manual または engine parameter を変更したときの手順:

1. Manual / parameter を変更する
2. Engine の実装と整合しているか確認する（**数値はcodeが正**）
3. Knowledge Registry を更新する
   - 変わり得る数値なら `dynamicValues.ts` のキーを増やし、説明文は `{{key}}` のままにする
   - ルールの意味そのものが変わったら `entries.ts` の explanation / semanticWarnings を直す
4. `GAME_KNOWLEDGE_REGISTRY_VERSION` を更新する（`knowledgeVersion`、必要なら `manualVersion`）
5. `app/lib/v2/gameKnowledge/__tests__/gameKnowledgeRegistry.test.ts` を実行する
   （このテストは Registry の記述を **engineのparameterと突き合わせて** 固定しているため、
   engineだけ変えて Registry を直し忘れると落ちる）
6. AI Meeting の smoke（§40の8問）を実行する

## 13. Known gaps

1. **Manual version tracking**: 追跡できる正式Manualが未整備（上記§11）。
2. **CAPEXの案件別数値**: 案件種別ごとの費用・必要四半期数・能力増分は
   `capex/parameters.ts` にあるが、Registryでは「parameterで決まる」とだけ述べ、
   個別の値を動的値として展開していない。案件種別が多く、質問頻度も低いため。
3. **市場別の需要規模**: 「US PDを2,000t売るには何人？」のような市場固有の逆算は、
   需要側がRun状態依存のため estimator を用意していない。工数能力の観点だけの
   逆算（`estimateSalesHeadcountForTons`）に留めている。
4. **Quality/Trustの定量式**: 品質スコア・信頼の更新式そのものは動的値化していない
   （定性的な関係のみ登録）。
5. **retrievalの語彙**: keyword一致であるため、登録キーワードから外れた言い回しでは
   引けないことがある。実プレイのログを見て keywords を足していくのが運用方針。

## 14. ChatSense 再利用

`app/lib/v2/gameKnowledge/index.ts` の以下がそのまま使える。

```ts
getGameKnowledgeForQuestion({ question, role?, domains?, topN?, parameters? })
getGameKnowledgeByDomain(domain)
getGameKnowledgeById(id)
formatKnowledgeForPrompt(entries)
estimateSalesCapacity / estimateWorkerRequirement / estimateSalesHeadcountForTons
GAME_KNOWLEDGE_REGISTRY_VERSION / GAME_KNOWLEDGE_IDS
```

AI Meeting固有のものはこのモジュールに一切含まれていない。
