# AI Management Meeting — 実Claude API Smoke Test

## REAL_API_SMOKE_NOT_RUN

ANTHROPIC_API_KEYが本セッションの環境に設定されていないため、実APIでのsmoke testは実施していない。

## 実施手順（開発者がAPI keyを利用できる環境で手動実行する場合）

```
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/aiMeetingRealApiSmokeTest.ts
```

- CIには一切組み込まない（このスクリプトは`npm test`からは呼ばれない）。
- 8つの最低ケース（CFO質問・COO質問・Commercial質問・CEO/strategy質問・CEO summary要求・
  primary+secondaryが必要な投資質問・structured proposalを返す質問・比較的長いPlayer message）に加え、
  Test26 BAL Turn1の実再現ケース（「前回の営業結果を教えて」、overdue=0のhealthy forward
  backlogのみを持つturn1状態、M2.2でinvestment affordability/AR認識/player correctionの3ケースを追加）、
  M2.6のRun Advisory Memory実例フロー4種（A: cash floor preference→CAPEX質問、
  B: Japan priority strategic intent→販売戦略質問、C: VAP price unverified claim→VAP投資質問、
  D: explicit forget後の再質問）を含む計16ケースを順に実行し、各callのmodel/inputTokens/outputTokens/latencyMs/stopReason/retryCount/
  schemaValidationResult/primarySpeaker/secondarySpeaker/proposalCountを本ファイルへ出力する。さらにM2.7の
  Opening Executive Brief実例3ケース（10A: Turn1 Initial Brief、10B: Test26 accounting regression再現、
  10C: Test26 backlog/operational regression再現）を、通常のAI Meetingとは別のgenerateOpeningBrief経路で
  実行し、model/inputTokens/outputTokens/latencyMs/keyChanges件数/suggestedFollowUps件数を出力する。
- 実行後は、本文内容（開発用ログにのみ出力。API keyはログへ出さない）を人手で確認し、
  役員らしさ・役割の混在有無・数値の捏造有無・Standard AIへの反論可否・回答の簡潔さ・
  factsUsedの妥当性・日本語の自然さを評価する（本スクリプトは自動評価しない）。Opening Briefについては
  重要な変化を選ぶか・長すぎないか・事実誤認なし・原因を捏造しない・CEOらしい全社視点かも確認する。

