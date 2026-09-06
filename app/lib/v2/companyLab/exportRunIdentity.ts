// ShrimpX V2 — EXPORT-RUN-IDENTITY-1: 全Exportで共有するRun Identityの唯一の生成箇所
//
// 【経緯（test61監査）】複数の販売市場モデル（legacy-waterfall-v1 / tiered-v200-candidate-v1）
// が並存するようになったが、AI Analysis Pack・Standard AI Audit・Company/GM Databook・
// manifest.json・lab_index.jsonのいずれにも、実際に使われた販売モデルの識別情報が
// 記録されていなかった（test61で判明）。
//
// 【設計方針】
//   - 新しい市場配分・価格計算・財務計算は一切追加しない。既存のsalesParametersFor
//     （companyLab/runner.ts、Engineが実際に使うSalesParametersを解決する唯一の関数）を
//     そのまま呼び出し、そこから得られる値だけを転記する。
//   - Export側で「configuredSalesModelId未指定ならlegacy」等の判定ロジックを重複実装しない
//     （salesParametersForの優先順位＝salesParamsOverride > salesModelId > sai5レガシー
//     variant、をそのまま踏襲する）。
//   - この関数は各Export（AI Analysis Pack・Standard AI Audit・Company/GM Databook・
//     manifest.json・lab_index.json）から共通で呼ばれる、Run Identity生成の唯一のSSoT。
//     個々のExportが独自にsalesModelId関連フィールドを組み立てることを禁止する
//     （重複実装によるドリフトを防ぐ）。
//   - 過去保存Run（config自体が読めない・schemaVersion 3未満でresumePayload自体が無い等）を
//     壊さないよう、config が無い場合は「取得不能」を表すnullを返す（推測でlegacyと
//     決めつけない。CLAUDE.md「推測で修正しない・捏造しない」）。

import { CompanyLabConfig } from "./types";
import { salesParametersFor } from "./runner";
import { SalesModelId } from "../sales/salesModels";

/** 全Exportが記録すべきRun Identityの最小集合（EXPORT-RUN-IDENTITY-1・指示§2）。 */
export interface ExportRunIdentity {
  /** 保存されたRun configのsalesModelId値そのもの（未指定＝legacy運用のRunはnull）。 */
  readonly configuredSalesModelId: SalesModelId | null;
  /**
   * Engineが実際に解決して使用したモデル。configuredSalesModelId未指定でも、
   * 実際に使われたモデル（"legacy-waterfall-v1"）を明示する。
   * config自体が取得不能な過去保存Run（resumePayload無し等）のときのみnull。
   */
  readonly resolvedSalesModelId: SalesModelId | null;
  /** 実際に使用したSalesParameters.parametersVersion。config取得不能時はnull。 */
  readonly salesParametersVersion: string | null;
  /** tiered時のみTieredMarketAllocationParameters.parametersVersion。legacy・取得不能時はnull。 */
  readonly tierParametersVersion: string | null;
  readonly sourceCommit: string;
  readonly sourceBranch: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly requestedTurns: number;
  readonly completedTurns: number;
}

interface SalesModelIdentityFields {
  readonly configuredSalesModelId: SalesModelId | null;
  readonly resolvedSalesModelId: SalesModelId | null;
  readonly salesParametersVersion: string | null;
  readonly tierParametersVersion: string | null;
}

/** config自体が取得できない過去保存Run向けの明示的な「取得不能」値（0で埋めない・推測しない）。 */
const SALES_MODEL_IDENTITY_UNAVAILABLE: SalesModelIdentityFields = {
  configuredSalesModelId: null,
  resolvedSalesModelId: null,
  salesParametersVersion: null,
  tierParametersVersion: null,
};

/**
 * configから実際に使われたSalesParametersを解決し、そこから導出できる識別値だけを返す。
 * 判定ロジック自体はsalesParametersFor（唯一の計算箇所）に委譲する。
 */
function resolveSalesModelIdentity(config: CompanyLabConfig): SalesModelIdentityFields {
  const resolvedParameters = salesParametersFor(config);
  return {
    configuredSalesModelId: config.salesModelId ?? null,
    // 【salesParamsOverride】診断専用・in-memory限定（永続schemaに存在しない）フィールドが
    // 効いている場合、実際に使われたSalesParametersはsalesModelIdレジストリの外にあり、
    // 2値のSalesModelId型では表現できない。Export対象はすべて永続化されたconfigから
    // 読むため、この分岐は実運用のExportでは到達しない（保存されたconfigに
    // salesParamsOverrideが乗ることは無い）。到達した場合も推測で埋めずnullにする。
    resolvedSalesModelId: config.salesParamsOverride ? null : (config.salesModelId ?? "legacy-waterfall-v1"),
    salesParametersVersion: config.salesParamsOverride ? null : resolvedParameters.parametersVersion,
    tierParametersVersion: config.salesParamsOverride ? null : (resolvedParameters.tieredMarketAllocation?.parametersVersion ?? null),
  };
}

function currentSourceCommit(): string {
  // 【Vercel Git Integration】next.config.tsがVERCEL_GIT_COMMIT_SHAをビルド時に
  // NEXT_PUBLIC_SOURCE_COMMITへ焼き込む（AI Analysis Packが既存で使っている経路と同じ。
  // companyLabAdminExcelBuilder.ts側のgit実行時サブプロセス方式は.gitがデプロイ物に
  // 含まれないVercel serverless環境では機能しないため、Export Run Identityの
  // SSoTとしてはこちらを使う）。
  return process.env.NEXT_PUBLIC_SOURCE_COMMIT ?? "UNKNOWN";
}

function currentSourceBranch(): string {
  return process.env.NEXT_PUBLIC_SOURCE_BRANCH ?? "UNKNOWN";
}

/**
 * Company Lab系（labId・CompanyLabPersistedStateV1）向けのRun Identity。
 * configは常に取得可能（CompanyLabPersistedStateV1.configはtop-level必須フィールド）。
 */
export function buildExportRunIdentityFromCompanyLabConfig(
  config: CompanyLabConfig,
  scenarioVersion: string,
  completedTurns: number
): ExportRunIdentity {
  return {
    ...resolveSalesModelIdentity(config),
    sourceCommit: currentSourceCommit(),
    sourceBranch: currentSourceBranch(),
    scenarioId: config.scenarioId,
    scenarioVersion,
    seed: config.seed,
    requestedTurns: config.turns,
    completedTurns,
  };
}

/** Simulation Run系（Management Console / Independent Player Flow）向けのRun Identity入力。 */
export interface SimulationRunIdentityFields {
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly requestedTurns: number;
  readonly completedTurns: number;
}

/**
 * Simulation Run系向けのRun Identity。configは、schemaVersion 3以降のresumePayloadを
 * 持つRunのみ取得可能（resumePayload.state.configは履歴windowingの対象外＝常に完全な値）。
 * schemaVersion 1/2の旧保存Run（resumePayload自体が無い）ではconfigをundefinedのまま渡す
 * ことで、salesModel関連フィールドが明示的に「取得不能」（null）になる
 * （legacyと決めつけない）。
 */
export function buildExportRunIdentityFromSimulationRun(
  run: SimulationRunIdentityFields,
  config: CompanyLabConfig | undefined
): ExportRunIdentity {
  return {
    ...(config ? resolveSalesModelIdentity(config) : SALES_MODEL_IDENTITY_UNAVAILABLE),
    sourceCommit: currentSourceCommit(),
    sourceBranch: currentSourceBranch(),
    scenarioId: run.scenarioId,
    scenarioVersion: run.scenarioVersion,
    seed: run.seed,
    requestedTurns: run.requestedTurns,
    completedTurns: run.completedTurns,
  };
}
