// ShrimpX V2 — 永続化状態・シリアライズ契約 共通型（Phase 5.6）
//
// app/lib/v2/turn/（ターン・オーケストレーター）・app/lib/v2/turnState/
// （状態遷移層）の外側、将来のRedis/API層の内側に位置する、
// 「継続的に保存すべきゲーム状態」だけを表す純粋な型とシリアライズ契約。
// Redis・Next.js API・ブラウザAPIには一切依存しない。
//
// 【重要】TurnOrchestratorInputをそのまま保存しない。TurnOrchestratorInputは
// 「毎ターン新たに与える市場入力・シナリオ変数・会社別提出計画」を含んでおり、
// これらは（a）外部シナリオエンジンや会社の意思決定によって毎ターン新規に
// 決まるものであり、（b）1ターン前の状態からは再構成できない・する必要もない
// （提出計画は再送されるものであり、「過去の提出計画」を保存し続ける必然性が
// ない）。そのため、本モジュールは「ターンをまたいで生き続ける最小限の状態」
// だけを PersistedGameStateV2 として定義し、それ以外は
//   - 毎ターン外部から与えられる入力（ExternalTurnInput、本ファイルで定義）
//   - 実行時にのみ存在する中間結果・debug情報（TurnOrchestratorResult.debug等）
// として、保存対象から明確に除外する。

import { PeriodV2 } from "../core/period";
import { SalesContract } from "../sales/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { AquacultureStockingPlanEntry, ImportOrderInput } from "../rawMaterials/types";
import { CompanySalesPlanEntry } from "../sales/types";
import { MarketQuarterInput } from "../market/types";
import { QualityReliabilityState } from "../quality/types";
import { CompanyFinanceState } from "../finance/types";
import {
  DomesticPurchaseIntentSource,
  TurnOrchestratorParameters,
  TurnScenarioVariables,
} from "../turn/types";

// ---------------------------------------------------------------------
// 1. スキーマバージョン
// ---------------------------------------------------------------------

/**
 * PersistedGameStateV2の現行スキーマバージョン。将来フィールドを追加・変更する
 * 際は、このバージョンを上げ、schema.tsのdecode側にバージョンごとの分岐
 * （マイグレーション）を追加できる構造にしてある（本Phaseではマイグレーション
 * 自体は未実装。§9「将来のスキーママイグレーション方針」参照）。
 */
/**
 * 【バージョン履歴】
 *   1: Phase 5.7 初版。
 *   2: Phase 6.3。SalesContractへオプショナルなcostSnapshot（契約時予想原価
 *      スナップショット）を追加。バージョン1のデータは追加フィールドが無いだけで
 *      そのまま読める（マイグレーション不要の追加的変更）。
 *   3: Phase 7A。品質・顧客信頼・納期信頼性・増産履歴（qualityReliability、
 *      quality/types.tsのQualityReliabilityStateをそのまま再利用）を追加。
 *      バージョン1・2のデータにはqualityReliabilityキー自体が存在しないため、
 *      decode時にqualityByCompanyProduct/trustByCompanyMarket/rampHistoryが
 *      いずれも空配列の安全な初期値を補う（schema.ts参照、マイグレーション
 *      不要の追加的変更）。
 *
 *      【重要・アーキテクチャ上の既知の限界】本フィールドはPersistedGameStateV2
 *      （app/lib/v2/turn・turnStateが扱う、無印/v2ゲームの永続化状態）の一部
 *      として定義される。一方、Phase 7Aの品質・信頼・納期信頼性ロジック自体は
 *      app/lib/v2/companyLab/（会社ラボ統合テスト環境）のターン処理
 *      （advanceCompanyLabQuarter）でのみ計算されており、companyLab自体は
 *      現時点でいかなる永続化層にも接続されていない（LabBanner等のUI上の
 *      既存コメントの通り、ブラウザ内の決定論的計算のみ）。したがって本schema
 *      v3は「無印/v2ゲームの永続化契約として品質状態を保存できる形を用意する」
 *      という指示（仕様書§永続化）を満たすために追加したものであり、
 *      無印/v2ゲーム自身のturn/runTurnはPhase 7Aの品質ロジックを一切呼ばず、
 *      qualityReliabilityへ実際に値を書き込むことはない（常に安全な初期値の
 *      ままとなる）。companyLabの計算結果をこのフィールドへ実際に書き込む
 *      配線は本Phaseの対象外（Redis/API実配線は仕様書で明示的に対象外と
 *      されている）。詳細はdocs/v2/QUALITY_RELIABILITY_ARCHITECTURE_v0.1.md
 *      §永続化を参照。
 *   4: Phase 8A。会社別の財務状態（financeStates、finance/types.tsの
 *      CompanyFinanceStateをそのまま再利用。現金・売掛/買掛・借入・固定資産・
 *      利益剰余金・完成品原価台帳）を追加。バージョン1〜3のデータには
 *      financeStatesキー自体が存在しないため、decode時に空配列（財務状態
 *      未初期化）の安全な初期値を補う（キーの有無で判定する追加的変更。
 *      旧schemaを読み込んだ場合は「財務未使用」として扱い、companyLab側が
 *      必要時にbuildInitialCompanyFinanceStateで整合する初期財務状態を構築
 *      する）。schemaVersion 3までと同様、無印/v2ゲーム自身のrunTurnは財務
 *      ロジックを呼ばないため、companyLab→Redis/API実配線（対象外）までは
 *      本フィールドへ実際に値が書き込まれることはない。
 */
export const CURRENT_PERSISTED_GAME_STATE_VERSION = 4;

// ---------------------------------------------------------------------
// 2. 永続化状態
// ---------------------------------------------------------------------

/** ターン完了・実行に関する最小限のメタ状態。 */
export interface PersistedGameStateExecution {
  /** これまでに完了したターン数（0始まり）。 */
  readonly completedTurnCount: number;
  /** 最後に完了したターンのPeriod（1ターンも完了していない初期状態ではundefined）。 */
  readonly lastCompletedPeriod?: PeriodV2;
  /** 最後に適用したターン実行識別子（冪等性境界の判定に使う。§7参照）。 */
  readonly lastTurnExecutionId?: string;
}

/** 作成・更新日時（ISO 8601文字列）。 */
export interface PersistedGameStateMetadata {
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * ターンをまたいで保存すべき、V2ゲームの永続化状態。Redis保存・API応答・
 * セーブデータのいずれの実装からも、この型とencode/decode関数だけを介して
 * 読み書きされることを想定する（本モジュール自体はRedis/APIを一切呼ばない）。
 *
 * 【意図的に含めないもの】（詳細はdocs/v2アーキテクチャ文書 §16参照）
 *   - 会社別の販売・国内買付・輸入・養殖の当該ターン提出計画
 *   - Phase1の当該ターン市場入力（MarketQuarterInput）・シナリオ変数
 *   - 市場結果・販売結果・国内買付配分結果（再計算可能な派生結果）
 *   - debug情報・一時的な必要原料量サマリー
 *   - 関数・RandomStreamのインスタンス本体
 *   - RedisキーやAPI固有の情報
 */
export interface PersistedGameStateV2 {
  readonly schemaVersion: number;
  readonly gameId: string;
  readonly scenarioId: string;
  readonly currentPeriod: PeriodV2;
  readonly seed: string;
  readonly contracts: readonly SalesContract[];
  readonly rawMaterialLots: readonly RawMaterialLot[];
  /**
   * Phase 7A（schemaVersion 3）。品質・顧客信頼・納期信頼性・増産履歴。
   * 常に存在する（v1/v2データをdecodeする際は安全な初期値＝空配列一式を補う。
   * 上記バージョン履歴のコメント参照）。
   */
  readonly qualityReliability: QualityReliabilityState;
  /**
   * Phase 8A（schemaVersion 4）。会社別の財務状態。常に存在する
   * （v1/v2/v3データをdecodeする際は空配列＝財務状態未初期化を補い、
   * 利用側が必要時に整合する初期財務状態を構築する。上記バージョン履歴参照）。
   */
  readonly financeStates: readonly CompanyFinanceState[];
  readonly execution: PersistedGameStateExecution;
  readonly metadata: PersistedGameStateMetadata;
}

// ---------------------------------------------------------------------
// 3. 毎ターン外部から与える入力（保存対象外）
// ---------------------------------------------------------------------

/**
 * hydrateTurnInputFromPersistedStateが「永続化状態からは注入しない」フィールド
 * だけを受け取るための入力型。currentPeriod・seed・contracts・raw material lots
 * を意図的に含めない（永続化状態側からのみ注入され、外部入力側からは上書き
 * できない構造にするため。builder.ts参照）。
 */
export interface ExternalTurnInput {
  readonly marketInput: MarketQuarterInput;
  readonly scenarioVariables?: TurnScenarioVariables;
  readonly salesPlans: readonly CompanySalesPlanEntry[];
  readonly domesticPurchaseIntentSource: DomesticPurchaseIntentSource;
  readonly importOrders: readonly ImportOrderInput[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingPlanEntry[];
  readonly parameters?: TurnOrchestratorParameters;
}
