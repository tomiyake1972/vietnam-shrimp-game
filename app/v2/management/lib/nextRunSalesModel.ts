// ShrimpX V2 — MANAGEMENT-CONSOLE-SALES-MODEL-1B
//
// Management Console の中で「新しいRunを始める」（Reset／シナリオ・seedを変えて
// 開始）ときに、新しいRunへ引き継ぐ販売市場モデルを決める純粋関数。
//
// 【新しいID・parameter・registryを作らない】ここは既存の
// CompanyLabConfig.salesModelId（値の意味は lib/v2/sales/salesModels.ts の
// immutable registry だけが持つ）を、現在のRunから次のRunへ**そのまま運ぶ**だけである。
// 変換も既定値の上書きもしない。

import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { SalesModelId } from "../../../lib/v2/sales/salesModels";

/**
 * 現在表示中のSimulation Sessionから、次に作るRunへ渡すべき salesModelId を返す。
 *
 * - 現在のRunが三層顧客価格モデルなら、そのIDをそのまま返す（scenario／seedを
 *   変えても維持する。「始め直した瞬間に従来モデルへ戻る」事故を防ぐ）。
 * - 現在のRunが従来市場モデル（salesModelId未設定を含む）なら undefined を返す。
 *   呼び出し側（createSimulationSession）は config へキー自体を作らないため、
 *   従来Runとビット単位で同一のconfigになる。
 * - 現在のRunが無い／閲覧専用（resumePayloadを持たずconfigが復元できない）Runなら
 *   undefined を返す。保存されていない値を推測して別のモデルを選ばない。
 */
export function salesModelIdForNextRun(currentSession: SimulationSession | null | undefined): SalesModelId | undefined {
  return currentSession?.state.config.salesModelId;
}
