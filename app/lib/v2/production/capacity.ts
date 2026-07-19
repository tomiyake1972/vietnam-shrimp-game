// ShrimpX V2 — 工場・ワーカー・生産モジュール 工場有効能力（Phase 6）
//
// 工場の名目能力（Factory.*Capacity）に、基準稼働率・設備利用可能率を適用して
// 有効能力を算出する純粋関数。稼働状態が"active"でない工場は、全プールの
// 有効能力を0とする（idle/suspendedの工場は生産に参加しない）。
// 設備増設・工場建設・減価償却（Phase8対象）はここでは一切行わない
// （渡されたFactoryの名目能力をそのまま使うのみ）。

import { hosoEqTons, HosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { Factory, FactoryEffectiveCapacity } from "./types";

function applyRates(nominal: number, baseUtilizationRate: number, equipmentAvailabilityRate: number): HosoEqTons {
  const effective = nominal * baseUtilizationRate * equipmentAvailabilityRate;
  return hosoEqTons(Math.max(0, roundHosoEqTons(effective)));
}

/** 1工場の有効能力（プールごと）を算出する。 */
export function calculateFactoryEffectiveCapacity(factory: Factory): FactoryEffectiveCapacity {
  if (factory.status !== "active") {
    const zero = hosoEqTons(0);
    return {
      factoryId: factory.factoryId,
      companyId: factory.companyId,
      commonProcessing: zero,
      hoso: zero,
      pd: zero,
      vap: zero,
      freezingPackaging: zero,
    };
  }

  const base = unwrapUnit(factory.baseUtilizationRate);
  const avail = unwrapUnit(factory.equipmentAvailabilityRate);

  return {
    factoryId: factory.factoryId,
    companyId: factory.companyId,
    commonProcessing: applyRates(unwrapUnit(factory.commonProcessingCapacity), base, avail),
    hoso: applyRates(unwrapUnit(factory.hosoCapacity), base, avail),
    pd: applyRates(unwrapUnit(factory.pdCapacity), base, avail),
    vap: applyRates(unwrapUnit(factory.vapCapacity), base, avail),
    freezingPackaging: applyRates(unwrapUnit(factory.freezingPackagingCapacity), base, avail),
  };
}

/** 複数工場ぶんの有効能力をまとめて算出する。 */
export function calculateFactoryEffectiveCapacities(factories: readonly Factory[]): readonly FactoryEffectiveCapacity[] {
  return factories.map(calculateFactoryEffectiveCapacity);
}
