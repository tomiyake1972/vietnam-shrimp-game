// ShrimpX V2 — Phase 8D-5 凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック）のパネル
//
// production/coldStorage.ts が算出済みの状態を描画するだけ。計算を持たない。
// 「エンジン未接続」の注記は必ず表示する（誤認防止）。

import { CompanyColdStorageState } from "../../../lib/v2/production/coldStorage";
import { CapacityPoolBreakdown } from "../processingCapacityViewModel";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS, NO_VALUE_TEXT } from "./panelStyles";

interface ColdStoragePanelProps {
  readonly state: CompanyColdStorageState;
  /** 凍結・包装処理能力（フロー）の内訳。会社合計の行をそのまま渡す。 */
  readonly freezingPackagingPool: CapacityPoolBreakdown | undefined;
  /** 現在の凍結・包装の処理計画（見込み処理量の合計、トン/四半期）。 */
  readonly plannedProcessingTons: number;
  /** 追加保管1トンあたりの投資額（USD）。算定できなければundefined。 */
  readonly investmentUsdPerStorageTon: number | undefined;
  readonly explanationText: string;
}

function formatTons(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} t`;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? NO_VALUE_TEXT : `${(value * 100).toFixed(1)}%`;
}

export default function ColdStoragePanel(props: ColdStoragePanelProps) {
  const { state, freezingPackagingPool, plannedProcessingTons } = props;

  const flowEffective = freezingPackagingPool?.currentEffectiveTons;
  const flowUtilization = flowEffective !== undefined && flowEffective > 0 ? plannedProcessingTons / flowEffective : undefined;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-400">{props.explanationText}</p>

      {/* フロー: 凍結・包装処理能力 */}
      <div>
        <h5 className="text-[11px] font-semibold text-gray-300 mb-1">凍結・包装処理能力（フロー・トン／四半期）</h5>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">現在の名目能力</th>
                <th className="pr-3 py-1">現在の実効能力</th>
                <th className="pr-3 py-1">現在の処理計画</th>
                <th className="pr-3 py-1">処理能力使用率</th>
              </tr>
            </thead>
            <tbody>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                  {freezingPackagingPool ? formatTons(freezingPackagingPool.currentNominalTons) : NO_VALUE_TEXT}
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{flowEffective !== undefined ? formatTons(flowEffective) : NO_VALUE_TEXT}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatTons(plannedProcessingTons)}</td>
                <td className={`pr-3 py-1 ${flowUtilization !== undefined && flowUtilization >= 1 ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                  {formatRate(flowUtilization)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500 mt-1">こちらが生産量の上限として実際に働きます（生産エンジンの段階3）。</p>
      </div>

      {/* ストック: 冷凍・冷蔵保管能力 */}
      <div>
        <h5 className="text-[11px] font-semibold text-gray-300 mb-1">冷凍・冷蔵保管能力（ストック・同時保管トン）</h5>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">現在の保管能力</th>
                <th className="pr-3 py-1">現在の保管使用量</th>
                <th className="pr-3 py-1">空き保管容量</th>
                <th className="pr-3 py-1">使用率</th>
                <th className="pr-3 py-1">建設中投資の完成後</th>
                <th className="pr-3 py-1">追加保管1tあたり投資額</th>
              </tr>
            </thead>
            <tbody>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatTons(state.totalCapacityTons)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatTons(state.usedTons)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatTons(state.freeTons)}</td>
                <td className={`pr-3 py-1 ${state.isOverCapacity ? "text-rose-300" : state.isTight ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                  {formatRate(state.utilizationRate)}
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                  {state.pendingAdditionTons > 0 ? formatTons(state.capacityAfterPendingInvestmentsTons) : NO_VALUE_TEXT}
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                  {props.investmentUsdPerStorageTon !== undefined
                    ? `$${Math.round(props.investmentUsdPerStorageTon).toLocaleString("en-US")}`
                    : NO_VALUE_TEXT}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 商品別の保管使用量 */}
      {Object.keys(state.usedByProduct).length > 0 && (
        <details>
          <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">商品別の保管使用量</summary>
          <ul className="mt-1 space-y-0.5">
            {(["hoso", "pd", "vap"] as const).map((p) =>
              state.usedByProduct[p] !== undefined ? (
                <li key={p} className="text-[11px] text-gray-400">
                  {p.toUpperCase()}: {formatTons(state.usedByProduct[p]!)}
                </li>
              ) : null
            )}
          </ul>
        </details>
      )}

      {state.isOverCapacity && (
        <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg px-3 py-2 text-[11px] text-amber-200">
          完成品在庫が保管能力を {formatTons(state.overCapacityTons)} 超えています。
        </div>
      )}

      {/* エンジン未接続であることの明示（誤認防止。必ず表示する） */}
      <div className="bg-gray-900/60 border border-gray-700/60 rounded-lg px-3 py-2 text-[11px] text-gray-400">
        <span className="font-semibold text-gray-300">実装状況の注記: </span>
        {state.engineConnectionNote}
      </div>
    </div>
  );
}
