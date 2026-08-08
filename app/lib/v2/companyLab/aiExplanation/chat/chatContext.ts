// ShrimpX V2 — 「Standard AIに質問する」対話機能（Phase 1 MVP） Claude入力コンテキスト
//
// 【最重要原則（実装指示§0）】Standard AI = 意思決定主体 / Claude = 説明主体。
// この機能はStandard AIが既に算出した意思決定を「説明する」だけであり、Claudeは
// sales headcount・allocation・procurement・production・labor・borrowing・capex等の
// 数値を新しく決めない。したがってこのコンテキストは「説明のための読み取り専用の
// 事実集合」であり、意思決定の入力ではない。
//
// 【既存構造の再利用（実装指示§4）】新しい別系統の巨大contextは作らない。既存の
// ExplanationContext（buildExplanationContext.ts）をそのまま埋め込み、そこに含まれて
// いなかった「今期の主要／第2ボトルネック」だけを、Standard AI自身が既に算出済みの
// situationDiagnosisから素通しで転記する（新しい計算は一切行わない）。
//
// 【情報境界（実装指示§14・§15）】ExplanationContextは既に
//   - 他社の非公開データ
//   - 生のCompanyLabState・履歴全体
//   - 将来需要・将来ショック・将来イベント
// を構造的に持たない（入力型にそもそも存在しない）。この機能はそのExplanationContextと
// situationDiagnosis（Standard AI自身の診断結果）以外の情報源を一切参照しないため、
// 「PlayerとStandard AIが見える情報範囲」を構造的に超えられない。

import { createHash } from "crypto";
import { StandardAiQuarterDiagnostics } from "../../standardAi/policy";
import { ExplanationContext } from "../buildExplanationContext";
import { stableStringify } from "../reportCache";
import { CHAT_PROMPT_VERSION } from "./chatSystemPrompt";

/** このチャット用コンテキストの構造バージョン。フィールドの追加・削除・意味変更のたびに上げる。 */
export const CHAT_CONTEXT_SCHEMA_VERSION = 1;

/**
 * 今期のボトルネック（Standard AI自身のsituationDiagnosisの素通し）。
 * 「なぜ工場を増設しないの？」「何が今期の最大のボトルネックなの？」に、
 * Claudeが自分で制約を推定するのではなくAIの判定結果で答えられるようにするためのもの。
 * situationDiagnosisが存在しない場合（永続化された古いドラフト等）はnullになり、
 * その場合Claudeは「ボトルネック判定はログに存在しない」と答える（捏造しない）。
 */
export interface ChatContextBottleneck {
  readonly primaryConstraint: string;
  readonly secondaryConstraint: string;
  readonly salesFulfillmentRatio: number;
  readonly salesFulfillmentState: string;
  readonly productionLoadRatio: number;
  readonly productionLoadState: string;
  readonly productionCapacityHeadroom: number;
  readonly workerLoadRatio: number;
  readonly workerLoadState: string;
  readonly workerHeadroom: number;
  readonly rawMaterialCoverageRatio: number;
  readonly rawMaterialCoverageState: string;
  readonly rawMaterialProcurementNeeded: boolean;
  readonly rawMaterialSupplyConstraintState: string;
  readonly inventoryExcessRatio: number;
  readonly inventoryExcessState: string;
  readonly liquidityCoverageRatio: number;
  readonly liquidityCoverageState: string;
}

/**
 * 「他にどんな選択肢があったの？」（実装指示§17）に答えるための材料。
 * MVPでは反実仮想計算を行わないため、Standard AIのログに既に記録されている
 * 比較候補だけを渡す。現行のStandard AIは「棄却された候補（rejected candidates）」を
 * 構造化して保存していないため、hasRecordedAlternatives は常にfalseになる。
 * この事実自体をコンテキストへ明示し、Claudeが代替案を創作しないようにする。
 */
export interface ChatContextAlternatives {
  readonly hasRecordedAlternatives: boolean;
  readonly note: string;
}

export interface StandardAiChatContext {
  readonly chatContextSchemaVersion: number;
  readonly chatPromptVersion: string;
  /** 既存のExplanationContextそのもの（再利用。改変・再計算なし）。 */
  readonly explanation: ExplanationContext;
  /** Standard AI自身のボトルネック判定（素通し）。存在しない場合はnull。 */
  readonly bottleneck: ChatContextBottleneck | null;
  readonly alternatives: ChatContextAlternatives;
}

const NO_ALTERNATIVES_NOTE =
  "現在のStandard AIは、採用しなかった比較候補（rejected candidates）を構造化して保存していません。" +
  "そのため「他にどんな選択肢があったか」はログから確認できません。代替案を推測して提示してはいけません。";

/**
 * ExplanationContext（既存）＋Standard AIの診断結果から、チャット用コンテキストを組み立てる。
 * 純粋関数・副作用なし。新しい数値計算は一切行わず、既存の値の転記だけを行う。
 */
export function buildStandardAiChatContext(
  explanation: ExplanationContext,
  diagnostics: StandardAiQuarterDiagnostics
): StandardAiChatContext {
  const sd = diagnostics.situationDiagnosis;
  return {
    chatContextSchemaVersion: CHAT_CONTEXT_SCHEMA_VERSION,
    chatPromptVersion: CHAT_PROMPT_VERSION,
    explanation,
    bottleneck: sd
      ? {
          primaryConstraint: sd.primaryConstraint,
          secondaryConstraint: sd.secondaryConstraint,
          salesFulfillmentRatio: sd.salesFulfillmentRatio,
          salesFulfillmentState: sd.salesFulfillmentState,
          productionLoadRatio: sd.productionLoadRatio,
          productionLoadState: sd.productionLoadState,
          productionCapacityHeadroom: sd.productionCapacityHeadroom,
          workerLoadRatio: sd.workerLoadRatio,
          workerLoadState: sd.workerLoadState,
          workerHeadroom: sd.workerHeadroom,
          rawMaterialCoverageRatio: sd.rawMaterialCoverageRatio,
          rawMaterialCoverageState: sd.rawMaterialCoverageState,
          rawMaterialProcurementNeeded: sd.rawMaterialProcurementNeeded,
          rawMaterialSupplyConstraintState: sd.rawMaterialSupplyConstraintState,
          inventoryExcessRatio: sd.inventoryExcessRatio,
          inventoryExcessState: sd.inventoryExcessState,
          liquidityCoverageRatio: sd.liquidityCoverageRatio,
          liquidityCoverageState: sd.liquidityCoverageState,
        }
      : null,
    alternatives: { hasRecordedAlternatives: false, note: NO_ALTERNATIVES_NOTE },
  };
}

/**
 * 【Context固定（実装指示§10）】同一Turn内の対話では、最初に生成した
 * Standard AI proposal / diagnostics contextを固定する必要がある。そのための識別子。
 * 既存Explanation層のcontextHash設計（reportCache.tsのstableStringify＋sha256）を
 * そのまま再利用する（キーの挿入順序に依存しない決定論的ハッシュ）。
 *
 * ゲームstateが変わればexplanation側の内容が変わるためhashも変わり、
 * 「チャット途中で別状態が混ざる」ことを検出できる。
 */
export function computeChatContextHash(context: StandardAiChatContext): string {
  return createHash("sha256").update(stableStringify(context)).digest("hex");
}
