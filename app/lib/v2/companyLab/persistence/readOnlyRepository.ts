// ShrimpX V2 — 会社ラボ 読み取り専用Repository（エクスポートAPI専用）
//
// 【目的】/api/v2/exports/** は読み取り専用のエクスポートAPIであり、ゲーム状態の
// 作成・更新・削除・初期化・復元を一切行えない構造にする（三宅さんの指示）。
// 既存のCompanyLabStateRepository（createLab・saveDraft・commitQuarterAtomically等の
// 書き込みメソッドを含む）をそのままエクスポートAPI層へ渡すと、将来のコード変更で
// 誤って書き込みメソッドを呼んでしまう余地が残る。本モジュールは、読み取りメソッド
// だけを持つ別インターフェース CompanyLabReadOnlyRepository を定義し、
// toReadOnlyCompanyLabRepository() で「読み取りメソッドの参照だけをコピーした
// 新しいオブジェクト」を作る。これにより：
//   - 型レベル: CompanyLabReadOnlyRepositoryを受け取るコードは、そもそも
//     createLab等を呼び出すコードを書いてもコンパイルが通らない。
//   - 実行時レベル: 生成されたオブジェクト自体に createLab 等のプロパティが
//     存在しない（prototype継承ではなく、許可したメソッドだけを持つ新しい
//     オブジェクトリテラルとして組み立てるため）。テストで
//     `"createLab" in readOnlyRepo` が false であることを直接検証できる。

import { CompanyLabHistoryPage, CompanyLabHistoryPageInput, CompanyLabStateRepository } from "./repository";
import { CompanyLabPersistedStateV1, CompanyLabQuarterHistoryEntry } from "./types";

/**
 * エクスポートAPIが必要とする読み取り操作だけを持つRepository。
 * 【意図的に含めないもの】createLab・saveDraft・loadDraft（draftは未確定の
 * 編集中データであり「確定済み」ではないため対象外）・acquireProcessingLock・
 * releaseProcessingLock・commitQuarterAtomically・loadFullHistory（診断用途、
 * 数十MB規模になりうるため今回のスコープ外）。
 */
export interface CompanyLabReadOnlyRepository {
  /** ラボ現在状態の読込（config・fixtures・currentState・metadata。draftは含まない）。 */
  loadCurrentState(labId: string): Promise<CompanyLabPersistedStateV1>;
  /** 存在確認。 */
  labExists(labId: string): Promise<boolean>;
  /** 単一履歴の読込。 */
  loadHistoryEntry(labId: string, turn: number): Promise<CompanyLabQuarterHistoryEntry>;
  /** 履歴indexの読込（昇順のturn番号一覧）。 */
  loadHistoryIndex(labId: string): Promise<readonly number[]>;
  /** 直近（最大turn）の確定履歴エントリの読込。 */
  loadLatestHistoryEntry(labId: string): Promise<CompanyLabQuarterHistoryEntry | null>;
  /** 履歴のページング読込。 */
  loadHistoryPage(labId: string, input: CompanyLabHistoryPageInput): Promise<CompanyLabHistoryPage>;
}

/**
 * 既存のCompanyLabStateRepositoryから、読み取りメソッドの参照だけを持つ新しい
 * オブジェクトを組み立てる。書き込みメソッドへの参照はこのオブジェクトのどこにも
 * 含まれない（スプレッド構文を使わず、許可した6メソッドだけを1つずつ列挙する）。
 */
export function toReadOnlyCompanyLabRepository(repository: CompanyLabStateRepository): CompanyLabReadOnlyRepository {
  return {
    loadCurrentState: (labId: string) => repository.loadCurrentState(labId),
    labExists: (labId: string) => repository.labExists(labId),
    loadHistoryEntry: (labId: string, turn: number) => repository.loadHistoryEntry(labId, turn),
    loadHistoryIndex: (labId: string) => repository.loadHistoryIndex(labId),
    loadLatestHistoryEntry: (labId: string) => repository.loadLatestHistoryEntry(labId),
    loadHistoryPage: (labId: string, input: CompanyLabHistoryPageInput) => repository.loadHistoryPage(labId, input),
  };
}
