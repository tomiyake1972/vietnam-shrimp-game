// ShrimpX V2 — 読み取り専用エクスポートAPI（/api/v2/exports/**） 依存関係の生成
//
// 【書き込み権限の境界】既存の app/api/v2/company-labs/_lib/dependencies.ts が
// 組み立てる CompanyLabApiDependencies は、書き込みメソッド（createLab・saveDraft・
// commitQuarterAtomically等）を含む CompanyLabStateRepository をそのまま公開する。
// エクスポートAPIはこれを絶対に直接参照してはならない（三宅さんの指示：
// 「Export ルートは書き込み可能な Company Lab Repository を直接参照しない構成にし、
// 型とテストの両方で確認する」）。
//
// 本ファイルは、実Redis接続の組み立て自体は既存コード（createDefaultCompanyLabRedisClient・
// createCompanyLabStateRepository）を再利用しつつ、route層へ渡す直前に
// toReadOnlyCompanyLabRepository()で読み取り専用インターフェースへ変換する。
// これにより、exports/_lib配下のどのファイルも CompanyLabStateRepository 型（の
// 書き込みメソッド）を型として持つ変数を扱えない。

import { readAppEnvV2FromEnv, AppEnvV2 } from "../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabClient";
import { createCompanyLabStateRepository } from "../../../../lib/v2/companyLab/persistence/redisRepository";
import { CompanyLabReadOnlyRepository, toReadOnlyCompanyLabRepository } from "../../../../lib/v2/companyLab/persistence/readOnlyRepository";
import { CompanyLabExportAuditLogger, createCompanyLabExportAuditLogger } from "../../../../lib/v2/redis/companyLabExportAuditLog";

export interface CompanyLabExportApiDependencies {
  readonly readOnlyRepository: CompanyLabReadOnlyRepository;
  readonly auditLog: CompanyLabExportAuditLogger;
  readonly appEnv: AppEnvV2;
}

/**
 * 実Redis（Upstash）に接続した、読み取り専用の依存関係一式を組み立てる。
 * route.tsのGETハンドラー本体の中で、リクエストごとに呼び出すこと
 * （既存app/api/v2/company-labs/_lib/dependencies.tsと同じ方針。モジュール上位や
 * サーバー起動時に一度だけ呼んでキャッシュしない）。
 */
export async function createCompanyLabExportApiDependencies(): Promise<CompanyLabExportApiDependencies> {
  const appEnv = readAppEnvV2FromEnv();
  const client = await createDefaultCompanyLabRedisClient(appEnv);
  const writableRepository = createCompanyLabStateRepository({ client, appEnv });
  const readOnlyRepository = toReadOnlyCompanyLabRepository(writableRepository);
  const auditLog = createCompanyLabExportAuditLogger(client, appEnv);
  return { readOnlyRepository, auditLog, appEnv };
}
