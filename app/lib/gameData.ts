export type CompanyId = "A" | "B" | "C" | "D" | "E";

export interface CompanyProfile {
  id: CompanyId;
  name: string;
  fullName: string;
  color: string;
  cash: number;
  totalAssets: number;
  equity: number;
  debtEquityRatio: number;
  creditScore: number;
  farmingArea: number;
  processingCapacity: number;
  // 貸借対照表詳細（期初値）
  // 資産側: cash + accountsReceivable + rawInventory + finishedInventory + buildingsNet + (equipmentGross - accumulatedDepreciation) = totalAssets
  // 負債側: accountsPayable + shortTermLoans + longTermLoans + paidInCapital + (equity - paidInCapital) = totalAssets
  accountsReceivable: number;     // 売掛金
  rawInventory: number;           // 原料在庫
  finishedInventory: number;      // 製品在庫
  buildingsNet: number;           // 建物（純額）
  equipmentGross: number;         // 設備（総額）
  accumulatedDepreciation: number;// 減価償却累計額
  accountsPayable: number;        // 買掛金
  shortTermLoans: number;         // 短期借入金
  longTermLoans: number;          // 長期借入金
  paidInCapital: number;          // 資本金
}

// 貸借対照表検証（開発用コンソール出力）:
// 資産合計 = cash + AR + rawInv + finInv + bldgNet + equipGross - accumDepr
// 社A: 20+18+6+4+40+260-78=270 ✓  社B: 20+10+4+3+22+140-44=155 ✓
// 社C: 6+7+3+2+18+110-32=114 ✓   社D: 15+20+7+5+42+270-89=270 ✓
// 社E: 5+6+2+2+16+105-31=105 ✓
// 負債合計 = AP + STL + LTL
// 社A: 12+47+111=170 ✓  社B: 8+31+71=110 ✓  社C: 7+20+47=74 ✓
// 社D: 13+50+117=180 ✓  社E: 6+22+52=80 ✓

export const COMPANIES: Record<CompanyId, CompanyProfile> = {
  A: {
    id: "A", name: "社A", fullName: "Mekong Leader", color: "blue",
    cash: 20, totalAssets: 270, equity: 100, debtEquityRatio: 1.3, creditScore: 98,
    farmingArea: 1800, processingCapacity: 8000,
    accountsReceivable: 18, rawInventory: 6, finishedInventory: 4,
    buildingsNet: 40, equipmentGross: 260, accumulatedDepreciation: 78,
    accountsPayable: 12, shortTermLoans: 47, longTermLoans: 111,
    paidInCapital: 80,
  },
  B: {
    id: "B", name: "社B", fullName: "Delta Processor", color: "green",
    cash: 20, totalAssets: 155, equity: 45, debtEquityRatio: 2.4, creditScore: 75,
    farmingArea: 1200, processingCapacity: 5000,
    accountsReceivable: 10, rawInventory: 4, finishedInventory: 3,
    buildingsNet: 22, equipmentGross: 140, accumulatedDepreciation: 44,
    accountsPayable: 8, shortTermLoans: 31, longTermLoans: 71,
    paidInCapital: 35,
  },
  C: {
    id: "C", name: "社C", fullName: "Premium Fresh", color: "purple",
    cash: 6, totalAssets: 114, equity: 40, debtEquityRatio: 1.75, creditScore: 65,
    farmingArea: 800, processingCapacity: 3500,
    accountsReceivable: 7, rawInventory: 3, finishedInventory: 2,
    buildingsNet: 18, equipmentGross: 110, accumulatedDepreciation: 32,
    accountsPayable: 7, shortTermLoans: 20, longTermLoans: 47,
    paidInCapital: 35,
  },
  D: {
    id: "D", name: "社D", fullName: "Pacific Volume", color: "orange",
    cash: 15, totalAssets: 270, equity: 90, debtEquityRatio: 2.0, creditScore: 85,
    farmingArea: 2200, processingCapacity: 9000,
    accountsReceivable: 20, rawInventory: 7, finishedInventory: 5,
    buildingsNet: 42, equipmentGross: 270, accumulatedDepreciation: 89,
    accountsPayable: 13, shortTermLoans: 50, longTermLoans: 117,
    paidInCapital: 70,
  },
  E: {
    id: "E", name: "社E", fullName: "Rising Star", color: "red",
    cash: 5, totalAssets: 105, equity: 25, debtEquityRatio: 2.8, creditScore: 60,
    farmingArea: 700, processingCapacity: 3000,
    accountsReceivable: 6, rawInventory: 2, finishedInventory: 2,
    buildingsNet: 16, equipmentGross: 105, accumulatedDepreciation: 31,
    accountsPayable: 6, shortTermLoans: 22, longTermLoans: 52,
    paidInCapital: 20,
  },
};

export const PHASES = [
  { id: 0, title: "情報確認", description: "確定受注・仕入れ契約残の確認" },
  { id: 1, title: "設備投資", description: "工場新設・拡張の検討申請" },
  { id: 2, title: "生産計画", description: "養殖量・加工計画の策定" },
  { id: 3, title: "調達", description: "外部調達量・単価の決定" },
  { id: 4, title: "加工", description: "バルク／VAP比率の決定" },
  { id: 5, title: "販売", description: "販売先・価格・数量の決定" },
  { id: 6, title: "財務", description: "借入・返済・増資の決定" },
];
