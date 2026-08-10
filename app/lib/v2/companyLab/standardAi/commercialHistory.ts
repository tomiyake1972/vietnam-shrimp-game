// ShrimpX V2 — Phase 6C: 自社の商業実績履歴（提出 → 成約 の転換率観測）
//
// 【なぜ必要か（#05 Phase 6C §7）】
// Standard AI は「20,000t 提出して 14,000t しか成約しなかった」という自社の
// 実績を、次の四半期の判断へ持ち込めなければならない。ところが Standard AI の
// 意思決定は純粋関数であり、四半期をまたぐ記憶を持たない。
//
// 【設計】
//   - 記憶するのは **自社が提出した販売計画** だけ（自社の意思決定履歴であり、
//     ゲーム側の秘匿情報でも未来情報でもない）。
//   - 成約実績は ownState.contracts（自社の契約台帳）から、契約四半期で
//     突き合わせて求める。新しいゲーム状態は一切追加しない。
//   - 記憶の保持は createStandardAiProvider（実行単位）が行い、意思決定関数へは
//     **引数として渡す**。これにより generateStandardAiDecisionWithDiagnostics は
//     引き続き純粋関数（同一入力→同一出力）である。
//
// 【未来 TRUE WORLD の禁止】ここで参照するのは「過去に自分が出した計画」と
// 「過去に自分が取った契約」だけである。市場の真の需要も、他社の計画も見ない。

import { PeriodV2 } from "../../core/period";
import { DemandMarketId } from "../../market/types";
import { SalesContract } from "../../sales/types";
import { unwrapUnit } from "../../core/units";
import type { CommercialSubmissionRecord } from "../commercialHistoryState";

const EPSILON = 1e-6;

/** 1社ぶんの商業実績履歴（直近から遡って保持する）。 */
export interface CommercialHistory {
  readonly records: readonly CommercialSubmissionRecord[];
}

export const EMPTY_COMMERCIAL_HISTORY: CommercialHistory = { records: [] };

/** 転換率の観測に使う直近四半期数。短すぎると雑音を拾い、長すぎると学習が遅い。 */
export const CONVERSION_OBSERVATION_QUARTERS = 4;

export interface ConversionObservation {
  /** 観測に使った四半期数（0 なら履歴なし）。 */
  readonly observedQuarters: number;
  readonly submittedTons: number;
  readonly contractedTons: number;
  /**
   * 観測された転換率（成約 ÷ 提出）。履歴が無い場合は null。
   * **null を 1.0 と読み替えないこと**（呼び出し側が「未知」を明示的に扱う）。
   */
  readonly conversionRatio: number | null;
  /** 市場別の転換率（観測できた市場のみ）。 */
  readonly conversionRatioByMarket: ReadonlyMap<DemandMarketId, number>;
}

export const NO_CONVERSION_OBSERVATION: ConversionObservation = {
  observedQuarters: 0,
  submittedTons: 0,
  contractedTons: 0,
  conversionRatio: null,
  conversionRatioByMarket: new Map(),
};

function samePeriod(a: PeriodV2, b: PeriodV2): boolean {
  // PeriodV2 は "YYYYQn" 形式のブランド付き文字列（core/period.ts）。
  return a === b;
}

/**
 * 直近 N 四半期の「提出 → 成約」転換率を観測する。
 *
 * 成約側は contracts の originalQuantity（成約時点の数量）を使う。
 * outstandingQuantity は履行によって減るため、転換率の観測には使えない。
 */
export function observeContractConversion(
  history: CommercialHistory,
  contracts: readonly SalesContract[],
  currentTurn: number,
  quarters: number = CONVERSION_OBSERVATION_QUARTERS
): ConversionObservation {
  const recent = history.records.filter((r) => r.turn < currentTurn).slice(-Math.max(1, quarters));
  if (recent.length === 0) return NO_CONVERSION_OBSERVATION;

  let submittedTons = 0;
  let contractedTons = 0;
  const submittedByMarket = new Map<DemandMarketId, number>();
  const contractedByMarket = new Map<DemandMarketId, number>();

  for (const record of recent) {
    submittedTons += record.submittedTotalTons;
    for (const cell of record.submittedByMarketProduct) {
      submittedByMarket.set(cell.market, (submittedByMarket.get(cell.market) ?? 0) + cell.tons);
    }
    for (const contract of contracts) {
      if (!samePeriod(contract.contractedPeriod, record.period)) continue;
      const tons = unwrapUnit(contract.originalQuantity);
      contractedTons += tons;
      contractedByMarket.set(contract.market, (contractedByMarket.get(contract.market) ?? 0) + tons);
    }
  }

  const conversionRatioByMarket = new Map<DemandMarketId, number>();
  for (const [market, submitted] of submittedByMarket) {
    if (submitted <= EPSILON) continue;
    conversionRatioByMarket.set(market, (contractedByMarket.get(market) ?? 0) / submitted);
  }

  return {
    observedQuarters: recent.length,
    submittedTons,
    contractedTons,
    conversionRatio: submittedTons > EPSILON ? contractedTons / submittedTons : null,
    conversionRatioByMarket,
  };
}
