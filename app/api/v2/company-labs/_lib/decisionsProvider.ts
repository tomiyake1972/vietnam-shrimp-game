// ShrimpX V2 — 会社ラボ API decisionsProviderの配線（Phase 8C-3A §7）
//
// companyLabQuarterFlowService.ts（lib層・Phase 8C-2）のCompanyLabDecisionsProvider
// 注入点へ、実際の意思決定変換ロジックを接続する。
//
//   - プレイヤー会社: 提出済みdraft本体（unknown）を app/v2/company-lab/decisionDraft.ts の
//     buildDecisionInputFromDraft で CompanyDecisionInput へ変換する。
//   - AI会社（プレイヤー以外の4社）: 既存の決定論的 generateAutoPolicyDecision を使う
//     （新しいAI API呼び出しは導入しない。指示§7）。
//
// 【lib/UI分離の維持】本ファイルはapp/api配下（HTTP統合層）にあり、app/lib/v2
// （フレームワーク・UI非依存のライブラリ層）には置かない。app/v2/company-lab/
// decisionDraft.ts（UI層のドラフト型・変換）とapp/lib/v2（エンジン・自動方針）の
// 両方に依存してよいのはこの統合層だけ、という8C-1/8C-2で確立した設計方針を
// そのまま踏襲する（companyLabQuarterFlowService.ts冒頭コメント参照）。
//
// 【draft本体の実行時検証】buildDecisionInputFromDraft自体はdraftの形を検証しない
// （lib層のスマートコンストラクタが数値の境界は守るが、トップレベルの形が
// 壊れていれば例外を投げる）。提出済みdraftの本体は本来saveDraft時点でも
// 検証されていない生のunknownであるため、ここで最小限の構造検証を行い、
// 壊れている場合はCompanyLabQuarterProcessingError（既存のエラー分類。
// §8のHTTPマッピングで422になる）として扱う。これにより「型変換中の
// 生の例外（プロパティアクセスエラー等）がAPI応答にそのまま漏れる」ことを防ぐ。

import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../../../../lib/v2/companyLab/types";
import { CompanyId } from "../../../../lib/v2/sales/types";
import { buildCompanyOwnState } from "../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabDecisionContext, CompanyLabDecisionsProvider } from "../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabQuarterProcessingError } from "../../../../lib/v2/companyLab/persistence/errors";
import { CompanyDecisionDraft, buildDecisionInputFromDraft } from "../../../../v2/company-lab/decisionDraft";

/** submittedDraftBodyが最低限CompanyDecisionDraftとして解釈可能な形かどうかの構造検証（深い内容までは見ない）。 */
function isPlausibleCompanyDecisionDraft(value: unknown, expectedCompanyId: CompanyId): value is CompanyDecisionDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.companyId === expectedCompanyId &&
    Array.isArray(v.salesPlans) &&
    typeof v.domesticPurchase === "object" &&
    v.domesticPurchase !== null &&
    Array.isArray(v.importOrders) &&
    Array.isArray(v.aquacultureStockingPlans) &&
    Array.isArray(v.productionPlans) &&
    Array.isArray(v.workerAssignments) &&
    typeof v.financingRequest === "object" &&
    v.financingRequest !== null &&
    typeof v.capexDecision === "object" &&
    v.capexDecision !== null
  );
}

function buildPlayerDecision(labId: string, fixture: CompanyFixture, restoredState: CompanyLabState, submittedDraftBody: unknown): CompanyDecisionInput {
  if (!isPlausibleCompanyDecisionDraft(submittedDraftBody, fixture.companyId)) {
    throw new CompanyLabQuarterProcessingError(
      labId,
      `プレイヤー会社 "${fixture.companyId}" の提出済みdraftが、想定される意思決定ドラフトの形（CompanyDecisionDraft）と一致しません。`
    );
  }
  try {
    return buildDecisionInputFromDraft(submittedDraftBody, fixture, restoredState.currentPeriod);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CompanyLabQuarterProcessingError(labId, `プレイヤー会社 "${fixture.companyId}" のdraft変換に失敗しました: ${message}`);
  }
}

/**
 * API層用のCompanyLabDecisionsProviderを組み立てる。
 *   - playerCompanyId と一致する会社: 提出済みdraftから変換。
 *   - それ以外の会社（AI会社）: 既存の決定論的generateAutoPolicyDecisionをそのまま使う
 *     （プレイヤー以外の4社。新しいAI API呼び出しは導入しない）。
 */
export function buildApiDecisionsProvider(labId: string): CompanyLabDecisionsProvider {
  return (context: CompanyLabDecisionContext): Readonly<Record<CompanyId, CompanyDecisionInput>> => {
    const { restoredState, fixtures, publicInfo, period, turn, playerCompanyId, submittedDraftBody } = context;
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const fixture of fixtures) {
      if (fixture.companyId === playerCompanyId) {
        decisions[fixture.companyId] = buildPlayerDecision(labId, fixture, restoredState, submittedDraftBody);
      } else {
        const ownState = buildCompanyOwnState(restoredState, fixture);
        decisions[fixture.companyId] = generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn);
      }
    }
    return decisions;
  };
}
