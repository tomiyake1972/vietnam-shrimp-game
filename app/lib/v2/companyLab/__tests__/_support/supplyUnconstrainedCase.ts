// ShrimpX V2 — テスト support: 「供給側が制約になっていない世界」を作る
//
// 【なぜ必要か（2026-08-09・Test16 Stage E）】
// SAI-5因果(1b) が守りたいのは
//
//   「他条件が同じ、かつ供給制約が binding していない条件では、
//     営業基盤が高い会社ほど成約獲得力が高い」
//
// という因果である。ところが Stage E で商品集中生産効率を導入した結果、
// 特定商品へ集中した会社は必要Workerが減って供給余力を得るため、
// 営業基盤が弱くても成約を取れるようになった。
// 供給側の差が営業側の因果を覆い隠してしまい、この命題が観測できなくなる。
//
// そこで、このテストには**供給側が誰にとっても制約でない世界**を与え、
// 営業基盤だけが主要な差分になるようにする。
//
// 【何を同等にするか】
//   ・原料      … 毎ターン十分量を積み増す（誰も原料で詰まらない）
//   ・設備能力  … 全社・全商品を同一の大きな値にする
//   ・Worker    … 全社・全工場を同一の大きな人数・同一技能・同一出勤率にする
//   ・商品構成  … 上記により全社が同じ供給条件になる
//   ・集中条件  … 能力・人員が同一なので、同じ数量なら同じ集中係数が掛かる
//
// 【ゲームのパラメータ・エンジンには触れない】
// fixture と state を差し替えるだけの純粋な変換である。
// 集中効果そのものは**有効なまま**であり、無効化して因果を通しているのではない。
// 全社に同じ条件で掛かるため、会社間の差分にならないだけである。

import { CompanyFixture, CompanyLabState } from "../../types";
import { buildInitialWorkforceState } from "../../workforce";
import { RawMaterialLot } from "../../../rawMaterials/types";
import { hosoEqTons, usdPerHosoEqKg, ratio as asRatio } from "../../../core/units";

/** 全社共通の設備能力（十分に大きく、誰も設備で詰まらない水準）。 */
export const SUPPLY_UNCONSTRAINED_CAPACITY_TONS = 60_000;
/** 全社・全工場共通の常用ワーカー数。 */
export const SUPPLY_UNCONSTRAINED_REGULAR_HEADCOUNT = 20_000;
/** 毎ターン各社へ積み増す使用可能原料（トン）。 */
export const SUPPLY_UNCONSTRAINED_RAW_TOPUP_TONS = 200_000;
/** 積み増しロットの単価（相場並みに置き、原価を歪めない）。 */
const RAW_TOPUP_UNIT_COST = 4.2;

/**
 * fixture の設備能力・ワーカー基準を全社同一の潤沢な値へ揃える。
 * 会社間で差が残ると、それ自体が成約差の原因になってしまうため同一にする。
 */
export function asSupplyUnconstrainedFixtures(fixtures: readonly CompanyFixture[]): readonly CompanyFixture[] {
  const cap = hosoEqTons(SUPPLY_UNCONSTRAINED_CAPACITY_TONS);
  return fixtures.map((f) => ({
    ...f,
    factories: f.factories.map((factory) => ({
      ...factory,
      hosoCapacity: cap,
      pdCapacity: cap,
      vapCapacity: cap,
      commonProcessingCapacity: cap,
      freezingPackagingCapacity: cap,
    })),
    workerBaseline: f.workerBaseline.map((w) => ({
      ...w,
      regularHeadcount: SUPPLY_UNCONSTRAINED_REGULAR_HEADCOUNT,
      attendanceRate: asRatio(1),
      skills: w.skills.map((s) => ({ ...s, skillLevel: asRatio(1) })),
    })),
  }));
}

/**
 * その四半期に使える原料を全社へ十分量積み増した state を返す。
 * 既存ロットは消さない（消費・期限切れの通常挙動はそのまま）。
 * 各ターンの開始時に呼ぶこと。
 */
export function withSufficientRawMaterial(state: CompanyLabState, companyIds: readonly string[], turn: number): CompanyLabState {
  const topups: RawMaterialLot[] = companyIds.map((companyId) => ({
    lotId: `${companyId}-SUPPLY-UNCONSTRAINED-T${turn}`,
    companyId: companyId as RawMaterialLot["companyId"],
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: state.currentPeriod,
    originalQuantity: hosoEqTons(SUPPLY_UNCONSTRAINED_RAW_TOPUP_TONS),
    remainingQuantity: hosoEqTons(SUPPLY_UNCONSTRAINED_RAW_TOPUP_TONS),
    unitCost: usdPerHosoEqKg(RAW_TOPUP_UNIT_COST),
    availableFromPeriod: state.currentPeriod,
    status: "available",
  }));
  return { ...state, rawMaterialLots: [...state.rawMaterialLots, ...topups] };
}

/**
 * state 側のワーカー人数も潤沢な fixture に合わせて作り直す。
 *
 * workforceState は initializeCompanyLab の時点で fixture から写されるため、
 * 初期化**後**に fixture を差し替えても state 側は古い人数のままになる。
 * asSalesShortageCase が salesForceHiringState を作り直すのと同じ理由。
 */
export function asSupplyUnconstrainedState(state: CompanyLabState, fixtures: readonly CompanyFixture[]): CompanyLabState {
  return { ...state, workforceState: buildInitialWorkforceState(fixtures) };
}
