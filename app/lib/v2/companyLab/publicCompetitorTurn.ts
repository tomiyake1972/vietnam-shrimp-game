// ShrimpX V2 — Turnごとの公開競合情報の凍結（PUBLIC-COMPETITOR-4）
//
// 【このモジュールが存在する理由】
//   公開競合情報と競合ニュースは、これまで表示のたびに確定記録から決定論的に
//   再構築していた。同じコードで同じ記録を読む限り結果は同じだが、帯のしきい値・
//   混雑度の区分・噂の外れ率・記事テンプレートはいずれも今後の調整対象である。
//   再構築方式のままだと、パラメータを変えた瞬間に**過去のターンで受講者が実際に
//   見た内容まで遡って変わってしまう**。確定時点の内容をそのまま保存して凍結する。
//
// 【engine を薄く保つ】ターン処理側（engine.ts）からはこの関数を1回呼ぶだけにし、
//   どの材料をどう集めるかはここへ閉じ込める。engine に公開情報の組み立て手順を
//   書き足さない。

import { CompanyId } from "../sales/types";
import { CAPEX_PARAMETERS_V1 } from "../capex/parameters";
import { CompanyQuarterRecord } from "./types";
import { buildCompetitorNews } from "./competitorNews";
import {
  buildAnnualDividendNewsInput,
  buildCompanyFactoryCounts,
  buildCompetitorSignals,
  buildPersistedPublicTurnSnapshot,
  buildPublicInvestmentAnnouncements,
  projectPublicSnapshotForViewer,
} from "./publicCompetitorSnapshot";
import type { PersistedPublicCompetitorTurn, SimulationSession } from "./simulation/types";

/**
 * このTurnで確定した記録から、保存する公開情報とニュースを組み立てる。
 *
 * @param previousRecord 帯の↑↓判定にだけ使う、1つ前の確定記録。
 *                       engine からは「まだ書き換わっていない session.state.history の末尾」
 *                       （＝今回確定したTurnの1つ前）を渡す。
 */
export function buildPublicCompetitorTurn(input: {
  readonly session: SimulationSession;
  readonly record: CompanyQuarterRecord;
  readonly previousRecord: CompanyQuarterRecord | null;
}): PersistedPublicCompetitorTurn {
  const { session, record, previousRecord } = input;
  const companyIds: readonly CompanyId[] = session.fixtures.map((f) => f.companyId);

  // 営業人員はターンをまたぐ状態が持つ（四半期記録には入っていない）。
  const salesForceHeadcountByCompanyId = new Map(
    (session.state.salesForceHiringState?.companies ?? []).map((c) => [c.companyId, c.headcount])
  );

  const investments = buildPublicInvestmentAnnouncements({
    record,
    templatesByType: CAPEX_PARAMETERS_V1.templatesByType,
  });

  // 工場数は、capex で増えた新工場も反映された実効 Factory 一覧から数える。
  // ここでは確定後の state を参照できないため、fixture の工場に加えて
  // capex ポートフォリオの完成済み新工場を数える。
  const factoryCounts = buildCompanyFactoryCounts({
    factories: session.fixtures.flatMap((f) => f.factories.map((factory) => ({ companyId: factory.companyId }))),
    capexProjectsByCompanyId: new Map(
      (session.state.capexState?.companies ?? []).map((c) => [c.companyId, c.portfolio.projects])
    ),
    companyIds,
  });

  const snapshot = buildPersistedPublicTurnSnapshot({
    record,
    previousRecord,
    companyIds,
    salesForceHeadcountByCompanyId,
    investments,
    factoryCounts,
  });

  // ニュースの発火条件は会社に依らないため、射影の宛先はどの会社でも同じ結果になる。
  // ここでは先頭会社ぶんの射影を使う（exactShare はニュース生成では読まない）。
  const viewerSnapshot = projectPublicSnapshotForViewer(snapshot, companyIds[0] ?? "");
  const annualDividend = buildAnnualDividendNewsInput([...session.state.history, record], companyIds);

  const news = buildCompetitorNews({
    runId: session.run.simulationRunId,
    // 受講者がこの内容を見るのは次のTurn。記事IDとシードをそのTurnで固定する。
    turn: record.turn + 1,
    snapshot: viewerSnapshot,
    signals: buildCompetitorSignals(record, viewerSnapshot, companyIds),
    displayNameByCompanyId: new Map(session.fixtures.map((f) => [f.companyId, f.displayName])),
    ...(annualDividend ? { annualDividend } : {}),
  });

  return { viewedAtTurn: record.turn + 1, snapshot, news };
}
