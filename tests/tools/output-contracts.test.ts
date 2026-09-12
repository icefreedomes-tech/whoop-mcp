import { describe, it, expect } from "vitest";
import { outputSchemas } from "../../src/tools/output-contracts.js";
import { cycleFixture, recoveryFixture, sleepFixture } from "../helpers/analytics-fixtures.js";

// WHOOP marks the last page of a collection with `next_token: null`. The
// collection tools reported that final page as a contract violation.
describe("collection output contracts", () => {
  it.each([
    ["get_recovery_collection", recoveryFixture(0)],
    ["get_sleep_collection", sleepFixture(0)],
    ["get_cycle_collection", cycleFixture(0)],
  ])("%s accepts a final page with next_token: null", (tool, record) => {
    const schema = outputSchemas[tool];
    expect(schema).toBeDefined();
    expect(schema?.safeParse({ records: [record], next_token: null }).success).toBe(true);
  });
});
