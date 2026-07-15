# AI会社仕様

最終更新: 2026-07-15

## 確認結果の要約

**AI担当会社の自動意思決定ロジックはコード上に一切存在しない。** `ai-a`/`ai-b`/`ai-c`は`PlayerType`（`app/lib/gameTypes.ts`）の値として定義され、GM画面（`app/gm/page.tsx`）のプルダウンに選択肢として表示されるのみで、これらの値を読み取って何らかの意思決定を自動生成する処理は`app/`配下のどこにも存在しない。

（`claude/turn-processing-engine`ブランチの）ターン処理エンジン（`resolveCompanyTurn`, `app/lib/gameEngine.ts`）は、`CompanyDecision`が存在するかどうか（＝Redisに該当四半期・会社の意思決定が保存されているかどうか）だけを見て分岐しており、`GameSession.players[id]`が`human`か`ai-a/b/c`かは一切参照していない。つまり：

- 人間プレイヤーが提出を忘れた場合
- AI担当の会社（誰も意思決定を代行して提出しない）

の両方が、**コード上まったく同じ「未提出」の扱いになり、同じ既定値ロジック（`docs/finance_spec.md` §1）が適用される。**

## 1. AI会社A〜Eの役割

会社A〜Eそのものはプレイヤー会社であり、AI固有の「役割」を定義する設定は存在しない（`docs/parameter_spec.md` §1参照）。どの会社がAI担当になるかはGMがゲーム作成時に自由に設定する（`app/gm/page.tsx`のデフォルトはA=human、B/C/D/E=ai-b）。会社ごとに異なるAI戦略を紐づけるコードはない。

## 2. AI難易度A・B・C

出典: `app/gm/page.tsx`の`playerOptions`

| 値 | 表示ラベル |
|---|---|
| `ai-a` | 🤖 AI（上級） |
| `ai-b` | 🤖 AI（中級） |
| `ai-c` | 🤖 AI（初級） |

これらはUI上の選択肢ラベルとして定義されているのみで、難易度による意思決定内容の差異を実装したコードは存在しない。**未実装**。

## 3. AIが利用できる情報

**未実装**（AIロジック自体が存在しないため、情報アクセスの設計も存在しない）。

## 4. AIの意思決定項目

**未実装**。人間プレイヤーが入力するフェーズ0〜6の項目（`docs/parameter_spec.md`）と同一の項目をAIが埋める想定は自然だが、それを裏付ける実装・コメント・型定義はコード上に存在しない。

## 5. AIの目的関数

**未実装**。

## 6. AIの会社別戦略

**未実装**。

## 7. 財務・設備投資・営業・生産・品質の判断

**未実装**。品質・営業力に関するパラメータ自体が存在しないことは`docs/parameter_spec.md` §7-8のとおり。

## 8. AIの意思決定ログ

**未実装**。`CompanyDecision`型（`app/lib/gameTypes.ts`）は人間・AIを問わず同一の構造（`companyId, gameCode, year, quarter, submittedAt, phases`）であり、「AIが生成した」ことを示すフラグや、判断根拠を記録するフィールドは存在しない。

## 9. AIが判断した理由の保存方法

**未実装**。保存する仕組み自体が存在しない。

## 10. 現在の実装状況

| 項目 | 状態 |
|---|---|
| AI担当者タイプの選択UI | 実装済み（`app/gm/page.tsx`） |
| AI担当会社への意思決定の自動代入 | 未実装 |
| AI難易度による挙動の差 | 未実装 |
| AIの意思決定ログ・理由の保存 | 未実装 |
| 未提出時の既定値処理（結果的にAI担当会社にも適用される） | 実装済み（`claude/turn-processing-engine`ブランチのみ。`docs/finance_spec.md` §1） |

## 11. 将来実装する項目（設計時の論点整理。提案ではなく検討事項の列挙）

- AI用の意思決定生成関数を`resolveCompanyTurn`呼び出し前のどこに挿入するか（`process-turn/route.ts`内で`players[id]`を見て`decisions[id]`が空ならAIロジックを呼ぶ、等の統合方法の検討）
- 難易度別（上級/中級/初級）にどのようなパラメータ差を持たせるか
- AIの意思決定を`CompanyDecision`と同じ形式（`phases: Record<string,string>`）で生成するか、別の内部表現を持たせるか
- 意思決定理由をどこに保存するか（`CompanyDecision`への追加フィールド、別Redisキー等）
- GM画面（`/gm/[gameCode]`）でAIの意思決定内容を人間の提出と区別して表示するか
