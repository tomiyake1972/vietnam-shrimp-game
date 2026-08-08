// ShrimpX V2 — 相談役AI  contextの組み立て（4層を混同しないための単一の入口）
//
// 【4層（実装指示§9）】
//   A. LIVE GAME STATE        … 現在ゲーム内で起きていること
//   B. STANDARD AI STATE      … Standard AIの判断・診断
//   C. FORMAL GAME SPECIFICATION … 現在の正式仕様
//   D. DEVELOPMENT KNOWLEDGE  … なぜその仕様になったのかという開発背景
//
// この4つを別フィールドとして保持し、Claudeへも別ブロックとして渡す。
// 混ぜて1つのテキストにしない（混ぜると「現行仕様」と「過去の経緯」が区別できなくなる）。

import { createHash } from "crypto";
import { stableStringify } from "../aiExplanation/reportCache";
import { AdvisorLiveGameState, AdvisorStandardAiState } from "./gameState/advisorGameState";
import { DriveAccessDeclaration, buildDriveAccessDeclaration } from "./knowledge/driveWorkingMaterials";
import { RetrievalResult, RetrievedExcerpt } from "./knowledge/retrieval";
import { AdvisorRetrievalPlan } from "./questionRouting";
import { ADVISOR_PROMPT_VERSION } from "./advisorSystemPrompt";

export const ADVISOR_CONTEXT_SCHEMA_VERSION = 1;

/**
 * 【実装指示§7】今ユーザーがどの画面を見ているか。MVPではoptional（UIからは送らない）。
 * 後から渡せるようschemaにだけ用意する。
 */
export type AdvisorCurrentViewContext =
  | "sales"
  | "procurement"
  | "production"
  | "labor"
  | "finance"
  | "capex"
  | "pl"
  | "bs"
  | "standard_ai_proposal"
  | "unknown";

export interface AdvisorDocumentSection {
  /** 実際に渡す抜粋。 */
  readonly excerpts: readonly RetrievedExcerpt[];
  /** 文書を読めなかった等の理由。相談役AIへ「参照できなかった」と伝えるために使う。 */
  readonly unavailableReason: string | null;
  readonly searchedDocumentCount: number;
}

export interface AdvisorContext {
  readonly contextSchemaVersion: number;
  readonly promptVersion: string;
  readonly identity: {
    readonly labId: string;
    readonly companyId: string;
    readonly turn: number;
    readonly year: number;
    readonly quarter: number;
    readonly scenarioId: string;
    readonly mode: "GAME_OWNER";
    readonly currentViewContext: AdvisorCurrentViewContext;
  };
  /** A層。 */
  readonly liveGameState: AdvisorLiveGameState;
  /** B層。 */
  readonly standardAiState: AdvisorStandardAiState;
  /** C層。現行仕様として使ってよい文書だけ。含めない場合はnull。 */
  readonly formalSpecification: AdvisorDocumentSection | null;
  /**
   * C'層。現行実装のソースコード抜粋（品質強化Batch 1・§9）。含めない場合はnull。
   * sourcePolicyが最上位に置いている情報源であり、文書と食い違う場合はこちらが正である。
   */
  readonly currentImplementation: AdvisorDocumentSection | null;
  /** D層。開発背景。含めない場合はnull。 */
  readonly developmentKnowledge: AdvisorDocumentSection | null;
  /** Google Driveの扱い（MVPでは未接続であることの宣言）。 */
  readonly driveAccess: DriveAccessDeclaration;
  /** この回答で何を取りに行ったか（ログ・UI表示・将来の分析用）。 */
  readonly retrievalPlan: AdvisorRetrievalPlan;
  /** 資料の扱いに関する固定ルール（promptだけでなくcontextにも明示する）。 */
  readonly sourcePolicy: string;
}

const SOURCE_POLICY = [
  "情報源の優先順位: (1) 現行実装コード / GitHub上の正式文書（authority=CURRENT_IMPLEMENTATION, FORMAL）、",
  "(2) 作業資料（WORKING）、(3) 過去の資料（HISTORICAL）。",
  "現行仕様の説明には (3) を使ってはいけない。過去の経緯の説明には積極的に使ってよい。",
  "同一論点で資料と実装が食い違う場合は、どちらかへ統合せず「現行実装では〜」「旧文書では〜」と分けて示すこと。",
  "developmentKnowledge が null または excerpts が空の場合、開発上の意図は確認できていない。",
  "その場合はもっともらしい理由を作らず、確認できなかったと明言すること。",
].join("");

export interface BuildAdvisorContextInput {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly year: number;
  readonly quarter: number;
  readonly scenarioId: string;
  readonly currentViewContext?: AdvisorCurrentViewContext;
  readonly liveGameState: AdvisorLiveGameState;
  readonly standardAiState: AdvisorStandardAiState;
  readonly formalSpecification: RetrievalResult | null;
  readonly currentImplementation: RetrievalResult | null;
  readonly developmentKnowledge: RetrievalResult | null;
  readonly retrievalPlan: AdvisorRetrievalPlan;
}

function toDocumentSection(result: RetrievalResult | null): AdvisorDocumentSection | null {
  if (result === null) return null;
  return {
    excerpts: result.excerpts,
    unavailableReason: result.unavailableReason,
    searchedDocumentCount: result.searchedDocumentCount,
  };
}

export function buildAdvisorContext(input: BuildAdvisorContextInput): AdvisorContext {
  return {
    contextSchemaVersion: ADVISOR_CONTEXT_SCHEMA_VERSION,
    promptVersion: ADVISOR_PROMPT_VERSION,
    identity: {
      labId: input.labId,
      companyId: input.companyId,
      turn: input.turn,
      year: input.year,
      quarter: input.quarter,
      scenarioId: input.scenarioId,
      mode: "GAME_OWNER",
      currentViewContext: input.currentViewContext ?? "unknown",
    },
    liveGameState: input.liveGameState,
    standardAiState: input.standardAiState,
    formalSpecification: toDocumentSection(input.formalSpecification),
    currentImplementation: toDocumentSection(input.currentImplementation),
    developmentKnowledge: toDocumentSection(input.developmentKnowledge),
    driveAccess: buildDriveAccessDeclaration(),
    retrievalPlan: input.retrievalPlan,
    sourcePolicy: SOURCE_POLICY,
  };
}

/**
 * contextHash。既存Explanation層の設計（stableStringify + sha256）を再利用する。
 * 【注意】相談役AIのcontextは質問ごとに取得する文書が変わるため、同一Turnでも
 * 質問が違えばhashは変わる。これは「その回答がどの情報を見て作られたか」を
 * 一意に辿るための識別子であり、Q&A機能のような「会話中のstate固定」用ではない
 * （state固定の役割は liveGameState.observed 側のcontextHashが担う）。
 */
export function computeAdvisorContextHash(context: AdvisorContext): string {
  return createHash("sha256").update(stableStringify(context)).digest("hex");
}
