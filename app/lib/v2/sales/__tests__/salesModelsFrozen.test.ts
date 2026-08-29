// ShrimpX V2 — ENG-SALES-MODEL-PERSIST-2 §4/§20 販売モデル registry の frozen snapshot
//
// 【このテストの役割】A3（immutable / versioned registry）の再現性を CI で守る。
// 一度公開した salesModelId が指す SalesParameters を書き換えたら、このテストが落ちる。
// 再校正したい場合は既存 ID の値を変えるのではなく、
// "tiered-v200-candidate-v2" のような **新しい ID を registry へ追加**すること
// （保存済み Run は旧 ID を持ったまま旧定数で resume される）。
//
// canonical snapshot は market → product → tier の順序を明示して直列化し、
// オブジェクトのキー順に依存しない形にしてある。

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { resolveTierParameters } from "../tieredAllocation";
import {
  CUSTOMER_TIER_IDS,
  SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1,
  qualitySensitivityCalibrationFactorFor,
} from "../parameters";
import {
  SALES_MODEL_IDS,
  SalesModelId,
  UnknownSalesModelIdError,
  isSalesModelId,
  salesModelDefinitionForId,
  salesParametersForModelId,
} from "../salesModels";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** market → product → tier の順序を固定して canonical object を組み立てる。 */
function canonicalSnapshotOf(salesModelId: SalesModelId) {
  const params = salesParametersForModelId(salesModelId);
  assert.ok(params, `${salesModelId} は固定 SalesParameters を持たない`);
  const tiered = params!.tieredMarketAllocation;
  assert.ok(tiered, `${salesModelId} に tieredMarketAllocation が無い`);
  const cells: Record<string, Record<string, Record<string, number>>> = {};
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const resolved = resolveTierParameters(tiered!, market, product);
      const byTier: Record<string, Record<string, number>> = {};
      for (const tierId of CUSTOMER_TIER_IDS) {
        const t = resolved[tierId];
        byTier[tierId] = {
          demandShare: t.demandShare,
          priceSensitivity: t.priceSensitivity,
          qualitySensitivity: t.qualitySensitivity,
          differentiationSensitivity: t.differentiationSensitivity,
          nonPriceSensitivity: t.nonPriceSensitivity,
          reservationPriceMultiplier: t.reservationPriceMultiplier,
          reservationSoftPenaltySlope: t.reservationSoftPenaltySlope,
          externalOptionBaseUtility: t.externalOptionBaseUtility,
        };
      }
      cells[`${market}/${product}`] = byTier;
    }
  }
  return {
    parametersVersion: params!.parametersVersion,
    marketAllocationMode: params!.marketAllocationMode,
    utilityClamp: tiered!.utilityClamp,
    tieredParametersVersion: tiered!.parametersVersion,
    cells,
  };
}

/**
 * tiered-v200-candidate-v1 の凍結スナップショット。
 * **この定数は書き換えないこと。** 値を変えたい場合は新しい salesModelId を追加する。
 */
const FROZEN_TIERED_V200_CANDIDATE_V1 =
{
    "parametersVersion": "sales-v0.2+tiered-market-allocation-v200-candidate-v1",
    "marketAllocationMode": "tieredSimultaneousAllocation",
    "utilityClamp": 60,
    "tieredParametersVersion": "tiered-market-allocation-v200-candidate-v1（B-moderated-v1・プレイテスト用暫定値）",
    "cells": {
      "CN/hoso": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.55,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 1.5,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.35,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 3,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.1,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 6,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "CN/pd": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.6,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.3,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.1,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "CN/vap": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.45,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.4,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.15,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "US/hoso": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.5,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.4,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.1,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "US/pd": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.35,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.2,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "US/vap": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.15,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 1.512,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 3.024,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.4,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 6.048,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "EU/hoso": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.15,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.5,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.35,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "EU/pd": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.2,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.35,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "EU/vap": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.15,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 1.3679999999999999,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.4,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 2.7359999999999998,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.45,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 5.4719999999999995,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "JP/hoso": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.1,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.45,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "JP/pd": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.15,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.4,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "JP/vap": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.1,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 2.34,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.4,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 4.68,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.5,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 9.36,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "OTHER/hoso": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.45,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.42,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.13,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "OTHER/pd": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.35,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.2,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      },
      "OTHER/vap": {
        "PRICE_SENSITIVE": {
          "demandShare": 0.25,
          "priceSensitivity": 6.5,
          "qualitySensitivity": 0.6,
          "differentiationSensitivity": 0.3,
          "nonPriceSensitivity": 0.4,
          "reservationPriceMultiplier": 1.05,
          "reservationSoftPenaltySlope": 60,
          "externalOptionBaseUtility": 1.6
        },
        "STANDARD": {
          "demandShare": 0.45,
          "priceSensitivity": 3.5,
          "qualitySensitivity": 1.2,
          "differentiationSensitivity": 1.4,
          "nonPriceSensitivity": 0.8,
          "reservationPriceMultiplier": 1.15,
          "reservationSoftPenaltySlope": 40,
          "externalOptionBaseUtility": 1.6
        },
        "PREMIUM": {
          "demandShare": 0.3,
          "priceSensitivity": 1.7,
          "qualitySensitivity": 2.4,
          "differentiationSensitivity": 4,
          "nonPriceSensitivity": 1.2,
          "reservationPriceMultiplier": 1.35,
          "reservationSoftPenaltySlope": 25,
          "externalOptionBaseUtility": 1.6
        }
      }
    }
  }
;

// =====================================================================

test("SMID-FROZEN-1: tiered-v200-candidate-v1 の canonical snapshot が凍結値と完全一致", () => {
  assert.deepEqual(canonicalSnapshotOf("tiered-v200-candidate-v1"), FROZEN_TIERED_V200_CANDIDATE_V1);
});

test("SMID-FROZEN-2: ID → parametersVersion の対応が固定", () => {
  const params = salesParametersForModelId("tiered-v200-candidate-v1")!;
  assert.equal(params.parametersVersion, "sales-v0.2+tiered-market-allocation-v200-candidate-v1");
  assert.equal(params, SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1, "registry が別の定数を指している");
  assert.equal(params.marketAllocationMode, "tieredSimultaneousAllocation");
  // legacy は固定 SalesParameters を持たない（config の機能フラグから解決する）。
  assert.equal(salesParametersForModelId("legacy-waterfall-v1"), undefined);
});

test("SMID-FROZEN-3: 全15セルの解決値が凍結されている（15セル×3層）", () => {
  const cells = FROZEN_TIERED_V200_CANDIDATE_V1.cells as Record<string, unknown>;
  assert.equal(Object.keys(cells).length, 15);
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const cell = cells[`${market}/${product}`] as Record<string, { demandShare: number }>;
      assert.ok(cell, `${market}/${product} が snapshot に無い`);
      assert.equal(Object.keys(cell).length, 3);
      const sum = CUSTOMER_TIER_IDS.reduce((s, t) => s + cell[t].demandShare, 0);
      assert.ok(Math.abs(sum - 1) <= 1e-9, `${market}/${product}: demandShare 合計 ${sum}`);
    }
  }
});

test("SMID-FROZEN-4: anchor calibration（US/EU factor との合成を含む）が凍結されている", () => {
  const cells = FROZEN_TIERED_V200_CANDIDATE_V1.cells as Record<string, Record<string, { qualitySensitivity: number }>>;
  const base = SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1.tieredMarketAllocation!.tiers;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const usEuVapFactor =
        (market === "US" || market === "EU") && product === "vap" ? US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1 : 1;
      const expectFactor = usEuVapFactor * qualitySensitivityCalibrationFactorFor(market, product);
      for (const tierId of CUSTOMER_TIER_IDS) {
        assert.ok(
          Math.abs(cells[`${market}/${product}`][tierId].qualitySensitivity - base[tierId].qualitySensitivity * expectFactor) < 1e-12,
          `${market}/${product}/${tierId}`
        );
      }
    }
  }
  // anchor 4セルの値そのものも固定（P1D-3 で確定した multiplier）。
  assert.equal(cells["CN/hoso"].PREMIUM.qualitySensitivity, 2.4 * 2.5);
  assert.equal(cells["JP/vap"].PREMIUM.qualitySensitivity, 2.4 * 3.9);
  assert.ok(Math.abs(cells["US/vap"].PREMIUM.qualitySensitivity - 2.4 * 0.6 * 4.2) < 1e-12);
  assert.ok(Math.abs(cells["EU/vap"].PREMIUM.qualitySensitivity - 2.4 * 0.6 * 3.8) < 1e-12);
});

test("SMID-FROZEN-5: registry 内の ID に重複が無く、定義と ID が一致する", () => {
  assert.equal(new Set(SALES_MODEL_IDS).size, SALES_MODEL_IDS.length, "SALES_MODEL_IDS に重複がある");
  for (const id of SALES_MODEL_IDS) {
    const def = salesModelDefinitionForId(id);
    assert.equal(def.salesModelId, id, "definition の salesModelId が key と一致していない");
    assert.ok(def.description.length > 0);
  }
  assert.deepEqual([...SALES_MODEL_IDS], ["legacy-waterfall-v1", "tiered-v200-candidate-v1"]);
});

test("SMID-FROZEN-6: 未知 ID は resolve 時にも必ず失敗する（silent fallback しない）", () => {
  assert.equal(isSalesModelId("tiered-v200-candidate-v2"), false);
  assert.equal(isSalesModelId(""), false);
  assert.equal(isSalesModelId(undefined), false);
  assert.throws(() => salesParametersForModelId("tiered-v200-candidate-v2" as SalesModelId), UnknownSalesModelIdError);
  assert.throws(() => salesModelDefinitionForId("unknown-model" as SalesModelId), UnknownSalesModelIdError);
});
