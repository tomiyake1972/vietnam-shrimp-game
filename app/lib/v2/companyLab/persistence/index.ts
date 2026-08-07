// ShrimpX V2 — 会社ラボ専用永続化モデル エントリポイント（Phase 8C-1、Phase 8C-2で拡張）
//
// 会社ラボ（app/v2/company-lab/）の永続化のための保存モデル・Repository・原子
// コミット基盤。実際の四半期処理フローへの接続（Application Service）は
// app/lib/v2/companyLab/application/companyLabQuarterFlowService.tsが担う
// （Phase 8C-2）。API route・UIへの接続は8C-3以降。
//
// 想定される呼び出し方（Application/API層からの利用イメージ。本モジュール
// 自身はRedis実クライアント・APIには一切依存しない）:
//
//   const repo = createInMemoryCompanyLabStateRepository(); // またはcreateCompanyLabStateRepository(deps)
//   const service = createCompanyLabQuarterFlowService({ repository: repo }); // application/参照
//   await service.createLab({ labId, config, now });
//   // ...ドラフト保存・提出...
//   const result = await service.processQuarter({ labId, turnId, lockToken, now, playerCompanyId, decisionsProvider });

export * from "./types";
export * from "./errors";
export { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot, snapshotHasForbiddenHistoryKeys } from "./snapshot";
export {
  validateCompanyLabPersistedState,
  validateCompanyLabQuarterHistoryEntry,
  validateCompanyLabDraftEnvelope,
  validateCompanyLabRuntimeSnapshot,
} from "./schema";
export { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState, decodeCompanyLabPersistedStateFromStored } from "./codec";
export type { AtomicQuarterCommitResult, AtomicCommitReadView, AtomicCommitDecisionInput } from "./atomicCommit";
export { decideAtomicQuarterCommit, COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT, executeAtomicQuarterCommit } from "./atomicCommit";
export type { AtomicCreateLabResult } from "./atomicCreateLab";
export { COMPANY_LAB_CREATE_LAB_LUA_SCRIPT, executeAtomicCreateLab } from "./atomicCreateLab";
export { COMPANY_LAB_RELEASE_LOCK_LUA_SCRIPT, acquireProcessingLockOnRedis, releaseProcessingLockOnRedis } from "./processingLock";
export type {
  CompanyLabStateRepository,
  CompanyLabQuarterCommitInput,
  CreateCompanyLabInput,
  CompanyLabHistoryPageInput,
  CompanyLabHistoryPage,
  AcquireProcessingLockInput,
} from "./repository";
export { createInMemoryCompanyLabStateRepository, sliceHistoryPageTurns } from "./repository";
export { createCompanyLabStateRepository } from "./redisRepository";
export type { CompanyLabStateRepositoryDependencies } from "./redisRepository";
