/**
 * Convention Mining — violation site.
 *
 * Exactly ONE unhandled `axios.get(...)` callsite. This file produces the
 * violation that the convention-miner test asserts against. The miner
 * (Wave 3) should attach `conventionMatch` with `pattern_id =
 * "try-catch:direct"` because 5 other sites in this fixture sub-tree DO
 * wrap the same call in a try/catch.
 *
 * The annotation below mirrors the harness convention used by other
 * ground-truth fixtures.
 */

import axios from "axios";

export async function fetchUnhandled(userId: string) {
  // SHOULD_FIRE: error-4xx-5xx — axios.get throws AxiosError, no try-catch (mining target)
  const r = await axios.get(`https://api.example.com/users/${userId}`);
  return r.data;
}
