// ShrimpX V2 — Standard AI Investment Portfolio Calibration（Phase PC-1新設）
//
// 【指示§4・§20・§26・§39】既存の会計上のCAPEX/OPEX区分（finance/quarterClose.ts）を
// 一切変更せず、既存の10種のCapitalProjectType（capex/types.ts）を
// growth/productivity/quality の3カテゴリへ機械的に分類する純粋関数のみを提供する。
// VAP Product Developmentは既存実装どおりOPEX（SG&A）であり、本モジュールの
// CAPEX集計には一切含めない（totalCapexUsdとvapProductDevelopmentOpexUsdは
// 常に独立した別フィールド。指示§4「VAP Product DevelopmentをCAPEX扱いしない」）。
//
// 新しい永続SSoTは作らない。呼び出し側（benchmarkスクリプト）が、既存の
// CapexQuarterResult.events / CapitalProject.cumulativePaidUsd 等から集計した
// 「projectType別の支払済み金額」を渡すだけの、集計・分類専用モジュール。

import { CapitalProjectType, CAPITAL_PROJECT_TYPES } from "../../capex/types";

/** 【指示§4】growth（新規能力）・productivity（省人化）・quality（品質）の3分類。 */
export type CapexCategory = "growth" | "productivity" | "quality";

/**
 * 既存CapitalProjectType（capex/types.ts、10種）を機械的に分類する。
 * 新規生産能力を増やすもの（新工場・各ライン・共通前処理・凍結包装・冷蔵）はgrowth、
 * 既存能力の省人化（pdMechanization）はproductivity、品質・環境設備
 * （qualityControlEquipment・environmentalEquipment）はqualityとする。
 * この分類はCAPITAL_PROJECT_TYPESの全10種を過不足なく被覆する（PC1-1で検証）。
 */
export const CAPEX_CATEGORY_BY_PROJECT_TYPE: Readonly<Record<CapitalProjectType, CapexCategory>> = {
  newFactoryConstruction: "growth",
  commonProcessingExpansion: "growth",
  hosoLineExpansion: "growth",
  pdLineExpansion: "growth",
  vapLineExpansion: "growth",
  freezingPackagingExpansion: "growth",
  coldStorageExpansion: "growth",
  pdMechanization: "productivity",
  qualityControlEquipment: "quality",
  environmentalEquipment: "quality",
};

export interface CompanyCapexBreakdown {
  readonly byProjectType: Readonly<Partial<Record<CapitalProjectType, number>>>;
  readonly growthCapexUsd: number;
  readonly productivityCapexUsd: number;
  readonly qualityCapexUsd: number;
  readonly totalCapexUsd: number;
}

const EPSILON = 1e-6;

/**
 * projectType別の支払済み金額（呼び出し側がCapexQuarterResult.events等から集計）から、
 * カテゴリ別内訳を構築する。growthCapexUsd+productivityCapexUsd+qualityCapexUsd は
 * 常にtotalCapexUsdへ一致する（分類が全種を過不足なく被覆するため。PC1-1）。
 */
export function buildCompanyCapexBreakdown(paidUsdByProjectType: Readonly<Partial<Record<CapitalProjectType, number>>>): CompanyCapexBreakdown {
  let growthCapexUsd = 0;
  let productivityCapexUsd = 0;
  let qualityCapexUsd = 0;
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const paidUsd = paidUsdByProjectType[projectType] ?? 0;
    const category = CAPEX_CATEGORY_BY_PROJECT_TYPE[projectType];
    if (category === "growth") growthCapexUsd += paidUsd;
    else if (category === "productivity") productivityCapexUsd += paidUsd;
    else qualityCapexUsd += paidUsd;
  }
  return {
    byProjectType: paidUsdByProjectType,
    growthCapexUsd,
    productivityCapexUsd,
    qualityCapexUsd,
    totalCapexUsd: growthCapexUsd + productivityCapexUsd + qualityCapexUsd,
  };
}

export interface CompanyPortfolioTotals {
  readonly companyId: string;
  readonly capex: CompanyCapexBreakdown;
  /**
   * 【指示§4・§20】VAP Product Developmentは既存会計上OPEX（SG&A、
   * finance/quarterClose.ts）であり、capex.totalCapexUsdには一切含まれない。
   * 常にCAPEXとは独立した別フィールドとして保持する（PC1-2）。
   */
  readonly vapProductDevelopmentOpexUsd: number;
  /**
   * 【指示§26「Product Development equivalent spend %」用】投資構成比の
   * 表示だけを目的とした、CAPEX + VAP Product Development OPEXの合算値。
   * 会計上はCAPEXとOPEXのまま区分されていることに変わりはなく（capex.totalCapexUsdは
   * 不変）、この値はあくまで「資金配分の全体像を100%として見せる」ための
   * 表示専用の合算であることに注意。
   */
  readonly totalInvestmentUsd: number;
}

export function buildCompanyPortfolioTotals(
  companyId: string,
  paidUsdByProjectType: Readonly<Partial<Record<CapitalProjectType, number>>>,
  vapProductDevelopmentOpexUsd: number
): CompanyPortfolioTotals {
  const capex = buildCompanyCapexBreakdown(paidUsdByProjectType);
  return {
    companyId,
    capex,
    vapProductDevelopmentOpexUsd,
    totalInvestmentUsd: capex.totalCapexUsd + vapProductDevelopmentOpexUsd,
  };
}

/** 投資構成比（%）。totalInvestmentUsd=0の場合は全項目0を返す（0除算しない）。 */
export interface InvestmentMixPercent {
  readonly growthCapexPercent: number;
  readonly productivityCapexPercent: number;
  readonly qualityCapexPercent: number;
  readonly vapProductDevelopmentPercent: number;
}

export function computeInvestmentMixPercent(totals: CompanyPortfolioTotals): InvestmentMixPercent {
  const denom = totals.totalInvestmentUsd;
  if (denom <= EPSILON) {
    return { growthCapexPercent: 0, productivityCapexPercent: 0, qualityCapexPercent: 0, vapProductDevelopmentPercent: 0 };
  }
  return {
    growthCapexPercent: (totals.capex.growthCapexUsd / denom) * 100,
    productivityCapexPercent: (totals.capex.productivityCapexUsd / denom) * 100,
    qualityCapexPercent: (totals.capex.qualityCapexUsd / denom) * 100,
    vapProductDevelopmentPercent: (totals.vapProductDevelopmentOpexUsd / denom) * 100,
  };
}
