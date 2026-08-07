// ShrimpX V2 — 会社ラボ API route.ts 共通アダプター（Phase 8C-3A）
//
// 各route.tsが個別に重複させがちな「管理トークン認証 → 依存関係の組み立て →
// ハンドラー呼び出し → 例外のJSON応答化」の定型処理を1箇所へ集約する
// （指示§5「同じ責務の初期化コードを各routeへ複製しない」対応）。
//
// 【認証方針】Company Labは本番運用の対象外の検証・調整用ツールであり
// （既存app/v2/company-lab/page.tsx自体がクライアント側の実験的画面であり、
// 永続化・API接続は本Phaseが初めて導入する）、本番環境では一切提供しない。
// 既存のassertStagingAdmin（本番なら403、非本番でも管理トークン必須）を、
// 読み取り専用のGETを含む全route（作成・一覧・状態取得・ドラフト操作・
// 四半期処理・履歴取得のすべて）に一律で適用する。V1のスナップショット
// 一覧のように読み取り系だけ認証を免除する設計も検討したが、Company Labは
// V1の「進行中ゲームを画面上で見る」ような閲覧用途を今のところ持たず、
// Redisへの新規アクセス経路を極力絞る（露出面を最小化する）ほうが安全側と
// 判断した。UIからの利用が具体化するPhase 8C-3Bで、この認証方針は再検討する。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingAdmin } from "../../../../lib/stagingAdmin";
import { CompanyLabApiDependencies, createCompanyLabApiDependencies } from "./dependencies";
import { ApiResult } from "./handlers";

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（依存関係の初期化に失敗しました）。時間をおいて再度お試しください。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

/**
 * 管理トークン認証 → 依存関係組み立て → handlerFn呼び出し → NextResponse変換、
 * を一括して行う。handlerFnはhandlers.tsのhandle*関数を想定し、例外を投げず
 * ApiResult（{status, body}）を返す契約になっているが、依存関係の組み立て自体
 * （environment変数未設定・Redis接続不可等）が投げる例外はここで捕まえ、
 * 内部詳細を応答へ含めない500として返す。
 */
export async function withApiContext(req: NextRequest, handlerFn: (deps: CompanyLabApiDependencies) => Promise<ApiResult>): Promise<NextResponse> {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: auth.error } }, { status: auth.status });
  }

  let deps: CompanyLabApiDependencies;
  try {
    deps = await createCompanyLabApiDependencies();
  } catch (e) {
    // 環境変数未設定・Redis接続不可等はサーバーログに残す（応答には出さない）。
    console.error("[company-lab api] 依存関係の組み立てに失敗しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } }, { status: 500 });
  }

  try {
    const result = await handlerFn(deps);
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    // handlers.ts側の各関数はdomainエラーをmapDomainErrorToHttpで捕まえてApiResultへ
    // 変換する契約だが、想定外の例外（バグ等）がここまで伝播した場合に備え、
    // クライアントへは常にJSON応答を返す（生の例外・HTMLエラーページを返さない。
    // V1のapp/api/game/route.tsと同じ方針）。
    console.error("[company-lab api] ハンドラーで予期しないエラーが発生しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_UNEXPECTED_ERROR } }, { status: 500 });
  }
}

/** リクエストボディをJSONとしてパースする。パース失敗時はnullを返す（route.ts側で400扱いにする）。 */
export async function parseJsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
