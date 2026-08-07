// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 納期観測（Phase 7A）
//
// 当期の契約状態（履行適用・納期超過処理まで終えた後のSalesContract[]）から、
// 会社×市場ぶんの納期観測を集計する純粋関数。
//   - dueQuantity（当期の評価対象コホート）は dueDate === currentPeriod の契約
//     だけを対象とする（過年度からの持ち越し未履行を毎期新しい失敗として
//     無制限に重複加算しないため）。
//   - dueDate < currentPeriod で当期末もなお未履行（status="overdue"）の数量は
//     continuingOverdueQuantityとして別集計し、scoreUpdates.tsの小さな追加
//     ペナルティにのみ使う（メインのonTime比率には混ぜない）。

import { hosoEqTons, unwrapUnit } from "../core/units";
import { PeriodV2 } from "../core/period";
import { DemandMarketId } from "../market/types";
import { CompanyId, SalesContract } from "../sales/types";
import { MarketDeliveryObservation } from "./types";

/** 会社IDと市場の組み合わせキー。 */
function key(companyId: string, market: string): string {
  return `${companyId}::${market}`;
}

/**
 * 履行適用・納期超過処理まで終えたcontractsAfterから、会社×市場ぶんの
 * 納期観測を組み立てる（純粋関数、入力は変更しない）。
 * companyMarketPairsに含まれる組み合わせは、当期dueQuantity=0でも観測を
 * 返す（値は全て0。呼び出し側がdueQuantity>0かどうかで更新要否を判断する）。
 */
export function computeMarketDeliveryObservations(
  companyMarketPairs: readonly { readonly companyId: CompanyId; readonly market: DemandMarketId }[],
  contractsAfter: readonly SalesContract[],
  currentPeriod: PeriodV2
): readonly MarketDeliveryObservation[] {
  const dueQuantityByKey = new Map<string, number>();
  const onTimeByKey = new Map<string, number>();
  const newlyOverdueByKey = new Map<string, number>();
  const continuingOverdueByKey = new Map<string, number>();

  for (const c of contractsAfter) {
    const k = key(c.companyId, c.market);
    if (c.dueDate === currentPeriod) {
      const original = unwrapUnit(c.originalQuantity);
      dueQuantityByKey.set(k, (dueQuantityByKey.get(k) ?? 0) + original);
      if (c.status === "fulfilled") {
        onTimeByKey.set(k, (onTimeByKey.get(k) ?? 0) + original);
      } else if (c.status === "overdue") {
        newlyOverdueByKey.set(k, (newlyOverdueByKey.get(k) ?? 0) + unwrapUnit(c.outstandingQuantity));
      }
      // "partiallyFulfilled"のまま当期末を迎えることは基本的にない
      // （updateContractStatusesForQuarterEndがdueDate<=当期かつoutstanding>0を
      // overdueへ遷移させるため）が、念のため両方に該当しない場合は
      // どちらにも加算しない（unresolvedな中間状態は上位のバグとして
      // テストで検出させる）。
    } else if (c.dueDate < currentPeriod && c.status === "overdue") {
      continuingOverdueByKey.set(k, (continuingOverdueByKey.get(k) ?? 0) + unwrapUnit(c.outstandingQuantity));
    }
  }

  return companyMarketPairs.map(({ companyId, market }) => {
    const k = key(companyId, market);
    return {
      companyId,
      market,
      dueQuantity: hosoEqTons(dueQuantityByKey.get(k) ?? 0),
      onTimeQuantity: hosoEqTons(onTimeByKey.get(k) ?? 0),
      newlyOverdueQuantity: hosoEqTons(newlyOverdueByKey.get(k) ?? 0),
      continuingOverdueQuantity: hosoEqTons(continuingOverdueByKey.get(k) ?? 0),
    };
  });
}
