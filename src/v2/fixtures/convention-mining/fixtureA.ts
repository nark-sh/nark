/**
 * Convention Mining — fixture A.
 *
 * Three callsites of `axios.get(...)` wrapped in try/catch. The
 * convention-miner (Wave 3) should ingest these as "passing sites" for
 * the `try-catch:direct` pattern when computing conventionMatch on the
 * unrelated violation site in `violation.ts`.
 *
 * Paired with fixtureB.ts (2 more passing sites) — combined site_count
 * should reach 5, which is the threshold the convention-miner test
 * asserts.
 */

import axios from "axios";

export async function fetchProfileA1(userId: string) {
  try {
    const r = await axios.get(`https://api.example.com/users/${userId}`);
    return r.data;
  } catch (error) {
    console.error("fetchProfileA1 failed", error);
    throw error;
  }
}

export async function fetchOrdersA2(userId: string) {
  try {
    const r = await axios.get(`https://api.example.com/users/${userId}/orders`);
    return r.data;
  } catch (error) {
    console.error("fetchOrdersA2 failed", error);
    return [];
  }
}

export async function fetchProductsA3(query: string) {
  try {
    const r = await axios.get(`https://api.example.com/products?q=${query}`);
    return r.data;
  } catch (error) {
    console.error("fetchProductsA3 failed", error);
    return null;
  }
}
