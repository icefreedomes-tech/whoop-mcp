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

  // Regression: workouts with no distance (strength training, most gym work)
  // arrive with distance and altitude set to null, not omitted. All 18 such
  // workouts were rejected, failing get_workout_collection and blanking
  // get_today's last workout.
  it("get_workout_collection accepts a workout with null distance and altitude", () => {
    const strengthWorkout = {
      id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
      v1_id: null,
      user_id: 1,
      created_at: "2026-09-11T19:00:00.000Z",
      updated_at: "2026-09-11T20:09:42.548Z",
      start: "2026-09-11T18:00:00.000Z",
      end: "2026-09-11T19:00:00.000Z",
      timezone_offset: "+02:00",
      sport_name: "weightlifting",
      sport_id: 45,
      score_state: "SCORED",
      score: {
        strain: 9.4,
        average_heart_rate: 112,
        max_heart_rate: 158,
        kilojoule: 1350.5,
        percent_recorded: 100,
        distance_meter: null,
        altitude_gain_meter: null,
        altitude_change_meter: null,
        zone_durations: {
          zone_zero_milli: 60_000,
          zone_one_milli: 1_200_000,
          zone_two_milli: 1_500_000,
          zone_three_milli: 600_000,
          zone_four_milli: 240_000,
          zone_five_milli: 0,
        },
      },
    };

    const result = outputSchemas.get_workout_collection?.safeParse({
      records: [strengthWorkout],
      next_token: null,
    });

    expect(result?.success).toBe(true);
  });
});
