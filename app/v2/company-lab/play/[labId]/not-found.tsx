// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ラボ未発見時の表示（指示§11）

import Link from "next/link";
import LabBanner from "../../components/LabBanner";

export default function CompanyLabPlayerNotFound() {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <LabBanner />
      <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="text-lg font-semibold">ラボが見つかりません</div>
        <p className="text-sm text-gray-400">指定されたラボは存在しないか、削除された可能性があります。URLをご確認ください。</p>
        <Link href="/v2/company-lab/play" className="inline-block text-teal-400 underline text-sm">
          ラボ一覧へ戻る
        </Link>
      </div>
    </div>
  );
}
