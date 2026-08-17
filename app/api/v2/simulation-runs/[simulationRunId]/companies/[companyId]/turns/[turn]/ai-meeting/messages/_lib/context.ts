// ShrimpX V2 — Simulation Run AI Management Meeting API の依存関係（薄いアダプター）
//
// 認証・Repository 組み立て・例外のJSON応答化は、既存の
// simulation-runs/_lib/context.ts（withSimulationRunApiContext）をそのまま使う。
// ここで足すのは、会話artifactの永続化に要る CompanyLabRedisClient だけ
// （company-labs 側の ai-meeting/_lib/dependencies.ts と同じ方針。新しい Redis 接続
// 経路も新しい認証機構も増やさない）。

import { NextRequest, NextResponse } from "next/server";
import { withSimulationRunApiContext } from "../../../../../../../../_lib/context";
import { readAppEnvV2FromEnv } from "../../../../../../../../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../../../../../../../../lib/v2/redis/companyLabClient";
import { AiMeetingApiResult } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/session";
import { RunAiMeetingDependencies } from "./handlers";

export async function withRunAiMeetingApiContext(
  req: NextRequest,
  handlerFn: (deps: RunAiMeetingDependencies) => Promise<AiMeetingApiResult>
): Promise<NextResponse> {
  return withSimulationRunApiContext(req, async (repository) => {
    const appEnv = readAppEnvV2FromEnv();
    const redisClient = await createDefaultCompanyLabRedisClient(appEnv);
    return handlerFn({ repository, redisClient });
  });
}
