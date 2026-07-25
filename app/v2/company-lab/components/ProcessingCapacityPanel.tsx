// ShrimpX V2 — 会社経営統合テスト環境 工場加工能力パネル（現時点の能力＋現在追加中の能力）
//
// プレイヤーからの要望「各加工能力と、現在追加中（つまり設備投資を意思決定して
// これから加わる能力）がわかるようにしてください」に対する意思決定画面側の表示。
//
// 表示する値はすべて processingCapacityViewModel.ts が
// applyCapexCapacityToFactories / calculateFactoryEffectiveCapacity /
// isCapexProjectOperationalAt（＝エンジン本体の純粋関数）から導出したものであり、
// このコンポーネントは整形と並置のみを行う。
//
// 【禁止事項】
//   - 能力の加算・稼働開始判定・稼働率の適用をこのファイルで計算しない。
//   - 「基礎＋増加＝当期」の検算結果を文章で断定しない（3列を並置し、プレイヤー自身が
//     読んで確認できる形にする）。
//   - 値が無い箇所を0で埋めない（NO_VALUE_TEXTを出す）。

import { formatHosoEqTons, formatRatioAsPercent } from "../../../lib/v2/industryLab/ui/formatters";
import {
  CAPACITY_POOL_DESCRIPTIONS,
  CompanyProcessingCapacityViewModel,
} from "../processingCapacityViewModel";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS, NO_VALUE_TEXT } from "./panelStyles";

const FACTORY_STATUS_LABELS: Record<string, string> = {
  active: "稼働中",
  idle: "休止中",
  suspended: "操業停止中",
};

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** 加算ぶんは0のとき「－」を出す（0トンの加算という実績があるわけではないため）。 */
function formatAddition(tons: number): string {
  if (tons === 0) return NO_VALUE_TEXT;
  return `+${formatHosoEqTons(tons)}`;
}

export interface ProcessingCapacityPanelProps {
  readonly viewModel: CompanyProcessingCapacityViewModel;
}

export default function ProcessingCapacityPanel(props: ProcessingCapacityPanelProps) {
  const { viewModel } = props;
  const multiFactory = viewModel.factories.length > 1;

  return (
    <div className="space-y-4" data-testid="processing-capacity-panel">
      {/* 1. 能力プール別サマリ（会社合計） */}
      <div className="space-y-1.5">
        <h4 className="text-xs font-semibold text-gray-300">能力プール別（会社合計・トン/四半期）</h4>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">能力</th>
                <th className="pr-3 py-1">当初の能力</th>
                <th className="pr-3 py-1">稼働済み投資による増加</th>
                <th className="pr-3 py-1">現時点の能力（名目）</th>
                <th className="pr-3 py-1">現時点の能力（実効）</th>
                <th className="pr-3 py-1">現在追加中</th>
              </tr>
            </thead>
            <tbody>
              {viewModel.companyTotals.map((pool) => {
                const pending = viewModel.pendingTotalsByPool[pool.poolKey];
                return (
                  <tr key={pool.poolKey} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1" title={CAPACITY_POOL_DESCRIPTIONS[pool.poolKey]}>
                      {pool.poolLabel}
                    </td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHosoEqTons(pool.baseNominalTons)}</td>
                    <td className={`pr-3 py-1 ${pool.addedByOperationalCapexTons > 0 ? "text-teal-300" : INFO_VALUE_CLASS}`}>
                      {formatAddition(pool.addedByOperationalCapexTons)}
                    </td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatHosoEqTons(pool.currentNominalTons)}</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHosoEqTons(pool.currentEffectiveTons)}</td>
                    <td className={`pr-3 py-1 ${pending > 0 ? "text-amber-300" : INFO_VALUE_CLASS}`}>{formatAddition(pending)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500">
          「名目」は工場の設計能力、「実効」はそこへ基準稼働率と設備利用可能率を掛けた、実際に生産計画の上限として働く能力です。
          「現在追加中」は、まだ現時点の能力には含まれていません（稼働開始四半期に達した時点で「稼働済み投資による増加」へ移ります）。
        </p>
      </div>

      {/* 2. 工場別（複数工場の会社のみ） */}
      {multiFactory && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">工場別の現時点の能力（名目・トン/四半期）</h4>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">工場</th>
                  <th className="pr-3 py-1">状態</th>
                  {viewModel.companyTotals.map((pool) => (
                    <th key={pool.poolKey} className="pr-3 py-1">
                      {pool.poolLabel}
                    </th>
                  ))}
                  <th className="pr-3 py-1">基準稼働率</th>
                  <th className="pr-3 py-1">設備利用可能率</th>
                </tr>
              </thead>
              <tbody>
                {viewModel.factories.map((f) => (
                  <tr key={f.factoryId} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">
                      {f.factoryId}
                      {f.receivesCapexCapacity && <span className="ml-1 text-[10px] text-teal-400">投資反映</span>}
                    </td>
                    <td className={`pr-3 py-1 ${f.status === "active" ? INFO_VALUE_CLASS : "text-amber-300"}`}>
                      {FACTORY_STATUS_LABELS[f.status] ?? f.status}
                    </td>
                    {f.pools.map((pool) => (
                      <td key={pool.poolKey} className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>
                        {formatHosoEqTons(pool.currentNominalTons)}
                      </td>
                    ))}
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatRatioAsPercent(f.baseUtilizationRate)}</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatRatioAsPercent(f.equipmentAvailabilityRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. 現在追加中の案件明細 */}
      <div className="space-y-1.5">
        <h4 className="text-xs font-semibold text-gray-300">現在追加中の能力（設備投資を意思決定済み・まだ能力へ未反映）</h4>
        {viewModel.pendingProjects.length === 0 ? (
          <p className="text-[11px] text-gray-500">現在追加中の加工能力はありません（能力を増やす設備投資が進行中でない状態です）。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">案件</th>
                  <th className="pr-3 py-1">対象能力</th>
                  <th className="pr-3 py-1">増加量(t/四半期)</th>
                  <th className="pr-3 py-1">状態</th>
                  <th className="pr-3 py-1">工期</th>
                  <th className="pr-3 py-1">完成</th>
                  <th className="pr-3 py-1">能力へ反映される四半期</th>
                  <th className="pr-3 py-1">支払済 / 承認額</th>
                </tr>
              </thead>
              <tbody>
                {viewModel.pendingProjects.map((row) => (
                  <tr key={row.projectId} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">{row.projectTypeDisplayName}</td>
                    <td className="pr-3 py-1">{row.targetPoolLabel ?? NO_VALUE_TEXT}</td>
                    <td className="pr-3 py-1 text-amber-300">+{formatHosoEqTons(row.capacityIncreaseTonsPerQuarter)}</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{row.displayStatusLabel}</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                      {row.requiredConstructionQuarters}四半期中 {row.elapsedConstructionQuartersWithPayment}四半期経過
                    </td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                      {row.completionPeriod ?? NO_VALUE_TEXT}
                      {row.completionPeriod !== undefined && row.isCompletionEstimate && <span className="ml-1 text-[10px] text-gray-500">見込</span>}
                    </td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                      {row.operationalStartPeriod ?? NO_VALUE_TEXT}
                      {row.operationalStartPeriod === undefined && <span className="ml-1 text-[10px] text-gray-500">完成後に確定</span>}
                    </td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                      {formatUsd(row.cumulativePaidUsd)} / {formatUsd(row.approvedBudgetUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-gray-500">
          能力が増えるのは「完成した四半期」ではなく「能力へ反映される四半期（稼働開始四半期）」からです。
          完成前の案件は完成時期そのものが確定していないため、反映四半期は完成後に確定します。
        </p>
      </div>
    </div>
  );
}
