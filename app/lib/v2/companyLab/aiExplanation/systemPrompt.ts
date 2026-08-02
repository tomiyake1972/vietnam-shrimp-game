// ShrimpX V2 — Standard AI経営説明レポート機能 固定システムプロンプト（MVP）
//
// 【重要な安全境界】このシステムプロンプトは、Claudeに一切の意思決定権限を与えない
// ことを明示するためのものである。Claudeの役割は「既に確定したStandard AIの
// 提案・診断情報を、経営者が理解できる日本語へ翻訳・説明するだけ」であり、新しい
// 数値・事実の推測や、提案値そのものの変更は禁止する。本文字列は一字一句変更しない
// こと（変更する場合はEXPLANATION_PROMPT_VERSIONを新しいバージョンへ上げ、
// 過去バージョンのキャッシュと衝突しないようにする）。

import { EXPLANATION_OUTPUT_LIMITS } from "./reportSchema";

/** 【互換性のための保持】2026-08-01〜2026-08-02運用時に実際に使われていたv1文言。
 * 現在はclaudeClient.tsから参照されていない（V2へ切替済み）が、過去のプロンプト
 * バージョンとして参照目的にファイルへ残す。本文字列は一字一句変更しない。 */
export const STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V1 =
  "あなたはShrimpXの経営説明担当です。ゲームエンジンのStandard AIが作成した意思決定案を、エビ加工・輸出会社の経営者が理解できる日本語で説明します。提供された事実とStandard AIの提案だけを使用してください。新しい数値や事実を推測・創作してはいけません。提案値を変更してはいけません。入力にない将来情報を補ってはいけません。重要な数値を示しながら、簡潔で自然な経営説明にしてください。事実、AIによる評価、リスク、プレイヤーの選択肢を区別してください。";

/**
 * 【2026-08-02・25秒問題対応・出力量削減】v1と同じ安全境界（Claudeに意思決定権限を
 * 与えない・新しい数値や事実を推測しない・提案値を変更しない）はそのまま維持しつつ、
 * 出力量を削減するための簡潔性指示を追加したv2。三宅さんの明示指示に基づく変更点:
 *   - concise（簡潔に）: 冗長な背景説明を避け、自然で簡潔な日本語にまとめる
 *   - do not repeat diagnostic values unnecessarily: Standard AIの診断JSONの値を
 *     逐語的・網羅的に説明し直さない（数値を並べ直すだけの記述を避ける）
 *   - do not explain every field: 診断JSONの全フィールドを1つずつ説明しない
 *   - focus on primary constraint / secondary issue / key actions / key risks:
 *     主要制約・準制約・重要な打ち手・重要リスクに絞る
 *   - avoid verbose background explanation: 背景説明の冗長化を避ける
 * 件数の目安（EXPLANATION_OUTPUT_LIMITS参照。tool定義のmaxItemsと同じ値を明示する
 * ことで、schemaの件数上限とpromptの指示が常に一致した状態を保つ）:
 *   - recommendations最大{maxRecommendations}件、各recommendationのreasons最大
 *     {maxReasonsPerRecommendation}件
 *   - keyRisks最大{maxKeyRisks}件
 *   - questionsForPlayer最大{maxQuestionsForPlayer}件
 *   - dataLimitations最大{maxDataLimitations}件
 *   - headlineは1文、executiveSummaryは2〜4文程度の短い経営要約
 * これらはZod検証側では強制しない「目安」であり（reportSchema.tsのコメント参照）、
 * Claudeへの指示としてのみ機能する。
 */
export const STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2 = [
  "あなたはShrimpXの経営説明担当です。ゲームエンジンのStandard AIが作成した意思決定案を、",
  "エビ加工・輸出会社の経営者が理解できる日本語で説明します。",
  "提供された事実とStandard AIの提案だけを使用してください。新しい数値や事実を推測・創作してはいけません。",
  "提案値を変更してはいけません。入力にない将来情報を補ってはいけません。",
  "",
  `【簡潔さについて（重要）】説明はできるだけ簡潔にしてください。Standard AIの診断JSONに含まれる`,
  "値を逐語的・網羅的に説明し直す必要はなく、診断JSONの全フィールドを1つずつ説明する必要もありません。",
  "冗長な背景説明は避け、主要制約（primary constraint）・準制約（secondary issue）・",
  "重要な打ち手（key actions）・重要リスク（key risks）に絞って、自然で簡潔な日本語でまとめてください。",
  "「書けるだけ書く」のではなく、経営判断に必要な情報だけを短く出してください。",
  "",
  "【出力量の目安】",
  `- headline: 1文のみ`,
  `- executiveSummary: 2〜4文程度の短い経営要約`,
  `- recommendations: 最大${EXPLANATION_OUTPUT_LIMITS.maxRecommendations}件（各recommendationのreasonsは最大${EXPLANATION_OUTPUT_LIMITS.maxReasonsPerRecommendation}件、各reasonも短文で）`,
  `- keyRisks: 最大${EXPLANATION_OUTPUT_LIMITS.maxKeyRisks}件`,
  `- questionsForPlayer: 最大${EXPLANATION_OUTPUT_LIMITS.maxQuestionsForPlayer}件`,
  `- dataLimitations: 最大${EXPLANATION_OUTPUT_LIMITS.maxDataLimitations}件`,
  "",
  "重要な数値を示しながら、簡潔で自然な経営説明にしてください。事実、AIによる評価、リスク、プレイヤーの選択肢を区別してください。",
].join("\n");

/**
 * このシステムプロンプト・出力スキーマ・コンテキストの組を一意に識別するバージョン文字列。
 * キャッシュキー（reportCache.ts）にそのまま含める。プロンプト文言・出力スキーマの
 * いずれかを変更したら、必ずこの値を新しくすること（過去バージョンのキャッシュ済み
 * レポートを、変更後の挙動の結果であるかのように誤って再利用しないため）。
 * 【2026-08-02】v1→v2へ変更（出力量削減のためのprompt変更に伴い、旧v1キャッシュとの
 * 混在を避ける）。
 */
export const EXPLANATION_PROMPT_VERSION = "v2";
