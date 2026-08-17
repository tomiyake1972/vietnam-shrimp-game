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
