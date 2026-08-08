import type { NextConfig } from "next";

/**
 * 【相談役AI（Management Advisor AI）のknowledge retrievalが実行時に読むファイル】
 *
 * これらはどのモジュールからもimportされていない（fsで動的に読む）ため、Next.jsの
 * file tracingでは既定でserverless bundleに含まれない。含めない場合、Vercel上では
 * 相談役AIは「参照できませんでした」と答えることになる（捏造はしないが機能しない）。
 * ローカル開発では process.cwd() 直下に実体があるためこの設定が無くても動くので、
 * 差異に気づきにくい点に注意。
 *
 * ・docs/**\/*.md … 開発記録・正式仕様（docStore.ts）
 * ・app/lib/v2 の一部 … 現行実装のソース（sourceCodeStore.ts の SOURCE_CODE_WHITELIST）
 *   ソースの .ts はビルド後のFunctionには残らないため、明示的に含める必要がある。
 *   whitelistと下のリストは必ず一致させること（片方だけ増やさない）。
 */
const ADVISOR_RUNTIME_FILES: readonly string[] = [
  "./docs/**/*.md",
  "./app/lib/v2/sales/**/*.ts",
  "./app/lib/v2/production/**/*.ts",
  "./app/lib/v2/rawMaterials/**/*.ts",
  "./app/lib/v2/finance/**/*.ts",
  "./app/lib/v2/financing/**/*.ts",
  "./app/lib/v2/capex/**/*.ts",
  "./app/lib/v2/market/**/*.ts",
  "./app/lib/v2/quality/**/*.ts",
  "./app/lib/v2/turn/**/*.ts",
  "./app/lib/v2/companyLab/standardAi/**/*.ts",
];

const nextConfig: NextConfig = {
  /**
   * 【2つのルートに設定している理由】
   * 相談役AIは2経路から呼ばれる。
   *   (1) /api/.../advisor            … REST API経路
   *   (2) /v2/company-lab/play/[labId] … 画面のServer Action（askAdvisorAction）経路
   * Server Actionは「そのページのFunction」の中で実行されるため、(1)にだけ設定しても
   * 実際にUIが使う(2)にはファイルが含まれない。両方に設定する必要がある。
   *
   * 他のルートのbundleは太らせない（この2つに限定している）。
   */
  outputFileTracingIncludes: {
    "/api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/advisor": [...ADVISOR_RUNTIME_FILES],
    "/v2/company-lab/play/[labId]": [...ADVISOR_RUNTIME_FILES],
  },
};

export default nextConfig;
