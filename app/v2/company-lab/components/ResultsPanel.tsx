// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 1社ぶんの結果表示パネル
//
// CompanyQuarterSummary（すでに計算済み）を表示するだけの純粋な表示コンポーネント。
// 契約→原料確保→生産→納品の流れが追えるよう、セクションを分けて並べる。

import { CompanyQuarterSummary } from "../../../lib/v2/companyLab";
import { formatHosoEqTons, formatRatioAsPercent, formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";

interface ResultsPanelProps {
  readonly summary: CompanyQuarterSummary;
  readonly displayName: string;
}

function StatCell(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-gray-900/50 rounded-lg px-3 py-2">
      <div className="text-[11px] text-gray-500">{props.label}</div>
      <div className="text-sm text-gray-100">{props.value}</div>
    </div>
  );
}

export default function ResultsPanel(props: ResultsPanelProps) {
  const { summary: s, displayName } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h3 className="text-base font-semibold text-gray-100">
        {s.companyId}（{displayName}）— {s.period}
      </h3>

      <div>
        <div className="text-xs text-gray-400 mb-1">① 契約（販売）</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCell label="新規成約量" value={formatHosoEqTons(s.newContractedQuantity)} />
          <StatCell label="成約平均価格" value={formatUsdPerHosoEqKg(s.newContractedAveragePrice)} />
          <StatCell label="履行量" value={formatHosoEqTons(s.fulfilledQuantity)} />
          <StatCell label="未履行残高" value={formatHosoEqTons(s.outstandingQuantity)} />
          <StatCell label="うち納期超過" value={formatHosoEqTons(s.overdueQuantity)} />
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">② 原料確保（国内買付・輸入・養殖）</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCell label="国内買付量" value={formatHosoEqTons(s.domesticPurchaseQuantity)} />
          <StatCell label="国内買付価格" value={formatUsdPerHosoEqKg(s.domesticPurchasePrice)} />
          <StatCell label="輸入中" value={formatHosoEqTons(s.importInTransitQuantity)} />
          <StatCell label="輸入到着" value={formatHosoEqTons(s.importArrivedQuantity)} />
          <StatCell label="養殖中" value={formatHosoEqTons(s.aquacultureGrowingQuantity)} />
          <StatCell label="養殖収穫" value={formatHosoEqTons(s.aquacultureHarvestedQuantity)} />
          <StatCell label="原料在庫" value={formatHosoEqTons(s.rawMaterialInventory)} />
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">③ 生産</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCell label="HOSO生産" value={formatHosoEqTons(s.hosoProduced)} />
          <StatCell label="PD生産" value={formatHosoEqTons(s.pdProduced)} />
          <StatCell label="VAP生産" value={formatHosoEqTons(s.vapProduced)} />
          <StatCell label="完成品在庫" value={formatHosoEqTons(s.finishedGoodsInventory)} />
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-1">④ 未達・稼働率</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCell label="原料不足" value={formatHosoEqTons(s.rawMaterialShortfall)} />
          <StatCell label="設備不足" value={formatHosoEqTons(s.equipmentShortfall)} />
          <StatCell label="ワーカー不足" value={formatHosoEqTons(s.laborShortfall)} />
          <StatCell label="設備稼働率" value={formatRatioAsPercent(s.equipmentUtilizationRate)} />
          <StatCell label="労働稼働率" value={formatRatioAsPercent(s.laborUtilizationRate)} />
          <StatCell label="残業率" value={formatRatioAsPercent(s.overtimeRate)} />
          <StatCell label="臨時比率" value={formatRatioAsPercent(s.temporaryWorkerShare)} />
        </div>
      </div>

      {s.reasonCodes.length > 0 && (
        <div>
          <div className="text-xs text-gray-400 mb-1">理由コード</div>
          <div className="flex flex-wrap gap-1.5">
            {s.reasonCodes.map((r, idx) => (
              <span key={`${r.code}-${idx}`} className="text-[11px] bg-teal-950/60 border border-teal-700/50 text-teal-200 rounded-full px-2 py-0.5">
                {r.message}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
