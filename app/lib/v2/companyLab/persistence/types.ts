// ShrimpX V2 — 会社ラボ専用永続化モデル 共通型（Phase 8C-1）
//
// 目的（Phase 8C-0調査・設計、ユーザー確定事項§1・§2反映）:
//   会社ラボ（app/v2/company-lab/）は現在ブラウザのuseStateのみで状態を保持し、
//   画面再読込・中断再開・四半期履歴の閲覧のいずれにも対応していない。本モジュールは
//   その永続化のための保存モデルを、会社ラボ専用の並行した型として新設する
//   （既存のapp/lib/v2/persistence/のPersistedGameStateV2は無印/v2本番ゲーム専用の
//   形であり、会社ラボの形（scenarioState・productionState・四半期ごとの
//   CompanyQuarterRecord履歴等）とは差異が大きいため拡張しない。Phase 8C-0完了
//   報告§12参照）。
//
// 【最重要の設計修正（ユーザー指示）】
//   history（CompanyLabState.historyだけでなく、後述のproductionState.historyも
//   含む）を、四半期履歴エントリの処理前・処理後スナップショットへ絶対に含めない。
//   含めると、四半期が進むごとに保存量が二次関数的（またはそれ以上）に増大する
//   （各履歴エントリが「それ以前の全履歴」を再帰的に複製してしまうため）。
//   このため、CompanyLabState をそのまま使わず、専用の CompanyLabRuntimeSnapshot
//   型を新設し、生成は snapshot.ts の createCompanyLabRuntimeSnapshot() という
//   純粋関数（保存対象フィールドを明示的に組み立てる。Omit型で済ませない）に
//   一本化する。

import { PeriodV2 } from "../../core/period";
import { Product } from "../../market/types";
import { CompanyId, SalesContract } from "../../sales/types";
import { ScenarioState } from "../../scenario/types";
import { RawMaterialLot } from "../../rawMaterials/types";
import { FinishedGoodsLot } from "../../production/types";
import { QualityReliabilityState } from "../../quality/types";
import { FinanceState } from "../../finance/types";
import { FinancingState } from "../../financing/types";
import { CapexState } from "../../capex/types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabConfig, CompanyQuarterRecord } from "../types";
import type { WorkforceState } from "../workforce";
import type { ConsumerMarketCarryStateTable } from "../../market/consumerInventory";
import type { SalesForceHiringState } from "../salesForceHiring";

// ---------------------------------------------------------------------
// 0. バージョン定数
// ---------------------------------------------------------------------

/**
 * 会社ラボ専用永続化状態の現行スキーマバージョン。
 *
 * 【重要・取り違え注意】以下とは明確に別物であり、混同しないこと（Phase 8C-0
 * 完了報告§12で指摘済みの既知の紛らわしさ）。
 *   - app/lib/v2/core/version.ts の SCHEMA_VERSION_V2（無印/v2 GameSessionのスキーマ、
　*     現行値2）
 *   - app/lib/v2/persistence/types.ts の CURRENT_PERSISTED_GAME_STATE_VERSION
 *     （無印/v2本番ゲームの永続化状態スキーマ、現行値6）
 */
/**
 * バージョン履歴:
 *   v1 … Phase 8C-1 初版。
 *   v2 … 【Phase 8D-4】CompanyLabRuntimeSnapshot へ workforceState（Worker総人数）を追加。
 *        **追加的変更のみで、マイグレーション処理は不要**。
 *        validateCompanyLabPersistedState は「現行より新しいバージョン」だけを拒否するため、
 *        schemaVersion:1 の既存データはそのまま読み込める。workforceState キーが
 *        存在しない場合は空（{ companies: [] }）として復元し、
 *        restoreCompanyLabStateFromRuntimeSnapshot が確定履歴の
 *        decisions[].workerAssignments から実際の人数を復元する（推測値は作らない）。
 *   v3 … 【Phase 8F-1】CompanyLabRuntimeSnapshot へ consumerMarketState
 *        （市場別・消費国在庫・購買循環モデルのcarry state）を追加。
 *        **追加的変更のみで、マイグレーション処理は不要**（workforceStateと同じ方式）。
 *        schemaVersion:1〜2 の既存データには consumerMarketState キーが存在しない
 *        ため、schema側で全市場ゼロ値（market/consumerInventory.ts の
 *        isConsumerMarketStateEmptyがtrueと判定する組み合わせ）として復元し、
 *        restoreCompanyLabStateFromRuntimeSnapshot が確定履歴の直近四半期の
 *        marketInput.demandMarketsから決定論的に再構築する（推測値は作らない）。
 *        併せてCompanyQuarterRecord.consumerMarketRecordsもoptionalとして追加した
 *        （既存の確定履歴エントリにはこのキーが無いため）。
 *   v4 … 【Phase 8G §2】CompanyLabRuntimeSnapshot へ salesForceHiringState
 *        （会社別・営業人員総数）を追加。**追加的変更のみで、マイグレーション処理は
 *        不要**。schemaVersion:1〜3の既存データには salesForceHiringState キーが
 *        存在しないため、schema側で空（{ companies: [] }）として復元される。
 *        この機能自体がPhase 8Gで新設されたものであり、それ以前のどの四半期にも
 *        「採用」という意思決定は存在し得なかったため、workforceState・
 *        consumerMarketStateのような確定履歴からの再構築（積算・直近1件の復元）は
 *        行わない（積算しても結果は0のまま＝下記のフォールバックと完全に一致する
 *        ため不要）。restoreCompanyLabStateFromRuntimeSnapshotはスナップショットの
 *        値をそのまま返し、空の場合は会社単位でrunner.ts側（buildCompanyOwnState・
 *        advanceCompanyLabQuarter）がfixture.salesForceHeadcountTotalへ
 *        フォールバックする。併せてCompanyDecisionInput.salesForceHireCountも
 *        optionalとして追加した（既存の確定履歴エントリにはこのキーが無いため）。
 */
export const CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION = 4;

// ---------------------------------------------------------------------
// 1. ランタイムスナップショット（history非包含。§2-1・§2-2）
// ---------------------------------------------------------------------

/**
 * ProductionStateのうち、再開に必要な「現在の生きた状態」だけを持つ型。
 * 内部の`history: readonly ProductionQuarterRecord[]`を意図的に持たない。
 *
 * 【根拠（Phase 8C-1実装時追加確認§E-2）】app/lib/v2/production/runner.ts の
 * advanceProductionQuarter は `history: [...state.history, record]` として
 * 既存historyへ追記するだけであり、advanceCompanyLabQuarter・turn/・production/
 * 配下のいずれのコードも、生成した直後の最新1件（
 * `productionStateAfter.history[productionStateAfter.history.length - 1]`）以外の
 * historyの要素を一切読み取らない（grepで確認済み、ゲームロジック上の再計算・
 * 参照に使われることはない）。したがってこの内部historyを空配列として再開しても
 * シミュレーション結果は一切変わらない。
 *
 * 一方、この内部historyを保持したままだと、CompanyLabState.history（本モジュールが
 * 除外対象とする最上位のhistory）とは別に、四半期が進むごとに増え続ける重複ログを
 * 毎回のCompanyLabRuntimeSnapshotへ複製することになる。四半期履歴エントリは
 * 処理前・処理後の両方でこのスナップショットを保持するため、対処しないと
 * turn N番目の履歴エントリが埋め込むproductionState.historyの長さはN、
 * 40四半期分の合計は1+2+...+40=820件分の重複となり、"history"というキー名こそ
 * 出現しないものの、本Phaseが防止しようとしている「保存量の二次関数的増大」を
 * 別のフィールド名の下で再現してしまう。詳細・実測値はPhase 8C-1完了報告§D・§E参照。
 */
export interface CompanyLabProductionRuntimeSnapshot {
  readonly currentPeriod: PeriodV2;
  readonly finishedGoodsLots: readonly FinishedGoodsLot[];
}

/**
 * CompanyLabStateのうち、再開に必要な「現在状態」だけを持つ型。
 * `config`（永続化状態の最上位に別途保持するため）と `history`（本Phaseの最重要
 * 設計修正により絶対に含めない）を除いた11フィールドで構成する
 * （CompanyLabState全13フィールド − config − history = 11）。
 *
 * 生成は必ず snapshot.ts の createCompanyLabRuntimeSnapshot() を経由すること。
 * 型を `Omit<CompanyLabState, "config" | "history">` にするだけでは、実装者が
 * 誤ってCompanyLabStateをそのまま渡した場合にhistoryが実行時オブジェクトへ
 * 残ってしまう危険があるため、明示的な専用型として独立させてある。
 */
export interface CompanyLabRuntimeSnapshot {
  readonly currentPeriod: PeriodV2;
  readonly scenarioState: ScenarioState;
  readonly contracts: readonly SalesContract[];
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly productionState: CompanyLabProductionRuntimeSnapshot;
  readonly lastQuarterActualProduction: Readonly<Record<CompanyId, Readonly<Partial<Record<Product, number>>>>>;
  readonly qualityState: QualityReliabilityState;
  readonly financeState: FinanceState;
  readonly financingState: FinancingState;
  readonly capexState: CapexState;
  /**
   * 【Phase 8D-4・schemaVersion 2で追加】会社別・工場別のWorker総人数。
   * 会社数×工場数ぶんの小さなスカラー集合であり、四半期ごとに増え続けることはない
   * （履歴エントリへ2回複製されても保存量への影響は無視できる）。
   * schemaVersion:1 のデータにはこのキーが無いため、schema側で空として復元する。
   */
  readonly workforceState: WorkforceState;
  /**
   * 【Phase 8F-1・schemaVersion 3で追加】市場別（CN/US/EU/JP/OTHER）の
   * 消費国在庫・購買循環モデルのcarry state（期首在庫・前期消費実績・価格履歴）。
   * schemaVersion:1〜2 のデータにはこのキーが無いため、schema側で全市場ゼロ値
   * として復元する（market/consumerInventory.ts isConsumerMarketStateEmpty参照）。
   */
  readonly consumerMarketState: ConsumerMarketCarryStateTable;
  /**
   * 【Phase 8G §2・schemaVersion 4で追加】会社別の営業人員総数。会社数ぶんの
   * 小さなスカラー集合であり、四半期ごとに増え続けることはない
   * （履歴エントリへ2回複製されても保存量への影響は無視できる）。
   * schemaVersion:1〜3 のデータにはこのキーが無いため、schema側で空として復元する。
   */
  readonly salesForceHiringState: SalesForceHiringState;
  readonly isComplete: boolean;
}

// ---------------------------------------------------------------------
// 2. ドラフト（§3-2）
// ---------------------------------------------------------------------

/**
 * 会社ラボのドラフト（入力中の意思決定一式）の保存用エンベロープ。
 *
 * 【意図的な設計判断】`draft`本体の具体的な型（app/v2/company-lab/decisionDraft.ts
 * の CompanyDecisionDraft）は、UI層（app/v2/配下）で定義されている。本モジュールは
 * app/lib/v2/配下の純粋ドメイン層であり、UI層の型へ依存すると既存のlib/UI分離
 * （companyLab等の他モジュールが一貫して守っている方針）を破ることになるため、
 * ここでは意図的に`unknown`として保持する。具体的な型としての検証・キャストは、
 * 8C-2でAPIルート・Application Serviceを実装する際に、decisionDraft.tsを
 * importできるapp/v2側またはapplication層で行う想定（本Phaseでは配線しない）。
 */
export interface CompanyLabDraftEnvelope {
  readonly labId: string;
  readonly period: PeriodV2;
  readonly turnId: string;
  readonly revision: number;
  readonly draft: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 正式提出前はnull。正式提出された瞬間にISO8601文字列が入る。 */
  readonly submittedAt: string | null;
}

// ---------------------------------------------------------------------
// 3. 四半期確定履歴（§2-2・§5）
// ---------------------------------------------------------------------

/**
 * プレイヤー提出とAI提案の差分要約（将来のAI提案比較機能のための型のみ先行定義。
 * 実際の差分計算ロジックはPhase 8C-1の対象外・未実装。フィールド構成は今後の
 * UI要件に応じて変更されうる暫定型）。
 */
export interface DecisionDiffSummary {
  readonly hasDifferences: boolean;
  readonly changedFieldPaths: readonly string[];
}

/**
 * 確定四半期履歴1件分。processedAt以降は追記専用・不変（Repository層で上書きを
 * 拒否する。atomicCommit.ts参照）。GM訂正・ロールバックの実操作は本Phaseの対象外
 * だが、`correctionOf`等を後から追加できる閉じていない設計にしてある
 * （8C-1では未使用のフィールドを先行実装しない、というユーザー指示に従い、
 * 本Phaseでは追加しない）。
 */
export interface CompanyLabQuarterHistoryEntry {
  readonly turnId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly engineVersion: string;
  readonly schemaVersion: number;
  /** 四半期処理直前（advanceCompanyLabQuarter呼び出し前）のランタイム状態。 */
  readonly preProcessingStateSnapshot: CompanyLabRuntimeSnapshot;
  /** 四半期処理直後（advanceCompanyLabQuarter呼び出し後）のランタイム状態。 */
  readonly postProcessingStateSnapshot: CompanyLabRuntimeSnapshot;
  readonly playerSubmission: CompanyDecisionInput;
  readonly aiProposal?: CompanyDecisionInput;
  readonly diffFromAiProposal?: DecisionDiffSummary;
  readonly otherCompaniesDecisions: readonly CompanyDecisionInput[];
  readonly record: CompanyQuarterRecord;
  readonly processedAt: string;
}

// ---------------------------------------------------------------------
// 4. 現在状態・永続化状態トップレベル（§3-1）
// ---------------------------------------------------------------------

export interface CompanyLabPersistedCurrentState {
  readonly runtime: CompanyLabRuntimeSnapshot;
  /** 直近に確定処理された四半期のturnId（冪等性・二重処理防止の判定に使う）。未処理ならundefined。 */
  readonly lastProcessedTurnId?: string;
  /** 楽観的排他制御用のリビジョン番号（0始まり、コミットのたびに+1）。 */
  readonly revision: number;
}

export interface CompanyLabPersistedStateMetadata {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanyLabPersistedStateV1 {
  readonly schemaVersion: number;
  readonly engineVersion: string;
  readonly labId: string;
  readonly config: CompanyLabConfig;
  /**
   * 【ユーザー確定事項】保存する。buildCompanyFixtures(startPeriod)は現時点では
   * 決定論的だが、将来fixture生成ロジック自体が変更された場合、保存せず
   * 再導出する設計だと、過去に開始したラボが再読込のたびに異なるfixtureで
   * 再開されてしまう危険がある（engineVersionを記録する目的そのものと矛盾する）。
   * そのため明示的に保存する。
   */
  readonly fixtures: readonly CompanyFixture[];
  /**
   * 【Phase 8C-3B】このラボでプレイヤーが操作する会社。作成時に必須で指定され、
   * 以後変更されない（fixturesと同様、作成時に確定し永続化される値）。必ず
   * fixturesに含まれる会社のいずれかと一致する。曖昧なfallback（未指定時に
   * 特定の会社へ暗黙に決める等）は行わない — 8C-3A時点のBAL固定/先頭会社
   * fallbackを廃止した8C-3Bでの変更（指示§6）。
   */
  readonly playerCompanyId: CompanyId;
  readonly currentState: CompanyLabPersistedCurrentState;
  readonly draft: CompanyLabDraftEnvelope | null;
  readonly metadata: CompanyLabPersistedStateMetadata;
}

// ---------------------------------------------------------------------
// 5. 処理ロック（§7・§5-1。実際の取得/解放/TTL更新フローは8C-2対象）
// ---------------------------------------------------------------------

/**
 * 四半期処理の排他ロック状態。本Phaseでは型・Repository契約の受け皿のみ用意し、
 * 実際にロックを取得・解放・TTL更新する呼び出しコードは追加しない（§10対象外）。
 * atomicCommitの条件確認には`expectedLockToken`を任意で渡せるようにしてあり、
 * 8C-2で実際のロック取得フローと接続できる。
 */
export interface CompanyLabProcessingLockState {
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}
