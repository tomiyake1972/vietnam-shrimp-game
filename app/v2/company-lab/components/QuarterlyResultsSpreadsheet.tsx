// ShrimpX V2 — Phase 8G §6 四半期結果のスプレッドシート型UI
//
// 【計算ロジックを一切持たない】
//   quarterlyResultsSpreadsheetViewModel.tsが既存の確定値（CompanyQuarterSummary・
//   CompanyFinancialQuarterResult）から抽出しただけの行データを、指標を行・
//   四半期(turn)を列とした表（スプレッドシート型）へ並べ替えて表示するだけ。
//   このコンポーネント自身は数値を一切計算・加工しない（既存formattersでの
//   単位表示フォーマットのみ）。
//
// 【表の向きについて】
//   既存のadminExport（companyLabAdminExcelBuilder.ts）は「指標名を1列目、
//   値をもう1列」という単一四半期ぶんのレイアウトのみで、複数四半期を並べる
//   既存の型は無かったため、その列レイアウトを踏襲しつつ「四半期ごとに列を
//   増やす」形（指標＝行、turn＝列）で拡張した。

import { QuarterlyResultsSpreadsheetRow } from "../quarterlyResultsSpreadsheetViewModel";
import { formatHosoEqTons, formatRatioAsPercent, formatUsd, formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";
import { NO_VALUE_TEXT } from "./panelStyles";

interface QuarterlyResultsSpreadsheetProps {
  readonly rows: readonly QuarterlyResultsSpreadsheetRow[];
}

interface MetricDef {
  readonly key: string;
  readonly label: string;
  readonly format: (row: QuarterlyResultsSpreadsheetRow) => string;
}

const METRICS: readonly MetricDef[] = [
  { key: "newContractedQuantity", label: "新規成約数量", format: (r) => formatHosoEqTons(r.newContractedQuantity) },
  { key: "newContractedAveragePrice", label: "新規成約平均単価", format: (r) => formatUsdPerHosoEqKg(r.newContractedAveragePrice) },
  { key: "fulfilledQuantity", label: "履行数量", format: (r) => formatHosoEqTons(r.fulfilledQuantity) },
  { key: "outstandingQuantity", label: "未履行残", format: (r) => formatHosoEqTons(r.outstandingQuantity) },
  { key: "overdueQuantity", label: "延滞数量", format: (r) => formatHosoEqTons(r.overdueQuantity) },
  { key: "domesticPurchaseQuantity", label: "国内買付量", format: (r) => formatHosoEqTons(r.domesticPurchaseQuantity) },
  { key: "domesticPurchasePrice", label: "国内買付価格", format: (r) => formatUsdPerHosoEqKg(r.domesticPurchasePrice) },
  { key: "importInTransitQuantity", label: "輸入中", format: (r) => formatHosoEqTons(r.importInTransitQuantity) },
  { key: "importArrivedQuantity", label: "輸入到着", format: (r) => formatHosoEqTons(r.importArrivedQuantity) },
  { key: "rawMaterialInventory", label: "原料在庫", format: (r) => formatHosoEqTons(r.rawMaterialInventory) },
  { key: "hosoProduced", label: "HOSO生産量", format: (r) => formatHosoEqTons(r.hosoProduced) },
  { key: "pdProduced", label: "PD生産量", format: (r) => formatHosoEqTons(r.pdProduced) },
  { key: "vapProduced", label: "VAP生産量", format: (r) => formatHosoEqTons(r.vapProduced) },
  { key: "finishedGoodsInventory", label: "完成品在庫", format: (r) => formatHosoEqTons(r.finishedGoodsInventory) },
  { key: "equipmentUtilizationRate", label: "設備稼働率", format: (r) => formatRatioAsPercent(r.equipmentUtilizationRate) },
  { key: "laborUtilizationRate", label: "労務稼働率", format: (r) => formatRatioAsPercent(r.laborUtilizationRate) },
  { key: "netRevenue", label: "純売上高", format: (r) => (r.netRevenue === null ? NO_VALUE_TEXT : formatUsd(r.netRevenue)) },
  { key: "operatingProfit", label: "営業利益", format: (r) => (r.operatingProfit === null ? NO_VALUE_TEXT : formatUsd(r.operatingProfit)) },
  { key: "netIncome", label: "当期純利益", format: (r) => (r.netIncome === null ? NO_VALUE_TEXT : formatUsd(r.netIncome)) },
  { key: "closingCash", label: "期末現金", format: (r) => (r.closingCash === null ? NO_VALUE_TEXT : formatUsd(r.closingCash)) },
];

export default function QuarterlyResultsSpreadsheet(props: QuarterlyResultsSpreadsheetProps) {
  const { rows } = props;

  if (rows.length === 0) {
    return <p className="text-xs text-gray-400">{NO_VALUE_TEXT} まだ確定した四半期結果がありません。</p>;
  }

  return (
    <div className="overflow-x-auto" data-testid="quarterly-results-spreadsheet">
      <table className="min-w-full text-xs text-gray-300 border-collapse">
        <thead>
          <tr className="text-gray-400 text-left">
            <th className="sticky left-0 bg-gray-800 pr-3 py-1 font-medium whitespace-nowrap">指標</th>
            {rows.map((r) => (
              <th key={r.turn} className="pr-3 py-1 font-medium whitespace-nowrap text-right">
                turn {r.turn}
                <div className="text-[10px] text-gray-500 font-normal">{r.period}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRICS.map((metric) => (
            <tr key={metric.key} className="border-t border-gray-700/60">
              <td className="sticky left-0 bg-gray-800 pr-3 py-1 font-semibold text-gray-100 whitespace-nowrap">{metric.label}</td>
              {rows.map((r) => (
                <td key={r.turn} className="pr-3 py-1 whitespace-nowrap text-right">
                  {metric.format(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
