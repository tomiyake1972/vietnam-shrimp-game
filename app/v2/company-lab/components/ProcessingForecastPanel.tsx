// ShrimpX V2 — 会社経営統合テスト環境 「現在の入力に基づく処理見込み」パネル
//
// プレイヤーからの要望「優先順位による処理見込みを表示してください」に対する表示。
// 生産計画の希望量・優先度・ワーカー配置を変更すると、この表は即時に更新される
// （親コンポーネントがdraftから毎レンダー再計算するため、useStateもuseMemoも不要）。
//
// 【このファイルが計算を持たない理由（最重要）】
//   表示値はすべて processingForecastViewModel.buildCompanyProcessingForecast が
//   生産処理エンジンの純粋関数 allocateProductionPlans をそのまま呼んで得たもの
//   である。UI側に「簡易的な先着配分」などの別計算は存在しない。
//
// 【禁止事項】
//   - 「VAPの処理可能量は約810t」のような、優先度に依存する値を固定文言として書かない。
//   - この表を確定結果として書かない（見出しに「現在の入力に基づく処理見込み」を明示し、
//     注意書き（caveatTexts）を必ず併記する）。
//   - 制約理由をこのファイルで判定・並べ替えしない（エンジンが返した順序をそのまま使う）。
//   - 値が無い箇所を0で埋めない。

import { formatHosoEqTons } from "../../../lib/v2/industryLab/ui/formatters";
import { CompanyProcessingForecast, CONSTRAINT_ORDER_TEXTS } from "../processingForecastViewModel";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS } from "./panelStyles";

export interface ProcessingForecastPanelProps {
  readonly forecast: CompanyProcessingForecast;
}

export default function ProcessingForecastPanel(props: ProcessingForecastPanelProps) {
  const { forecast } = props;

  return (
    <div className="space-y-2" data-testid="processing-forecast-panel">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h4 className="text-xs font-semibold text-gray-200">{forecast.headingText}</h4>
        <span className="text-[11px] text-amber-300">確定結果ではありません</span>
        <span className="text-[11px] text-gray-500">
          利用可能な原料在庫（現時点） {formatHosoEqTons(forecast.availableRawMaterialTons)}
        </span>
      </div>

      {forecast.rows.length === 0 ? (
        <p className="text-[11px] text-gray-500">
          生産希望量が0より大きい生産計画がないため、処理見込みはありません。生産希望量を入力すると、この表に見込みが表示されます。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300" data-testid="processing-forecast-table">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">工場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">生産希望量</th>
                <th className="pr-3 py-1">優先度</th>
                <th className="pr-3 py-1">商品別名目能力</th>
                <th className="pr-3 py-1">商品別実効能力</th>
                <th className="pr-3 py-1">処理見込み量</th>
                <th className="pr-3 py-1">未処理見込み量</th>
                <th className="pr-3 py-1">制約となった能力</th>
              </tr>
            </thead>
            <tbody>
              {forecast.rows.map((row) => (
                <tr key={`${row.factoryId}-${row.product}`} className={INFO_TABLE_ROW_CLASS} data-testid={`processing-forecast-row-${row.product}`}>
                  <td className="pr-3 py-1">{row.factoryId}</td>
                  <td className="pr-3 py-1 uppercase">{row.product}</td>
                  <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHosoEqTons(row.desiredTons)}</td>
                  <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{row.priority}</td>
                  <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHosoEqTons(row.productNominalCapacityTons)}</td>
                  <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHosoEqTons(row.productEffectiveCapacityTons)}</td>
                  <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatHosoEqTons(row.forecastProcessedTons)}</td>
                  <td className={`pr-3 py-1 ${row.forecastUnprocessedTons > 0 ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                    {formatHosoEqTons(row.forecastUnprocessedTons)}
                  </td>
                  <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{row.constraintSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 不足の内訳（主因と補足要因を区別して具体的に示す） */}
      {forecast.rows.some((r) => r.constraints.length > 0) && (
        <div className="space-y-1">
          <h5 className="text-[11px] font-semibold text-gray-300">能力不足の内訳</h5>
          <ul className="space-y-1">
            {forecast.rows
              .filter((r) => r.constraints.length > 0)
              .map((row) => (
                <li key={`${row.factoryId}-${row.product}`} className="text-[11px] text-gray-400">
                  <span className="text-gray-200 uppercase">{row.product}</span>
                  <span className="text-gray-500">（{row.factoryId}）</span>
                  <ul className="ml-4 mt-0.5 space-y-0.5">
                    {row.constraints.map((c) => (
                      <li key={c.reason} className={c.role === "primary" ? "text-amber-300" : "text-gray-400"}>
                        {c.sentence}
                      </li>
                    ))}
                    {row.priorityNote !== undefined && <li className="text-gray-500">{row.priorityNote}</li>}
                  </ul>
                </li>
              ))}
          </ul>
        </div>
      )}

      <details className="mt-1">
        <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">この見込みの計算方法（能力が適用される順序・優先度の扱い）</summary>
        <div className="mt-1 space-y-1">
          <p className="text-[11px] text-gray-400">生産処理エンジンは、次の順序で上限を適用します。</p>
          <ol className="ml-4 space-y-0.5">
            {CONSTRAINT_ORDER_TEXTS.map((text) => (
              <li key={text} className="text-[11px] text-gray-400">
                {text}
              </li>
            ))}
          </ol>
          {forecast.caveatTexts.map((text) => (
            <p key={text} className="text-[11px] text-gray-500">
              {text}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
