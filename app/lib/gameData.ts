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
}

export const COMPANIES: Record<CompanyId, CompanyProfile> = {
  A: { id: "A", name: "社A", fullName: "Mekong Leader", color: "blue", cash: 20, totalAssets: 270, equity: 100, debtEquityRatio: 1.3, creditScore: 98, farmingArea: 1800, processingCapacity: 8000 },
  B: { id: "B", name: "社B", fullName: "Delta Processor", color: "green", cash: 20, totalAssets: 155, equity: 45, debtEquityRatio: 2.4, creditScore: 75, farmingArea: 1200, processingCapacity: 5000 },
  C: { id: "C", name: "社C", fullName: "Premium Fresh", color: "purple", cash: 6, totalAssets: 114, equity: 40, debtEquityRatio: 1.75, creditScore: 65, farmingArea: 800, processingCapacity: 3500 },
  D: { id: "D", name: "社D", fullName: "Pacific Volume", color: "orange", cash: 15, totalAssets: 270, equity: 90, debtEquityRatio: 2.0, creditScore: 85, farmingArea: 2200, processingCapacity: 9000 },
  E: { id: "E", name: "社E", fullName: "Rising Star", color: "red", cash: 5, totalAssets: 105, equity: 25, debtEquityRatio: 2.8, creditScore: 60, farmingArea: 700, processingCapacity: 3000 },
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
