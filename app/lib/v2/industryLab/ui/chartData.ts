// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） グラフ用データ変換
//
// IndustryQuarterRecord[]（シミュレーションエンジンがすでに計算した結果）から、
// グラフ描画に必要な系列データを取り出すだけの純粋関数。価格・需給の計算は
// 一切行わない（実装指示 §8・§9「価格計算をUI内で再実装しないこと」）。

import { unwrapUnit } from "../../core/units";
import { IndustryQuarterRecord } from "../types";

export interface HosoPriceSeriesPoint {
  readonly turn: number;
  readonly periodLabel: string;
  readonly EC: number;
  readonly IN: number;
  readonly ID: number;
  readonly VN: number;
}

/** 国別HOSO FOB価格の四半期推移（実装指示 §7「国際HOSO基準価格が明示されない場合は国別価格を並べる」）。 */
export function buildHosoPriceSeries(quarters: readonly IndustryQuarterRecord[]): readonly HosoPriceSeriesPoint[] {
  return quarters.map((q) => ({
    turn: q.turn,
    periodLabel: q.periodLabel,
    EC: unwrapUnit(q.marketResult.hosoPrices.EC.price),
    IN: unwrapUnit(q.marketResult.hosoPrices.IN.price),
    ID: unwrapUnit(q.marketResult.hosoPrices.ID.price),
    VN: unwrapUnit(q.marketResult.hosoPrices.VN.price),
  }));
}

export interface VietnamDomesticPriceSeriesPoint {
  readonly turn: number;
  readonly periodLabel: string;
  readonly price: number;
}

export function buildVietnamDomesticPriceSeries(
  quarters: readonly IndustryQuarterRecord[]
): readonly VietnamDomesticPriceSeriesPoint[] {
  return quarters.map((q) => ({
    turn: q.turn,
    periodLabel: q.periodLabel,
    price: unwrapUnit(q.marketResult.vietnamDomestic.price),
  }));
}

export interface PremiumSeriesPoint {
  readonly turn: number;
  readonly periodLabel: string;
  readonly pdPremium: number;
  readonly vapPremium: number;
}

export function buildPremiumSeries(quarters: readonly IndustryQuarterRecord[]): readonly PremiumSeriesPoint[] {
  return quarters.map((q) => ({
    turn: q.turn,
    periodLabel: q.periodLabel,
    pdPremium: unwrapUnit(q.marketResult.pdPremium.basePremium),
    vapPremium: unwrapUnit(q.marketResult.vapPremium.basePremium),
  }));
}

export interface SupplyDemandSeriesPoint {
  readonly turn: number;
  readonly periodLabel: string;
  readonly worldSupply: number;
  readonly worldDemand: number;
  readonly balance: number;
}

export function buildSupplyDemandSeries(quarters: readonly IndustryQuarterRecord[]): readonly SupplyDemandSeriesPoint[] {
  return quarters.map((q) => ({
    turn: q.turn,
    periodLabel: q.periodLabel,
    worldSupply: unwrapUnit(q.marketResult.worldSupply),
    worldDemand: unwrapUnit(q.marketResult.worldDemand),
    balance: q.marketResult.worldSupplyDemandBalance,
  }));
}

export interface CountrySupplySeriesPoint {
  readonly turn: number;
  readonly periodLabel: string;
  readonly EC: number;
  readonly IN: number;
  readonly ID: number;
  readonly VN: number;
}

/** 国別の輸出可能供給量（exportableSupply）の四半期推移。 */
export function buildCountrySupplySeries(quarters: readonly IndustryQuarterRecord[]): readonly CountrySupplySeriesPoint[] {
  return quarters.map((q) => ({
    turn: q.turn,
    periodLabel: q.periodLabel,
    EC: unwrapUnit(q.marketResult.hosoPrices.EC.exportableSupply),
    IN: unwrapUnit(q.marketResult.hosoPrices.IN.exportableSupply),
    ID: unwrapUnit(q.marketResult.hosoPrices.ID.exportableSupply),
    VN: unwrapUnit(q.marketResult.hosoPrices.VN.exportableSupply),
  }));
}

export interface MarketDemandSeriesPoint {
  readonly turn: number;
  readonly periodLabel: string;
  readonly CN: number;
  readonly US: number;
  readonly EU: number;
  readonly JP: number;
  readonly OTHER: number;
}

/** 市場別（需要側）の当期需要（marketInputの入力値。市場モジュールの結果を再計算しない）。 */
export function buildMarketDemandSeries(quarters: readonly IndustryQuarterRecord[]): readonly MarketDemandSeriesPoint[] {
  return quarters.map((q) => ({
    turn: q.turn,
    periodLabel: q.periodLabel,
    CN: unwrapUnit(q.marketInput.demandMarkets.CN.priorPeriodConsumption),
    US: unwrapUnit(q.marketInput.demandMarkets.US.priorPeriodConsumption),
    EU: unwrapUnit(q.marketInput.demandMarkets.EU.priorPeriodConsumption),
    JP: unwrapUnit(q.marketInput.demandMarkets.JP.priorPeriodConsumption),
    OTHER: unwrapUnit(q.marketInput.demandMarkets.OTHER.priorPeriodConsumption),
  }));
}
