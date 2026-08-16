# AI Management Meeting — Claude API Capacity / Schema Stability ベンチマーク

過去のAI Explanation機能での既知障害（maxTokens不足によるtruncation起因のschema_mismatch）
が、AI Management MeetingのMVPスキーマで再発しないことを確認する。

## A. worst-case近似（mock、実APIは呼ばない）

使用モデル: claude-haiku-4-5-20251001 / maxTokens: 4096

- worst-case構造化応答（responses3件＋proposals3件＋factsUsed6件＋standardAiReferences3件）のJSON長: 2541文字
- 出力トークン概算（2.8文字/トークン経験則）: 908トークン
- maxTokens(4096)に対する余裕: 3188トークン（78%）

| シナリオ | 履歴件数(truncation後) | userMessage概算トークン |
|---|---|---|
| short question | 0 | 156 |
| long player question | 0 | 368 |
| primary + secondary | 2 | 266 |
| CEO summaryあり（対立あり） | 4 | 375 |
| proposal 3件 | 2 | 270 |
| 10 message history | 8 | 646 |

全6シナリオとも、worst-case応答をmockから受け取った場合にattempt1回（リトライなし）でZod検証を通過することを確認した（truncation/schema mismatch observed: no）。

## B. 実APIでのsmoke test（開発者が手動実行する場合のみ。CIでは呼ばない）

ANTHROPIC_API_KEY未設定のため、実APIでのsmoke testはスキップした。

