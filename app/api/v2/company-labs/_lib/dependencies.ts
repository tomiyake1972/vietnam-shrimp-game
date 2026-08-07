// ShrimpX V2 — 会社ラボ API 依存関係の生成（Phase 8C-3A）
//
// 【設計方針】
//   - 本ファイルはAPI route層専用であり、app/lib/v2配下（フレームワーク非依存の
//     ライブラリ層）には置かない。実Redis接続（@upstash/redis・環境変数）に
//     依存する組み立てコードを、各routeへ複製せずここへ集約する
//     （指示§5「同じ責務の初期化コードを各routeへ複製しない」への対応）。
//   - createCompanyLabApiDependencies()はモジュール読込時には一切呼ばれない
//     （route.tsが実際のリクエスト処理の中で呼び出すまで、環境変数チェックも
//     Redis接続も発生しない）。これにより、_lib配下の他のモジュール（validation・
//     errorResponse・decisionsProvider・handlers等）とそのテストは、実Upstash
//     認証情報が無い環境（このテスト実行環境を含む）でも安全にimport・実行できる。
//   - handlers.tsの各関数は、この関数の戻り値を「呼び出し側が注入する」形で
//     受け取る（テストでは常にin-memory Repositoryで作った依存関係を直接渡し、
//     この関数自体を経由しない）。

import { readAppEnvV2FromEnv } from "../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabClient";
import { createCompanyLabStateRepository } from "../../../../lib/v2/companyLab/persistence/redisRepository";
import { CompanyLabStateRepository } from "../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabQuarterFlowService } from "../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";

export interface CompanyLabApiDependencies {
  readonly repository: CompanyLabStateRepository;
  readonly service: CompanyLabQuarterFlowService;
}

/**
 * 実Redis（Upstash）に接続した依存関係一式を組み立てる。route.tsのハンドラー本体
 * （各HTTPメソッド関数）の中で、リクエストごとに呼び出すこと（モジュール上位や
 * サーバー起動時に一度だけ呼んでキャッシュする設計にはしない。@upstash/redisの
 * Redisクライアント自体はHTTPベースであり接続プーリングの概念を持たないため、
 * リクエストごとの生成でコスト上の問題はない）。
 *
 * APP_ENVが"production"/"staging"のいずれでもない場合（開発環境での未設定等）は
 * readAppEnvV2FromEnvがVersionValidationErrorを投げる。この関数はそれをそのまま
 * 伝播させ、呼び出し元（route.ts）でエラー応答へ変換する。
 */
export async function createCompanyLabApiDependencies(): Promise<CompanyLabApiDependencies> {
  const appEnv = readAppEnvV2FromEnv();
  const client = await createDefaultCompanyLabRedisClient(appEnv);
  const repository = createCompanyLabStateRepository({ client, appEnv });
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}
