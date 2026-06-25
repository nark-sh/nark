/**
 * Convention Mining — fixture B.
 *
 * Two callsites of `axios.get(...)` wrapped in try/catch — paired with
 * fixtureA.ts so the convention-miner (Wave 3) sees CROSS-FILE
 * aggregation: passing sites in BOTH files contribute toward
 * conventionMatch.site_count on the violation in violation.ts.
 *
 * (PH1-R3b asserts site_count == 5 only when both files participate.)
 */

import axios from "axios";

export async function fetchInventoryB1(sku: string) {
  try {
    const r = await axios.get(`https://api.example.com/inventory/${sku}`);
    return r.data;
  } catch (error) {
    console.error("fetchInventoryB1 failed", error);
    throw error;
  }
}

export async function fetchPricingB2(sku: string) {
  try {
    const r = await axios.get(`https://api.example.com/pricing/${sku}`);
    return r.data;
  } catch (error) {
    console.error("fetchPricingB2 failed", error);
    return null;
  }
}
