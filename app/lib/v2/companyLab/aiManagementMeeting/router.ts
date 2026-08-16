// ShrimpX V2 — AI Management Meeting: Deterministic Routing（AMM-M0/M1）
//
// プレイヤー発言から「誰が第一発言者(primary speaker)か」を、まずキーワード/簡易
// 意図分類で決定論的に決める（LLMルーティングは使わない。実装指示§34「deterministic
// first」に対応）。secondary（最大1名）・CEO summary要否の判定もここで行う。
// この判定結果はprompt.tsが「あなたが主担当です」という指示をClaudeへ渡すために使うが、
// Claude自身がprimarySpeakerを最終的に構造化応答へ含めるため、ここでの判定は
// 「Claudeへのヒント（既定値）」であり、Claudeの出力を強制的に上書きするものではない
// （responses[0].speakerとprimarySpeakerが一致しているかはvalidation.tsではなく
// 呼び出し側の軽い整合性チェックに委ねる）。

import { CEO_DIRECT_ADDRESS_KEYWORDS_JA, EXECUTIVE_ROLE_DEFINITIONS } from "./roles";
import { ExecutiveRole } from "./types";

export interface RoutingDecision {
  readonly primary: ExecutiveRole;
  /** 最大1名。primaryの担当領域と別領域にも強く関係する場合のみ設定。 */
  readonly secondary: ExecutiveRole | null;
  readonly matchedKeywords: readonly string[];
}

const ROLE_ORDER: readonly ExecutiveRole[] = ["CFO", "COO", "COMMERCIAL", "CEO"];

function countKeywordMatches(text: string, role: ExecutiveRole): { readonly count: number; readonly matched: string[] } {
  const def = EXECUTIVE_ROLE_DEFINITIONS[role];
  const matched: string[] = [];
  for (const kw of def.topicKeywordsJa) {
    if (text.includes(kw) || text.toLowerCase().includes(kw.toLowerCase())) matched.push(kw);
  }
  return { count: matched.length, matched };
}

/**
 * プレイヤー発言テキストから主担当・副担当（最大1名）を決める。
 * - 明示的にCEO宛て（"CEO", "社長"等）に呼びかけている場合はCEOをprimaryにする。
 * - それ以外は、各役割のtopicKeywordsJaへのマッチ数が最も多い役割をprimaryにする。
 * - 2番目に多くマッチした役割が、primaryの半分以上のマッチ数を持ち、かつ1件以上
 *   マッチしている場合のみsecondaryとして設定する（実装指示§35「max 1 additional」）。
 * - 何もマッチしない場合はCEOをprimaryにする（全体方針についての一般的な質問として扱う）。
 */
export function routePlayerMessage(playerMessageText: string): RoutingDecision {
  const text = playerMessageText.trim();
  const directCeo = CEO_DIRECT_ADDRESS_KEYWORDS_JA.some((kw) => text.includes(kw));

  const scored = ROLE_ORDER.filter((r) => r !== "CEO").map((role) => ({ role, ...countKeywordMatches(text, role) }));
  scored.sort((a, b) => b.count - a.count);

  if (directCeo) {
    const top = scored[0];
    return {
      primary: "CEO",
      secondary: top && top.count > 0 ? top.role : null,
      matchedKeywords: top ? top.matched : [],
    };
  }

  const top = scored[0];
  if (!top || top.count === 0) {
    return { primary: "CEO", secondary: null, matchedKeywords: [] };
  }

  const second = scored[1];
  const secondary = second && second.count > 0 && second.count >= top.count / 2 ? second.role : null;

  return { primary: top.role, secondary, matchedKeywords: top.matched };
}

/**
 * CEO summaryを追加すべきかどうかの既定判定（実装指示§37「non-conflict, non-multi-proposal,
 * non-explicit-request cases must NOT get a CEO summary」）。Claude自身が
 * requiresCeoSummaryを最終決定するが、prompt.ts組み立て時にこの既定値をヒントとして渡す。
 */
export function shouldSuggestCeoSummary(input: {
  readonly hasSecondary: boolean;
  readonly stancesConflict: boolean;
  readonly proposalCount: number;
  readonly explicitCeoRequest: boolean;
}): boolean {
  if (input.explicitCeoRequest) return true;
  if (input.stancesConflict) return true;
  if (input.proposalCount >= 2) return true;
  return false;
}
