// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） UI用依存関係解決
//
// 【原則】実際のブラウザ操作 → 永続化されたRedis状態、という指示§14の完成条件に
// 対応するため、通常はapp/api/v2/company-labs/_lib/dependencies.tsのcreateCompanyLabApiDependencies
// （実Upstash接続）をそのまま呼び出す。UI層独自のRedis接続コード・環境変数読み込みは
// 一切追加しない（指示§7・§16「重複実装しない」）。
//
// 【指示§14の明示的な例外】実Upstash認証情報が無い検証環境（本開発環境を含む）では
// createCompanyLabApiDependencies()自体がVersionValidationError等で例外を投げ、
// ブラウザE2E検証が一切できなくなる。指示§14は「実Redis E2Eが環境変数不足で不可能な
// 場合、単に停止せず、in-memoryまたは既存の安全なテスト用依存性注入を使ってUI統合
// フローを検証し、実環境で残る検証項目を明記すること」を明示的に求めている。
//
// これに対応するため、以下の両方が真の場合に限り、既存のcreateInMemoryCompanyLabStateRepository
// （Phase 8C-1からの既存テスト用実装。新規実装ではない）へフォールバックする:
//   1. 本番環境でないこと（isProduction は checkStagingAdminToken と同じ判定源）
//   2. 明示的な環境変数 COMPANY_LAB_UI_E2E_IN_MEMORY=1 が設定されていること
//      （デフォルトでは絶対にin-memoryへフォールバックしない。誤って本番相当の
//      staging環境でin-memoryへ落ちて「保存したはずのデータが消える」事故を防ぐ）。
//
// 通常のJSON API route（app/api/v2/company-labs/**/route.ts）はこの関数を一切
// 経由しない（既存のdependencies.tsを直接使い続ける）。このフォールバックは
// 新しいUI（app/v2/company-lab/play/**）だけのものであり、Phase 8C-3Aで受入済みの
// API層の挙動には一切影響しない。

import { isProduction } from "../../../../lib/env";
import { CompanyLabApiDependencies, createCompanyLabApiDependencies } from "../../../../api/v2/company-labs/_lib/dependencies";
import { createInMemoryCompanyLabStateRepository } from "../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";

const E2E_IN_MEMORY_ENV_FLAG = "COMPANY_LAB_UI_E2E_IN_MEMORY";

// プロセス内で使い回す、in-memory時のみのシングルトン。モジュールトップレベルでは
// 生成しない（isProduction判定・env読み込みを、実際にこの関数が呼ばれるまで遅延させる。
// dependencies.ts冒頭コメントの「モジュール読込時には一切呼ばれない」方針を踏襲）。
let inMemoryDependenciesSingleton: CompanyLabApiDependencies | null = null;

function isE2eInMemoryModeEnabled(): boolean {
  return !isProduction && process.env[E2E_IN_MEMORY_ENV_FLAG] === "1";
}

export function isCompanyLabUiRunningInMemoryForE2e(): boolean {
  return isE2eInMemoryModeEnabled();
}

/**
 * UI（Server Component・Server Action）専用の依存関係解決。通常はcreateCompanyLabApiDependencies
 * （実Redis）をそのまま返す。COMPANY_LAB_UI_E2E_IN_MEMORY=1が設定された非本番環境でのみ、
 * プロセス内で使い回すin-memory Repositoryへフォールバックする（ブラウザを再読み込みしても
 * 同じサーバープロセス内であればデータは保持される。ただしサーバー再起動で消える点は
 * 実Redisと異なる。E2E専用の一時フォールバックであることをドキュメントで明記する）。
 */
export async function resolveCompanyLabUiDependencies(): Promise<CompanyLabApiDependencies> {
  if (isE2eInMemoryModeEnabled()) {
    if (!inMemoryDependenciesSingleton) {
      const repository = createInMemoryCompanyLabStateRepository();
      const service = createCompanyLabQuarterFlowService({ repository });
      inMemoryDependenciesSingleton = { repository, service };
    }
    return inMemoryDependenciesSingleton;
  }
  return createCompanyLabApiDependencies();
}
