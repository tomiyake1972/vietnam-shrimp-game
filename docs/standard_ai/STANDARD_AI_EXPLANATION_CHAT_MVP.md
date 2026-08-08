# Standard AI Explanation Chat（Q&A）MVP — 設計と境界

作成日: 2026-08-08
ブランチ: `feature/v2-standard-ai-explanation-chat-mvp`
対象: ShrimpX V2 / Company Lab プレイヤー画面（Test15相当）

---

## 1. Purpose（目的）

既存のStandard AIが算出した意思決定について、そのTurnの
Observation / Decision / reason codes / diagnostics / bottleneck を根拠に、
Claudeがプレイヤーへ説明する「会話レイヤー」を追加する。

この機能は **Standard AIを会話AIへ置き換えるものではない**。

    Standard AI = 意思決定主体
    Claude       = 説明主体

Claudeは sales headcount / sales allocation / sales desired quantity /
procurement / production / labor / borrowing / capex のいずれも新しく決めない。
役割は「なぜその判断になったのか」を説明することだけである。

### 最重要思想

この機能は「Standard AIを賢そうに見せる機能」ではない。
目的は、人間がStandard AIの判断を問い、理由を理解し、矛盾を発見し、批判できるようにすること。
説明できない判断は説明で取り繕わず、
「現在のStandard AIにはその判断を正当化する十分な根拠がありません」と答えられることを重視する。

---

## 2. Architecture（構成）

```
PlayerScreenClient.tsx
  └─ StandardAiChatPanel.tsx            … 対話UI（Client Component）
       └─ askStandardAiChatAction        … Server Action（actions.ts）
            └─ handlePostAiExplanationChat
                 ├─ resolveRequestContext          （既存Explanation APIから再利用）
                 │    └─ loadPlayerScreenViewModel  （既存の唯一の状態読み込み経路）
                 ├─ buildStandardAiChatContext      （ExplanationContext + bottleneck）
                 ├─ computeChatContextHash
                 ├─ generateStandardAiChatAnswer    （Claude呼び出し）
                 └─ appendHumanChallengeRecord      （Human Challenge Log）
```

新規ファイル:

| ファイル | 役割 |
| --- | --- |
| `app/lib/v2/companyLab/aiExplanation/chat/chatContext.ts` | チャット用コンテキスト（既存ExplanationContextを内包） |
| `app/lib/v2/companyLab/aiExplanation/chat/chatSchema.ts` | 出力スキーマ（Zod＋tool input schema） |
| `app/lib/v2/companyLab/aiExplanation/chat/chatSystemPrompt.ts` | 固定システムプロンプト（安全境界そのもの） |
| `app/lib/v2/companyLab/aiExplanation/chat/chatClient.ts` | Claude呼び出し（timeout/retry/ログ） |
| `app/lib/v2/companyLab/aiExplanation/chat/challengeLog.ts` | Human Challenge Log |
| `app/api/.../ai-explanation/chat/route.ts` + `_lib/handlers.ts` | APIエンドポイント |
| `app/v2/company-lab/play/[labId]/StandardAiChatPanel.tsx` | 対話UI |

既存コードへの変更は最小限:

- `reportCache.ts`: `stableStringify` を export（contextHash設計の再利用のため）
- `claudeClient.ts`: `createRealClient` を export（SDK生成箇所を1つに保つため）
- `ai-explanation/_lib/handlers.ts`: `resolveRequestContext` を export（状態読み込み経路を1本に保つため）
- `actions.ts` / `PlayerScreenClient.tsx`: Q&Aの配線を追加

**Standard AI decision logic / market / sales engine / procurement / production /
labor / finance / capex / game parameters / Test15保存データは1行も変更していない。**

---

## 3. Decision / Explanation separation（意思決定と説明の分離）

構造上、この機能はStandard AIの意思決定値を変更できない。

1. `StandardAiChatPanel` は `draft` / `setDraft` を props として受け取らない。
   意思決定フォームへ書き込む手段をコンポーネントが持たない。
2. APIハンドラーは decision を返さない。返すのは `answer`（説明）と `contextHash` だけ。
3. 出力スキーマ（`standardAiChatAnswerSchema`）に数値提案を表現するフィールドが存在しない。
   フィールドは `answerKind` / `conclusion` / `evidence` / `supplement` /
   `relatedReasonCodes` / `limitations` のみ。
4. `buildStandardAiChatContext` は純粋関数で、入力を変更しない（回帰テストで検証）。

---

## 4. Information boundary（情報境界）

Claudeへ渡すのは、次の2つの出所だけ。

1. 既存の `ExplanationContext`（`buildExplanationContext`の出力そのもの）
2. Standard AI自身の `situationDiagnosis`（ボトルネック判定の素通し）

`ExplanationContext` は入力型の設計上、次を **構造的に持てない**。

- 他社の非公開データ
- 生の `CompanyLabState`・履歴全体
- current true demand（Player/AI未観測）
- future demand / future shock / future random event / future allocation result
- API key / secrets / 内部スタックトレース

回帰テストで実際に確認していること:

- チャットcontextのトップレベルキーが5つ（`explanation` / `bottleneck` / `alternatives` /
  `chatContextSchemaVersion` / `chatPromptVersion`）から増えていない
- `explanation` が `buildExplanationContext` の出力と完全に一致する（加工なし）
- `future` / `forecast` / `shock` / `randomEvent` / `trueDemand` / `allocationResult` 等の
  キー名がcontext全体（再帰走査）に一切出現しない
- 他社の companyId が直列化結果に一切出現しない（Turn1〜3で確認）

### Player / Standard AI の公平性

回答根拠は、そのTurnでStandard AI自身が使えた情報に限定される。
「ゲーム内部にはあるがAIは見ていない情報」は、上記のとおりcontextへ到達する経路が無い。

---

## 5. Hallucination policy（ハルシネーション防止方針）

システムプロンプトで固定している原則:

1. **回答順序**: FACT → STANDARD_AI_REASON → INTERPRETATION → LIMITATION
2. **後付け禁止**: Standard AIが実際には使っていない理由を作らない
3. **根拠が無い場合の定型回答**（プロンプトに文言を固定）
   - 「この点はStandard AIの判断ログからは確認できません」
   - 「現在のStandard AIはその要因を判断材料として使っていません」
   - このとき `answerKind = insufficient_evidence`
4. **Standard AIを擁護しない**: ログ上の根拠が弱ければ
   「ご指摘は妥当です」「現在のStandard AIではこの判断を十分に正当化できません」
   「この部分はヒューリスティック依存です」と答えてよい
5. **代替案の創作禁止**: `alternatives.hasRecordedAlternatives = false` のとき
   「現在のStandard AIログには比較候補が保存されていません」と答える
6. **理由コードの創作禁止**: `relatedReasonCodes` には `diagnosticEntries` に実在するcodeだけ

### normalizationを行わない

Explanation層で確立した禁止事項をそのまま踏襲する。
`chatClient.ts` は応答に対して一切の正規化・救済を行わない。

- 単純stringを勝手に1要素arrayにしない
- schema不明な値を強制変換しない
- invalid JSONを黙って修正しない
- Zod検証を緩めない

不一致は `schema_mismatch` として素直に失敗させ、ログへ記録する。

---

## 6. UI

Company LabのStandard AI提案エリア内、「AIによる説明文（Claude生成）」ブロックの直下。

視覚的な区別:

| ブロック | 配色 | 性質 |
| --- | --- | --- |
| ゲームエンジンが確定した事実 | 灰色（既存） | 事実 |
| AIによる説明文（Claude生成） | indigo系（既存） | 一方向のレポート |
| **Standard AIへの質問（対話）** | **emerald系（新規）** | **対話** |
| 詳細な判断ログ | 既存のseverity色分け | Standard AI自身の出力 |

構成要素: 「Standard AIに質問する」ボタン → 展開で
質問入力欄（textarea）／送信ボタン／質問例チップ／会話履歴／loading／error。

iPhone対応（縦型）:

- 1カラム固定。入力欄は `w-full`、ボタンは `w-full sm:w-auto`（狭幅では全幅、広幅で自動）
- 横並びはすべて `flex-wrap`
- 本文は `break-words` / `whitespace-pre-wrap`、理由コードは `break-all`
- 入力欄は `text-base`（16px相当）— iOS Safariの自動ズーム回避
- `overflow-x-*` とピクセル固定幅を使わない（回帰テストで機械的に検証）

---

## 7. API

```
POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation/chat
```

one-shot explanation（`.../ai-explanation`）と interactive Q&A は役割が違うため
エンドポイントを分けた。ただし認証（`assertStagingAdmin` / Server Actionでは
`requireStagingSession` + `assertSameOriginRequest`）・依存関係
（`AiExplanationApiDependencies`）・状態解決（`resolveRequestContext`）は完全に共通。

リクエスト:

```jsonc
{
  "question": "なぜ営業を追加採用するの？",   // 必須・1〜400文字
  "history": [{ "question": "...", "answerConclusion": "..." }],  // 任意・直近5往復
  "expectedContextHash": "…"                 // 任意・2回目以降の質問で送る
}
```

レスポンス（成功）:

```jsonc
{ "result": "success", "answer": { … }, "contextHash": "…", "chatPromptVersion": "chat-v1", "model": "…", "generatedAt": "…" }
```

レスポンス（失敗・HTTPは200）:

```jsonc
{ "result": "failure", "errorCategory": "network_error", "contextHash": "…" }
```

`expectedContextHash` が現在のhashと一致しない場合のみ HTTP 409 `CONTEXT_CHANGED`。

---

## 8. Context schema

```ts
interface StandardAiChatContext {
  chatContextSchemaVersion: number;   // 現在 1
  chatPromptVersion: string;          // 現在 "chat-v1"
  explanation: ExplanationContext;    // 既存構造をそのまま内包（加工なし）
  bottleneck: ChatContextBottleneck | null;  // situationDiagnosisの素通し
  alternatives: { hasRecordedAlternatives: boolean; note: string };
}
```

`explanation` に含まれるもの（既存 `EXPLANATION_CONTEXT_SCHEMA_VERSION = 2`）:
identity（lab/company/turn/period/scenario/model/promptVersion）、
ownState（BS・契約backlog・原料在庫・工場能力・binding capacity・労働生産性・
workforce・salesForce・品質/信頼/納期スコア）、
marketInfo（前四半期の国内相場・国内市場清算結果・ライフサイクル・供給圧力）、
standardAi（decision そのもの＋diagnosticEntries＝reason code / keyValues / threshold / message）。

`bottleneck`（`situationDiagnosis` の素通し。新しい計算は行わない）:
primary/secondaryConstraint、sales/production/worker/rawMaterial/inventory/liquidity の
各ratio・state、productionCapacityHeadroom、workerHeadroom、
rawMaterialProcurementNeeded、rawMaterialSupplyConstraintState。

### contextHash

既存Explanation層の設計（`stableStringify` で再帰的にキーをソート → sha256）をそのまま再利用。
同一Turn・同一stateなら常に同一hash、stateが変われば必ず変わる。

UIは最初の回答で受け取ったhashを保持し、2回目以降の質問で送り返す。
サーバー側が現在のhashと突き合わせ、不一致なら409で拒否する
（＝チャット途中でゲームstateが変わっても、別状態が混ざらない）。

---

## 9. Model / timeout / max_tokens

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| model | `getExplanationModelConfig().model`（既定 `claude-haiku-4-5-20251001`） | Explanation層と同一。勝手に変更しない |
| timeout | `CHAT_CLAUDE_TIMEOUT_MS = EXPLANATION_CLAUDE_TIMEOUT_MS`（40,000ms） | 定数を再定義せず参照。片方だけずれない |
| SDK自動retry | `EXPLANATION_CLAUDE_MAX_RETRIES = 0` | `createRealClient` を再利用 |
| アプリ側retry | invalid_json / schema_mismatch / empty_response のみ1回 | Explanation層と同一方針 |
| max_tokens | **1,536** | 下記 |

**max_tokens = 1,536 の選定理由**（値を決めたら理由を記録する、という指示への対応）:

Explanationは6フィールドを1回で書き切る必要があり、実測で最大約2,300トークンを要した
（2026-08-08のTest15 turn4調査で `max_tokens=2000` に張り付いて打ち切られた実績がある）。
一方この対話回答は conclusion（1〜2文）＋evidence最大4件＋supplement（1〜2文）＋
relatedReasonCodes最大5件＋limitations最大3件であり、必要量はExplanationの概ね1/4〜1/3、
概算で400〜700トークン。1,024ではなく、余裕を2倍以上確保できる1,536を採用した
（Explanationの4,096より小さく、かつ打ち切り再発の余地を残さない）。

---

## 10. Error handling / logging

Explanation層の考え方をそのまま再利用する。

- `errorCategory`: `missing_api_key` / `http_error` / `invalid_json` /
  `schema_mismatch` / `empty_response` / `network_error`（型を共有）
- `failureCause`: `TIMEOUT_OR_NETWORK` / `HTTP_<status>` / `NO_TOOL_USE_BLOCK` /
  `MAX_TOKENS_TRUNCATION` / `MODEL_SCHEMA_DEVIATION`
- ログ項目: attempt / lab / company / turn / model / maxTokens / timeoutMs /
  elapsedMs / inputTokens / outputTokens / stopReason / chatPromptVersion /
  contextHash / errorCategory / failureCause
- **実測値と推定値を混同しない**: SDKの `usage` から取れた値だけを inputTokens /
  outputTokens として出し、取れない場合は `(不明)` と書く（0で埋めない）
- 質問文・回答本文・APIキーはログに出さない

UI表示は「回答生成に失敗しました／原因: 通信エラーまたはタイムアウト」程度。
内部スタック・詳細メッセージ・秘密情報は表示しない。
失敗してもStandard AIの数値提案は影響を受けない（回帰テストで検証）。

---

## 11. Human Challenge Log（§18・§19）

`companylab:v2:{labId}:{companyId}:{turn}:humanChallengeLog` に、turn単位のJSON配列として追記。
1turnあたり最大50件。**保存に失敗しても回答は返す**（`appendHumanChallengeRecord` は例外を投げない）。

```ts
interface HumanChallengeRecord {
  schemaVersion: number;
  labId; companyId; turn; contextHash;
  chatPromptVersion; chatContextSchemaVersion; model;
  challengeType: "WHY" | "DISAGREEMENT" | "ALTERNATIVE_REQUEST" | "BOTTLENECK_QUESTION" | "OTHER";
  question: string;
  answer: StandardAiChatAnswer | null;   // 失敗時null
  errorCategory: string | null;
  relatedReasonCodes: readonly string[];
  timestamp: string;
}
```

`challengeType` は質問文のキーワードによる決定論的ヒューリスティック分類であり、
意味理解ではない。誤分類はありうるため、`question` の原文を必ず併せて保存し、
Harness側で再分類できるようにしてある。分類のためにClaudeを追加で呼ぶことはしない。

### 将来のTraining Harness接続

`HUMAN_AI_CHALLENGE` として渡すのに必要な要素は揃っている。

| Harnessが必要とするもの | この記録での対応 |
| --- | --- |
| State | `labId` + `companyId` + `turn` + `contextHash`（同一hashで同一stateを一意に特定） |
| Standard AI Decision | 同一contextHashのStandard AI提案から再取得可能 |
| Reason Codes | `relatedReasonCodes`（＋contextから全diagnosticEntriesを再取得可能） |
| Human Question | `question` |
| Claude Explanation | `answer`（構造化されたまま保存。要約・加工なし） |

**MVPでは自動学習・自動修正は一切行わない。Training Harnessのdecision logicも変更しない。**

---

## 12. 今回やらなかったこと（Phase 2以降）

- Standard AI decisionの書き換え／チャットから意思決定フォームへの反映
- Standard AIの再計算
- what-if / counterfactual simulation（「営業を5人にしたら？」等）
- AI役員複数人による経営会議
- Turnをまたぐ長期memory・自由会話
- 他社の非公開情報を使った回答
- future demand / future eventの参照
- **回答キャッシュ**: 同一contextHash＋同一questionのキャッシュは実装していない。
  MVPでは会話履歴自体がクライアント側のみに存在し、リロードで消えるため、
  キャッシュのヒット率が低い割に「失敗結果の永続化」という既知の不具合（2026-08-01に
  Explanation層で実際に発生）を再導入する危険がある。§20は「MVPで複雑になるなら必須ではない」
  としているため、今回は入れない。

### Phase 2への設計上の備え

`Q&A Explanation` と `Counterfactual Simulation` を分離できる責務配置にしてある。

- `chatContext.ts` は「説明のための読み取り専用の事実集合」を作るだけで、
  シミュレーションの入力は作らない
- `chatSchema.ts` の `answerKind` に `counterfactual` 等を追加する形で拡張できる
- what-ifを追加する場合は、Standard AIの再実行を行う別モジュール
  （Claudeではなくゲームエンジン側）を新設し、その結果を `evidence` として
  この会話レイヤーへ渡す構成にすればよい。Claudeが数値を推定する形にはしないこと。

---

## 13. 既知のリスク

1. **回答品質はモデル依存**。プロンプトとスキーマで「根拠が無ければ言わない」を強制しているが、
   モデルが `evidence` にcontext外の数値を書く可能性を完全にはゼロにできない。
   `relatedReasonCodes` は実在コードのみと指示しているが、機械的な照合は行っていない
   （Phase 2で `diagnosticEntries` との照合バリデーションを追加する余地がある）。
2. **challengeTypeの誤分類**。キーワード一致であるため、Harnessでの再分類を前提にすること。
3. **実APIでの回答内容は未検証**（下記）。
4. Standard AIが rejected candidates を保存していないため、
   「他にどんな選択肢があったの？」には常に「記録なし」としか答えられない。
   これはStandard AI側の記録不足であり、Phase 2以降の改善候補。

---

## 14. 実環境確認の状況

このセッションには `ANTHROPIC_API_KEY` が無いため、実際にClaude APIを呼んで
回答文を得る確認は実施していない（「一度成功した」を成功条件にしない方針とも整合する）。

代わりに、実シミュレーションで生成したTest15相当のTurn4 contextに対して、
Claudeへ実際に渡される入力と不変性を実測した。

```
設定: model=claude-haiku-4-5-20251001 maxTokens=1536 timeoutMs=40000
turn4 contextHash=2b0ba2e5ed33f0d5… 診断31件
primaryConstraint=sales_shortage secondaryConstraint=production_capacity_surplus
hasRecordedAlternatives=false

Q1「なぜこの市場に営業を多く配置しているの？」 入力20,307字 / 推定7,253tok
Q2「なぜ営業を追加採用するの？」               入力20,300字 / 推定7,250tok
Q3「なぜ工場を増設しないの？」                 入力20,299字 / 推定7,250tok

いずれの質問でも参照可能な reason code（context内に実在）:
  営業系   SALES_HEADCOUNT_INSUFFICIENT_TOTAL / SALES_FORCE_BINDING_CONSTRAINT /
           SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY /
           SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION /
           SALES_CAPACITY_BELOW_TARGET_SCALE / SALES_REDUCED_FOR_SUPPLY_LIMIT /
           VAP_MIX_INCREASES_SALES_EFFORT_NEED
  能力/投資系 CAPEX_DEFERRED / PRODUCTION_CAPACITY_HEADROOM /
           PRODUCTION_CAPACITY_RECOGNITION_GAP / PRODUCTION_CAPACITY_BELOW_TARGET_SCALE

意思決定オブジェクト不変: true
他社IDの混入: なし
```

3つの質問すべてについて、Claudeが理由を創作しなくても答えられるだけの
reason code / bottleneck判定がcontextに実在することを確認した。
