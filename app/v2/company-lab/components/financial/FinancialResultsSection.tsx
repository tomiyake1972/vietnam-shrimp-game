// ShrimpX V2 — Company Lab プレイヤー画面 「財務・資金・設備投資」大区分パネル
//
// 既存のMarketPanel/ResultsPanelと同じく、永続化済みの確定結果を表示するだけの
// 純粋な表示コンポーネント。PL/BS/CF/資金調達・信用力/設備投資結果の5タブに
// 分け、当期・前期・増減を表示する（前期がない初回四半期はその旨を表示する）。

"use client";

import { useState } from "react";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { CompanyFinancingState, FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CapexQuarterResult } from "../../../../lib/v2/capex";
import ProfitAndLossTab from "./ProfitAndLossTab";
import BalanceSheetTab from "./BalanceSheetTab";
import CashFlowTab from "./CashFlowTab";
import FinancingTab from "./FinancingTab";
import CapexResultsTab from "./CapexResultsTab";

type TabKey = "pl" | "bs" | "cf" | "financing" | "capex";

const TABS: readonly { readonly key: TabKey; readonly label: string }[] = [
  { key: "pl", label: "PL（損益計算書）" },
  { key: "bs", label: "BS（貸借対照表）" },
  { key: "cf", label: "CF（キャッシュフロー）" },
  { key: "financing", label: "資金調達・信用力" },
  { key: "capex", label: "設備投資結果" },
];

interface FinancialResultsSectionProps {
  readonly displayName: string;
  readonly companyId: string;
  readonly currentTurn: number;
  readonly currentPeriod: string;
  readonly financialResult: CompanyFinancialQuarterResult | null;
  readonly financingResult: FinancingQuarterResult | null;
  readonly capexResult: CapexQuarterResult | null;
  readonly ownFinancingState: CompanyFinancingState;
  readonly previousTurn: number | null;
  readonly previousPeriod: string | null;
  readonly previousFinancialResult: CompanyFinancialQuarterResult | null;
  readonly previousFinancingResult: FinancingQuarterResult | null;
  readonly previousCapexResult: CapexQuarterResult | null;
}

export default function FinancialResultsSection(props: FinancialResultsSectionProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("pl");

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h3 className="text-base font-semibold text-gray-100">
        {props.companyId}（{props.displayName}）— 財務・資金・設備投資 — {props.currentPeriod}
      </h3>
      <div className="text-[11px] text-gray-500">
        当期: turn {props.currentTurn}（{props.currentPeriod}） / 前期:{" "}
        {props.previousTurn !== null ? `turn ${props.previousTurn}（${props.previousPeriod}）` : "データなし（初回四半期のため前期比較はできません）"}
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-gray-700 pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`text-xs rounded-full px-3 py-1.5 font-medium transition-colors ${
              activeTab === t.key ? "bg-teal-600 text-white" : "bg-gray-900/50 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "pl" && <ProfitAndLossTab current={props.financialResult} previous={props.previousFinancialResult} />}
      {activeTab === "bs" && <BalanceSheetTab current={props.financialResult} previous={props.previousFinancialResult} />}
      {activeTab === "cf" && <CashFlowTab current={props.financialResult} previous={props.previousFinancialResult} />}
      {activeTab === "financing" && (
        <FinancingTab current={props.financingResult} previous={props.previousFinancingResult} ownFinancingState={props.ownFinancingState} />
      )}
      {activeTab === "capex" && <CapexResultsTab current={props.capexResult} previous={props.previousCapexResult} />}
    </div>
  );
}
