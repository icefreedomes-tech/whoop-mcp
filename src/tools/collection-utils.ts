/**
 * Shared types and utilities for collection tool handlers.
 *
 * All 4 collection tools (recovery, sleep, workout, cycle) use the same
 * query parameter shape and query string building logic.
 *
 * Enhanced date expressions ("today", "last 7 days", etc.) are resolved
 * to ISO 8601 before sending to the WHOOP API.
 */

import { resolveDateExpression } from "./date-utils.js";

/** Input params shared by all collection endpoints */
export interface CollectionParams {
  start?: string;
  end?: string;
  limit?: number;
  nextToken?: string;
}

/**
 * Build a query string from collection params.
 * Resolves enhanced date expressions in start/end to ISO 8601.
 * Omits undefined values. Returns empty string if no params are set.
 *
 * @param params - Optional collection query parameters
 * @returns Query string (e.g. "?start=...&limit=5") or empty string
 */
export function buildCollectionQuery(params: CollectionParams): string {
  const searchParams = new URLSearchParams();

  const now = new Date();
  const start =
    params.start === undefined ? undefined : resolveDateExpression(params.start, now).start;
  const end = params.end === undefined ? undefined : resolveDateExpression(params.end, now).end;

  if (start !== undefined) {
    searchParams.set("start", start);
  }
  if (end !== undefined) {
    searchParams.set("end", end);
  }
  if (params.limit !== undefined) {
    searchParams.set("limit", String(params.limit));
  }
  if (params.nextToken !== undefined) {
    searchParams.set("nextToken", params.nextToken);
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}
