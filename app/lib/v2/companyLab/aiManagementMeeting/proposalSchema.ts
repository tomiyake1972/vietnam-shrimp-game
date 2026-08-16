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
import { AI_MEETING_EXECUTIVE_ROLES, AI_MEETING_INTENTS, AI_MEETING_STANCES, STANDARD_AI_REFERENCE_STANCES } from "./types";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

export const AI_MEETING_PROPOSAL_LIMITS = {
  maxResponses: 3,
  maxProposals: 3,
  maxFactsUsedPerResponse: 6,
  maxStandardAiReferencesPerResponse: 3,
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

const salesProposalSchema = z.object({
  ...proposalBaseFields,
  domain: z.literal("SALES"),
  market: z.enum(DEMAND_MARKET_IDS as unknown as [string, ...string[]]),
  product: z.enum(PRODUCTS),
  desiredQuantityTons: z.number().finite().optional(),
  priceAdjustmentUsdPerHosoEqKg: z.number().finite().optional(),
  salesForceHeadcount: z.number().finite().optional(),
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

export const aiMeetingProposalSchema = z.discriminatedUnion("domain", [
  salesProposalSchema,
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

export const aiMeetingStructuredResponseSchema = z.object({
  primarySpeaker: executiveRoleSchema,
  responses: z.array(responseEntrySchema).min(1).max(AI_MEETING_PROPOSAL_LIMITS.maxResponses),
  requiresCeoSummary: z.boolean(),
  proposals: z.array(aiMeetingProposalSchema).max(AI_MEETING_PROPOSAL_LIMITS.maxProposals),
  meetingIntent: z.enum(AI_MEETING_INTENTS),
  potentialStrategicChange: z.boolean(),
  potentialStrategicChangeNote: z.string().optional(),
});

export type AiMeetingStructuredResponseParsed = z.infer<typeof aiMeetingStructuredResponseSchema>;
