// ShrimpX V2 — Phase 8D-4 Worker（工場作業者）増減パネル
//
// 表示値はすべて investmentPlanningViewModel.ts が算出済みのものを描画するだけで、
// このコンポーネントは計算を一切持たない（必要人数の逆算・労働能力・人件費は、
// いずれもエンジンの純粋関数から得た値である）。
//
// 【禁止事項】
//   - 人件費単価・1人あたり効率をここへ書かない。
//   - 不足の判定をここで作らない（view-modelのisShortage/shortageSentenceを使う）。
//   - 警告を色だけで表現しない（必ず不足量と理由を文章でも出す）。

import { WorkforcePlanRow } from "../investmentPlanningViewModel";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS, INPUT_CONTROL_CLASS, NO_VALUE_TEXT } from "./panelStyles";

interface WorkforcePanelProps {
  readonly rows: readonly WorkforcePlanRow[];
  readonly disabled: boolean;
  readonly onChangeHeadcountDelta: (factoryId: string, delta: number) => void;
  readonly onChangeTemporaryHeadcount: (factoryId: string, value: number) => void;
  readonly onChangeOvertimeRate: (factoryId: string, value: number) => void;
}

function formatUsd(value: number): string {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString("en-US")}`;
}

function formatHeadcount(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")}人`;
}

export default function WorkforcePanel(props: WorkforcePanelProps) {
  const { rows, disabled } = props;

  if (rows.length === 0) {
    return <p className="text-xs text-gray-400">{NO_VALUE_TEXT} 対象となる工場がありません。</p>;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1">工場</th>
              <th className="pr-3 py-1">現在人数</th>
              <th className="pr-3 py-1">増員／減員</th>
              <th className="pr-3 py-1">変更後人数</th>
              <th className="pr-3 py-1">必要人数（目安）</th>
              <th className="pr-3 py-1">過不足</th>
              <th className="pr-3 py-1">四半期人件費</th>
              <th className="pr-3 py-1">増減</th>
              <th className="pr-3 py-1">臨時人数</th>
              <th className="pr-3 py-1">残業率(0〜1)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.factoryId} className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1">{row.factoryId}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHeadcount(row.headcountBefore)}</td>
                <td className="pr-3 py-1">
                  <input
                    type="number"
                    step={10}
                    value={row.headcountChange}
                    disabled={disabled}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      props.onChangeHeadcountDelta(row.factoryId, Number.isFinite(n) ? Math.round(n) : 0);
                    }}
                    className={`w-24 ${INPUT_CONTROL_CLASS}`}
                  />
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>{formatHeadcount(row.headcountAfter)}</td>
                <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{formatHeadcount(row.requiredRegularHeadcount)}</td>
                <td className={`pr-3 py-1 ${row.isShortage ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                  {row.headcountSurplus >= 0 ? `+${formatHeadcount(row.headcountSurplus)}` : `−${formatHeadcount(-row.headcountSurplus)}`}
                </td>
                <td className={`pr-3 py-1 ${INFO_VALUE_STRONG_CLASS}`}>${Math.round(row.costAfter.totalCostUsd).toLocaleString("en-US")}</td>
                <td className={`pr-3 py-1 ${row.costDeltaUsd < 0 ? "text-teal-300" : row.costDeltaUsd > 0 ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                  {formatUsd(row.costDeltaUsd)}
                </td>
                <td className="pr-3 py-1">
                  <input
                    type="number"
                    min={0}
                    step={10}
                    value={row.temporaryHeadcount}
                    disabled={disabled}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      props.onChangeTemporaryHeadcount(row.factoryId, Number.isFinite(n) && n > 0 ? n : 0);
                    }}
                    className={`w-20 ${INPUT_CONTROL_CLASS}`}
                  />
                </td>
                <td className="pr-3 py-1">
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={row.overtimeRate}
                    disabled={disabled}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      props.onChangeOvertimeRate(row.factoryId, Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
                    }}
                    className={`w-20 ${INPUT_CONTROL_CLASS}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 不足の説明（色だけに頼らず、不足量と理由を文章で示す） */}
      {rows.some((r) => r.shortageSentence !== undefined) && (
        <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg px-3 py-2 space-y-1">
          <div className="text-[11px] font-semibold text-amber-300">Worker不足</div>
          <ul className="space-y-0.5">
            {rows
              .filter((r) => r.shortageSentence !== undefined)
              .map((r) => (
                <li key={r.factoryId} className="text-[11px] text-amber-200">
                  {r.factoryId}: {r.shortageSentence}
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* 変更後の推定労働能力（設備能力を超えないことが数値で分かるようにする） */}
      <details>
        <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">変更後の推定労働能力（商品別・トン/四半期）</summary>
        <div className="overflow-x-auto mt-1">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">工場</th>
                <th className="pr-3 py-1">HOSO</th>
                <th className="pr-3 py-1">PD</th>
                <th className="pr-3 py-1">VAP</th>
                <th className="pr-3 py-1">Worker削減による未処理見込み</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.factoryId} className={INFO_TABLE_ROW_CLASS}>
                  <td className="pr-3 py-1">{row.factoryId}</td>
                  {(["hoso", "pd", "vap"] as const).map((p) => (
                    <td key={p} className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>
                      {row.laborCapacityByProductAfter[p] !== undefined ? row.laborCapacityByProductAfter[p]!.toFixed(2) : NO_VALUE_TEXT}
                    </td>
                  ))}
                  <td className={`pr-3 py-1 ${row.unprocessedByLaborTons > 0 ? "text-amber-300" : INFO_VALUE_CLASS}`}>
                    {row.unprocessedByLaborTons > 0 ? `${row.unprocessedByLaborTons.toFixed(2)} t` : NO_VALUE_TEXT}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-500 mt-1">
            推定労働能力は、設備能力を上限としてクリップされています（人を増やしても設備能力を超えて生産量は増えません）。
            必要人数は目安であり、実際に処理できる量は「現在の入力に基づく処理見込み」の表が唯一の正です。
          </p>
        </div>
      </details>
    </div>
  );
}
