// ShrimpX V2 — 会社経営統合テスト環境 「名目能力 → 実効能力」の計算過程パネル
//
// プレイヤーからの要望「名目能力から実効能力への計算を説明してください」に対する表示。
// 列構成は 能力プール / 名目能力 / 実効率 / 実効能力 / 主な補正理由 の5列で、
// 折りたたみで補正要因の内訳を出す。
//
// 【このファイルが計算を持たない理由】
//   実効率も実効能力も processingForecastViewModel.buildRateTable が
//   calculateFactoryEffectiveCapacity（エンジン本体の純粋関数）から導出済みである。
//   このコンポーネントは整形のみを行う。
//
// 【禁止事項】
//   - すべての能力プールが一律85.5%であると決め打ちしない（プールごとに
//     CapacityEffectiveRateRow.effectiveRate をそのまま表示する）。
//   - コードに存在しない補正要因（人員充足率・工場保守状態・設備立ち上がり・
//     品質リスク等）を表示しない。実在するのは baseUtilizationRate と
//     equipmentAvailabilityRate の2つだけである。
//   - 値が無い箇所を0で埋めない（NO_VALUE_TEXTを出す）。

import {
  CapacityEffectiveRateTable,
  EFFECTIVE_CAPACITY_FORMULA_TEXT,
} from "../processingForecastViewModel";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS, NO_VALUE_TEXT } from "./panelStyles";

/**
 * 丸めによって「名目能力 × 表示上の実効率 ≠ 表示上の実効能力」に見えないよう、
 * トンは小数1桁、率は小数2桁（パーセント表記）で揃える。エンジンは実効能力を
 * 小数2桁（10kg単位）へ丸めるため、この桁数であれば表示上の検算が一致する。
 */
const TONS_FORMATTER = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const RATE_PERCENT_FORMATTER = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatTons1(value: number): string {
  return `${TONS_FORMATTER.format(value)} t`;
}

function formatRatePercent(value: number | undefined): string {
  if (value === undefined) return NO_VALUE_TEXT;
  return `${RATE_PERCENT_FORMATTER.format(value * 100)}%`;
}

export interface CapacityEffectiveRatePanelProps {
  readonly table: CapacityEffectiveRateTable;
  /** 見出し（会社合計か工場別か）。 */
  readonly title: string;
}

export default function CapacityEffectiveRatePanel(props: CapacityEffectiveRatePanelProps) {
  const { table, title } = props;

  return (
    <div className="space-y-1.5" data-testid={`capacity-effective-rate-${table.factoryId ?? "company"}`}>
      <h4 className="text-xs font-semibold text-gray-300">{title}</h4>
      <p className="text-[11px] text-gray-400">{EFFECTIVE_CAPACITY_FORMULA_TEXT}</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1">能力プール</th>
              <th className="pr-3 py-1">名目能力</th>
              <th className="pr-3 py-1">実効率</th>
              <th className="pr-3 py-1">実効能力</th>
              <th className="pr-3 py-1">主な補正理由</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.poolKey} className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1" title={row.poolDescription}>
                  {row.poolLabel}
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatTons1(row.nominalTons)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatRatePercent(row.effectiveRate)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatTons1(row.effectiveTons)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{row.correctionNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-1">
        <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">実効率の内訳（この画面で実際に掛けている値）</summary>
        <div className="mt-1 space-y-1">
          {table.rows[0] !== undefined && table.rows[0].factors.length > 0 ? (
            <>
              <table className="min-w-full text-xs text-gray-300">
                <thead>
                  <tr className={INFO_TABLE_HEAD_CLASS}>
                    <th className="pr-3 py-1">補正要因</th>
                    <th className="pr-3 py-1">値</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows[0].factors.map((factor) => (
                    <tr key={factor.key} className={INFO_TABLE_ROW_CLASS}>
                      <td className="pr-3 py-1">{factor.label}</td>
                      <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatRatePercent(factor.value)}</td>
                    </tr>
                  ))}
                  <tr className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1 text-gray-200">積（＝実効率）</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatRatePercent(table.rows[0].factorsProduct)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-[11px] text-gray-500">
                実効率を構成する補正要因は、この2つだけです（生産処理エンジンの capacity.ts が
                名目能力へ掛けているのは Factory.baseUtilizationRate と Factory.equipmentAvailabilityRate のみ）。
                人員充足率・保守状態・設備立ち上がり・品質リスクといった補正は、現在のエンジンには存在しません。
                人員の制約は実効能力ではなく、生産配分の段階5（有効労働能力）で別に効きます。
              </p>
              <p className="text-[11px] text-gray-500">
                実効能力はエンジン側で小数2桁（10kg単位）へ丸められるため、この表の実効率は
                「実効能力 ÷ 名目能力」として表示しています（表示上の検算が一致するようにするため）。
              </p>
            </>
          ) : (
            <p className="text-[11px] text-gray-500">
              工場ごとに基準稼働率・設備利用可能率が異なるため、会社合計としての単一の内訳は表示できません。工場別の表をご確認ください。
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
