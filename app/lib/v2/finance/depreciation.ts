// ShrimpX V2 — 財務モジュール 既存固定資産の減価償却（Phase 8B-2C）
//
// ゲーム開始時点で保有している既存固定資産（capex経由の新規completed資産を除く）
// の減価償却を、単一の四半期定率（旧depreciationRatePerQuarter、実質は取得原価に
// 対する定額10年均等だった）から、建物・機械の2区分へ簡便配分したコンポーネント別
// 定額法へ置き換える。
//
// 【簡略モデルであることの明記】既存資産には個別の取得履歴・取得時期が無いため、
// 精密な固定資産台帳は新設しない。ゲーム開始時点の帳簿価額（=各社の初期
// fixedAssetsGross。より正確には、prev.fixedAssetsGrossのうちcapex経由で完成済み
// の金額を除いた「レガシー」取得原価。呼び出し側のfinance/quarterClose.tsが
// 除外後の値を渡す）を、finance/parameters.tsの共通比率（35%/65%）で建物・機械へ
// 配分し、それぞれ「ゲーム開始時点で残っているとみなす耐用年数」（80四半期・
// 32四半期）で定額償却する。会社別の構成比や残存耐用年数の差は今回実装しない。

import { PeriodV2, toYearQuarter } from "../core/period";
import { FinanceParameters } from "./parameters";

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/** 既存資産1社ぶんの、建物・機械コンポーネント別の当期減価償却費。 */
export interface ExistingAssetDepreciation {
  readonly buildingUsd: number;
  readonly machineryUsd: number;
  readonly totalUsd: number;
}

/**
 * ゲーム開始時点の既存固定資産帳簿価額（openingGrossUsd）を建物・機械へ簡便配分し、
 * それぞれの推定残存耐用年数で定額償却した当期分を算出する。
 *   - buildingは経過四半期数がbuildingRemainingLifeQuartersAtGameStartを超えると0。
 *   - machineryは経過四半期数がmachineryRemainingLifeQuartersAtGameStartを超えると0
 *     （buildingより先に償却終了することが多く、その後もbuildingの償却だけが続く）。
 *   - 累計償却は各コンポーネントの配分額（openingGrossUsd×該当ratio）を厳密に
 *     超えない（耐用年数ぶんちょうど計上して打ち切るため）。
 *   - gameStartPeriod当四半期そのものが償却1期目（elapsedQuarters=1）。既存資産は
 *     新規capex資産と異なり、ゲーム開始と同時に（未来の稼働開始四半期を待たず）
 *     償却が始まる。
 */
export function computeExistingAssetDepreciationUsd(
  openingGrossUsd: number,
  gameStartPeriod: PeriodV2,
  currentPeriod: PeriodV2,
  params: FinanceParameters
): ExistingAssetDepreciation {
  const cfg = params.finance.existingAssetDepreciation;
  const buildingOpeningUsd = openingGrossUsd * cfg.buildingOpeningRatio;
  const machineryOpeningUsd = openingGrossUsd * cfg.machineryOpeningRatio;
  const elapsedQuarters = quartersBetween(gameStartPeriod, currentPeriod) + 1;

  const buildingUsd =
    elapsedQuarters <= cfg.buildingRemainingLifeQuartersAtGameStart ? buildingOpeningUsd / cfg.buildingRemainingLifeQuartersAtGameStart : 0;
  const machineryUsd =
    elapsedQuarters <= cfg.machineryRemainingLifeQuartersAtGameStart ? machineryOpeningUsd / cfg.machineryRemainingLifeQuartersAtGameStart : 0;

  return { buildingUsd, machineryUsd, totalUsd: buildingUsd + machineryUsd };
}
