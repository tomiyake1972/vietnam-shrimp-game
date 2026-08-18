// ShrimpX V2 — Shared Game Knowledge Registry（Phase M2.8）
//
// 【共有ドメイン層（実装指示§26）】AI Management Meeting専用に閉じない。
// 将来 ChatSense Analysis Agent / AI Analysis Context / Standard AI Audit Workbook
// のdocumentationからも、この同じAPIでゲームルール知識を取得できる。
// React・Redis・Anthropic SDKへは一切依存しない。

import { GAME_KNOWLEDGE_ENTRIES } from "./entries";
import { SALES_PARAMETERS_V1 } from "../sales/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../production/parameters";
import { FINANCE_PARAMETERS_V1 } from "../finance/parameters";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../rawMaterials/parameters";
import { KnowledgeRegistryVersion } from "./types";

export { GAME_KNOWLEDGE_ENTRIES } from "./entries";
export {
  getGameKnowledgeForQuestion,
  getGameKnowledgeByDomain,
  getGameKnowledgeById,
  classifyQuestionIntent,
  formatKnowledgeForPrompt,
  resolveKnowledgeEntry,
  DEFAULT_KNOWLEDGE_TOP_N,
} from "./retrieval";
export { estimateSalesCapacity, estimateSalesHeadcountForTons, estimateWorkerRequirement } from "./estimators";
export { buildDynamicValueMap, DEFAULT_GAME_KNOWLEDGE_PARAMETERS, UNRESOLVED_DYNAMIC_VALUE } from "./dynamicValues";
export type { GameKnowledgeParameterSources } from "./dynamicValues";
export type {
  KnowledgeDomain,
  KnowledgeEntry,
  KnowledgeRegistryVersion,
  KnowledgeRetrievalResult,
  KnowledgeRole,
  KnowledgeRuleType,
  KnowledgeSourceType,
  QuestionIntent,
  ResolvedKnowledgeEntry,
} from "./types";
export type { SalesCapacityEstimate, WorkerRequirementEstimate } from "./estimators";

/**
 * 実装指示§25。Manual更新時にstale knowledgeを検出できるようにする版情報。
 *
 * manualVersion は "NOT_TRACKED"。GitHub上に、このRegistryの転記元として
 * 追跡できる正式Manualのversioned artifactがまだ存在しないため、存在しない
 * バージョン番号を捏造しない（見つかった時点でここを更新する）。
 */
export const GAME_KNOWLEDGE_REGISTRY_VERSION: KnowledgeRegistryVersion = {
  knowledgeVersion: "gk-v1",
  manualVersion: "NOT_TRACKED",
  parameterVersion: [
    `sales=${SALES_PARAMETERS_V1.parametersVersion}`,
    `production=${PRODUCTION_PARAMETERS_V1.parametersVersion}`,
    `finance=${FINANCE_PARAMETERS_V1.parametersVersion}`,
    `rawMaterials=${RAW_MATERIALS_PARAMETERS_V1.parametersVersion}`,
  ].join(","),
};

/** 登録済みIDの一覧（structured responseのknowledgeUsedIds検証に使う）。 */
export const GAME_KNOWLEDGE_IDS: readonly string[] = GAME_KNOWLEDGE_ENTRIES.map((e) => e.id);
