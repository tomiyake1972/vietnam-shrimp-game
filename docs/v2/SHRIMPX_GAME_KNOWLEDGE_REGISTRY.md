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

**【M2.8.1で変更】role は hard filter ではなく ranking preference である。**

M2.8では「担当domain AND `appliesToRoles`」で候補を絞っていたため、
たとえば「営業1人当たり何トン？」をCFOが受けると SALES domain が丸ごと除外され、
注入知識が **0件** になっていた（実測: `Q1[CFO] ids=[]`）。知識ゼロのまま回答させた結果、
Claudeがbriefingの「売上 ÷ 営業人数」から存在しないルールを逆算した。

ゲームルールの正しさは誰が答えるかに依存しないため、現在の実装では:

- keyword一致が0のentryは引かない（無関係な知識で埋めない）
- keyword一致があるentryは、roleに関係なく候補に残る
- 担当domain一致で +4、`appliesToRoles` 一致で +2 の**加点**のみ行い、順位付けに使う

## 8. Retrieval（実装指示§28・§29）

Embedding/RAGは使わない。keyword一致スコア + role/domainフィルタの
**決定論的な軽量検索**。同じ質問には常に同じ知識が返る（再現性・監査性）。
roleは除外条件ではなく加点（§7参照）。

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

## 9.1 Deterministic Rule Resolution（M2.8.1・実装指示§3〜§6）

estimatorsだけでは足りなかった。実APIでは、知識と目安を渡してもモデルが
briefingの数字から独自にルールを逆算し、6問で誤答した。そこで
**server側で答えそのものを確定させ、「この結果は変更してはならない」と明示して渡す**
層を追加した（`app/lib/v2/gameKnowledge/ruleResolver.ts`）。

```ts
resolveGameRuleAnswers({ question, previousProduct?, previousTons?, previousAsksWorker? })
  → ResolvedGameRuleAnswer[]
```

`ResolvedGameRuleAnswer` は `resolverId` / `knowledgeIds` / `canonicalFacts` /
`calculation` / `result` / `unit` / `caveats` / `currentApplication` を持つ。
Claudeの役割は `result` を日本語で説明することだけで、計算ではない。

| resolverId | 何を確定させるか |
| --- | --- |
| `SALES_CAPACITY_AT_HEADCOUNT` | 営業N人の工数能力（会社全体の飽和曲線に代入） |
| `SALES_CAPACITY_PER_PERSON` | 「1人当たり◯トン」という固定パラメータは**存在しない**こと |
| `SALES_HEADCOUNT_FOR_TONS` | Nトンに必要な営業人数（工数観点のみ／漸近上限超なら到達不能） |
| `WORKER_REQUIREMENT` | 商品別の必要常用Worker数（残業上限を使う場合も） |
| `TIMING_AR` | 履行 Turn N → 入金 Turn N+1 |
| `TIMING_IMPORT` | 発注 Turn N → 現金 N+1 → 到着・使用可 N+2 |
| `TIMING_DOMESTIC` | 買付 Turn N → 現金 N → 使用可 N |
| `TIMING_AQUACULTURE` | 池入れ Turn N → 収穫・使用可 N+1 |
| `TIMING_CAPEX` | 能力が増えるのは完成した四半期から |
| `CAPACITY_POOLS` | 能力は複数プールで構成され、ライン能力の合計は全社の天井ではない |

省略形の追問（「VAP 1,000tなら？」）は `extractRecentProductQuantity(recentTexts)` が
直前の会話から商品・数量・「直前がWorker質問だったか」を拾って解決する。

## 9.2 Semantic consistency validator（M2.8.1・実装指示§7・§10）

生成された日本語テキストをserver側でもう一度検査し、確定解答と矛盾する記述が
残っていれば **1回だけrepair** する（既存のoverdue語彙guardと同一手順）。
`app/lib/v2/gameKnowledge/ruleAnswerValidator.ts`。

| code | 検出する誤り |
| --- | --- |
| `SALES_PER_PERSON_FIXED_CAPACITY` | 「営業1人当たり◯トン」という固定能力の断定 |
| `SALES_CAPACITY_CANONICAL_MISSING` | 確定した営業工数能力が回答に含まれていない |
| `WORKER_HEADCOUNT_CANONICAL_MISSING` | 確定した必要Worker数が回答に含まれていない |
| `AR_TIMING_CONTRADICTION` | 売掛金が当四半期中に現金化されるという記述 |
| `IMPORT_TIMING_CONTRADICTION` | 輸入原料が発注四半期に使えるという記述 |
| `LINE_SUM_AS_COMPANY_CEILING` | 商品ライン能力の合計を全社の天井として提示 |
| `KNOWLEDGE_NOT_USED` | GAME_RULE/MIXEDで知識を注入したのに `knowledgeUsedIds` が空 |

false positiveを出さないことを優先し、曖昧な表現は違反にしない。
結果は診断 `ruleAnswerGuardResult` / `ruleAnswerViolationCodes` に記録される。

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
5. `app/lib/v2/gameKnowledge/__tests__/gameKnowledgeRegistry.test.ts` と
   `gameRuleEnforcement.test.ts`（AMM-GKE-1〜14）を実行する
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
resolveGameRuleAnswers({ question, previousProduct?, previousTons?, previousAsksWorker? })
extractRecentProductQuantity(recentTexts)
findRuleAnswerViolations(texts, resolved) / findKnowledgeUsageViolation(...) / buildRuleAnswerRepairNote(...)
GAME_KNOWLEDGE_REGISTRY_VERSION / GAME_KNOWLEDGE_IDS
```

AI Meeting固有のものはこのモジュールに一切含まれていない。
