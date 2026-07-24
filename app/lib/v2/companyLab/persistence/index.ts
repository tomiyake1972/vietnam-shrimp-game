// ShrimpX V2 — 会社ラボ専用永続化モデル エントリポイント（Phase 8C-1）
//
// 会社ラボ（app/v2/company-lab/）の永続化のための保存モデル・Repository・原子
// コミット基盤。API・UI・実際の四半期処理フローへの接続は本Phaseの対象外
// （Phase 8C-0完了報告§10のフェーズ計画のうち、8C-2以降で行う）。
//
// 想定される呼び出し方（将来のApplication/API層からの利用イメージ。本モジュール
// 自身はRedis実クライアント・APIには一切依存しない）:
//
//   const repo = createInMemoryCompanyLabStateRepository(); // またはcreateCompanyLabStateRepository(deps)
//   const runtime = createCompanyLabRuntimeSnapshot(state); // state: CompanyLabState
//   const stored = await repo.createLab({ labId, engineVersion, config, fixtures, runtime, now });
//   // ...四半期確定時...
//   const result = await repo.commitQuarterAtomically({ labId, turn, turnId, expectedRevision, nextStoredState, historyEntry });

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
export type { CompanyLabStateRepository, CompanyLabQuarterCommitInput, CreateCompanyLabInput } from "./repository";
export { createInMemoryCompanyLabStateRepository } from "./repository";
export { createCompanyLabStateRepository } from "./redisRepository";
export type { CompanyLabStateRepositoryDependencies } from "./redisRepository";
