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
// （その場合はOpeningCompanyStatePanel・簡易BSだけを表示し、償却資産/市場情報パネルは
// 省略する。値を捏造しない）。
//
// 【Opening Balance SheetをINFOタブ最上段に常時表示する理由】Management Console
// （openingInfoを渡さない呼び出し元）経由でTestplayすると、期初BSがどこにも
// 表示されずプレイ判断がしづらいという指摘があった。BS自体はownStateだけから
// 計算できる（buildOpeningBalanceSheet）ため、openingInfoの有無に関わらず
// 既存のOpeningBalanceSheetPanel・既存の計算式をそのまま使って必ず表示する。
// openingInfoがある場合はその中のbalanceSheet（同じ計算結果）を再利用し、
// 二重計算はしない。
//
// 【News（世界のニュース）も同じ理由でINFOタブ上部に常時表示する】Test26 Dynamic
// Scenarioをtestplayすると、Newsがどこにも表示されないという指摘があった。調査の
// 結果、Newsデータ自体はシナリオ側（dynamicScenario1News.ts）に存在し、GM向けの
// Management Console画面には既に配線されていたが、PLAYER Workspace（このINFO
// タブ）には一度も配線されていなかった（UI配線漏れ。scenario側のNews contract・
// 公開判定ロジックは変更していない）。openingInfoがある場合は
// openingInfo.scenarioNews（既存のtoScenarioNewsItemsが変換した結果）をそのまま
// 使い、無い場合は呼び出し元（PlayerWorkspace.tsx）がmanagement/lib/scenarioNews.ts
// 経由で組み立てた同じ形のscenarioNewsをそのまま使う。ここでは新しいNews取得・
// 変換ロジックを作らない。

import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../../../lib/v2/companyLab";
import CollapsibleSection from "../CollapsibleSection";
import OpeningCompanyStatePanel from "../OpeningCompanyStatePanel";
import { DepreciableAssetsPanel, ObservedMarketDemandPanel, OpeningBalanceSheetPanel, OpeningMarketInfoPanel } from "../OpeningInfoPanels";
import { buildOpeningBalanceSheet, type OpeningInfoViewModel, type ScenarioNewsItem } from "../../play/_lib/openingInfoViewModel";
import { AREA_TONES } from "../panelStyles";
import ScenarioNewsFeed from "./ScenarioNewsFeed";

function usd(v: number): string {
  return `$${Math.round(v).toLocaleString()}`;
}

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
  /**
   * openingInfoを渡さない呼び出し元（PlayerWorkspace.tsx）向けのNews直接指定。
   * openingInfoがある場合はopeningInfo.scenarioNewsを優先し、こちらは無視する。
   */
  readonly scenarioNews?: readonly ScenarioNewsItem[];
}

export default function InformationScreen({ fixture, ownState, turn, publicInfo, openingInfo, scenarioNews }: InformationScreenProps) {
  const tone = AREA_TONES.info;
  // openingInfoがあればその中のBS（同一計算結果）を再利用し、無ければownStateから
  // 直接組み立てる。どちらもbuildOpeningBalanceSheetの結果であり、計算式は1箇所のまま。
  const bs = openingInfo?.balanceSheet ?? buildOpeningBalanceSheet(ownState);
  const bsTurn = openingInfo?.turn ?? turn;
  const news = openingInfo?.scenarioNews ?? scenarioNews;

  return (
    <div className="space-y-3" data-testid="decision-studio-info-screen">
      {/* 【最上段・常時表示】スクロールしなくても現金・有利子負債・純資産・資産合計が
          見えるよう、開閉不要な一覧をタブの一番上に置く。値はbsそのまま（捏造・再計算なし）。
          Player-facing表示のため見出しは日本語のみ（英語併記はしない）。 */}
      <div className={`rounded-lg p-3 ${tone.section}`} data-testid="info-screen-opening-bs-glance">
        <div className="mb-1 flex items-center gap-2">
          <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
          <span className={`text-sm font-semibold ${tone.heading}`}>期初BS（一目）</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <div className="text-[10px] text-gray-500">現金</div>
            <div className="text-sm font-semibold tabular-nums text-gray-100">{usd(bs.cash)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">有利子負債</div>
            <div className="text-sm font-semibold tabular-nums text-gray-100">{usd(bs.totalDebt)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">純資産</div>
            <div className="text-sm font-semibold tabular-nums text-gray-100">{usd(bs.totalEquity)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">資産合計</div>
            <div className="text-sm font-semibold tabular-nums text-gray-100">{usd(bs.totalAssets)}</div>
          </div>
        </div>
      </div>

      {/* 【Turn Start / INFOタブ上部に常時表示】Dynamic Scenarioでは世界のニュースが
          主要な情報源のため、期初BSのすぐ下・詳細パネル類より前に置く。News一覧は
          「Turn開始時に必ず見せたい概要情報」として今回のdefault collapsed化の対象外。 */}
      {news !== undefined && bsTurn !== undefined && <ScenarioNewsFeed news={news} turn={bsTurn} />}

      {/* 【表示調整】詳細な貸借対照表は情報閲覧用パネルのため、既定で折り畳む
          （上のBS一目summaryで主要4項目は常に見えているため、内訳は必要な人だけ
          クリックして開く）。defaultOpenを渡さないことでOpeningBalanceSheetPanel
          既定のfalseに戻す。 */}
      {bsTurn !== undefined && <OpeningBalanceSheetPanel bs={bs} turn={bsTurn} />}

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
          <DepreciableAssetsPanel assets={openingInfo.depreciableAssets} />
          <OpeningMarketInfoPanel info={openingInfo.marketInfo} referencePrice={openingInfo.domesticReferencePrice} />
          <ObservedMarketDemandPanel observed={openingInfo.observedMarketDemand} />
        </>
      ) : (
        <p className="text-xs text-gray-500">
          この画面では償却資産明細・市場情報の詳細を組み立てるための情報（CompanyLabState全体）が渡されていません。BS（上記）と以下の自社状態要約のみ表示します。
          {publicInfo && ` （参考: 国内原料前期価格 $${publicInfo.vietnamDomesticPriorPrice.toFixed(2)}/kg）`}
        </p>
      )}

      {turn !== undefined ? (
        // 【表示調整】PlayerScreenClient.tsxの既存レイアウトと同じCollapsibleSectionで
        // 包み、既定で折り畳む（自社状態要約も情報閲覧用の詳細パネルのため）。
        <CollapsibleSection title={`自社の状態（turn ${turn} 開始時点）`} tone="info" defaultOpen={false} testId="opening-company-state-section">
          <OpeningCompanyStatePanel ownState={ownState} fixture={fixture} turn={turn} />
        </CollapsibleSection>
      ) : (
        <p className="text-xs text-gray-500">turn番号が未確定のため、自社状態要約（backlog・原料在庫・完成品在庫・工場・Worker・資金/負債）を表示できません。</p>
      )}
    </div>
  );
}
