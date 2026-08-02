import { computeMarketProductMix } from "../app/lib/v2/market/productLifecycle";
import { DEMAND_MARKET_IDS } from "../app/lib/v2/market/types";
const r3=(x:number)=>x.toFixed(3);
console.log("turn | " + DEMAND_MARKET_IDS.map(m=>`${m}(h/p/v)`.padEnd(20)).join(""));
for(let t=1;t<=32;t+=2){
  const m=computeMarketProductMix(t);
  console.log(String(t).padStart(4)+" | "+DEMAND_MARKET_IDS.map(k=>`${r3(m[k].hoso)}/${r3(m[k].pd)}/${r3(m[k].vap)}`.padEnd(20)).join(""));
}
console.log("\n--- 各市場のPD/VAPシェアが最大伸長した区間 ---");
for(const k of DEMAND_MARKET_IDS){
  for(const p of ["pd","vap"] as const){
    let best=0,bt=0;
    for(let t=2;t<=32;t++){const d=computeMarketProductMix(t)[k][p]-computeMarketProductMix(t-1)[k][p]; if(d>best){best=d;bt=t;}}
    console.log(`${k}.${p}: 最大伸長 turn${bt} (+${best.toFixed(4)}pt/Q), t1=${computeMarketProductMix(1)[k][p].toFixed(3)} t32=${computeMarketProductMix(32)[k][p].toFixed(3)}`);
  }
}
import { PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1 as TUNED } from "../app/lib/v2/market/productLifecycle";
console.log("\n--- TUNED ---");
for(const k of DEMAND_MARKET_IDS){
  for(const p of ["pd","vap"] as const){
    let best=0,bt=0;
    for(let t=2;t<=32;t++){const d=computeMarketProductMix(t,TUNED)[k][p]-computeMarketProductMix(t-1,TUNED)[k][p]; if(d>best){best=d;bt=t;}}
    console.log(`${k}.${p}: 最大伸長 turn${bt} (+${best.toFixed(4)}), t1=${computeMarketProductMix(1,TUNED)[k][p].toFixed(3)} t32=${computeMarketProductMix(32,TUNED)[k][p].toFixed(3)}`);
  }
}
