# 相談役AI（Management Advisor AI）MVP — 設計と境界

作成日: 2026-08-08
ブランチ: `feature/v2-management-advisor-ai-mvp`
対象: ShrimpX V2 / Company Lab プレイヤー画面（Game Owner Mode）

---

## 1. Purpose（目的）

ゲームオーナーが、ゲーム画面を見ながら相談役AIと自由に対話できるようにする。

相談役AIは次の4つを必要に応じて参照し、経営者と**一緒に考える**。

1. 現在のゲーム状態（会社の経営）
2. Standard AIの判断・診断
3. ShrimpXの正式仕様
4. なぜその仕様になったのかという開発背景

### 最重要思想

この機能は「Standard AIを説明するAI」でも「ゲーム攻略を教えるAI」でもない。

- 「今この会社をどう経営すべきか」だけでなく
- 「なぜShrimpXはこういうゲームとして設計されているのか」

も理解している必要がある。将来この相談役AIから CFO / 営業役員 / 生産役員 / CEO へ
情報・責務・権限を絞り込み、AI経営会議へ発展させる。まずは万能な相談役AIを作り、
実際の対話から「どの情報が必要か」「どこを決定論的ロジックへ戻すべきか」を学ぶ。

---

## 2. Standard AI / Explanation / Explanation Chat との違い

| 機能 | 役割 | UI位置 | 性質 |
| --- | --- | --- | --- |
| Standard AI | 決定論的な経営判断ロジック | 意思決定編集欄の初期値 | 意思決定主体 |
| AIによる説明文（Explanation） | 判断を一方向に説明 | 提案カード内・indigo | one-shot |
| Standard AIに質問する（Explanation Chat） | 「なぜそう判断したか」に限定して答える | 提案カード内・emerald | 限定的な対話 |
| **相談役AI（本機能）** | **あなたならどう考える？ このゲームはなぜこうなっている？** | **画面右下固定・sky** | **自由対話** |

既存2機能は残している。相談役AIだけは提案カードの中ではなく画面に固定され、
どの画面を見ていても使える。

**相談役AIはStandard AIに従う必要がない。** 異なる意見を述べてよく、弱点を指摘してよい。
ただしStandard AIが考えていない理由を「Standard AIの理由」として作ってはならない。

---

## 3. Architecture

```
PlayerScreenClient.tsx
  └─ ManagementAdvisorPanel.tsx           … 画面固定の対話UI（Client Component）
       ├─ askAdvisorAction                 … Server Action
       ├─ loadAdvisorConversationAction    … 会話の復元
       └─ clearAdvisorConversationAction   … 会話の消去
            └─ handlePostAdvisor / handleGet… / handleDelete…
                 ├─ resolveRequestContext          （既存ai-explanationから再利用）
                 ├─ planRetrieval(question)        … 質問分類 → 取得する層を決定
                 ├─ buildAdvisorLiveGameState      … A層
                 ├─ buildAdvisorStandardAiState    … B層
                 ├─ getFormalSpecification()       … C層
                 ├─ getDevelopmentRationale()      … D層
                 ├─ buildAdvisorContext            … 4層を混ぜずに束ねる
                 ├─ generateAdvisorAnswer          … Claude呼び出し
                 └─ saveAdvisorConversation        … 会話ログ
```

新規ファイル:

| ファイル | 役割 |
| --- | --- |
| `advisorAi/sourceTags.ts` | sourceType / authority の定義と優先順位 |
| `advisorAi/advisorSchema.ts` | 出力スキーマ（Zod + tool input schema） |
| `advisorAi/advisorSystemPrompt.ts` | role prompt（将来の役員AI分割に備え隔離） |
| `advisorAi/questionRouting.ts` | 質問分類 → retrieval strategy |
| `advisorAi/buildAdvisorContext.ts` | 4層のcontext組み立て + contextHash |
| `advisorAi/advisorClient.ts` | Claude呼び出し・ログ |
| `advisorAi/conversationStore.ts` | 会話の保存・復元・消去 |
| `advisorAi/gameState/advisorGameState.ts` | A層・B層の組み立て |
| `advisorAi/knowledge/docCatalog.ts` | path → 文書種別・authority の決定論的分類 |
| `advisorAi/knowledge/docStore.ts` | docs/ の読み込み・chunk化 |
| `advisorAi/knowledge/retrieval.ts` | 5つのretrieval関数 |
| `advisorAi/knowledge/driveWorkingMaterials.ts` | Drive（interfaceのみ・未接続） |
| `api/.../advisor/route.ts` + `_lib/handlers.ts` | API（POST/GET/DELETE） |
| `play/[labId]/ManagementAdvisorPanel.tsx` | UI |

既存コードへの変更は最小限（`next.config.ts` への file tracing 追加、
`actions.ts` / `PlayerScreenClient.tsx` の配線のみ）。

**Standard AI decision logic / market / sales engine / procurement / production /
labor / finance / capex / game parameters / Test15保存データは1行も変更していない。**

---

## 4. Owner Mode

UIヘッダーに `Game Owner Mode` を明示。Owner Modeでは次を利用できる。

- ゲーム内部の状態（他社の四半期確定サマリー等）
- 開発文書

利用できないもの（Owner Modeでも禁止）:

- API key / environment variables / DB credential / secret / token / authentication情報
- system prompt全文 / stack trace

これらはそもそもcontextへ渡されない（この層はゲーム状態と`docs/`しか触らないため、
構造的にsecretへ到達できない）。回帰テストで、context直列化結果に環境変数名・
APIキー実値が含まれないことを機械的に確認している。

### 将来のPlayer Mode（§46）

`planRetrieval(question, { ownerMode })` が permission boundary の入口になっている。
`ownerMode: false` では他社・ゲーム内部情報が常に除外される（テスト済み）。
今回はOwner Mode固定だが、Player Mode / Director Mode を後から追加できる。

---

## 5. Information layers（4層）

混同しないよう、contextの別フィールドとして保持し、Claudeへも別ブロックで渡す。

### A. LIVE GAME STATE

- `observed`: 既存 `ExplanationContext` そのもの（自社状態・公開市場情報・
  Standard AIのdecision・diagnosticEntries）
- `financials`: PL/BS/CF の要約（当期・前期）。既に算出・永続化済みの値の転記のみ
- `recentHistory`: 直近の履歴
- `competitors`: 他社の四半期確定サマリー（**Owner Modeのみ**）。
  「前四半期の確定記録であり、当期の他社計画ではない」ことを `competitorsNote` で明示

### B. STANDARD AI STATE

- Standard AI Q&Aと同一の `StandardAiChatContext`（decision / diagnosticEntries /
  situationDiagnosisのボトルネック判定）を再利用
- `evaluationPolicy`: 「独立に評価してよいが理由は捏造しない」をcontextにも明示

### C. FORMAL GAME SPECIFICATION

`getFormalSpecification(topic)` の結果。**authority=HISTORICAL を構造的に除外**する。

### D. DEVELOPMENT KNOWLEDGE

`getDevelopmentRationale(topic)` の結果。開発日誌・設計文書・phase report・
テストプレイ分析。経緯の質問では古い資料も対象にする。

---

## 6. GitHub retrieval（実装した）

`docs/` 配下の 115ファイル・約2.3MB を実行時に読み、見出し単位で 2,139 chunk へ分割し、
軽量なキーワードスコアリングで検索する。

- 日本語はCJK bigram、英数字は単語単位でトークン化（形態素解析器を使わない）
- 出現回数は対数的に効かせ、一致トークンの種類数と authority で重み付け
- 1文書あたり最大2chunkに制限し、同じ文書で埋まらないようにする
- プロセス内で1回だけ読み、以降はキャッシュ

**Vercel上での注意**: `docs/` はどこからもimportされないため、Next.jsのfile tracingでは
既定でbundleに含まれない。`next.config.ts` の `outputFileTracingIncludes` で
相談役AIのAPIルートにのみ `./docs/**/*.md` を明示的に含めている。
読み取りに失敗した場合は例外にせず「文書0件 + unavailableReason」として振る舞い、
相談役AIは「開発記録を参照できませんでした」と答える（捏造しない）。

### なぜ大規模RAGを入れなかったか（§58）

vector DB・embedding pipeline・外部SaaS・大規模indexingは追加していない。
2.3MB規模ではキーワード検索で十分に引けることを実測で確認した（§13の実測結果参照）。
必要になった時点で提案する。

---

## 7. Drive retrieval（実装していない・interfaceのみ）

**この判断は§57の明示要求に従い、ここに記録する。**

アプリ本体からGoogle Driveを直接検索するには、Google OAuth（service accountまたは
ユーザー委任）・スコープ付与・トークン保管・Vercel環境変数の追加が必要になる。
これは「新しい認証・外部連携の大規模実装」に当たるため、§57に従いMVPでは実装しない。

- GitHub / repo docs → **live retrieval**（実際に検索する）
- Google Drive → **architecture / interfaceのみ**

`driveWorkingMaterials.ts` は「Driveは未接続である」という事実と、
既知の資料（パラメータ文書ｖ.6.pdf / game_manual v.1.pdf / memo_20250713.md）の
**存在だけ**をcontextへ渡す。中身は渡さないため、相談役AIは
「Drive上の資料の内容」を推測で語ることを禁じられている。

将来 `DriveWorkingMaterialProvider` を実装して注入すれば、retrieval層の呼び出し側を
変えずにDrive検索を追加できる。その際も必ず `authority="WORKING"` とし、
GitHub正式版を置き換えないこと。

---

## 8. Source priority / stale document policy

| authority | 意味 | 現行仕様の根拠に使えるか |
| --- | --- | --- |
| `CURRENT_IMPLEMENTATION` | 現行の実装コード | ○ |
| `FORMAL` | GitHub上の正式文書 | ○ |
| `WORKING` | 作業資料・分析メモ（Driveを含む） | × |
| `HISTORICAL` | 過去の資料（旧manual・パラメータ仕様書） | **×** |
| `INFERENCE` | 相談役AIの推論 | × |

分類は `docCatalog.ts` の**パスベースの決定論的な規則**で行う（AIに推測させない）。
現在の内訳: FORMAL 75件 / WORKING 36件 / HISTORICAL 4件。

- 現行仕様の説明では HISTORICAL を除外する（`getFormalSpecification` が二重に保証）
- 過去の経緯の説明では HISTORICAL を積極的に使う（`includeHistorical: true`）
- 同一論点で資料と実装が食い違う場合、統合せず「現行実装では〜」「旧文書では〜」と分ける

メタデータは path / title / documentType / authority / sourceType / documentDate を保持。
**documentDate はファイル名の日付からのみ取り、ファイルのmtimeは使わない**
（mtimeはgit cloneの時刻であって文書の更新日ではないため。判定できない場合はnull）。

---

## 9. Source tags（§22）/ Source authority（§23）

2軸に分ける理由: 1軸だと「古いmanual」と「現在のコード」が同じ「仕様」に潰れてしまう。

- **sourceType**: `PUBLIC_INFO` / `STANDARD_AI_OBSERVED` / `GAME_INTERNAL_TRUE` /
  `FORMAL_SPEC` / `DEVELOPMENT_HISTORY` / `WORKING_MATERIAL` / `AI_INFERENCE` /
  `HUMAN_PROVIDED` / `FUTURE_SCENARIO`（将来用・MVPでは使わない）
- **authority**: 上表のとおり

---

## 10. Output schema（§24・§25）

```ts
{
  answer: string,                 // UIの主表示。自然な日本語
  sections: [{
    type: "FACT" | "STANDARD_AI_VIEW" | "ADVISOR_INFERENCE"
        | "DEVELOPMENT_RATIONALE" | "UNCERTAINTY",
    text: string,
    sourceTypes: SourceType[],
    sources: [{ title, path, authority }]
  }],
  relatedReasonCodes: string[],
  suggestedFollowUps: string[]
}
```

完全free textにしない理由: 相談役AIは自由に推論してよいが、
「どれが事実で、どれがStandard AIの見解で、どれが推論で、どれが開発記録か」を
区別できなければ、自由推論はそのまま誤情報になる。

UIは `answer` を主表示し、sections は折りたたみの「根拠の内訳」として色分けチップ付きで表示する。

**このスキーマには意思決定値を書き込むフィールドが存在しない**（構造的read-onlyの一部）。

---

## 11. Hallucination policy（§43・§44）

自由推論は許可、事実の捏造は禁止。

- ゲームの数値はcontextに実在するものだけ
- Standard AIの理由は `diagnosticEntries` にあるものだけ
- **開発の意図・経緯は、渡された開発文書の抜粋に根拠がある場合だけ事実として述べる**
- 推論は必ず `ADVISOR_INFERENCE` として示す
- 資料どうしの矛盾は矛盾として示す
- 分からないことは `UNCERTAINTY` として示す
- **what-ifの数値を作らない**（§29）。「再計算していないため利益額は正確に示せません」と答える

### 開発背景の捏造防止（§44・特に重要）

「なぜこの仕様にしたの？」に対してもっともらしい理由を創作してはならない。

- 根拠あり: 「開発記録では〜」＋ `sources` に path を示す
- 根拠なし: 「現行仕様としてそうなっていることは確認できますが、なぜこの仕様にしたのかを
  明示した記録は、現在参照できる文書からは確認できませんでした」

これは system prompt だけでなく、context の `sourcePolicy` にも書いてある。
さらに、開発文書の抜粋が0件だった場合は入力メッセージ自体に
「開発上の意図を推測で述べてはいけません」が挿入される（3重）。

### normalizationを行わない

Explanation層で確立した禁止事項を踏襲。応答の正規化・救済は一切行わない
（単純stringの配列化・schema不明値の強制変換・invalid JSONの黙殺をせず、Zod検証も緩めない）。

---

## 12. Model / timeout / max_tokens（§40〜§42）

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| model | 既存Explanation層と同一（既定 `claude-haiku-4-5-20251001`） | 勝手に変更しない |
| モデル上書き | 環境変数 `STANDARD_AI_ADVISOR_MODEL` | 将来のモデル比較実験用（コード変更不要） |
| timeout | `ADVISOR_CLAUDE_TIMEOUT_MS = EXPLANATION_CLAUDE_TIMEOUT_MS`（40,000ms） | 定数を参照。片方だけずれない |
| SDK自動retry | 0（`createRealClient` 再利用） | 76秒問題の再発防止 |
| アプリ側retry | invalid_json / schema_mismatch / empty_response のみ1回 | Explanation層と同一 |
| max_tokens | **3,072** | 下記 |

**max_tokens = 3,072 の選定理由**:
自由回答の `answer` 本文（日本語600〜1,000字＝概ね600〜1,000tok）＋sections最大6件
（各100〜200字＋メタデータ）＋reasonCodes＋followUps で、概算 1,600〜2,400tok。
2026-08-08にmax_tokens到達で実際に事故を起こしているため、必要量の上限側2,400に対して
約1.3倍の余裕がある3,072を初期値とする。4,096にしないのは、上限を上げるほど冗長に
書きがちで相談役の回答としては読みにくくなるため。実ログで `stopReason=max_tokens` が
出たら上げる（そのため outputTokens と stopReason を必ずログへ出している）。

---

## 13. Logging（§41）

将来のモデル比較（Haiku vs 上位モデル）のため、成功・失敗いずれの経路でも同形式で出力する。

```
attempt / lab / company / turn / category / model / maxTokens / timeoutMs /
elapsedMs / inputTokens / outputTokens / stopReason / promptVersion / contextHash /
errorCategory / failureCause
```

- **実測値と推定値を混同しない**: usageから取れた値だけを出し、取れない場合は `(不明)`（0で埋めない）
- 質問文・回答本文・秘密情報はログに出さない

---

## 14. Conversation persistence（§34・§35・§36）

- キー: `companylab:v2:{labId}:{companyId}:advisorConversation`
- MVPでは labId + companyId につき active conversation 1本（将来の複数thread化に備え
  値の中に `conversationId` を持たせてある）
- 保存項目: role / message / **turn（発言時点）** / timestamp / category /
  sourceTypesUsed / sourceDocuments / relatedReasonCodes / contextHash / model /
  answer（構造化のまま）/ errorCategory
- 最大30メッセージ（往復12＋余裕）
- リロード後・close→reopen後は GET で復元
- clear conversation は確認UI必須。消去後は新しい `conversationId` を発行
- **保存の失敗は回答を壊さない**（例外を投げず、失敗はログのみ）

### Turnをまたぐ会話（§33）

メッセージごとに発言時turnを保持し、入力メッセージには
「現在のturnは N です」「過去の相談内容と現在の状態を混同しないでください」を必ず入れる。
UIも、過去turnの質問には「（Turn N 時点の質問）」と表示する。

---

## 15. UI

### PC / tablet（§4）

画面右下の固定ボタン「相談役AI」→ 右側からパネルを展開。
幅 `clamp(320px, 32vw, 420px)`・`max-w-[92vw]`（完全固定px依存にしない／
ゲーム画面が完全には隠れない）。`position: fixed` なのでゲーム画面をスクロールしても固定。

open / close / minimize / send / loading / retry / clear conversation / conversation history
をすべて実装。

### Mobile / iPhone（§5）

右sidebarを縮めず、画面下から開く bottom sheet。高さ `80dvh`（拡大時 `95dvh`）。
上部に背景のゲーム画面が見える。入力欄は下部固定、`env(safe-area-inset-bottom)` 対応、
`text-base`（iOS Safariの自動ズーム回避）。

**キーボード対応**: 高さの基準に `vh` ではなく `dvh` を使う。`dvh` はキーボード表示で
縮むため、入力欄が画面外へ押し出されない。

横スクロールなし（`overflow-x-*` とピクセル固定幅を使わない／`break-words` /
`whitespace-pre-wrap` / reason code は `break-all`）。

### ヘッダー（§6）

```
相談役AI
BAL / Turn 4
[Game Owner Mode]
```

---

## 16. current view context（§7）

`currentViewContext`（sales / procurement / production / labor / finance / capex /
pl / bs / standard_ai_proposal / unknown）を API・context のschemaに用意してある。
MVPではUIから送っていない（常に `unknown`）。後からUI側で渡すだけで有効になる。

---

## 17. Security（§2・§45・§47）

- secretはcontextへ渡らない（構造的保証＋回帰テスト）
- prompt injection対策は3層:
  1. system prompt（役割変更・境界解除・プロンプト開示の要求に従わない）
  2. 入力構造（質問を `<user_question>` データブロックへ入れ、直前でも再度明示）
  3. 出力構造（スキーマに意思決定値のフィールドが無い）
- 質問文は改変せずそのまま渡す（勝手な検閲・書き換えをしない）
- 質問は1〜1,000文字に制限

---

## 18. Read-only（§48）

- `ManagementAdvisorPanel` は `draft` / `setDraft` を props に持たず、
  意思決定系Action（save/submit/process）を呼ばない
- APIハンドラーは decision を返さない。書き込むのは会話ログのみ
- 出力スキーマに意思決定値のフィールドが無い
- 3つの失敗経路すべてで decision と context が不変であることをテストで確認

---

## 19. Future tool use（§16・§38）

MVPでは内部関数だが、次の5つの責務に分けてあるため、後から
tool-based retrieval（Claudeがツールとして呼ぶ形）へ移行できる。

```
searchDevelopmentDocs(query)
getFormalSpecification(topic)
getDevelopmentRationale(topic)
getRecentDesignDecision(topic)
getTestPlayAnalysis(topic)
```

ゲーム状態側も `buildAdvisorLiveGameState` / `buildAdvisorStandardAiState` に分離済み。

---

## 20. Future counterfactual（§23・§29）

MVPではwhat-if計算を行わない。将来 `runCounterfactual()` を追加する場合、
**Claudeに数値を推定させず**、ゲームエンジン側でStandard AIを再実行する別モジュールを
新設し、その結果を `evidence` として会話レイヤーへ渡す構成にすること。
`sections` の type に `COUNTERFACTUAL` を追加する形で拡張できる。

---

## 21. AI経営会議へのロードマップ（§51）

1. **今回**: 万能な相談役AIとして運用する
2. 会話ログ（category / sourceTypesUsed / sourceDocuments / relatedReasonCodes）を分析し、
   - CFOが必要な情報
   - Sales Directorが必要な情報
   - COOが必要な情報
   - CEOが必要な情報
   を実際の対話から特定する
3. `buildAdvisorSystemPrompt(role)` の role を CFO / SALES_DIRECTOR / COO / CEO へ広げ、
   `planRetrieval` を役割ごとに絞る
4. 複数役員の同時対話（AI経営会議）へ

**knowledge retrieval（何を見るか）と role prompt（誰として話すか）を分離してある**ため、
配線・出力スキーマ・Claude呼び出しは共通のまま役割だけ差し替えられる（テスト済み）。

---

## 22. Known risks / limitations

1. **実APIでの回答内容は未検証**。このセッションに `ANTHROPIC_API_KEY` が無いため、
   実際にClaudeを呼んで回答文を得る確認はしていない。検証したのは
   「Claudeへ渡る入力」「retrievalの結果」「不変性」「情報境界」「prompt/schemaの固定」。
2. **retrievalはキーワード一致**であり、語彙が一致しない質問では取りこぼす。
   実装中に実際に §55 Q10（「なぜ歩留まりを細かく自分で計算しなくていいの？」）で
   取りこぼしが発生し、「なぜ」系の質問を文書検索の対象へ含める修正を入れた
   （回帰テスト化済み）。同種の取りこぼしは今後も起こりうる。
3. **質問分類は決定論的なキーワード一致**であり誤分類しうる。そのため分類は
   「何を必ず含めるか」を決めるだけで、原文は必ず保存しHarness側で再分類できる。
4. **Google Driveは未接続**（§7）。Drive上にしかない資料の内容は答えられない。
5. **relatedReasonCodes の機械的照合は未実装**。`diagnosticEntries` に実在するcodeだけを
   書くようpromptで指示しているが、サーバー側での照合はしていない（Phase 2候補）。
6. **iPhone実機での目視確認は未実施**。テストが保証するのは構造だけ。
7. **他社情報は前四半期の確定記録のみ**。当期の他社の意思決定は誰にも観測できないため、
   contextにも入らない（`competitorsNote` で明示）。
8. `docs/` を実行時に読むため、`outputFileTracingIncludes` の設定が外れると
   Vercel上で開発記録を引けなくなる。その場合も捏造はしないが機能としては成立しない。

---

## 23. Phase 2 proposal

1. **reason code照合バリデーション**（最優先）: 回答の `relatedReasonCodes` と
   `sections` 内の数値を、contextに実在するものと機械的に照合する
2. **currentViewContext のUI接続**: 今見ている画面をcontextへ渡す
3. **retrieval改善**: 同義語辞書、または埋め込み検索（必要性が実測で示された場合のみ）
4. **Counterfactual Simulation**: ゲームエンジン側で再実行し、結果をevidenceとして渡す
5. **Drive接続**: WORKING authority付きで追加
6. **Player Mode / Director Mode**: `planRetrieval` の permission boundary を拡張
7. **会話ログの分析**: AI経営会議の役割分割に向けた実データ収集
