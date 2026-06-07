// Demo file 1 of 3 — illustrates common axios mistakes Nark catches.
//
// Real production code looks like this all the time: a small client wrapper
// around a third-party API. The mistakes here are easy to miss in code
// review because nothing throws synchronously and TypeScript happily
// compiles every line.

import axios from "axios";

const API_BASE = "https://api.example.com";

// Fetches a user profile from an upstream service.
// VIOLATION (axios.error-4xx-5xx): no try/catch — a 404 or a network blip
// rejects the promise, the caller sees an unhandled rejection, and depending
// on the Node version the process may exit.
export async function fetchUserProfile(userId: string) {
  const response = await axios.get(`${API_BASE}/users/${userId}`);
  return response.data;
}

// Submits a comment to the upstream service.
// VIOLATION (axios.error-4xx-5xx): same shape as above, but on a POST —
// even more dangerous because retrying naively could double-post the
// comment without an idempotency key.
export async function postComment(userId: string, text: string) {
  const response = await axios.post(`${API_BASE}/comments`, { userId, text });
  return response.data;
}

// Fetches search results.
// VIOLATION (axios.rate-limited-429): there is a try/catch, but the catch
// only logs and re-throws. A 429 from a rate-limited API should trigger a
// backoff/retry; here it just bubbles up as a generic "request failed."
export async function searchPosts(query: string) {
  try {
    const response = await axios.get(`${API_BASE}/search`, {
      params: { q: query },
    });
    return response.data;
  } catch (error) {
    console.error("search failed:", error);
    throw error;
  }
}
