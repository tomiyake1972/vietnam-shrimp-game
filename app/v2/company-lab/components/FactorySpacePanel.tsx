// ShrimpX V2 — Phase 8D-3 工場スペースパネル
//
// production/factorySpace.ts が算出済みの状態を描画するだけ。計算を持たない。

import { CompanyFactorySpaceState } from "../../../lib/v2/production/factorySpace";
import { FACTORY_SPACE_EXPLANATION_TEXT, FACTORY_SPACE_UNIT_LABEL } from "../../../lib/v2/production/factorySpace";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS, NO_VALUE_TEXT } from "./panelStyles";

interface FactorySpacePanelProps {
  readonly state: CompanyFactorySpaceState;
}

function formatUnits(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatRate(value: number | undefined): string {
  return value === undefined ? NO_VALUE_TEXT : `${(value * 100).toFixed(1)}%`;
}

export default function FactorySpacePanel(props: FactorySpacePanelProps) {
  const { state } = props;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-400">{FACTORY_SPACE_EXPLANATION_TEXT}</p>

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1">工場</th>
              <th className="pr-3 py-1">総量</th>
              <th className="pr-3 py-1">稼働中設備の使用量</th>
              <th className="pr-3 py-1">建設中案件の予約量</th>
              <th className="pr-3 py-1">現在の空き</th>
              <th className="pr-3 py-1">投資完成後の使用量</th>
              <th className="pr-3 py-1">投資完成後の空き</th>
              <th className="pr-3 py-1">使用率（完成後）</th>
            </tr>
          </thead>
          <tbody>
            {state.factories.map((f) => (
              <tr key={f.factoryId} className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1">{f.factoryId}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatUnits(f.totalSpaceUnits)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatUnits(f.usedByOperationalSpaceUnits)}</td>
                <td className={`pr-3 py-1 ${f.reservedByPendingSpaceUnits > 0 ? "text-teal-300" : INFO_VALUE_CLASS}`}>
                  {f.reservedByPendingSpaceUnits > 0 ? formatUnits(f.reservedByPendingSpaceUnits) : NO_VALUE_TEXT}
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatUnits(f.freeSpaceUnits)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatUnits(f.usedAfterPendingSpaceUnits)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatUnits(f.freeAfterPendingSpaceUnits)}</td>
                <td className={`pr-3 py-1 ${f.isShortage ? "text-rose-300" : f.isTight ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                  {formatRate(f.utilizationRateAfterPending)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-500">単位は{FACTORY_SPACE_UNIT_LABEL}（工場の設置床面積 1 m² 相当とみなした抽象単位）です。</p>

      {state.isShortage && (
        <div className="bg-rose-950/40 border border-rose-700/50 rounded-lg px-3 py-2 text-[11px] text-rose-200">
          工場スペースが {formatUnits(state.shortfallSpaceUnits)} {FACTORY_SPACE_UNIT_LABEL}不足しています。
          この状態では新しい投資案件は承認されません（既存設備の能力が減ることはありません）。
        </div>
      )}

      {state.factories.some((f) => f.pendingReservations.length > 0) && (
        <details>
          <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">建設中案件が予約しているスペースの内訳</summary>
          <ul className="mt-1 space-y-0.5">
            {state.factories.flatMap((f) =>
              f.pendingReservations.map((r) => (
                <li key={`${f.factoryId}-${r.projectId}`} className="text-[11px] text-gray-400">
                  {f.factoryId} / {r.projectId}（{r.projectType}）: {formatUnits(r.requiredSpaceUnits)} {FACTORY_SPACE_UNIT_LABEL}
                </li>
              ))
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
