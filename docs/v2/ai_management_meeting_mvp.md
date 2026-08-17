# AI Management Meeting — MVP設計・実装ドキュメント（AMM-M0/M1）

対象branch: `feature/v2-32q-management-console`
実装開始時HEAD: `a975ea1`（PC-3完了時点。Standard AI / Portfolio Calibrationはこの時点でfreeze）

## 1. 位置づけ・三層分離

AI Management Meetingは、既存の

- **Engine Calculation**（決定論的なゲームエンジン。`app/lib/v2/companyLab/simulation/engine.ts`等）
- **Standard AI**（既存の自動意思決定ロジック。`app/lib/v2/companyLab/standardAi/`）

とは完全に独立した第三層である。Claudeは会話・助言のみを行い、ゲーム状態やStandard AIの
パラメータ・判断ロジックを一切変更しない。提案（proposals）はvalidation層を通過した後も
UIへ返すだけで、M1スコープでは自動適用しない（適用はM2/M3以降）。

この実装はStandard AI・Portfolio Calibration関連のコード（`app/lib/v2/companyLab/standardAi/`
配下の判断ロジック・パラメータ）を一切変更していない。

## 2. 既存Claude API基盤の監査結果

既存のClaude統合は `app/lib/v2/companyLab/aiExplanation/`（「Standard AI経営説明」機能）の
1箇所のみ。以下をそのまま踏襲・再利用した。

- **モデル**: `claude-haiku-4-5-20251001`（コスト最適化のため既に採用済み。環境変数
  `STANDARD_AI_EXPLANATION_MODEL` で上書き可能な設計を踏襲し、AI Management Meetingでは
  `AI_MANAGEMENT_MEETING_MODEL` で個別に上書き可能にした。既定値は同じHaikuモデル）。
- **トランスポート層**: `AnthropicMessagesClient` / `AnthropicToolDefinition` /
  `AnthropicMessageResponse` の各型、および `EXPLANATION_CLAUDE_TIMEOUT_MS`（40秒）・
  `EXPLANATION_CLAUDE_MAX_RETRIES`（0＝SDK自動retry無効化）を
  `app/lib/v2/companyLab/aiManagementMeeting/claudeClient.ts` から直接importして再利用した。
  新しいAnthropic接続経路・新しいtimeout/retryポリシーは作らなかった。
- **構造化出力方式**: tool_choiceでtool呼び出しを強制する方式（マークダウンのコード
  フェンス混入によるJSON.parse失敗を構造的に防ぐ）を踏襲。
- **ドメイン層は分離**: プロンプト文言・出力スキーマ・ExecutiveBriefingPacket構築ロジックは
  `aiManagementMeeting/` 配下に独立させ、`aiExplanation/` のprompt/schemaは一切importしていない
  （実装指示§9「reuse API client/transport layer only, not prompt/template, keep domain
  layer separate」）。

## 3. モデル選定

`claude-haiku-4-5-20251001` を採用した。理由: 既存のAI Explanation機能が同じ理由
（構造化出力・比較的単純な要約/助言タスク・コスト最適化）で既に採用しており、
AI Management Meetingも「既存ゲームデータの解釈・助言」という同種のタスクであるため、
新しいモデルを個別に採用する積極的な理由がない。`AI_MANAGEMENT_MEETING_MODEL` 環境変数で
個別に上書き可能（コード変更不要）。

## 4. アーキテクチャ比較: Option A（役員ごとに個別呼び出し） vs Option B（単一構造化呼び出し）

| 観点 | Option A（役員ごとに個別Claude呼び出し） | Option B（単一の構造化呼び出し） |
|---|---|---|
| レイテンシ | 発言者数分のAPI呼び出しが直列/並列いずれでも増える | 1回で完結 |
| コスト | 呼び出し回数に比例して増える（briefing再送も重複） | 1回ぶんのみ |
| 発言者間の一貫性 | 各役員が互いの発言を知らずに話す設計になりやすい（矛盾しやすい） | 同一コンテキスト内でprimary/secondary/CEO summaryの整合を取りやすい |
| primary/secondary/CEO summary要否の制御 | 「誰が何人喋るか」を呼び出し前に確定させる必要があり、動的な調整が難しい | Claude自身がprimarySpeaker/requiresCeoSummaryを1回の応答内で決定でき、実装指示のMVP UX（最大3発言・CEOは必要時のみ）と自然に一致する |

**結論**: 実装指示の既定推奨どおりOption Bを採用した。role-blendingの問題（1回の応答内で
複数役員の人格が混ざる懸念）は、tool schema側で `responses[].speaker` を明示的に分離し、
システムプロンプトで各役員の性格・語調を明記することで軽減する設計とした。実装・テスト
（AMM-2〜7等）を通じて、この設計でrole-blending起因の問題は確認されなかった
（構造化スキーマがspeakerごとにtextを分離しているため、混在が起きても検知・修正しやすい）。

## 5. モジュール構成

`app/lib/v2/companyLab/aiManagementMeeting/`（既存の `aiExplanation/` と同じ単一camelCase
フォルダ規約に合わせた）:

| ファイル | 役割 |
|---|---|
| `types.ts` | ExecutiveRole・メッセージ・提案・構造化応答・診断情報の型 |
| `roles.ts` | 4役員（CEO/CFO/COO/COMMERCIAL）の性格・責務・ルーティング用キーワード |
| `briefing.ts` | ExecutiveBriefingPacket構築（既存`aiExplanation/buildExplanationContext.ts`の出力を再利用） |
| `router.ts` | 決定論的ルーティング（primary/secondary判定・CEO summary要否の既定値） |
| `proposalSchema.ts` | Claude構造化応答のZodスキーマ（defense-in-depth） |
| `validation.ts` | 提案の実データ整合性検証（company/factory/market/product/CAPEX種別・重複検出） |
| `prompt.ts` | システムプロンプト・userメッセージ組み立て |
| `claudeClient.ts` | Claude呼び出し本体（tool定義・attempt/retry・診断ログ） |
| `conversation.ts` | 会話状態の永続化（Redis）・履歴truncation |

API: `app/api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/`
（`route.ts` + `_lib/{handlers,dependencies,withApiContext}.ts`。既存`ai-explanation/`と
同じ規約）。

## 6. ExecutiveBriefingPacket設計

`briefing.ts` の `buildExecutiveBriefingPacket()` は、既存の
`aiExplanation/buildExplanationContext.ts` が既に組み立てている `ExplanationContext`
（プレイヤー画面が既に見ている範囲だけをALLOWLISTした既存の派生オブジェクト）を入力として
再利用し、そこから役員ごとの厚いsubsetを切り出す**純粋関数**。新しい状態読み込み経路・
新しい能力算出ロジックは増設していない。

- **common**（全役員共通）: 会社ID・turn・現金残高・binding capacity（共有ボトルネック
  考慮済みの実行可能生産上限）・overdue backlog上位5件・プレイヤーdraft要約・
  Standard AI診断reasonCode上位8件（severity降順）。
- **cfo**: 貸借対照表全項目・借入残高・有利子負債件数・前四半期比較（cash/revenue/OP）。
- **coo**: 工場別能力上位5件・nominal/effective/binding合計・原料在庫合計・常用人員合計・
  商品別品質スコア。
- **commercial**: 市場×商品別backlog全件・顧客信頼度・納期信頼性・営業人員配置・
  国内原料市場の公開清算結果件数（lifecycle/supply pressure trendの有無）。
- **ceo**: 上位4件のreasonCode（severityのみ）・関与ドメイン一覧（全体感の把握用、詳細は含めない）。

**トークン予算の制約と、そこからの逸脱点（正直な開示）**: 実装指示は「3-4Q trend windows」を
briefingへ含めることを求めているが、監査の結果、`PlayerScreenViewModel` が実際に保持する
trend情報は `previousQuarterFinancials`（turn-1の1四半期ぶんのみ）だけであり、それ以上の
複数四半期trendを構築するための追加の履歴読み込み経路は現時点で存在しない（`recentHistory`
はturn/period等のメタデータのみでKPIを含まない）。新しい履歴集計ロジックを本フェーズで
新設すると「既存の状態読み込み経路だけを再利用する」という設計原則から外れるため、
本MVPでは**現在turn＋直近1四半期比較のみ**とし、この制約をここに明記する
（真の複数四半期trend表示は将来phaseの課題として残す）。

## 7. ルーティング（router.ts）

- キーワードベースの簡易分類（実装指示の例示マッピングに準拠: 現金/借入/融資→CFO、
  工場/生産/労働/原料/納期→COO、市場/価格/契約/販売/顧客→Commercial、戦略/優先/全体→CEO）。
- 明示的にCEO宛て（「CEO」「社長」「全体として」等）の場合はCEOをprimaryにする。
- secondaryは、2番目にマッチ数が多い役割が「primaryのマッチ数の半分以上」の場合のみ
  最大1名設定する（実装指示§35「max 1 additional」）。
- どの役割にもマッチしない場合はCEOをprimaryにする（全体方針についての一般的な質問として扱う）。
- **この判定はClaudeへの既定値（ヒント）であり、最終的なprimarySpeakerはClaude自身が
  構造化応答の中で決定する**（`routingHint` としてuserMessageへ含めるのみで、強制はしない）。

## 8. CEO summary要否

`shouldSuggestCeoSummary()` は、以下のいずれかに該当する場合のみtrueを既定提案する:
1. 複数役員の意見（stance）が対立している
2. 提案（proposals）が2件以上ある
3. プレイヤーが明示的にCEO・全体方針を求めている

該当しない通常の単一領域の質問では、CEO summaryを含めない（実装指示§37）。Claude自身が
最終的に `requiresCeoSummary` を決定する。

## 9. 会話状態（conversation.ts）

- **ゲーム状態SSoTとは別名前空間**: `companylab:v2:{labId}:{companyId}:aiMeeting:{meetingId}`
  というキーで、既存の `CompanyLabRedisClient`（`aiExplanation/reportCache.ts`と同じ接続・
  timeoutパターン）へ保存する。ゲームの意思決定・状態を書き換える経路は存在しない。
- meetingIdは省略時 `{labId}:{companyId}:turn{turn}`（1turn＝1ミーティング）を既定とする。
- **履歴truncation**: 永続化自体は全メッセージを保持するが、Claudeへ毎回送るのは直近8件
  （6-10件の範囲。`AI_MEETING_RECENT_MESSAGE_COUNT=8`）＋古い部分の簡潔な要約のみ
  （`buildRecentHistoryForPrompt`）。この要約は追加のClaude呼び出しをせず、決定論的な
  文字列圧縮（各発言の先頭80文字を連結）で作る（コスト・レイテンシを増やさないための
  意図的な単純化。将来phaseでLLMによる要約に置き換える余地は残す）。

## 10. 提案（Proposal）スキーマとValidation層

7ドメイン（SALES/PRODUCTION/PROCUREMENT/LABOR/FINANCE/CAPEX/VAP_PRODUCT_DEVELOPMENT）を
`AiMeetingProposal` の共用体として定義（`types.ts`）。各ドメインは既存のDecision schemaの
実際の粒度に合わせた（CAPEXは実在する`CapitalProjectType`10種のみ、`pdMechanization`は
`targetFactoryId`必須）。

**【M1.1で訂正】SALESドメインは単一の粒度ではない**: `app/lib/v2/sales/types.ts`の
`CompanySalesPlanEntry`・`app/lib/v2/sales/salesForce.ts`の
`validateSalesForceHeadcountBudget`を監査した結果、営業人員(`salesForceHeadcount`)は
**市場単位で共有**される（同一market内の全product行が同一の`salesForceHeadcount`を
持たなければならず、違反すると入力エラーになる）一方、販売数量(`desiredQuantityTons`)・
価格調整(`priceAdjustmentUsdPerHosoEqKg`)は**market×product単位**という非対称な粒度
であることが判明した（初版のドキュメントはこれを「SALESはmarket×product単位＋
salesForceHeadcount」と誤って一体化して記載していた——初版実装のバグでもあった）。
`SalesProposal`は`scope`で2種類に分離した:
- `SalesQuantityProposal`（`scope: "MARKET_PRODUCT"`）: `market`＋`product`＋
  `desiredQuantityTons`/`priceAdjustmentUsdPerHosoEqKg`のみ。`salesForceHeadcount`は含まない。
- `SalesForceProposal`（`scope: "MARKET"`）: `market`＋`salesForceHeadcount`のみ。
  `product`は含まない。

「日本向けPDに営業を3人追加」のような商品単位の営業人員配置は、`aiMeetingProposalSchema`
（discriminatedUnionではなくz.unionで実装。理由は両scopeが同じ`domain="SALES"`を共有する
ため）を構造上通過できない（`scope=MARKET_PRODUCT`のスキーマは`salesForceHeadcount`
フィールド自体を定義していないため、Claudeがこのフィールドを付けて返してもZodの既定挙動
（未知キーの除去）で結果から消える）。プロンプト（`prompt.ts`）・tool定義の
description（`claudeClient.ts`）双方にもこの区別を明示した。テストAMM-12/12b/12c/12dで
この構造的制約を証明済み。

Claude出力は以下の二段階で検証してからUIへ返す:
1. **`proposalSchema.ts`（Zod）**: 型・enum・配列件数上限（responses<=3, proposals<=3等）の検証。
2. **`validation.ts`**: 実データとの整合性検証——
   - company/factory/market/product/CAPEX種別の実在確認
   - 同一CAPEX案件（projectType×targetFactoryId）の重複検出
   - sales提案のscope別妥当性（`scope=MARKET`は`salesForceHeadcount`が0以上の整数、
     `scope=MARKET_PRODUCT`は`product`の実在確認と`desiredQuantityTons`の非負確認）
   - 数値の有限性（Zodの`.finite()`で担保）
   - 現在turnと一致しない場合は編集不可として`issues`へ記録
   - financiallyRisky（現金残高比の簡易heuristicによるsoft flag。M1では
     Finance Gateの完全な再計算はしない——実装指示§48の明示的なスコープ外指定に対応）

検証を通過した提案のみ `ValidatedAiMeetingProposal[]` としてUIへ返す。**M1では自動適用しない**
（UIへ返すのみ。適用UIはM2以降でUI担当と接続する）。

## 11. プレイヤー意図・戦略転換検知

`meetingIntent`（GROW_AGGRESSIVELY/PROTECT_CASH/REDUCE_BACKLOG/PRIORITIZE_JAPAN/
DEFER_CAPEX/CUSTOM）は当該ミーティング・turn限りの情報として構造化応答に含まれ、
会話状態へ記録されるのみで、Vision/Profileへの自動反映は一切行わない。

`potentialStrategicChange`（プレイヤーが恒久的な戦略転換を明言した場合のみtrue）も同様に
情報フラグとしてのみAPI応答に含まれ、自動適用されない（実装指示§51「without auto-applying」）。
これはAPIハンドラー（`handlers.ts`）がCompanyDecisionDraft・CompanyLabStateへの書き込み関数を
一切importしていないことで構造的に保証される。

## 12. API

`POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages`

リクエスト: `{ meetingId?: string, playerMessage: string, currentPlayerDraft?: unknown }`
（`currentPlayerDraft`はM1では未使用のプレースホルダ。将来phaseでdraftとの整合表示に使う想定）。

応答（200、Claude成功時）:
```json
{
  "meetingId": "...",
  "messages": [/* このリクエストで追加されたPLAYER + Executiveメッセージ */],
  "validatedProposals": [/* ValidatedAiMeetingProposal[] */],
  "meetingIntent": "...",
  "potentialStrategicChange": false,
  "potentialStrategicChangeNote": null,
  "available": true,
  "diagnostics": { "model": "...", "inputTokens": 0, "outputTokens": 0, "stopReason": "...", "latencyMs": 0, "retryCount": 0, "schemaValidationResult": "ok" }
}
```

失敗時（200、`available: false`）: `available: false` と `unavailableReason` を含む
構造化フォールバック応答を返す（例外は投げない）。

`GET .../ai-meeting/messages?meetingId=...` は読み取り専用（会話全体の再取得。副作用なし）。

既存の `ai-explanation` と同じ `assertStagingAdmin` 認証ゲートを再利用する。

## 13. プロンプト構成

`prompt.ts` の `AI_MANAGEMENT_MEETING_SYSTEM_PROMPT` は固定文字列（バージョン管理は
`AI_MEETING_PROMPT_VERSION`）。含む内容: 4役員の性格・責務、発言形式（最大3件・
primary2-5文/secondary1-4文/CEO summary2-4文）、CEO summary要否の判断基準、
factsUsedによる引用の義務化、standardAiReferencesの使い方、proposalsの実在ID限定、
SALES提案のmarket×product粒度の義務化、meetingIntent/potentialStrategicChangeの
非自動適用の明示。

userメッセージ（`buildMeetingUserMessage`）は `{ executiveBriefingPacket,
standardAiCurrentDecisionSummary, compactMeetingSummary, recentHistory, routingHint,
meetingIntentHint, playerMessage }` のJSON。32Qの生履歴・冗長な過去の説明文は含まない。

## 14. トークン・コスト設計 / max_tokens・schema安定性への対応

三宅さんの追加指示（Claude API Capacity / Schema Stability）に基づき、以下を実装した。

- **max_tokens**: `AI_MEETING_MAX_OUTPUT_TOKENS = 4096`（AI Explanation機能で実績のある値を
  踏襲。1200のような小さい固定値には戻さない）。`docs/standard_ai/benchmarks/
  ai_meeting_capacity_benchmark.md`（`scripts/aiMeetingCapacityBenchmark.ts`で生成）で、
  responses3件＋proposals3件＋factsUsed6件＋standardAiReferences3件という許容最大サイズの
  応答でも出力トークン概算は約894トークン（maxTokensの約22%）に収まることを確認した
  （約78%の余裕）。
- **stop_reason明示検知**: `response.stop_reason === "max_tokens"` を検知し、
  `failureCause`/`schemaValidationResult` へ `"max_tokens_truncation"` として、
  純粋な `"schema_mismatch"`（モデルの型逸脱）とは区別して記録する。
- **retry方針**: invalid_json/schema_mismatch/empty_response（max_tokens truncation由来を
  含む）は最大1回のみ再試行（合計最大2回のAPI呼び出し）。http_error/network_errorは
  再試行しない。retry stormは起こさない。
- **毎call診断**: `AiMeetingCallDiagnostics`（model/inputTokens/outputTokens/stopReason/
  latencyMs/retryCount/schemaValidationResult）を、成功・失敗いずれの場合も必ず返す。
- **スキーマの単純さ**: proposal内のdomain別フィールドは、深いネスト（oneOf/discriminated
  union）を避け、1つのフラットなobjectへ全フィールドをoptionalとして並べる設計にした
  （tool定義自体のinput token消費・Claudeが解釈すべき構造の複雑さを抑える）。
  domain別の必須フィールドの区別はdescription文言＋プロンプト本文と、受信後のZod
  discriminated union検証（`proposalSchema.ts`）の二段構えで担保する。
- **上限**: responses<=3件、proposals<=3件、factsUsed<=6件/発言、standardAiReferences<=3件/発言。
- **会話履歴の非全件再送**: 直近8件＋古い部分の決定論的な要約のみ（§9参照）。
- **実APIでのsmoke test経路**: `scripts/aiMeetingCapacityBenchmark.ts` は
  `ANTHROPIC_API_KEY` が設定されている場合のみ実APIを2回呼び、diagnosticsを実測ログへ出す
  （未設定時は自動でスキップ。`npm test`・CIからはこのスクリプト自体を呼ばないため、
  実APIを誤って叩くことはない）。

## 15. エラーハンドリング・timeout/retry・セキュリティ

- Claude呼び出し失敗（missing_api_key/http_error/invalid_json/schema_mismatch/
  empty_response/network_error のいずれ）でも例外を投げず、常に構造化された
  `{ available: false, unavailableReason, diagnostics }` をHTTP 200で返す。
  Standard AIのdraft・ゲームセッションは一切変更されない（このAPI自体が書き込み経路を
  持たないため構造的に保証される）。
- timeout: 既存の `EXPLANATION_CLAUDE_TIMEOUT_MS`（40秒）をそのまま再利用。
- retry: 既存の `EXPLANATION_CLAUDE_MAX_RETRIES=0`（SDK自動retry無効化）をそのまま再利用し、
  アプリ側で最大1回のみの明示的retryを実装（§14参照）。
- `ANTHROPIC_API_KEY` はサーバー側のみで読み取り、クライアントへは一切渡らない
  （既存の `ai-explanation` と同じ、Next.js Server Action/API Routeのサーバー側専用パターン）。
  ログにもAPIキー・prompt本文（機微になり得る経営数値）は出力せず、診断情報
  （token数・stopReason・latency等）のみを出力する。

## 16. UI契約（M2への引き継ぎ）

本フェーズ（AMM-M0/M1）ではUIの本実装は対象外（別branch/セッションのUI担当が担当）。
M2でUIが接続する際のAPI契約は §12 のとおり。UIは以下を実装する想定:
- チャット入力（プレイヤー発言）→ POST → `messages` を会話ログへ追記表示。
- `validatedProposals` を「AIからの提案」として表示し、プレイヤーが個別に承認した場合のみ
  （M2以降で）実際のDecision Draftへ反映する適用フローを別途実装する。
- `available: false` の場合は「AI Management Meetingは現在利用できません」という
  グレースフルなフォールバック表示（ゲーム進行は妨げない）。

## 17. テスト（AMM-1〜18）

`app/lib/v2/companyLab/aiManagementMeeting/__tests__/`（router/briefing/
proposalValidation/conversation）と `app/api/v2/company-labs/_lib/__tests__/
aiMeetingHandlers.test.ts`（角括弧ディレクトリ内のhandlers.tsを直接importするため、
既存の`ai-explanation`テストと同じ理由で角括弧を含まない場所に配置）に実装。
実Anthropic APIは一切呼ばず、既存の手書きフェイク`AnthropicMessagesClient`注入パターン
（モックライブラリ不使用）を踏襲した。全28テスト（AMM-1〜18の要求項目＋補助テスト）が
成功することを確認済み。

## 18. 品質ゲート・本番ゲーム挙動への影響

- `npx tsc --noEmit`: エラーなし。
- `npx eslint`（新規/変更ファイル）: エラーなし。
- `npm test`: 全3125件成功（既存テストの回帰なし）。
- **Standard AI・Portfolio Calibration・既存のAI Explanation・Management Console・
  ゲームエンジン・永続化・Decision Draftへのコード変更: なし**（新規ファイルの追加のみ。
  既存ファイルは一切編集していない）。本番ゲーム挙動（Standard AIの意思決定結果）は
  この変更によって一切変わらない。

## 19. 残存リスク・M2への申し送り

- ExecutiveBriefingPacketのtrend windowが「直近1四半期比較のみ」であり、指示にあった
  「3-4Q trend」を満たしていない（§6参照。追加の履歴集計ロジックが必要）。
- `financiallyRisky` はcash残高比の簡易heuristicであり、実際のFinance Gate
  （`financialGateFor`等）の再計算ではない。M2以降で提案の自動適用を実装する際は、
  適用前に既存のFinance Gate相当の検証を挟むことを推奨する。
- role-blendingの定量評価は実API呼び出しでの確認が未実施（`ANTHROPIC_API_KEY`が
  本セッションの環境に設定されていないため）。`scripts/aiMeetingCapacityBenchmark.ts`の
  smoke test経路を使い、実運用開始前に開発者が手動で数回確認することを推奨する。
- 会話要約（compactSummary）は決定論的な文字列圧縮のみで、意味的な要約ではない。
  会話が長期化するユースケースが増えた場合、LLMベースの要約への切り替えを検討する余地がある。

## 20. M1.1（Real API Smoke Test / Sales Schema Final Check）追記

ChatGPT #05からの追加指示（前提HEAD `d5a8e57`）に基づく対応。

### 20.1 Sales proposal schema最終監査（§4対応）

M0/M1の初版実装には、実際にご指摘のバグが存在した。`SalesProposal`が1つのオブジェクトに
`market`・`product`・`salesForceHeadcount`を同居させており、「Japan PDに営業を3人追加」
という、ShrimpXには存在しない粒度（商品単位の営業人員）の提案が構造上作れてしまっていた。

監査の結果（`app/lib/v2/sales/types.ts`の`CompanySalesPlanEntry`、
`app/lib/v2/sales/salesForce.ts`の`validateSalesForceHeadcountBudget`）、実際のゲーム構造は:
- 営業人員(`salesForceHeadcount`): **market単位**で共有（同一market内の全product行が
  同一の値を持たなければならず、違反は入力エラー）
- 販売数量・価格調整: **market×product単位**

という非対称な粒度であることを確認し、`SalesProposal`を`scope`で2種類（`MARKET_PRODUCT`
＝販売数量/価格、`MARKET`＝営業人員）へ分離した（詳細は§10参照）。修正後、以下のテストで
「無効な提案が構造上生成・validation通過できないこと」を証明した:
- AMM-12: `scope=MARKET`は`salesForceHeadcount`のみ検証、`scope=MARKET_PRODUCT`は
  `product`実在確認・`desiredQuantityTons`非負確認のみ検証（validation.ts）
- AMM-12b: `scope`未指定のSALES提案はZodで拒否される
- AMM-12c: `scope=MARKET_PRODUCT`に`salesForceHeadcount`を付けても、Zodの既定挙動
  （未知キー除去）で結果から消え、「商品単位の営業人員」という意味論は成立しない
- AMM-12d: `scope=MARKET`に`product`を付けても、同様に結果から消える

### 20.2 実Claude API Smoke Test（§1・§2・§5対応）

`scripts/aiMeetingRealApiSmokeTest.ts`を新設した。8つの最低ケース（CFO質問・COO質問・
Commercial質問・CEO/strategy質問・CEO summary要求・primary+secondaryが必要な投資質問・
structured proposalを返す質問・比較的長いPlayer message）を実行し、各callで
model/inputTokens/outputTokens/latencyMs/stopReason/retryCount/schemaValidationResult/
primarySpeaker/secondarySpeaker/proposalCountを記録する設計。CIには組み込まない
（`npm test`・tscからはこのスクリプト自体を呼ばない）。

**本セッションの実行環境には`ANTHROPIC_API_KEY`が設定されていないため、実APIでの
smoke testは実施していない（`REAL_API_SMOKE_NOT_RUN`）**。実行すると
`docs/standard_ai/benchmarks/ai_meeting_real_api_smoke_test.md`にその旨と、
API keyを持つ開発者が手動実行するための手順（コマンド例・評価観点）が出力される。
手順:
```
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/aiMeetingRealApiSmokeTest.ts
```

### 20.3 変更ファイル（M1.1）

`types.ts`（SalesProposal分離）・`proposalSchema.ts`（discriminatedUnion→z.union、
salesQuantity/salesForceの2スキーマ化）・`validation.ts`（scope別検証）・
`claudeClient.ts`（tool JSON schemaへscope・粒度の説明追加）・`prompt.ts`
（システムプロンプトのSALES提案ガイダンス訂正）・`__tests__/proposalValidation.test.ts`
（AMM-12/12bの内容更新＋AMM-12c/12d新設）・`scripts/aiMeetingCapacityBenchmark.ts`
（worst-caseペイロードを新schemaへ追従）。**Standard AI・ゲームエンジン・既存の
Decision schema自体（`app/lib/v2/sales/`等）への変更はなし**（AI Management Meeting
モジュール内のみの修正）。

## 21. M2.1（Backlog Semantics / Fact Grounding Correction）追記

ChatGPT #05からの追加指示（Test26 Dynamic Scenario、BAL Turn1での実誤回答を受けた訂正）
に基づく対応。

### 21.1 root cause

初版の`briefing.ts`（AMM-M0/M1時点）は、既存の`computeBacklogByMarketProduct`
（`openingStateSummary.ts`）が返す「outstanding合計（納期を問わず全件合算）」を、
**`overdueBacklogTopN`という名前のフィールドへそのまま格納していた**。この関数自体は
overdue（納期超過）かどうかを一切判定しない単純な合計であり、名前だけが「overdue」を
名乗っていた。この命名と実装のズレが、Commercial Directorに「backlogが存在する＝
納期遅延している」と誤解釈させる直接の原因だった。

さらに、Commercial向けbriefingには実売上・受注実績データが一切含まれておらず
（財務実績は`cfo`サブセットのみに存在）、「Q2売上$66.4M」という具体的な数値は
BriefingPacketに存在しないデータの完全な捏造だったと判断される。

### 21.2 current backlog semantics（訂正後）

`backlogSemantics.ts`の`computeBacklogSemantics()`が、既存の`SalesContract.dueDate`・
`outstandingQuantity`（新しい観測は追加しない）だけから、PC-2C
（`scripts/pc2BacklogProductDiagnosis.ts`）で確立した方法論
（`periodIndex(dueDate) < currentPeriodIdx` ならoverdue）を再利用し、
Healthy Forward（納期未到来）／Due This Turn（当四半期納期）／Overdue（納期超過）を
明示的に分離する。`common.backlog`・`commercial.backlog`双方に
`{totalTons, healthyForwardTons, dueThisTurnTons, overdueTons}`として渡し、
`commercial.backlogByMarket`/`backlogByProduct`/`backlogByMarketProduct`
（各エントリに`earliestDueLabel`を含む）で市場・商品別の内訳も渡す。`coo.backlogByProduct`
にも同じ商品別内訳を渡す（生産計画の参考情報として）。

### 21.3 Trust code audit result

`app/lib/v2/quality/scoreUpdates.ts`の`updateDeliveryReliabilityScore`・
`updateCustomerTrustScore`を監査した結果、engine側は`dueQuantity`（当期に納期が来た数量）・
`onTimeQuantity`（そのうち期日通り履行できた数量）・`continuingOverdueQuantity`（持ち越しの
overdue分）——**当期に実際に発生した履行実績**——だけでTrust/delivery reliabilityを
更新しており、**未到来のoutstanding残高（healthy forward backlog）そのものは一切
参照していない**ことを確認した。engine側の設計は既にご指摘の原則（Backlog != Overdue）
どおりであり、変更不要と判断した。「#04設計問題」として報告すべき事象は見つからなかった。

### 21.4 BriefingPacket before/after

| フィールド | Before（バグ） | After（訂正後） |
|---|---|---|
| `common.overdueBacklogTopN` | 全backlogを`outstandingTons`降順で上位5件（overdue未判定なのに"overdue"と命名） | `common.backlog: {totalTons, healthyForwardTons, dueThisTurnTons, overdueTons}`（廃止し置換） |
| `commercial.backlogByMarketProduct` | `{market, product, outstandingTons, contractCount}`（overdue区別なし） | `commercial.backlog`＋`backlogByMarket`/`backlogByProduct`/`backlogByMarketProduct`（各々overdueTons/dueThisTurnTons/healthyForwardTons分離、earliestDueLabel付き） |
| `commercial.lifecycleTrendCount`/`supplyPressureCount` | 生の配列長（意味不明なraw count） | `commercial.supplyPressureFacts: {product, value, label, humanMeaning}[]`／`lifecycleTrendSummary: {growingCount, shrinkingCount, flatCount, humanMeaning}` |
| Commercialの売上実績 | 存在しない（CFOのみ保持） | `commercial.lastQuarterNetRevenueUsd`＋`commercial.lastQuarterLabel`（同じ値をperiodLabel付きでCommercialにも持たせる） |

### 21.5 supplyPressureCount definition

`context.marketInfo.supplyPressure`（`buildSupplyPressureRows`、`aiMarketInfoSummary.ts`）は
**常にPD・VAPの2要素**を返す固定長配列であり、`length`（count）自体には「供給の余裕度」を
示す意味は一切ない。各要素が持つ`label`（`SupplyPressureLabel`: `oversupply`/`undersupply`/
`balanced`、`classifySupplyPressure`が算出）こそが実際の意味を持つ。「supplyPressureCount=2
→ 市場は供給に余裕」という説明は、この生カウントを独自解釈した完全な誤りであり、コード上の
正式な意味に一切裏付けられていなかった。訂正後は、`label`ごとに固定の`humanMeaning`文字列
（例: `balanced`→「市場全体の需給はおおむね均衡」）を付与して渡す。

### 21.6 quarter label audit

`common.year`/`common.quarter`（`context.identity`由来）自体は正しくturnに対応している。
問題は「Q2売上」という**Commercial自身の発言**が、そもそもBriefingPacketに存在しない
実売上額を、存在しない四半期ラベルとセットで述べていたことにある。訂正後は
`commercial.lastQuarterLabel`（前四半期の正確なラベル。turn1等で前四半期が存在しない場合は
`null`）を明示的に渡し、prompt側にも「四半期に言及する際は必ずBriefingPacket内のラベルを
使い、推測して作らない」ことを明記した（§20.3のプロンプト追加参照）。

### 21.7 numeric hallucination cause

2つの要因が重なっていたと判断する。(1) Commercial向けbriefingに実売上データが無かった
ため、「$66.4M」は完全な捏造だった。(2) 3,063.42tを「3,600t超」と述べた点については、
`overdueBacklogTopN`というフィールド名が実際にはoverdue判定を伴わない単純合計だった
という構造的な誤解に加え、正確な数値が提供されていても大きく異なる数値へ丸めてしまう
挙動が見られた。訂正後は、`factsUsed`に記録されたBriefingPacketの実在フィールドのみを
使うこと、丸める場合も有効数字を大きく変えないこと（例: 3,063t→約3,100t）をprompt本文へ
明記した。

### 21.8 code changes

新設: `backlogSemantics.ts`（Healthy Forward/Due This Turn/Overdue分離）。変更:
`briefing.ts`（`BriefingBuildInput`へ`contracts`追加、`overdueBacklogTopN`廃止、
`commercial`/`coo`へbacklog内訳・売上実績・ラベル付き市場シグナルを追加）・`prompt.ts`
（backlog解釈原則・数値グラウンディング・四半期ラベル使用の明示、`AI_MEETING_PROMPT_VERSION`
をv1→v2へ）・API `handlers.ts`（`viewModel.ownState.contracts`を渡す配線、
`previousQuarter.periodLabel`の算出）・`scripts/aiMeetingRealApiSmokeTest.ts`
（Test26 BAL Turn1相当のbriefingケースをsmoke testへ追加）。**Sales engine・Contract
fulfillment mechanics・Trust mechanics・Standard AI・game parameters・backlogの定義
（`SalesContract`型自体）への変更はなし**（AI Meetingのfact grounding/briefing/prompt
修正のみ）。

### 21.9 tests

`__tests__/backlogSemantics.test.ts`を新設し、AMM-BL-1〜9（Test26 BAL Turn1相当の
AMM-BL-7を含む）を実装。既存の`briefing.test.ts`（AMM-8/AMM-16）も新schema
（`contracts`パラメータ追加）へ追従させた。全3136件成功、tsc/eslintエラーなし。

### 21.10 real API result

**REAL_API_SMOKE_NOT_RUN**（本セッションの環境に`ANTHROPIC_API_KEY`が設定されていない
ため未実施）。`scripts/aiMeetingRealApiSmokeTest.ts`にTest26 BAL Turn1相当の再現ケース
（「前回の営業結果を教えて」、9番目のケースとして追加）を用意済みであり、
`ANTHROPIC_API_KEY`を持つ開発者が手動実行することで、訂正後の実際のClaude応答
（overdue=0のhealthy forward backlogを「納期遅延」と述べていないか等）を確認できる。

### 21.11 remaining risk・readiness for continued Test26

- 訂正の効果は静的なテスト（AMM-BL-1〜9）でのみ検証済みであり、実Claude APIでの
  応答が実際に改善されたことは未確認（§21.10参照）。Test26を再開する前に、可能であれば
  実API smoke testで確認することを推奨する。
- `factsUsed`は依然としてClaude自身の自己申告であり、記載された数値が本当に
  BriefingPacketの値と一致しているかを機械的に検証する仕組みはM1/M2.1のいずれにも
  実装されていない（数値ハルシネーションの完全な技術的防止ではなく、prompt/schema設計に
  よる緩和にとどまる）。将来phaseで、応答内の数値をBriefingPacketの値と照合する
  post-hoc検証層を追加する余地がある。
- lifecycleTrendSummaryは市場×商品の内訳を集約したcount+humanMeaningのみで、
  個別の市場×商品トレンドの詳細（どの市場のどの商品が伸びているか）はCommercialへ
  渡していない。今後、特定市場のライフサイクルについて具体的に聞かれた場合に
  詳細不足で答えられない可能性がある。

## 22. M2.2（Cross-Role Fact Grounding / Finance Semantics / Player Correction Handling）追記

ChatGPT #05からの追加指示（前提commit `10c6cd4`）に基づく対応。

### 22.1 root cause

M2.1でCommercialのbacklog誤発言は修正されたが、その誤発言（会話履歴）を受けて
CFOが「Trust低下→AR回収遅延→投資余力減」という、ShrimpXに存在しない因果を
連鎖的に補完した。根本原因は2つ:
1. 他役員の発言（会話履歴内のexecutiveメッセージ）をfactとして無条件に信頼してよいという
   構造上の歯止めが、prompt/briefingいずれにも存在しなかった（truth hierarchyの不在）。
2. CFO向けbriefingに「売掛金がいつ現金化されるか」という実在する事実
   （`ReceivableRecord.dueSettlementPeriod`）が渡っておらず、一般的な企業会計の
   常識で空白を埋めてしまった（AR collection scheduleの不在）。

### 22.2 AR engine rule（監査結果・変更なし）

`app/lib/v2/finance/quarterClose.ts`・`app/lib/v2/finance/parameters.ts`を監査した結果:
- 売掛金は発生四半期から`params.workingCapital.arCollectionQuarters`（現在値=1）四半期後に、
  市場・商品を問わず一律で決済される（`dueSettlementPeriod = 発生期 + 1`）。
- 買掛金（輸入原料）も同様に`apImportPaymentQuarters`（現在値=1）四半期後。
- 決済処理（`quarterClose.ts`のAR決済セクション）は`dueSettlementPeriod <= period`の
  単純フィルタのみで、Customer Trust・delivery reliabilityを一切参照しない。
- `ReceivableRecord`型自体にarrears（延滞）フィールドは存在しない。融資（`LoanRecord`）には
  `arrearsPrincipalUsd`/`arrearsInterestUsd`があるが、これは返済延滞専用で売掛金とは別の仕組み。

### 22.3 Trust→AR relation: **NO**

`app/lib/v2/quality/scoreUpdates.ts`の監査（M2.1で実施済み、今回再確認）どおり、
Trust/delivery reliabilityは当期の履行実績（`dueQuantity`/`onTimeQuantity`）のみで更新され、
AR回収タイミングへの因果は存在しない。「Trust低下でAR回収が遅れる」という主張は
コード上の根拠が一切無い、CFOによる完全な創作だったと判断する。

### 22.4 CFO briefing before/after

| フィールド | Before | After |
|---|---|---|
| 売掛金 | `receivablesUsd`（残高のみ） | `receivablesUsd`＋`receivablesScheduleByPeriod`（実際の回収予定period・turnsFromNow） |
| 買掛金 | `payablesUsd`（残高のみ） | `payablesUsd`＋`payablesScheduleByPeriod` |
| 融資延滞 | 無し | `loanArrearsPrincipalUsd`/`loanArrearsInterestUsd`（既存`LoanRecord`から） |
| CAPEXコミット | 無し | `activeCapexRemainingCommitmentUsd`（承認済み未払額の合計） |
| 借入余力 | 無し | `borrowingHeadroom`（前四半期に計算済みの実際の`BorrowingCapacityResult`を転記） |
| 危機状態 | 無し | `crisis`（既存Standard AI `diagnostics.crisis`を転記） |

### 22.5 truth hierarchy実装

`prompt.ts`のシステムプロンプトへ、Engine facts→Structured diagnostics→Player訂正→
Standard AI提案→他役員の発言→一般常識、という6段階の優先順位を明記した
（`app/lib/v2/companyLab/aiManagementMeeting/prompt.ts`）。データ構造としての強制は
せず（tool schemaを複雑化させない三宅さんの追加指示§7の方針を踏襲）、prompt文言のみで
実現している。

### 22.6 cross-role grounding

会話履歴（`recentHistory`）はこれまでどおり`{speaker, text}`のプレーンな配列として
渡すが、prompt側に「他roleの発言はopinionであり、自分のBriefingPacketに同じ事実が
無ければ確定事実として扱わない」「他役員の発言に明示的に異議を述べてよい」ことを
明記した。全員を強制的に合意させない設計原則もあわせて明記した。

### 22.7 player correction handling

`AiMeetingStructuredResponse`へ`playerCorrectionStatus`（NOT_APPLICABLE/CONFIRMED/
UNSUPPORTED）・`playerCorrectionNote`を追加した。プレイヤーの事実主張・訂正は、
BriefingPacketと整合する場合のみCONFIRMEDとし、根拠が無い場合はUNSUPPORTEDとして
無条件に事実認定しない（`validation.ts`ではなくClaude自身の構造化出力として判定させ、
Zodで型を検証するだけ——判定ロジック自体を機械的に検証する仕組みはM2.2の対象外）。

### 22.8 correction memory

CONFIRMEDと判定された訂正は、`AiMeetingConversationState.confirmedCorrections`
（`PlayerCorrectionRecord[]`）へ、会話artifactとして記録する（Game SSoTには一切入れない）。
以後の同一meeting内のresponse生成では、`confirmedCorrections`をuserメッセージへ含め、
同じ誤りを繰り返さないよう明示的なメモリとして使う。上限10件（`MAX_CONFIRMED_CORRECTIONS`）。

### 22.9 RuleSemantics

`briefing.ts`に`RULE_SEMANTICS`（backlog/overdue/healthyForwardBacklog/receivables/
customerTrustの5用語について、company状態に依存しない固定の短い定義）を新設し、
`common.ruleSemantics`として常に渡す。token増大を避けるため、company別に変わる長文
説明ではなく固定辞書とした。

### 22.10 prompt version / briefing version

`AI_MEETING_PROMPT_VERSION`をv2→v3、新設した`EXECUTIVE_BRIEFING_VERSION`をv3とし、
`common.briefingVersion`として渡す。両者を揃えることで、旧versionとの混在を識別可能にした。

### 22.11 legacy conversation handling

`AiMeetingMessage`へ`promptVersion`（生成時のprompt version。PLAYERメッセージには
設定しない）を追加した。`conversation.ts`の`formatHistoryEntryForPrompt()`が、
現在のprompt versionと異なるexecutiveメッセージのtextへ`[legacy vN ...]`という
警告タグを前置してからClaudeへ渡す。新しい構造化フィールドは増やさず、既存の
`{speaker, text}`の枠内で実現している。

### 22.12 code changes

新設: `financeSemantics.ts`（AR/AP schedule・融資延滞・CAPEXコミット残高の導出）。
変更: `types.ts`（playerCorrectionStatus・PlayerCorrectionRecord・confirmedCorrections・
promptVersion追加）・`proposalSchema.ts`/`claudeClient.ts`（同フィールドのZod/tool schema対応）・
`briefing.ts`（CFO finance fields・RuleSemantics・briefingVersion・crisis/borrowingHeadroom追加）・
`conversation.ts`（correction memory・legacy message tagging）・`prompt.ts`（truth hierarchy・
cross-role grounding・fact/judgment分離・投資余力ガイダンス・v3）・API `handlers.ts`
（finance state・crisis・borrowingHeadroomの配線、correction memoryの永続化）。
**Standard AI・Finance engine・Sales engine・Contract fulfillment・Customer Trust・
CAPEX mechanics・game parametersへの変更はなし**（AI Management Meetingモジュール内のみ）。

### 22.13 tests

`__tests__/factGrounding.test.ts`を新設し、AMM-FG-1〜4・7〜10を実装。
`aiMeetingHandlers.test.ts`へAMM-FG-5・6（correction memoryのhandler結合テスト）を追加。
既存テスト（AMM-9/18等）も新schema（playerCorrectionStatus必須化）へ追従させた。
全3146件成功、tsc/eslintエラーなし。

### 22.14 real API test

**REAL_API_SMOKE_NOT_RUN**（本セッションの環境に`ANTHROPIC_API_KEY`が設定されていない
ため未実施）。`scripts/aiMeetingRealApiSmokeTest.ts`へ、指示§22のA〜D相当の4ケース
（Test26 BAL Turn1状態、Cash≈38.2M/Debt≈50.6M/AR≈66.4M/Backlog≈3063t/Overdue=0）を
追加済み（計12ケース）。`ANTHROPIC_API_KEY`を持つ開発者が手動実行することで確認できる。

### 22.15 remaining risks・readiness for continued Test26

- truth hierarchy・cross-role groundingはprompt文言による誘導であり、Claudeの出力を
  機械的に強制する仕組みではない。実API未検証のため、効果は理論的な設計としてのみ
  確認済み（静的テストで構造・文言の存在は証明したが、実際の応答品質は未検証）。
- `playerCorrectionStatus`の判定ロジック自体（BriefingPacketとの整合性判断）はClaude内部の
  推論に委ねられており、機械的な整合性チェック層は無い（`AiMeetingCallDiagnostics`の
  `schemaValidationResult`は型検証のみで、内容の正しさは検証しない）。
- `confirmedCorrections`は文字列（note）のリストであり、構造化されたfact参照ではない。
  将来phaseで、より構造化された「何が確認されたか」の表現（例: factKeyの参照）へ
  発展させる余地がある。
- 実API未検証のため、M2.1・M2.2の修正が実際にTest26の再誤答を防げているかは
  引き続き確認が必要。`ANTHROPIC_API_KEY`を持つ開発者による実行を強く推奨する。

## 23. M2.3（CFO Accounting Grounding / P&L-Cash-BS Separation / Variance Analysis）追記

### 23.1 root cause

Test26 BAL Turn2で、CFOが「売上債権の現金回収の遅れが営業利益の赤字要因」と説明した
（会計上の誤り。売掛金の回収タイミングはBalance Sheet/Cash Flowの事象であり、発生主義の
Operating Profitには直接関係しない）。プレイヤーが2回訂正しても、CFOはP&Lの話へ移行した後も
「原料費等の現金支出が売上を上回った」というcash用語のままP&Lを説明し続けた。根本原因は、
CFO向けbriefingがP&L・Cash Flow・Balance Sheetを区別せず、`receivablesUsd`（BS残高）と
`netRevenueUsd`（P&L）だけを渡していたため、Claudeが3表を混同する余地があったこと。

### 23.2 accounting engine audit

`app/lib/v2/finance/types.ts`の`ProfitAndLossStatement`・`BalanceSheet`・
`CashFlowStatement`・`CostOfSalesBreakdown`を監査した結果、実装指示§4-§6が要求する
全フィールド（grossRevenue〜netIncome、receiptsFromCustomers〜closingCash、
cash〜totalEquity等）は**既にengine（`finance/quarterClose.ts`）が計算済み**であり、
新しい会計計算を一切増設する必要がないことを確認した。M2.1（backlog）・M2.2（AR）とは異なり、
今回はengine側に真のギャップ・バグは見つからなかった（`finance/quarterClose.ts`自体は
一切変更していない）。

### 23.3 P&L/CF/BS separation

`app/lib/v2/companyLab/aiManagementMeeting/pnlSemantics.ts`（新規）に、既存の値を
そのまま転記するだけの`PnlPacket`・`CashFlowPacket`・`BalanceSheetPacket`（実装指示
§4-§6のフィールドを平坦化しただけ）を定義。`briefing.ts`の`CfoBriefing`へ
`financialStatements: { pnl, cashFlow, balanceSheet } | null`として追加し、
3表を構造的に分離して渡す。

### 23.4 CFO briefing before/after

- before: `cfo.receivablesUsd`（BS残高）と`cfo.previousQuarter.netRevenueUsd`（P&Lの
  一部）のみが混在して渡され、P&L・Cash Flow・Balance Sheetの構造的な区別が無かった。
- after: `cfo.financialStatements.{pnl,cashFlow,balanceSheet}`が3つの独立したpacketとして
  渡され、`cfo.pnlVariance`（発生主義の前期比差分）・`cfo.volumePriceFacts`（数量/平均単価の
  前期比）が別途追加された。

### 23.5 variance analysis実装

`computePnlVariance(current, prior, ...)`が、`ProfitAndLossStatement`2期分から
revenueDelta・各コスト科目delta・operatingProfitDelta等（実装指示§9の全フィールド）を
単純な差分として計算する（新しい会計解釈はしない）。`handlers.ts`が
`deps.repository.loadHistoryEntry(labId, currentTurn-1)`と`(labId, currentTurn-2)`を
それぞれ取得し（存在しなければ`CompanyLabHistoryEntryNotFoundError`を捕捉してnull、
捏造しない）、reportingPeriod（直近確定四半期）・priorPeriod（その前期）として
`buildExecutiveBriefingPacket`へ渡す。

### 23.6 Test26 T1→T2 variance結果（fixtureによる検証）

実装指示§10の実データに基づくfixture（`AMM-ACC-7`・`AMM-ACC-8`）で検証:
Turn1 netRevenue≈$66.594M/operatingProfit≈+$6.30M → Turn2 netRevenue≈$62.938M/
operatingProfit≈-$0.059M。`computePnlVariance`はrevenueDelta≈-$3.66M、
operatingProfitDelta≈-$6.36Mを正しく算出することを確認した。

### 23.7 price/volume解釈

`computeVolumePriceFacts(currentVolumeTons, currentNetRevenueUsd, priorVolumeTons,
priorNetRevenueUsd, ...)`が、既存のfulfilledQuantity・netRevenueの単純な除算のみで
`averageRealizedPriceUsdPerTon`を導出する（新しいPVM分解エンジンは作らない。実装指示§12の
「M2.3では不要」という明示的な許可の範囲内）。Turn1→Turn2で数量は増加（約12,591t→約14,407t）
したが平均実現単価は下落しており、`AMM-ACC-9`で検証済み。

### 23.8 Operating Profit vs Net Incomeの扱い

`PnlPacket`は`operatingProfit`と`interestExpense`・`netIncome`を独立したフィールドとして
保持する（`interestExpense`はOperating Profitの下）。prompt.tsに「Operating Profitの
赤字理由の説明にInterest Expenseを含めない／Net Incomeの説明には含めてよい」という
明示的な区別を追加した（実装指示§14）。

### 23.9 RuleSemantics

`briefing.ts`の`RULE_SEMANTICS`へ`operatingProfit`・`accountsReceivable`（更新）・
`operatingCashFlow`・`interestExpense`の4エントリを追加（実装指示§16の内容を
日本語で表現）。

### 23.10 player correction handling

M2.2で実装済みの`playerCorrectionStatus`/`confirmedCorrections`の仕組みをそのまま再利用。
prompt.tsに、「P&LとCash Flowを混同している」等の会計カテゴリの誤りをプレイヤーが指摘した
場合、単に謝るだけでなく同一meeting内で同じ種類の誤りを繰り返さない旨を明記した
（実装指示§18。新しい永続化層は追加していない）。

### 23.11 code changes

- 新規: `app/lib/v2/companyLab/aiManagementMeeting/pnlSemantics.ts`
  （PnlPacket/CashFlowPacket/BalanceSheetPacket/PnlVariance/VolumePriceFacts + builder関数）
- 変更: `briefing.ts`（`financialHistory`入力、`financialStatements`/`pnlVariance`/
  `volumePriceFacts`をCfoBriefingへ追加、RULE_SEMANTICS 4エントリ追加、
  `EXECUTIVE_BRIEFING_VERSION`を"v3"→"v4"）
- 変更: `prompt.ts`（P&L/Cash/BS分離の会計ガードレール一式を追加、
  `AI_MEETING_PROMPT_VERSION`を"v3"→"v4"）
- 変更: `handlers.ts`（`deps.repository.loadHistoryEntry`による直近2四半期取得を追加し、
  `financialHistory`を`buildExecutiveBriefingPacket`へ配線）
- 既存の`finance/quarterClose.ts`・Standard AI・Sales/pricingエンジン・Trust・
  game parametersは一切変更していない（実装指示§21の禁止事項の遵守）。

### 23.12 tests

`app/lib/v2/companyLab/aiManagementMeeting/__tests__/accountingSemantics.test.ts`に
AMM-ACC-1〜12（12件）を新規追加。既存backlogSemantics.test.ts・briefing.test.ts・
factGrounding.test.tsは、`financialHistory`フィールド追加に伴う呼び出しシグネチャの
変更のみ機械的に対応（`financialHistory: { reportingPeriod: null, priorPeriod: null }`）。
factGrounding.test.tsのAMM-FG-9（version識別テスト）を"v3"→"v4"へ更新。
AMM系テスト計49件、プロジェクト全体3157件、いずれもpass。

### 23.13 real API結果

このセッションの実行環境には`ANTHROPIC_API_KEY`が設定されていないため未実施
（M2.1・M2.2と同様）。`scripts/aiMeetingRealApiSmokeTest.ts`へ、Test26 BAL Turn2の
実会話再現ケース「9E. Test26 BAL Turn2再現（P&L/Cash/BS混同なしの営業赤字説明）」
（プレイヤー発言「2Qが営業赤字ですか？理由は？」、`test26Turn2Briefing()`に
実データベースのfinancialStatements/pnlVariance/volumePriceFactsを組み込み済み）を
追加した（計13ケース）。`ANTHROPIC_API_KEY`を持つ開発者が手動実行することで、
Operating Profit≈-$0.06Mへの急激な悪化・売上減少約$3.7M・処理費/労務費/固定費/SG&A増加・
販売数量自体は増加・市場価格下落が主因・AR回収は原因ではない、という方向で
CFOが応答するかを確認できる。

### 23.14 remaining risks

- M2.1・M2.2と同様、prompt文言による誘導であり、Claudeの出力を機械的に強制する
  仕組みではない。実API未検証のため、実際の応答品質（特に9Eケースでの改善）は
  引き続き確認が必要。
- `financialHistory`のreportingPeriod/priorPeriodは、`CompanyLabHistoryEntryNotFoundError`
  発生時にnullとして扱われる（捏造しない設計）。turn1・turn2等、履歴が浅い場合は
  `financialStatements`/`pnlVariance`がnullのままとなり、CFOが「データが無いため
  variance分析はできない」と答えることが期待されるが、実応答での確認は未実施。
- `computeVolumePriceFacts`の`averageRealizedPriceUsdPerTon`は単純な除算であり、
  商品構成（product mix）の変化までは分解しない（実装指示§12で明示的に許可された
  スコープ限定）。より詳細なPrice-Volume-Mix分解が必要になった場合は将来phaseの対象。

### 23.15 readiness for continued Test26

P&L/Cash Flow/Balance Sheetの構造的分離・variance分析・Operating Profit/Net Incomeの
区別・会計用語ガードレール・player correctionの会計カテゴリへの拡張が、コード・
テスト・prompt文言の3層で揃った。次のTest26継続セッションでは、Turn2の「2Qが営業赤字
ですか？理由は？」を含む会計関連の質問系列を優先的に再検証することを推奨する。

## 24. M2.4（Operational KPI Semantic Grounding / Forward Obligation Risk）追記

### 24.1 root causes

Test26 BAL Turn4「現在の当社業績を分析して」で、会議形式・役割分担は改善したが、
Databookと照合すると複数のFact/Semantic Errorが残っていた: (1) overdueTons=0の
健全なforward backlog（8,988.43t）と「現在の納期遅延」の混同余地、(2)
equipmentUtilization(47.44%)とlaborUtilization(95.32%)を「utilization」に一括して
「工場全体が能力上限」と誤解させる余地、(3) company-wide equipment utilizationだけ
では見えない商品別ローカルボトルネック（PD equipment shortage=1,015t）、(4)
rawMaterial(3,074.72t)/equipment(1,015t)/labor(0t)のshortfall優先順位が不明確、(5)
opening/ending/in-transit等の在庫種別が区別されず曖昧な在庫発言の余地、(6)
regular(4,140)/temporary(575)workerの区別欠如、(7) interest-bearing debt
（約$49.046M）とtotal liabilities（約$64M）の混同。根本原因はCFO/COO向けbriefingが
これらのKPIを構造的に分離せず渡していた（またはCOO側にutilization/bottleneck/
inventory/workforceの各KPIが一切渡っていなかった）ため、Claudeが生の内部指標を
自由解釈する余地があったこと。

### 24.2 COO briefing before/after

- before: `coo.rawMaterialTotalTons`・`coo.totalRegularHeadcount`のみで、utilization・
  bottleneck優先順位・在庫種別・temporary workerは一切渡っていなかった。
- after: `coo.utilization`（equipmentUtilizationRate/laborUtilizationRate/overtimeRate/
  temporaryWorkerShareを別フィールドで保持）、`coo.bottleneck`（rawMaterial/equipment/
  laborのshortfall量＋primary/secondaryBottleneck＋商品別productBottlenecks）、
  `coo.inventory`（ending/opening/in-transit/arrived/domestic purchaseを分離）、
  `coo.workforce`（regularWorkers/temporaryWorkers/overtimeRateを分離）が追加された。

### 24.3 Commercial briefing before/after

M2.1〜M2.3で既に整備済みのbacklog分離（healthyForward/dueThisTurn/overdue）・
customerTrustByMarketをそのまま利用。M2.4での変更は無く、promptガードレール側で
「future delivery obligation」という用語・FACT→JUDGMENTの順序を明示的に追加した
（実装指示§1・§2）。

### 24.4 CFO debt terminology

`cfo.interestBearingDebtUsd`（= shortTermLoansUsd + longTermLoansUsd、既存フィールドの
単純合算のみ）を新規追加し、既存の`cfo.totalLiabilitiesUsd`（買掛金その他負債込み）と
明確に区別した。RuleSemanticsへ`interestBearingDebt`/`totalLiabilities`の2エントリを
追加。

### 24.5 bottleneck semantics

`operationalSemantics.ts`の`computeBottleneckHierarchy`が、rawMaterialShortageTons/
equipmentShortageTons/laborShortageTonsのうちlost production（shortfall量）が最大の
ものをprimary、次点をsecondaryとして機械的に判定する（新しい経営判断ロジックでは
なく、既存reasonCodes.tsの会社全体集計と同じフィルタ条件の単純な優先順位付け）。
商品別equipment shortageは、既存`ProductionAllocationEntry`（companyId×factoryId×
product単位）をproductでグルーピングする単純集計で導出した（新しい生産判定は
一切追加していない）。

### 24.6 utilization semantics

`coo.utilization`でequipmentUtilizationRate/laborUtilizationRate/overtimeRateを
独立したフィールドとして保持し、prompt.tsに「utilization」への一括表現の明示的な
禁止を追加した。

### 24.7 inventory semantics

`coo.inventory`でendingRawMaterialInventoryTons（当期末）・
openingRawMaterialInventoryTons（前期末、無ければnull）・
endingFinishedGoodsInventoryTons・importInTransitTons・importArrivedTons・
domesticPurchaseTonsを分離した。すべて既存`CompanyQuarterSummary`のフィールドを
そのまま転記するだけで、新しい在庫計算は一切追加していない。

### 24.8 workforce semantics

`coo.workforce`でregularWorkers/temporaryWorkersを別フィールドとして保持した。
既存`WorkerAssignment`（該当四半期のdecisions.workerAssignments）のregularHeadcount/
temporaryHeadcountを会社全体で単純合算するだけで、新しい人員計算は一切追加して
いない。

### 24.9 forward obligation handling

RuleSemanticsへ`futureDeliveryObligation`エントリを追加し、prompt.tsに「overdueTons=0
の場合、納期遅延/履行遅延/納期未達/契約違反が既に発生/Trustを既に毀損という表現を
禁止し、future delivery obligation/次四半期に履行すべき受注/capacity planning上の
負荷/将来のdelivery riskという表現のみ許可する」旨、および「Healthy Forward Backlogが
次期能力を超える可能性がある場合はリスクとして議論してよいが、必ずFACTを先に述べ、
その後にJUDGMENTを続ける」という順序規律を追加した（実装指示§1・§2）。

### 24.10 Test26 Turn4 reproduction

`app/lib/v2/companyLab/aiManagementMeeting/__tests__/operationalSemantics.test.ts`の
AMM-OPS-10で、実装指示冒頭の実データ（equipmentUtilization=47.44%/
laborUtilization=95.32%/overtimeRate=8.21%、rawMaterialShortage=3,074.72t/
equipmentShortage=1,015t/laborShortage=0t、regularWorkers=4,140/
temporaryWorkers=575、endingRawMaterialInventory=0t）から、primary
bottleneck=RAW_MATERIAL・secondary=EQUIPMENT・PD商品別equipmentShortageTons=1,015が
正しく導出されることを確認した。`scripts/aiMeetingRealApiSmokeTest.ts`へ、実際の
プレイヤー発言「現在の当社業績を分析して」を使う「9F. Test26 BAL Turn4再現」
ケースも追加した。

### 24.11 code changes

- 新規: `app/lib/v2/companyLab/aiManagementMeeting/operationalSemantics.ts`
  （UtilizationPacket/BottleneckPacket/InventoryPacket/WorkforcePacket + builder関数 +
  computeBottleneckHierarchy）
- 変更: `briefing.ts`（`operationalHistory`入力、`coo.utilization`/`coo.bottleneck`/
  `coo.inventory`/`coo.workforce`/`cfo.interestBearingDebtUsd`を追加、RuleSemantics
  9エントリ追加、`EXECUTIVE_BRIEFING_VERSION`を"v4"→"v5"）
- 変更: `prompt.ts`（backlog現在/将来区別・utilization分離・bottleneck階層・在庫/人員
  semantics・debt semantics・wide question 1〜2論点規律を追加、
  `AI_MEETING_PROMPT_VERSION`を"v4"→"v5"）
- 変更: `handlers.ts`（`loadFinancialSnapshot`を`loadQuarterSnapshot`へ拡張し、
  companySummaries・workerAssignments（decisions）・productionAllocation.entriesを
  同一repository呼び出しから取得、`operationalHistory`を配線）
- 既存のfinance/quarterClose.ts・production engine・Standard AI・Sales/pricing
  エンジン・Trust・game parametersは一切変更していない（実装指示の禁止事項の遵守）。

### 24.12 tests

`app/lib/v2/companyLab/aiManagementMeeting/__tests__/operationalSemantics.test.ts`に
AMM-OPS-1〜10（10件）を新規追加。既存4テストファイル（backlogSemantics.test.ts・
briefing.test.ts・factGrounding.test.ts・accountingSemantics.test.ts）は、
`operationalHistory`フィールド追加に伴う呼び出しシグネチャの変更のみ機械的に対応
（`operationalHistory: { reportingPeriod: null, priorPeriod: null }`）。
factGrounding.test.ts AMM-FG-9のversion識別テストを"v4"→"v5"へ更新。AMM系テスト
計59件、プロジェクト全体3167件、いずれもpass。

### 24.13 real API結果

このセッションの実行環境には`ANTHROPIC_API_KEY`が設定されていないため未実施
（M2.1〜M2.3と同様）。`scripts/aiMeetingRealApiSmokeTest.ts`へ、Test26 BAL Turn4の
実会話再現ケース「9F. Test26 BAL Turn4再現（operational KPI grounding・wide
question）」（プレイヤー発言「現在の当社業績を分析して」、`test26Turn4Briefing()`に
実データベースのutilization/bottleneck/inventory/workforceを組み込み済み）を
追加した（計14ケース）。`ANTHROPIC_API_KEY`を持つ開発者が手動実行することで、
「工場全体が能力上限」と言わない・PD equipment shortageを局所的制約として区別・
primary bottleneckをraw materialと認識・labor shortageによるlost productionは無いと
明示・8,988tをoverdue=0のforward backlogとして扱う・US PD4,000/EU PD1,550を次期
obligationとして述べる・有利子負債と負債合計を混同しない、という方向で各役員が
応答するかを確認できる。

### 24.14 remaining risks

- M2.1〜M2.3と同様、prompt文言による誘導であり、Claudeの出力を機械的に強制する
  仕組みではない。実API未検証のため、実際の応答品質（特に9Fケースでの改善）は
  引き続き確認が必要。
- `operationalHistory`は`financialHistory`と同じ`CompanyLabHistoryEntryNotFoundError`
  捕捉によりnull化される。turn1等、履歴が浅い場合は`coo.utilization`等がnullのまま
  となり、COOが「データが無いため分析できない」と答えることが期待されるが、実応答
  での確認は未実施。
- 商品別bottleneck集計は、1つの`ProductionAllocationEntry`が複数のshortfallReasons
  を同時に持つ場合、各カテゴリへ同じshortfallQuantityが重複計上される（既存
  reasonCodes.tsの会社全体集計と同じ単純化。実装指示の範囲では許容されるが、将来
  より精緻な内訳が必要になった場合は要検討）。
- 「臨時/季節ワーカーの意思決定」（temporaryWorkers）は該当四半期の`decisions`
  レコードから取得するため、turn1等でdecisionsが空の場合は0として扱われる
  （捏造ではなく「無ければ0」という設計だが、「未決定」と「決定して0人」の区別は
  現状できない）。

### 24.15 readiness for continued Test26

Operational KPIの構造的分離（utilization/bottleneck/inventory/workforce）・
forward obligation riskのFACT→JUDGMENT順序規律・debt terminology区別・wide question
1〜2論点規律が、コード・テスト・prompt文言の3層で揃った。次のTest26継続セッション
では、Turn4の「現在の当社業績を分析して」を含む広範な業績分析質問系列を優先的に
再検証することを推奨する。

## 25. M2.5（Due-Date Grounding Enforcement / Capacity Pool Semantics）追記

### 25.1 root cause

Test26系の新規BAL Turn1「現状を分析してください」で、COO/CFO/Commercialが揃って、
overdueTons=0のfuture backlog（US HOSO 1,443.43t・OTHER HOSO 814.04t、いずれも
2015Q2納期＝次四半期）を「期限オーバー」「納期内に納めるにはCAPEX・人員増が必要」と
誤って説明した。COOはさらに、14,107.5t（HOSO 6,840+PD 5,985+VAP 1,282.5の商品別
専用ライン合計）を「実効能力で天井」と述べ、common preprocessing（25,650t）・
freezing/packing（25,650t）という遥かに大きい別のcapacity poolの存在を無視した。

### 25.2 why M2.4 prompt guard was insufficient

M2.1〜M2.4のprompt文言（backlog=overdueと呼ばない・healthyForward/dueThisTurn/
overdueTonsの3値分離）は既に存在していたが、3値を見た上で「どれが優勢か」をClaude
自身が都度解釈する余地が残っていた。overdueTons=0・dueThisTurnTons=0・
healthyForwardTons>0という組み合わせから、Claudeが独自に「大部分は将来納期だが
一部は期限が近い」のような曖昧な言い換えを行い、結果として「期限オーバー」という
単語そのものを使ってしまう余地があった。prompt文言による誘導だけでは、語彙選択の
最終決定権がClaude側に残っており、構造的な強制力が無かったことが直接の原因。

### 25.3 due status deterministic grounding

`backlogSemantics.ts`へ`classifyBacklogDueStatus(overdueTons, dueThisTurnTons,
healthyForwardTons)`を追加し、`"OVERDUE"|"DUE_THIS_TURN"|"FUTURE_DUE"|"MIXED"`という
唯一の分類結果を、common.backlog・commercial.backlog・coo.backlogByProduct・
commercial.backlogByMarket/backlogByProduct/backlogByMarketProductの全集計へ
`status`フィールドとして付与した。Claudeはこの値をそのまま使うだけでよく、3値の
大小関係から再判定する必要が無い（prompt側にも「再判定してはいけない」旨を明記）。

### 25.4 wording guard

overdueTonsが0の場合、prompt.tsに「overdue/late/delayed/past due/deadline
missed/納期遅延/期限オーバー/未達/契約違反」の使用を明示的に禁止する強い語彙
ガードを追加した。future backlogについては「next-quarter obligation/forward
order book/scheduled delivery/upcoming fulfillment requirement/将来納期の受注残/
次四半期の履行義務」という表現のみを許可し、「Q2中に消化できれば評価改善」という
誤表現も明示的に禁止した（正しくは「Q2納期なのでQ2中に予定どおり履行する必要が
ある」）。

### 25.5 response validator採否

**採否: 採用した。** `dueWordingGuard.ts`の`findOverdueWordingViolations`が、
overdueTons=0のときのみ応答テキストを走査し、禁止語彙（訂正文脈の否定表現近傍を
除く）を検知する。`handlers.ts`が、通常のClaude呼び出し後にこの検知を行い、
違反があれば最大1回だけ`repairNote`付きの同一入力で再呼び出しする（schema_mismatch
由来の既存retryとは別レイヤー。既存claudeClient.tsのretryポリシーは変更していない）。
採用理由: 平常時（違反が無い場合）のtoken・latencyコストは走査コストのみで
ほぼゼロであり、違反が実際に発生した稀なケースにのみ追加API呼び出しが発生する
ため、トレードオフが良好と判断した。限界: 完全な自然言語理解ではなく単純な文字列
マッチ＋否定表現の近傍一致であるため、「プレイヤーは『納期遅延』と述べましたが」
のような複雑な引用文脈までは正確に除外できない（remaining risksに明記）。

### 25.6 capacity pool semantics

`capacitySemantics.ts`の`buildCapacityPools`が、既存`ownState.factoryCapacity`
（commonProcessing/hoso/pd/vap/freezingPackagingの5フィールドを既に保持している）
を単純合算し、`coo.capacityPools`として明示的に分離する。`productLineSumTons`
（hoso+pd+vap）は「会社全体の実効生産能力」ではなく商品別専用ラインの合計に
すぎないことをRuleSemantics・prompt双方で明記し、`bindingPoolLabel`（既存
`computeProductionCapacitySummary`が既に正しく算出済みの"商品別実効能力"|
"共通前処理"|"凍結・包装"）を必ず明示するようCOOへ指示した。

### 25.7 raw material semantics

`coo.rawMaterialAvailability.currentOnHandTons`として、decision時点の現在在庫
（既存`ownState.rawMaterialInventory.totalTons`の転記のみ）を明示的にラベル付け。
今期のquarter processing中に発生し得るdomestic purchase/import arrivalsはこの
数値に含まれないことをpromptで明記し、「現在在庫0＝今期生産不可能」という誤った
断定を禁止した。

### 25.8 preview semantics

RuleSemantics.productionPreviewエントリと、promptの明示的な指示により、player
draftの現在の入力に基づく生産見込み（forecast/preview/current-input estimate）を
確定した生産能力・確定生産量と混同しないよう規定した。新しいpreview計算・新しい
観測フィールドは追加していない（現時点でAI Meeting briefingにpreview数値を渡す
経路自体が無いため、原則の明文化のみ）。

### 25.9 CAPEX grounding

CFO・COOがCAPEX必要性を述べる場合、現在のoverdue backlogだけを理由にせず、
(a) 商品別capacity gap、(b) forward obligationのstatus・期間、(c) 既存CAPEX
（cfo.activeCapexRemainingCommitmentUsd等）、(d) 財務的実現可能性、のうち複数の
根拠を示すことを要求する原則をprompt.tsへ追加した。future backlogが存在するという
事実だけで「CAPEXが必要」と断定することを明示的に禁止した。

### 25.10 Test26 BAL Turn1 reproduction

実装指示§9の実データ（ending backlog=3,625.95t/overdue=0、US HOSO 1,443.43t・
OTHER HOSO 814.04t（いずれも次四半期納期）、capacity pools common=25,650t/
HOSO=6,840t/PD=5,985t/VAP=1,282.5t/freezing=25,650t、ending raw inventory=0t）を
`dueCapacitySemantics.test.ts`のAMM-CAP-10で再現し、due status=FUTURE_DUE・
capacity pools分離・raw material=0の正しい算出を確認した。
`scripts/aiMeetingRealApiSmokeTest.ts`へ、実際のプレイヤー発言「現状を分析して
ください」を使う「9G. Test26 BAL Turn1再現（due-date grounding・capacity pool
semantics）」ケースも追加した。

### 25.11 code changes

- 新規: `app/lib/v2/companyLab/aiManagementMeeting/capacitySemantics.ts`
  （CapacityPools/RawMaterialAvailabilityFact + builder関数）
- 新規: `app/lib/v2/companyLab/aiManagementMeeting/dueWordingGuard.ts`
  （overdue関連禁止語彙の検知関数、訂正文脈の否定表現近傍除外を含む）
- 変更: `backlogSemantics.ts`（`classifyBacklogDueStatus`・`BacklogDueStatus`型を
  追加し、全集計エントリへ`status`フィールドを付与）
- 変更: `briefing.ts`（`coo.capacityPools`/`coo.rawMaterialAvailability`/
  `cfo`・`commercial`各backlog集計への`status`追加、RuleSemantics 5エントリ追加、
  `EXECUTIVE_BRIEFING_VERSION`を"v5"→"v6"）
- 変更: `prompt.ts`（due status唯一分類・強い語彙ガード・capacity pool説明規律・
  raw material/preview区別・CAPEX根拠要求・repairNote処理を追加、
  `AI_MEETING_PROMPT_VERSION`を"v5"→"v6"）
- 変更: `types.ts`（`AiMeetingCallDiagnostics.semanticGuardResult`をoptional追加）
- 変更: `handlers.ts`（overdue語彙違反検知時の最大1回repair呼び出しを追加、
  `diagnostics.semanticGuardResult`を返す）
- 既存のStandard AI・Production/Sales/Contract fulfillment/Finance/Trust
  mechanicsは一切変更していない（実装指示の禁止事項の遵守）。

### 25.12 tests

`app/lib/v2/companyLab/aiManagementMeeting/__tests__/dueCapacitySemantics.test.ts`に
AMM-DUE-1〜4・AMM-CAP-1〜6・AMM-CAP-10（Test26 Turn1 reproduction）の11件を新規追加。
`app/api/v2/company-labs/_lib/__tests__/aiMeetingHandlers.test.ts`にAMM-DUE-5
（repair発火）・AMM-DUE-6（repair不発火）の結合テスト2件を追加。既存
backlogSemantics.test.ts等は`status`フィールド追加が構造的に既存アサーションを
壊さないことを確認済み。factGrounding.test.ts AMM-FG-9のversion識別テストを
"v5"→"v6"へ更新。AMM系テスト計72件（59+11+2）、プロジェクト全体3180件、いずれも
pass。

### 25.13 real API結果

このセッションの実行環境には`ANTHROPIC_API_KEY`が設定されていないため未実施
（M2.1〜M2.4と同様）。`scripts/aiMeetingRealApiSmokeTest.ts`へ、Test26 BAL Turn1の
実会話再現ケース「9G. Test26 BAL Turn1再現（due-date grounding・capacity pool
semantics）」（プレイヤー発言「現状を分析してください」、実データベースの
due status・capacityPools・rawMaterialAvailabilityを組み込み済み）を追加した
（計15ケース）。`ANTHROPIC_API_KEY`を持つ開発者が手動実行することで、「期限
オーバー」等の禁止語彙を使わない・US HOSO/OTHER HOSOを次四半期の履行義務として
説明する・14,107.5tを会社全体の天井と呼ばない・common/freezing poolの存在を
明示する・現在在庫0と今期調達可能性を分離する・future backlogだけでCAPEXを
断定しない、という方向で各役員が応答するかを確認できる。

### 25.14 remaining risks

- prompt文言・response validatorともに、Claudeの出力を完全に機械的強制する
  仕組みではない。実API未検証のため、実際の応答品質（特に9Gケースでの改善）は
  引き続き確認が必要。
- `dueWordingGuard.ts`の訂正文脈除外は、否定表現の近傍一致という単純な
  ヒューリスティックであり、「プレイヤーは『納期遅延』と述べましたが」のような
  複雑な引用文脈までは正確に除外できない（既知の限界。将来phaseでより精緻な
  文脈解析が必要になった場合は要検討）。
- repair呼び出しは、1回のみで打ち切る設計のため、repair後も違反が残った場合
  （`semanticGuardResult="violation_after_repair"`）はそのまま応答を返す
  （無限リトライを避けるための意図的な設計）。
- `coo.capacityPools`は既存`ownState.factoryCapacity`の単純合算であり、
  factory単位の内訳（どの工場のどのラインが逼迫しているか）はfactoryCapacityTopN
  （上位N件）からしか読み取れない。全factory詳細が必要な場合は別途監査が必要。

### 25.15 readiness

due status・capacity pool・raw material/preview semantics・CAPEX根拠要求・
response validatorが、コード・テスト・prompt文言の3層で揃った。次のTest26継続
セッションでは、新規BAL Turn1の「現状を分析してください」を含む、backlogと
capacityに関する質問系列を優先的に再検証することを推奨する。
