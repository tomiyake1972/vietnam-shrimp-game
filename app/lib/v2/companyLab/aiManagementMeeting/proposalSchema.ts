// ShrimpX V2 — AI Management Meeting: Claude構造化応答 Zodスキーマ（AMM-M0/M1）
//
// claudeClient.tsのforced tool-use出力を、Zodスキーマで検証してから呼び出し側へ渡す
// （aiExplanation/reportSchema.tsと同じ、defense-in-depthの位置づけ）。
//
// 【三宅さんの追加指示§7・§13対応】スキーマを必要以上に複雑化しない。深いnested
// object・不要なnullable union・巨大なfree-form arraysを避ける。tool定義自体も
// input tokenを消費するため、フィールド数を絞る。
// 【§8・§10対応】responses配列は最大3件（primary+secondary+CEO summary）、
// proposals配列は最大3件という上限を、Zod側でも（reportSchema.tsとは異なり）
// 明示的に強制する。理由: aiExplanation/reportSchema.tsが上限を強制しない理由
// （「わずかな超過をretry対象にしたくない」）とは異なり、ここでの上限超過は
// 「Executiveが4人同時に喋る」「提案が野放図に増える」というMVPの設計原則
// （実装指示§4・§43）そのものへの違反であり、わずかな超過を許容すべきではないため。

import { z } from "zod";
import { CAPITAL_PROJECT_TYPES } from "../../capex/types";
import { DEMAND_MARKET_IDS } from "../../market/types";
import {
  AI_MEETING_EXECUTIVE_ROLES,
  AI_MEETING_INTENTS,
  AI_MEETING_STANCES,
  PLAYER_CORRECTION_STATUSES,
  RUN_ADVISORY_MEMORY_ACTIONS,
  RUN_ADVISORY_MEMORY_SCOPES,
  RUN_ADVISORY_MEMORY_TOPICS,
  RUN_ADVISORY_MEMORY_TYPES,
  STANDARD_AI_REFERENCE_STANCES,
} from "./types";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

export const AI_MEETING_PROPOSAL_LIMITS = {
  maxResponses: 3,
  maxProposals: 3,
  maxFactsUsedPerResponse: 6,
  maxStandardAiReferencesPerResponse: 3,
  // 【M2.6追加・実装指示§13】1 callで生成できるmemory候補の上限（毎messageでmemoryを乱造しない）。
  maxMemoryCandidates: 3,
  // 【M2.6追加・実装指示§9】1 memory itemは短い1〜2文のcanonical statement。会話全文を保存しない。
  maxMemoryStatementChars: 200,
  maxMemoryUsedIds: 8,
} as const;

const executiveRoleSchema = z.enum(AI_MEETING_EXECUTIVE_ROLES);
const stanceSchema = z.enum(AI_MEETING_STANCES);

const standardAiProposalReferenceSchema = z.object({
  reasonCode: z.string(),
  targetFactoryId: z.string().optional(),
  targetProduct: z.enum(PRODUCTS).optional(),
  stance: z.enum(STANDARD_AI_REFERENCE_STANCES),
  note: z.string(),
});

const proposalBaseFields = {
  id: z.string(),
  rationale: z.string(),
};

// 【M1.1・Sales proposal schema最終監査】ShrimpXでは営業人員(salesForceHeadcount)は
// 市場単位で共有される一方、販売数量・価格調整はmarket×product単位という非対称な粒度
// （app/lib/v2/sales/salesForce.ts の validateSalesForceHeadcountBudget が、同一market内で
// productごとに異なるsalesForceHeadcountを指定するとエラーにすることで、この粒度を
// 実際に強制している）。scopeで2種類に分離し、「Japan PDにsalespersonを3人追加」のような
// 存在しない粒度（商品単位の営業人員）の提案が構造上作れないようにする。
const marketEnum = z.enum(DEMAND_MARKET_IDS as unknown as [string, ...string[]]);

/** market×product単位: 販売数量・価格調整のみ（営業人員はここには持たせない）。 */
const salesQuantityProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("SALES"),
  scope: z.literal("MARKET_PRODUCT"),
  market: marketEnum,
  product: z.enum(PRODUCTS),
  desiredQuantityTons: z.number().finite().optional(),
  priceAdjustmentUsdPerHosoEqKg: z.number().finite().optional(),
});

/** 市場単位: 営業人員のみ（商品は持たせない。同一市場の全商品へ同じ人数が適用される）。 */
const salesForceProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("SALES"),
  scope: z.literal("MARKET"),
  market: marketEnum,
  salesForceHeadcount: z.number().finite(),
});

const productionProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("PRODUCTION"),
  factoryId: z.string(),
  product: z.enum(PRODUCTS),
  desiredQuantityTons: z.number().finite().optional(),
  priority: z.number().finite().optional(),
});

const procurementProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("PROCUREMENT"),
  channel: z.enum(["DOMESTIC", "IMPORT"]),
  desiredQuantityTons: z.number().finite().optional(),
  originCountry: z.string().optional(),
  priceAdjustmentUsdPerHosoEqKg: z.number().finite().optional(),
  procurementHeadcount: z.number().finite().optional(),
});

const laborProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("LABOR"),
  factoryId: z.string(),
  regularHeadcountDelta: z.number().finite().optional(),
  temporaryHeadcountDelta: z.number().finite().optional(),
  overtimeRate: z.number().finite().optional(),
});

const financeProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("FINANCE"),
  desiredAmountUsd: z.number().finite().optional(),
  desiredTermQuarters: z.number().finite().optional(),
  desiredPrepaymentUsd: z.number().finite().optional(),
});

const capexProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("CAPEX"),
  projectType: z.enum(CAPITAL_PROJECT_TYPES as unknown as [string, ...string[]]),
  requestedBudgetUsd: z.number().finite().optional(),
  targetFactoryId: z.string().optional(),
});

const vapProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("VAP_PRODUCT_DEVELOPMENT"),
  spendTierUsd: z.number().finite(),
});

// 【discriminatedUnionではなくz.unionを使う理由】salesQuantityProposalSchemaと
// salesForceProposalSchemaは、どちらもdomain="SALES"を共有し、scopeで区別する
// （2階層discriminated unionはzodのバージョン依存の癖があり、単純さを優先する
// 三宅さんの追加指示§7の方針にも合致するため、素直なz.unionへ統一した）。
export const aiMeetingProposalSchema = z.union([
  salesQuantityProposalSchema,
  salesForceProposalSchema,
  productionProposalSchema,
  procurementProposalSchema,
  laborProposalSchema,
  financeProposalSchema,
  capexProposalSchema,
  vapProposalSchema,
]);

const responseEntrySchema = z.object({
  speaker: executiveRoleSchema,
  text: z.string(),
  stance: stanceSchema.optional(),
  proposalIds: z.array(z.string()).max(AI_MEETING_PROPOSAL_LIMITS.maxProposals),
  factsUsed: z.array(z.string()).max(AI_MEETING_PROPOSAL_LIMITS.maxFactsUsedPerResponse),
  standardAiReferences: z.array(standardAiProposalReferenceSchema).max(AI_MEETING_PROPOSAL_LIMITS.maxStandardAiReferencesPerResponse),
});

// 【M2.6追加・実装指示§13】memory候補のZodスキーマ。server-side validationの第一段
// （型・enum・文字数）。dedupe/confirmation/上限判定等の意味論的なvalidationは
// runAdvisoryMemory.ts側で行う（実装指示§14「AIに保存可否を最終決定させない」）。
const memoryCandidateSchema = z.object({
  action: z.enum(RUN_ADVISORY_MEMORY_ACTIONS),
  type: z.enum(RUN_ADVISORY_MEMORY_TYPES),
  topic: z.enum(RUN_ADVISORY_MEMORY_TOPICS),
  statement: z.string().min(1).max(AI_MEETING_PROPOSAL_LIMITS.maxMemoryStatementChars),
  requestedScope: z.enum(RUN_ADVISORY_MEMORY_SCOPES),
  verificationHint: z.string().optional(),
  normalizedValue: z.number().finite().optional(),
  expiresAfterTurn: z.number().finite().optional(),
});

export const aiMeetingStructuredResponseSchema = z.object({
  primarySpeaker: executiveRoleSchema,
  responses: z.array(responseEntrySchema).min(1).max(AI_MEETING_PROPOSAL_LIMITS.maxResponses),
  requiresCeoSummary: z.boolean(),
  proposals: z.array(aiMeetingProposalSchema).max(AI_MEETING_PROPOSAL_LIMITS.maxProposals),
  meetingIntent: z.enum(AI_MEETING_INTENTS),
  potentialStrategicChange: z.boolean(),
  potentialStrategicChangeNote: z.string().optional(),
  // 【M2.2追加】playerCorrectionStatus/Note — see types.ts PlayerCorrectionStatus。
  playerCorrectionStatus: z.enum(PLAYER_CORRECTION_STATUSES),
  playerCorrectionNote: z.string().optional(),
  // 【M2.6追加】Run Advisory Memory候補・応答で参照したmemoryのid。
  memoryCandidates: z.array(memoryCandidateSchema).max(AI_MEETING_PROPOSAL_LIMITS.maxMemoryCandidates).default([]),
  memoryUsedIds: z.array(z.string()).max(AI_MEETING_PROPOSAL_LIMITS.maxMemoryUsedIds).default([]),
});

export type AiMeetingStructuredResponseParsed = z.infer<typeof aiMeetingStructuredResponseSchema>;
