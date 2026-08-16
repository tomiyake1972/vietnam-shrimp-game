// ShrimpX V2 — Procurement Planning: Production Linkage Header（表示専用）
//
// 【計算しない】この component は procurementRequirementViewModel.ts の
// buildProcurementRequirementViewModel が返した値をそのまま表示するだけ。
// Confirmed（在庫＋輸入到着）と Expected（養殖の期待収穫。疾病圧力次第で
// 変動しうる）を必ず分けて表示し、混同を防ぐ（ご指示の設計方針を維持）。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { ProcurementRequirementViewModel } from "../../procurementRequirementViewModel";
import { AREA_TONES } from "../panelStyles";

interface ProductionLinkageHeaderProps {
  readonly vm: ProcurementRequirementViewModel;
}

function StatTile(props: { readonly label: string; readonly value: string; readonly emphasis?: boolean; readonly testId?: string }) {
  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-900/50 px-3 py-2">
      <div className="text-[11px] text-gray-400">{props.label}</div>
      <div className={`mt-0.5 tabular-nums ${props.emphasis ? "text-lg font-bold text-gray-100" : "text-sm text-gray-200"}`} data-testid={props.testId}>
        {props.value}
      </div>
    </div>
  );
}

export default function ProductionLinkageHeader({ vm }: ProductionLinkageHeaderProps) {
  const tone = AREA_TONES.info;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="production-linkage-header">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>生産計画との関係（Production Linkage）</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Planned Production 計画生産量" value={formatHosoEqTons(vm.requirement.plannedProductionTotalTons)} emphasis testId="pl-planned-production" />
        <StatTile label="Required Raw Material 必要原料量" value={formatHosoEqTons(vm.requirement.requiredRawMaterialTons)} emphasis testId="pl-required-raw" />
        <StatTile label="Confirmed Available 当期確定利用可能" value={formatHosoEqTons(vm.available.confirmedAvailableTons)} testId="pl-confirmed-available" />
        <StatTile label="Expected Aquaculture Harvest 養殖見込み（未確定）" value={formatHosoEqTons(vm.available.expectedAquacultureHarvestTons)} testId="pl-expected-harvest" />
      </div>

      {/* 【混同禁止】確定だけで見た過不足と、養殖の期待収穫を含めた場合を必ず分けて表示する。 */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div
          className={`rounded-lg border px-3 py-2 ${
            vm.isConfirmedShortage ? "border-rose-700/60 bg-rose-950/40" : "border-gray-700/60 bg-gray-900/40"
          }`}
          data-testid="pl-confirmed-balance"
        >
          <div className="text-[11px] text-gray-400">Confirmed のみ（養殖の期待収穫を含まない・保守値）</div>
          <div className={`mt-0.5 text-sm font-semibold tabular-nums ${vm.isConfirmedShortage ? "text-rose-300" : "text-gray-100"}`}>
            {vm.isConfirmedShortage
              ? `Confirmed Shortage: ${formatHosoEqTons(vm.confirmedShortageTons)}`
              : `Confirmed Surplus: ${formatHosoEqTons(vm.confirmedSurplusTons)}`}
          </div>
        </div>
        <div
          className={`rounded-lg border px-3 py-2 ${vm.isShortage ? "border-amber-700/60 bg-amber-950/30" : "border-gray-700/60 bg-gray-900/40"}`}
          data-testid="pl-optimistic-balance"
        >
          <div className="text-[11px] text-gray-400">Including Expected（養殖の期待収穫を含む・楽観値）</div>
          <div className={`mt-0.5 text-sm font-semibold tabular-nums ${vm.isShortage ? "text-amber-300" : "text-gray-100"}`}>
            {vm.isShortage ? `Including Expected Shortage: ${formatHosoEqTons(vm.shortageTons)}` : `Including Expected Surplus: ${formatHosoEqTons(vm.surplusTons)}`}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Confirmed（手持ち在庫＋当期到着輸入）と Expected（養殖の当期収穫見込み。疾病圧力等により収穫時に変動しうる）は別の確実性を持つため、混ぜて1つの数値にしていません。
      </p>
    </div>
  );
}
