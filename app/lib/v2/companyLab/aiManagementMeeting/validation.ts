// ShrimpX V2 — AI Management Meeting: Proposal Validation Layer（AMM-M0/M1）
//
// Claude出力（proposalSchema.tsのZod検証を通過済み）が、実在するゲームデータ
// （company/factory/market/product/CAPEX種別）と整合しているかをここで検証する。
// このレイヤーを通過して初めて、提案は「validated」としてUIへ返される。
// 【M1スコープ】ここではvalid/invalidの判定と、financiallyRisky（財務リスクが高い
// 可能性がある）というsoft flagだけを付ける。財務実行可能性のフルな再計算
// （Finance Gate相当のシミュレーション）はM1の対象外（実装指示§48「full
// re-validation of financial feasibility is not required this phase」）。
// financialGateFor等の既存Finance Gateヘルパーはここでは呼ばない（呼ぶ場合は
// 将来phase）。

import { CAPITAL_PROJECT_TYPES, CapitalProjectType } from "../../capex/types";
import { CompanyFixture } from "../types";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { AiMeetingProposal, ValidatedAiMeetingProposal } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export interface ValidationContext {
  readonly fixture: CompanyFixture;
  readonly currentTurn: number;
  /** この提案がturn番号を明示的に持たないため、呼び出し側turnが現在turnと一致する場合のみ編集可能とする。 */
  readonly requestTurn: number;
  /** cash残高。財務リスクのsoft判定（simple heuristic）にのみ使う。 */
  readonly cashUsd: number;
}

function factoryExists(fixture: CompanyFixture, factoryId: string): boolean {
  return fixture.factories.some((f) => f.factoryId === factoryId);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function nonNegativeOrUndefined(v: number | undefined): boolean {
  return v === undefined || v >= 0;
}

/** 1件の提案を検証する。 */
function validateOne(proposal: AiMeetingProposal, ctx: ValidationContext, seenCapexKeys: Set<string>): ValidatedAiMeetingProposal {
  const issues: string[] = [];
  let financiallyRisky = false;

  if (ctx.requestTurn !== ctx.currentTurn) {
    issues.push(`turn ${ctx.requestTurn} は現在turn(${ctx.currentTurn})と一致しないため編集できません。`);
  }

  switch (proposal.domain) {
    case "SALES": {
      if (!DEMAND_MARKET_IDS.includes(proposal.market)) issues.push(`市場 "${proposal.market}" は存在しません。`);
      if (!PRODUCTS.includes(proposal.product)) issues.push(`商品 "${proposal.product}" は存在しません。`);
      if (!nonNegativeOrUndefined(proposal.desiredQuantityTons)) issues.push("desiredQuantityTonsは0以上である必要があります。");
      if (proposal.salesForceHeadcount !== undefined) {
        if (!Number.isInteger(proposal.salesForceHeadcount) || proposal.salesForceHeadcount < 0) {
          issues.push("salesForceHeadcountは0以上の整数である必要があります（市場×商品ごとの営業人員配置）。");
        }
      }
      break;
    }
    case "PRODUCTION": {
      if (!factoryExists(ctx.fixture, proposal.factoryId)) issues.push(`工場 "${proposal.factoryId}" は存在しません。`);
      if (!PRODUCTS.includes(proposal.product)) issues.push(`商品 "${proposal.product}" は存在しません。`);
      if (!nonNegativeOrUndefined(proposal.desiredQuantityTons)) issues.push("desiredQuantityTonsは0以上である必要があります。");
      break;
    }
    case "PROCUREMENT": {
      if (!nonNegativeOrUndefined(proposal.desiredQuantityTons)) issues.push("desiredQuantityTonsは0以上である必要があります。");
      if (proposal.procurementHeadcount !== undefined && (!Number.isInteger(proposal.procurementHeadcount) || proposal.procurementHeadcount < 0)) {
        issues.push("procurementHeadcountは0以上の整数である必要があります。");
      }
      if (proposal.channel === "IMPORT" && !proposal.originCountry) {
        issues.push("輸入提案(channel=IMPORT)はoriginCountryが必須です。");
      }
      break;
    }
    case "LABOR": {
      if (!factoryExists(ctx.fixture, proposal.factoryId)) issues.push(`工場 "${proposal.factoryId}" は存在しません。`);
      if (proposal.overtimeRate !== undefined && proposal.overtimeRate < 0) issues.push("overtimeRateは0以上である必要があります。");
      break;
    }
    case "FINANCE": {
      if (!nonNegativeOrUndefined(proposal.desiredAmountUsd)) issues.push("desiredAmountUsdは0以上である必要があります。");
      if (proposal.desiredTermQuarters !== undefined && (!Number.isInteger(proposal.desiredTermQuarters) || proposal.desiredTermQuarters <= 0)) {
        issues.push("desiredTermQuartersは1以上の整数である必要があります。");
      }
      if (proposal.desiredAmountUsd !== undefined && proposal.desiredAmountUsd > ctx.cashUsd * 5) {
        // 【M1の簡易heuristic】厳密なFinance Gate再計算はしない。現金残高の5倍を超える
        // 希望借入額は「財務リスクが高い可能性」というsoft flagのみ立てる（拒否はしない）。
        financiallyRisky = true;
      }
      break;
    }
    case "CAPEX": {
      if (!CAPITAL_PROJECT_TYPES.includes(proposal.projectType as CapitalProjectType)) {
        issues.push(`CAPEX種別 "${proposal.projectType}" は存在しません。`);
      }
      if (proposal.targetFactoryId !== undefined && !factoryExists(ctx.fixture, proposal.targetFactoryId)) {
        issues.push(`工場 "${proposal.targetFactoryId}" は存在しません。`);
      }
      if (proposal.projectType === "pdMechanization" && !proposal.targetFactoryId) {
        issues.push("pdMechanizationはtargetFactoryIdが必須です。");
      }
      if (!nonNegativeOrUndefined(proposal.requestedBudgetUsd)) issues.push("requestedBudgetUsdは0以上である必要があります。");
      const dupKey = `${proposal.projectType}::${proposal.targetFactoryId ?? ""}`;
      if (seenCapexKeys.has(dupKey)) {
        issues.push(`同一の設備投資案件（projectType=${proposal.projectType}, targetFactoryId=${proposal.targetFactoryId ?? "(未指定)"})が重複して提案されています。`);
      }
      seenCapexKeys.add(dupKey);
      if (proposal.requestedBudgetUsd !== undefined && proposal.requestedBudgetUsd > ctx.cashUsd * 3) {
        financiallyRisky = true;
      }
      break;
    }
    case "VAP_PRODUCT_DEVELOPMENT": {
      if (!isFiniteNumber(proposal.spendTierUsd) || proposal.spendTierUsd < 0) issues.push("spendTierUsdは0以上の数値である必要があります。");
      break;
    }
  }

  return { proposal, valid: issues.length === 0, issues, financiallyRisky };
}

/** 提案配列全体を検証する（重複CAPEX検出は配列全体を横断して行うため、単一関数として公開）。 */
export function validateAiMeetingProposals(proposals: readonly AiMeetingProposal[], ctx: ValidationContext): readonly ValidatedAiMeetingProposal[] {
  const seenCapexKeys = new Set<string>();
  return proposals.map((p) => validateOne(p, ctx, seenCapexKeys));
}
