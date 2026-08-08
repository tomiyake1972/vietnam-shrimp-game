import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 【相談役AI（Management Advisor AI）のknowledge retrieval用】
   * docs/ 配下のmarkdownは、どのモジュールからもimportされていないため、Next.jsの
   * file tracingでは既定でserverless bundleに含まれない。相談役AIは実行時に
   * これらを読んで「なぜこの仕様なのか」を開発記録から答えるため、明示的に含める。
   *
   * ここに含めない場合、Vercel上では docs/ が存在せず、相談役AIは
   * 「開発記録を参照できませんでした」と答えることになる（捏造はしないが、
   * 機能としては成立しない）。ローカル開発では process.cwd() 直下に実体があるため
   * この設定が無くても動作するので、差異に気づきにくい点に注意。
   *
   * 対象は相談役AIのAPIルートのみに限定し、他のルートのbundleを不必要に太らせない。
   */
  outputFileTracingIncludes: {
    "/api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/advisor": ["./docs/**/*.md"],
  },
};

export default nextConfig;
