import { describe, it, expect } from "vitest";
import { outputSchemas } from "../../src/tools/output-contracts.js";
import { cycleFixture, recoveryFixture, sleepFixture } from "../helpers/analytics-fixtures.js";

/** A workout shaped the way the live WHOOP API returns strength training. */
const STRENGTH_WORKOUT = {
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
    percent_recorded: 0.9991369,
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

describe("collection output contracts", () => {
  // WHOOP marks the last page of a collection with `next_token: null`. The
  // collection tools reported that final page as a contract violation.
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
    const result = outputSchemas.get_workout_collection?.safeParse({
      records: [STRENGTH_WORKOUT],
      next_token: null,
    });

    expect(result?.success).toBe(true);
  });

  // Nested score objects silently dropped every field the schema did not name,
  // so anything WHOOP sends beyond its documented contract — strength-trainer
  // detail on a workout, say — could never be seen by the client.
  it("keeps undocumented fields inside workout, sleep and recovery scores", () => {
    const workout = {
      ...STRENGTH_WORKOUT,
      score: {
        ...STRENGTH_WORKOUT.score,
        undocumented_detail: [{ name: "squat", sets: 3 }],
        zone_durations: { ...STRENGTH_WORKOUT.score.zone_durations, zone_extra_milli: 7 },
      },
    };
    const sleep = sleepFixture(0);
    const recovery = recoveryFixture(0);

    const workouts = outputSchemas.get_workout_collection?.parse({ records: [workout] }) as {
      records: Array<{
        score: Record<string, unknown> & { zone_durations: Record<string, unknown> };
      }>;
    };
    const sleeps = outputSchemas.get_sleep_collection?.parse({
      records: [
        {
          ...sleep,
          score: {
            ...sleep.score,
            undocumented_metric: 1,
            stage_summary: { ...sleep.score?.stage_summary, undocumented_stage: 2 },
          },
        },
      ],
    }) as {
      records: Array<{
        score: Record<string, unknown> & { stage_summary: Record<string, unknown> };
      }>;
    };
    const recoveries = outputSchemas.get_recovery_collection?.parse({
      records: [{ ...recovery, score: { ...recovery.score, undocumented_metric: 3 } }],
    }) as { records: Array<{ score: Record<string, unknown> }> };

    expect(workouts.records[0]?.score.undocumented_detail).toEqual([{ name: "squat", sets: 3 }]);
    expect(workouts.records[0]?.score.zone_durations.zone_extra_milli).toBe(7);
    expect(sleeps.records[0]?.score.undocumented_metric).toBe(1);
    expect(sleeps.records[0]?.score.stage_summary.undocumented_stage).toBe(2);
    expect(recoveries.records[0]?.score.undocumented_metric).toBe(3);
  });

  // WHOOP's percent_recorded is a 0–1 fraction. Reject a 0–100 value outright so
  // a scale change surfaces in the contract diagnostics instead of turning into
  // a silent 10000% downstream.
  it("get_workout_collection rejects percent_recorded outside 0–1", () => {
    const misScaled = {
      ...STRENGTH_WORKOUT,
      score: { ...STRENGTH_WORKOUT.score, percent_recorded: 100 },
    };

    const result = outputSchemas.get_workout_collection?.safeParse({
      records: [misScaled],
      next_token: null,
    });

    expect(result?.success).toBe(false);
    expect(JSON.stringify(result?.error?.issues)).toContain("percent_recorded");
  });
});
