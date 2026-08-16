// ShrimpX V2 — Decision Studio: WORKER（常用/臨時Worker増減・残業率）
//
// 旧DecisionEditor.tsxの「Worker（工場作業者）の増減」CollapsibleSectionをそのまま移設。
// applyHeadcountChange（常用人数の逆算式・唯一の情報源）は変更しない。

import { CompanyDecisionDraft } from "../../decisionDraft";
import { applyHeadcountChange, WORKFORCE_EXPLANATION_TEXT } from "../../../../lib/v2/companyLab/workforce";
import { DecisionStudioViewModel } from "../../decisionStudioViewModel";
import WorkforcePanel from "../WorkforcePanel";
import CollapsibleSection from "../CollapsibleSection";

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

interface WorkforcePlanningScreenProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly vm: DecisionStudioViewModel;
}

export default function WorkforcePlanningScreen({ draft, onChange, disabled, vm }: WorkforcePlanningScreenProps) {
  const workforceRows = vm.planning.workforceRows;

  return (
    <div className="space-y-3" data-testid="decision-studio-worker-screen">
      <CollapsibleSection
        title="Worker（工場作業者）の増減"
        tone="input"
        testId="worker-assignment-section"
        description={WORKFORCE_EXPLANATION_TEXT}
        summaryRight={
          workforceRows.length > 0
            ? `変更後 合計 ${workforceRows.reduce((s, r) => s + r.headcountAfter, 0).toLocaleString("en-US")}人 / 四半期人件費 ${formatUsd(
                workforceRows.reduce((s, r) => s + r.costAfter.totalCostUsd, 0)
              )}`
            : undefined
        }
      >
        <WorkforcePanel
          rows={workforceRows}
          disabled={disabled}
          onChangeHeadcountDelta={(factoryId, delta) => {
            const idx = draft.workerAssignments.findIndex((w) => w.factoryId === factoryId);
            if (idx < 0) return;
            const row = draft.workerAssignments[idx];
            const before = row.regularHeadcountBefore ?? row.regularHeadcount;
            const next = [...draft.workerAssignments];
            next[idx] = {
              ...row,
              regularHeadcountBefore: before,
              regularHeadcountChange: delta,
              regularHeadcount: applyHeadcountChange(before, delta),
            };
            onChange({ ...draft, workerAssignments: next });
          }}
          onChangeTemporaryHeadcount={(factoryId, value) => {
            const idx = draft.workerAssignments.findIndex((w) => w.factoryId === factoryId);
            if (idx < 0) return;
            const next = [...draft.workerAssignments];
            next[idx] = { ...next[idx], temporaryHeadcount: Math.round(value) };
            onChange({ ...draft, workerAssignments: next });
          }}
          onChangeOvertimeRate={(factoryId, value) => {
            const idx = draft.workerAssignments.findIndex((w) => w.factoryId === factoryId);
            if (idx < 0) return;
            const next = [...draft.workerAssignments];
            next[idx] = { ...next[idx], overtimeRate: value };
            onChange({ ...draft, workerAssignments: next });
          }}
        />
      </CollapsibleSection>
    </div>
  );
}
