// ShrimpX V2 — Decision Studio: INFO（読み取り専用の会社・市場情報タブ）
//
// 【計算しない】feature/v2-32q-management-consoleに既にある期初情報component群
// （OpeningBalanceSheetPanel・DepreciableAssetsPanel・OpeningMarketInfoPanel・
// ObservedMarketDemandPanel・OpeningCompanyStatePanel）をそのまま並べるだけ。
// 新しい計算ロジック・新しい集計式は一切作らない。
//
// 【呼び出し元によって渡せる情報量が異なる理由】PlayerScreenClient.tsx（実プレイ画面）は
// すでにCompanyLabState全体からdomesticReferencePrice等を組み立てた
// OpeningInfoViewModelを持っているため、それをそのまま渡せる。GM画面（page.tsx）や
// PlayerWorkspace.tsxはより軽量なデータしか持たないため、openingInfoを省略できる
// （その場合はOpeningCompanyStatePanelだけを表示し、BS/償却資産/市場情報パネルは
// 省略する。値を捏造しない）。

import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../../../lib/v2/companyLab";
import OpeningCompanyStatePanel from "../OpeningCompanyStatePanel";
import { DepreciableAssetsPanel, ObservedMarketDemandPanel, OpeningBalanceSheetPanel, OpeningMarketInfoPanel } from "../OpeningInfoPanels";
import type { OpeningInfoViewModel } from "../../play/_lib/openingInfoViewModel";
import { AREA_TONES } from "../panelStyles";

interface InformationScreenProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly turn?: number;
  readonly publicInfo?: PublicMarketInfo;
  /**
   * 呼び出し元（PlayerScreenClient.tsx）がすでに持っているBS・償却資産明細・市場情報の
   * まとめ。省略時はOpeningCompanyStatePanel（自社状態の要約）のみを表示する。
   */
  readonly openingInfo?: OpeningInfoViewModel;
}

export default function InformationScreen({ fixture, ownState, turn, publicInfo, openingInfo }: InformationScreenProps) {
  const tone = AREA_TONES.info;
  return (
    <div className="space-y-3" data-testid="decision-studio-info-screen">
      <div className={`rounded-lg p-3 ${tone.section}`}>
        <div className="mb-1 flex items-center gap-2">
          <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
          <span className={`text-sm font-semibold ${tone.heading}`}>INFO（読み取り専用）</span>
        </div>
        <p className="text-[11px] text-gray-500">
          backlog・市場情報・完成品在庫・原料在庫・工場・Worker・資金/負債・投資状況を確認できます。ここでは何も入力しません。
        </p>
      </div>

      {openingInfo ? (
        <>
          <OpeningBalanceSheetPanel bs={openingInfo.balanceSheet} turn={openingInfo.turn} />
          <DepreciableAssetsPanel assets={openingInfo.depreciableAssets} />
          <OpeningMarketInfoPanel info={openingInfo.marketInfo} referencePrice={openingInfo.domesticReferencePrice} />
          <ObservedMarketDemandPanel observed={openingInfo.observedMarketDemand} />
        </>
      ) : (
        <p className="text-xs text-gray-500">
          この画面では貸借対照表・償却資産明細・市場情報の詳細を組み立てるための情報（CompanyLabState全体）が渡されていません。以下の自社状態要約のみ表示します。
          {publicInfo && ` （参考: 国内原料前期価格 $${publicInfo.vietnamDomesticPriorPrice.toFixed(2)}/kg）`}
        </p>
      )}

      {turn !== undefined ? (
        <OpeningCompanyStatePanel ownState={ownState} fixture={fixture} turn={turn} />
      ) : (
        <p className="text-xs text-gray-500">turn番号が未確定のため、自社状態要約（backlog・原料在庫・完成品在庫・工場・Worker・資金/負債）を表示できません。</p>
      )}
    </div>
  );
}
