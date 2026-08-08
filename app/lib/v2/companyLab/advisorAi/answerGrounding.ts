// ShrimpX V2 — 相談役AI  回答の根拠検証（品質強化Batch 1・§12〜§14）
//
// 【解決したい問題】
// 相談役AIの回答には relatedReasonCodes（Standard AIの理由コード）が含まれる。
// UI上、これは「Standard AIが実際にそう判断した」という強い主張として読まれる。
// ところがモデルは、それらしい命名規則（例: LABOR_SHORTAGE_DETECTED）を自分で
// 作ることができてしまう。存在しないコードが出れば、利用者は
// 「Standard AIがそう診断した」と誤解する。これは最も直接的なハルシネーションである。
//
// 【方針（§13）】promptで禁止するだけにせず、サーバー側で機械的に検証する。
//   1. contextに実在する diagnosticEntries[].code の集合を作る
//   2. 回答の relatedReasonCodes / sections[].sources と突き合わせる
//   3. 実在しないものが1つでもあれば、その試行は「不合格」として1回だけ再生成する
//   4. 再生成後もまだ実在しないコードが残る場合は、回答自体は返すが、
//      実在しないコードは**落として**返す（利用者へは絶対に見せない）
//
// 【なぜ回答ごと失敗にしないか】
// 本文の内容は正しいのに理由コードだけが1つ余計、というケースで回答全体を捨てると
// 応答完走率（§0の第1優先）が下がる。捏造値の除去は「落とす」で十分に達成でき、
// 落としたことはログに残るので品質評価もできる。
//
// 【純粋関数】ここではI/O・API呼び出しを一切行わない。テスト可能な純粋関数のみ。

import { AdvisorAnswer } from "./advisorSchema";
import { AdvisorContext } from "./buildAdvisorContext";

/** contextに実在する Standard AI の理由コード一覧を取り出す。 */
export function collectKnownReasonCodes(context: AdvisorContext): ReadonlySet<string> {
  const codes = new Set<string>();
  const entries = context.standardAiState.chatContext.explanation.standardAi.diagnosticEntries;
  for (const entry of entries) {
    if (typeof entry.code === "string" && entry.code.length > 0) codes.add(entry.code);
  }
  return codes;
}

/** contextで実際に渡した文書パス一覧（sourcesの捏造検出用）。 */
export function collectKnownDocumentPaths(context: AdvisorContext): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const section of [context.formalSpecification, context.currentImplementation, context.developmentKnowledge]) {
    if (section === null) continue;
    for (const excerpt of section.excerpts) paths.add(excerpt.path);
  }
  return paths;
}

export interface AnswerGroundingReport {
  /** 実在しない理由コード（＝捏造）。 */
  readonly fabricatedReasonCodes: readonly string[];
  /** 渡していない文書パスを出所として挙げた件数。 */
  readonly fabricatedSourcePathCount: number;
  /**
   * 数値を述べていそうなのに evidenceRefs が空の FACT 節の件数。
   * 【推定であることの明示】「数値を述べたか」は正規表現による推定であり断定ではない。
   * この値はログと品質評価にのみ使い、回答の合否判定には使わない。
   */
  readonly factSectionsMissingEvidenceRefs: number;
  /** 何らかの捏造が検出されたか（＝再生成に値するか）。 */
  readonly hasFabrication: boolean;
}

/** 数字を含む本文かどうかの推定（全角数字・パーセント・金額表記を含む）。 */
function looksNumeric(text: string): boolean {
  return /[0-9０-９]/.test(text);
}

export function inspectAnswerGrounding(answer: AdvisorAnswer, context: AdvisorContext): AnswerGroundingReport {
  const knownCodes = collectKnownReasonCodes(context);
  const knownPaths = collectKnownDocumentPaths(context);

  const fabricatedReasonCodes = answer.relatedReasonCodes.filter((code) => !knownCodes.has(code));

  let fabricatedSourcePathCount = 0;
  let factSectionsMissingEvidenceRefs = 0;
  for (const section of answer.sections) {
    for (const source of section.sources) {
      if (source.path !== null && source.path.length > 0 && !knownPaths.has(source.path)) fabricatedSourcePathCount++;
    }
    if (section.type === "FACT" && looksNumeric(section.text) && (section.evidenceRefs?.length ?? 0) === 0) {
      factSectionsMissingEvidenceRefs++;
    }
  }

  return {
    fabricatedReasonCodes,
    fabricatedSourcePathCount,
    factSectionsMissingEvidenceRefs,
    // 【再生成の対象】理由コードと出所パスの捏造だけを対象にする。
    // evidenceRefsの欠落は「間違い」ではなく「情報が足りない」だけなので、
    // これを理由に再生成すると無駄な待ち時間とコストが増える（§0の優先順位に反する）。
    hasFabrication: fabricatedReasonCodes.length > 0 || fabricatedSourcePathCount > 0,
  };
}

/**
 * 実在しない理由コード・出所パスを回答から取り除く。
 * 本文（answer / section.text）は書き換えない（意味を壊さないため）。
 */
export function stripFabricatedReferences(answer: AdvisorAnswer, context: AdvisorContext): AdvisorAnswer {
  const knownCodes = collectKnownReasonCodes(context);
  const knownPaths = collectKnownDocumentPaths(context);
  return {
    ...answer,
    relatedReasonCodes: answer.relatedReasonCodes.filter((code) => knownCodes.has(code)),
    sections: answer.sections.map((section) => ({
      ...section,
      sources: section.sources.filter((s) => s.path === null || s.path.length === 0 || knownPaths.has(s.path)),
    })),
  };
}
