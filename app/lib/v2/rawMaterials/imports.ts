// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 輸入原料（Phase 5）
//
// 会社は原産国別に輸入注文を出せる。着地価格はPhase1の国別HOSO FOB価格
// （原則変更しない）に、運賃・関税諸税・保険取扱費・原産国別調整額（すべて
// 設定可能）を加えて算出する。輸入注文は発注時点では在庫にせず、輸送中の
// ロット（status="inTransitImport"）として保持し、到着四半期にのみ
// status="available"へ遷移する。原産国別供給上限を超える注文は決定論的
// （会社間の按分）に配分し、5社の輸入量では国際基準価格を一切変更しない
// （Phase1のexportableSupply・allocatedDemandへは書き戻さない）。

import { nextPeriod, PeriodV2 } from "../core/period";
import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, roundHosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { CountryId } from "../market/types";
import { CompanyId, ImportLandedPriceBreakdown, ImportOrderInput, RawMaterialLot, RawMaterialsValidationError } from "./types";
import { RawMaterialsParameters } from "./parameters";
import { waterFillAllocate } from "./waterFill";
import { buildLotId } from "./inventoryIds";

/**
 * 輸入着地価格を、Phase1の当該国HOSO FOB価格（originPrice）から算出する。
 * landedPrice = originPrice × (1 + dutyRatio) + freight + insurance + 原産国別調整額
 * （原産国別調整額はマイナスもあり得るため、最終的に0未満にはならないよう
 * Math.maxで下限0にクランプする）。
 */
export function calculateLandedPrice(originPrice: UsdPerHosoEqKg, originCountry: CountryId, params: RawMaterialsParameters): ImportLandedPriceBreakdown {
  const imp = params.imports;
  const origin = unwrapUnit(originPrice);
  const dutyAndTax = origin * imp.dutyRatio;
  const freight = imp.freightUsdPerHosoEqKg;
  const insurance = imp.insuranceHandlingUsdPerHosoEqKg;
  const adjustment = imp.originCountryAdjustmentUsdPerHosoEqKg[originCountry] ?? 0;
  const landed = Math.max(0, origin + dutyAndTax + freight + insurance + adjustment);

  return {
    originPrice,
    freightUsdPerHosoEqKg: freight,
    dutyAndTaxUsdPerHosoEqKg: dutyAndTax,
    insuranceAndHandlingUsdPerHosoEqKg: insurance,
    originCountryAdjustmentUsdPerHosoEqKg: adjustment,
    landedPrice: usdPerHosoEqKg(landed),
  };
}

function resolveArrivalPeriod(orderedPeriod: PeriodV2, leadTimeTurns: number): PeriodV2 {
  if (!Number.isInteger(leadTimeTurns) || leadTimeTurns < 1) {
    throw new RawMaterialsValidationError(`輸入リードタイムは1以上の整数である必要があります。受け取った値: ${leadTimeTurns}`);
  }
  let due = orderedPeriod;
  for (let i = 0; i < leadTimeTurns; i++) {
    due = nextPeriod(due);
  }
  return due;
}

interface PreparedOrder {
  readonly order: ImportOrderInput;
  readonly breakdown: ImportLandedPriceBreakdown;
  readonly arrivalPeriod: PeriodV2;
  readonly key: string;
}

/**
 * 輸入注文一式から、原産国別供給上限を適用したうえで「輸送中」状態の
 * 原料ロットを生成する。5社の注文合計が原産国の供給上限
 * （originExportableSupply[country] × importAvailableSupplyRatio）を超えた
 * 場合、決定論的（会社×原産国×発注四半期の要求量に比例した水位法）に配分する。
 * 入力配列の順序には一切依存しない。
 *
 * 【調達規模効果】国際HOSO基準価格（originHosoFobPrice）・着地価格の計算式自体は
 * 一切変更しない。discountRatioByCompany（会社別・輸入チャネルの割引率、0〜1）が
 * 指定された場合のみ、着地価格確定後にロットのunitCostへ(1-discountRatio)を
 * 乗じて、会社別の実効仕入原価として記録する（未指定時は従来どおり）。
 */
export function createImportLots(
  orders: readonly ImportOrderInput[],
  originHosoFobPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>,
  originExportableSupply: Readonly<Record<CountryId, HosoEqTons>>,
  params: RawMaterialsParameters,
  discountRatioByCompany?: ReadonlyMap<CompanyId, number>
): readonly RawMaterialLot[] {
  const prepared: PreparedOrder[] = [...orders]
    .sort((a, b) => {
      if (a.companyId !== b.companyId) return a.companyId.localeCompare(b.companyId);
      if (a.originCountry !== b.originCountry) return a.originCountry.localeCompare(b.originCountry);
      return a.orderedPeriod.localeCompare(b.orderedPeriod);
    })
    .map((order) => {
      if (!Number.isFinite(unwrapUnit(order.orderedQuantity)) || unwrapUnit(order.orderedQuantity) <= 0) {
        throw new RawMaterialsValidationError(`会社 "${order.companyId}" の輸入注文数量は正の数である必要があります。`);
      }
      const leadTimeTurns = order.leadTimeTurns ?? params.imports.standardLeadTimeTurns;
      const arrivalPeriod = resolveArrivalPeriod(order.orderedPeriod, leadTimeTurns);
      const breakdown = calculateLandedPrice(originHosoFobPrice[order.originCountry], order.originCountry, params);

      if (order.maxLandedPriceUsdPerHosoEqKg !== undefined && unwrapUnit(breakdown.landedPrice) > unwrapUnit(order.maxLandedPriceUsdPerHosoEqKg) + 1e-9) {
        throw new RawMaterialsValidationError(
          `会社 "${order.companyId}" の輸入注文（原産国 "${order.originCountry}"）の着地価格 ${unwrapUnit(breakdown.landedPrice)} が、注文の最大許容着地価格 ${unwrapUnit(order.maxLandedPriceUsdPerHosoEqKg)} を超えています（注文条件不成立）。`
        );
      }

      return { order, breakdown, arrivalPeriod, key: `${order.companyId}::${order.originCountry}::${order.orderedPeriod}` };
    });

  // 原産国ごとに供給上限を適用する（会社ごとの注文を参加者として水位法で配分）。
  const byCountry = new Map<CountryId, PreparedOrder[]>();
  for (const p of prepared) {
    const list = byCountry.get(p.order.originCountry) ?? [];
    list.push(p);
    byCountry.set(p.order.originCountry, list);
  }

  const allocatedQuantityByOrderKey = new Map<string, number>();
  for (const [country, ordersForCountry] of byCountry) {
    const cap = unwrapUnit(originExportableSupply[country]) * params.imports.importAvailableSupplyRatio;
    const participants = ordersForCountry.map((p, index) => ({
      id: `${p.key}::${index}`,
      weight: unwrapUnit(p.order.orderedQuantity),
      cap: unwrapUnit(p.order.orderedQuantity),
    }));
    const { allocated } = waterFillAllocate(participants, cap);
    ordersForCountry.forEach((p, index) => {
      allocatedQuantityByOrderKey.set(`${p.key}::${index}`, allocated.get(`${p.key}::${index}`) ?? 0);
    });
  }

  const lots: RawMaterialLot[] = [];
  let sequence = 0;
  for (const [, ordersForCountry] of byCountry) {
    ordersForCountry.forEach((p, index) => {
      const allocatedQuantity = roundHosoEqTons(Math.max(0, allocatedQuantityByOrderKey.get(`${p.key}::${index}`) ?? 0));
      if (allocatedQuantity <= 0) return;
      sequence += 1;
      const lotId = buildLotId("import", p.order.companyId, p.order.orderedPeriod, p.order.originCountry, sequence);
      const discountRatio = Math.max(0, Math.min(1, discountRatioByCompany?.get(p.order.companyId) ?? 0));
      const unitCost = usdPerHosoEqKg(unwrapUnit(p.breakdown.landedPrice) * (1 - discountRatio));
      lots.push({
        lotId,
        companyId: p.order.companyId,
        source: "import",
        originCountry: p.order.originCountry,
        inboundPeriod: p.order.orderedPeriod,
        originalQuantity: hosoEqTons(allocatedQuantity),
        remainingQuantity: hosoEqTons(allocatedQuantity),
        unitCost,
        availableFromPeriod: p.arrivalPeriod,
        status: "inTransitImport",
      });
    });
  }

  return lots.sort((a, b) => a.lotId.localeCompare(b.lotId));
}

/**
 * currentPeriod時点で到着済み（availableFromPeriod <= currentPeriod）の
 * "inTransitImport" ロットを "available" へ遷移させる（不変更新）。
 */
export function receiveArrivedImports(lots: readonly RawMaterialLot[], currentPeriod: PeriodV2): readonly RawMaterialLot[] {
  return lots.map((lot) => {
    if (lot.source !== "import" || lot.status !== "inTransitImport") return lot;
    if (lot.availableFromPeriod.localeCompare(currentPeriod) > 0) return lot;
    return { ...lot, status: "available" as const };
  });
}
