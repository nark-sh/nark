/**
 * Test fixture: Inline suppression
 *
 * This file demonstrates inline comment suppression.
 * The axios call below should NOT trigger a violation because it's suppressed.
 */

import axios from 'axios';

async function fetchData() {
  // @behavioral-contract-ignore axios/network-failure: Testing suppression system
  const response = await axios.get('https://api.example.com/data');
  return response.data;
}

export { fetchData };
