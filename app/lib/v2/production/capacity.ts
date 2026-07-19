// ShrimpX V2 — 工場・ワーカー・生産モジュール 工場有効能力（Phase 6、Phase 6.1で単位定義を明確化）
//
// 工場の名目能力（Factory.*Capacity）に、基準稼働率・設備利用可能率を適用して
// 有効能力を算出する純粋関数。稼働状態が"active"でない工場は、全プールの
// 有効能力を0とする（idle/suspendedの工場は生産に参加しない）。
// 設備増設・工場建設・減価償却（Phase8対象）はここでは一切行わない
// （渡されたFactoryの名目能力をそのまま使うのみ）。
//
// 単位についての設計判断（暫定・要校正、Phase 6.1で明確化）:
//   - commonProcessing（共通原料処理能力）は「原料投入HOSO換算量」の上限として
//     扱う（allocation.tsが、原料消費側の制約としてこの値を使う）。
//   - hoso/pd/vap（商品別加工能力）・freezingPackaging（冷凍・包装能力）は
//     「完成品HOSO換算量」の上限として扱う（allocation.tsが、歩留まり適用後の
//     完成品側の制約としてこれらの値を使う）。
//   いずれもHosoEqTonsという同じ単位・同じ基準稼働率/設備利用可能率の適用式を
//   使うため、本ファイル自体の計算ロジックはプール間で変わらない（意味の違いは
//   呼び出し側のallocation.tsが、どちらの段階でこの値を制約として使うかで
//   表現する）。物理歩留まり（physicalYieldRatio）を能力側へ重ねて適用することは
//   しない（二重換算を避ける）。

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
