// ShrimpX V2 — AI Management Meeting: Overdue Wording Guard（AMM-M2.5・実装指示§2・§11）
//
// 【役割】prompt文言によるstrong wording guard（§2）の二重防御として、実際の応答
// テキストにoverdue関連の禁止語彙が含まれていないかを機械的に検知する。overdueTonsが
// 0（またはごく僅少）の場合のみ判定対象とする。検知した場合、呼び出し側（handlers.ts）
// が最大1回のrepair/retryを行うかどうかを判断する材料として使う（本モジュール自体は
// リトライを行わない。純粋な検知関数のみ）。
//
// 【引用・訂正文脈の扱い（実装指示§2「ただし引用・訂正文脈を除く」への対応）】
// 完全な文脈解析はしない（新しい自然言語理解ロジックを増設しない）。実務上最も
// 重要なケース——役員が「これはoverdueではありません」のように禁止語を使って
// 明示的に否定・訂正している場合——だけを、単純な否定表現の近傍一致で除外する。
// これ以外の引用文脈（例:「プレイヤーは『納期遅延』と述べましたが」）まで完全に
// 除外することは保証しない（既知の限界。remaining risksに明記する）。

const BANNED_OVERDUE_PHRASES: readonly string[] = [
  "overdue",
  "late",
  "delayed",
  "past due",
  "deadline missed",
  "納期遅延",
  "期限オーバー",
  "未達",
  "契約違反",
];

/** 禁止語の直前・直後の短い範囲に否定表現があれば、訂正文脈として除外する。 */
const NEGATION_CUES: readonly string[] = ["ではな", "はな", "無い", "ではありません", "not ", "isn't", "is not", "no longer"];

const NEGATION_WINDOW = 12;

function isNegatedContext(text: string, matchIndex: number, matchLength: number): boolean {
  const start = Math.max(0, matchIndex - NEGATION_WINDOW);
  const end = Math.min(text.length, matchIndex + matchLength + NEGATION_WINDOW);
  const window = text.slice(start, end);
  return NEGATION_CUES.some((cue) => window.includes(cue));
}

/**
 * overdueTonsがほぼ0の場合のみ、応答テキスト群から禁止語彙の出現（訂正文脈を除く）を
 * 検出する。overdueTonsが0でない場合は常に空配列（判定不要）。
 */
export function findOverdueWordingViolations(responseTexts: readonly string[], overdueTons: number): readonly string[] {
  if (overdueTons > 1e-6) return [];
  const violations: string[] = [];
  for (const text of responseTexts) {
    const lower = text.toLowerCase();
    for (const phrase of BANNED_OVERDUE_PHRASES) {
      const needle = phrase.toLowerCase();
      let searchFrom = 0;
      for (;;) {
        const idx = lower.indexOf(needle, searchFrom);
        if (idx === -1) break;
        if (!isNegatedContext(text, idx, phrase.length)) {
          violations.push(phrase);
        }
        searchFrom = idx + needle.length;
      }
    }
  }
  return violations;
}
