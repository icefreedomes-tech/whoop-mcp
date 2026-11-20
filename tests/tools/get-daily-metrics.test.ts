import { describe, it, expect } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { getDailyMetrics, dailyMetricsOutputSchema } from "../../src/tools/get-daily-metrics.js";

// 10:30 local (+01:00) on 2026-11-20. Bedtime is 22:00 local, before midnight,
// so every cycle starts the evening before the day it covers.
const NOW = new Date("2026-11-20T09:30:00Z");
const DAY = 86_400_000;

interface DayOptions {
  hrv?: number;
  rhr?: number;
  steps?: number | null;
}

/** Records for the cycle you woke up in `daysAgo` days before NOW. */
function dayRecords(
  daysAgo: number,
  options: DayOptions = {}
): {
  cycle: Record<string, unknown>;
  sleep: Record<string, unknown>;
  recovery: Record<string, unknown>;
} {
  const wake = new Date(Date.parse("2026-11-20T06:30:00Z") - daysAgo * DAY);
  const bedtime = new Date(wake.getTime() - 9.5 * 3_600_000); // 21:00Z, 22:00 local
  const nextBedtime = new Date(bedtime.getTime() + DAY);
  const sleepId = `sleep-${daysAgo}`;
  const cycleId = 1000 + daysAgo;
  return {
    cycle: {
      id: cycleId,
      user_id: 1,
      created_at: wake.toISOString(),
      updated_at: wake.toISOString(),
      start: bedtime.toISOString(),
      end: daysAgo === 0 ? null : nextBedtime.toISOString(),
      timezone_offset: "+01:00",
      score_state: "SCORED",
      score: {
        strain: 10 + daysAgo / 10,
        kilojoule: 8368,
        average_heart_rate: 70,
        max_heart_rate: 150,
      },
      step_count: options.steps === undefined ? 8000 + daysAgo : options.steps,
    },
    sleep: {
      id: sleepId,
      cycle_id: cycleId,
      user_id: 1,
      created_at: wake.toISOString(),
      updated_at: wake.toISOString(),
      start: bedtime.toISOString(),
      end: wake.toISOString(),
      timezone_offset: "+01:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 34_200_000,
          total_awake_time_milli: 1_800_000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 18_000_000,
          total_slow_wave_sleep_time_milli: 7_200_000,
          total_rem_sleep_time_milli: 7_200_000,
          sleep_cycle_count: 5,
          disturbance_count: 3,
        },
        sleep_needed: {
          baseline_milli: 27_000_000,
          need_from_sleep_debt_milli: 1_800_000,
          need_from_recent_strain_milli: 900_000,
          need_from_recent_nap_milli: -900_000,
        },
        respiratory_rate: 16.5,
        sleep_performance_percentage: 80,
        sleep_efficiency_percentage: 95,
        sleep_consistency_percentage: 70,
      },
    },
    recovery: {
      cycle_id: cycleId,
      sleep_id: sleepId,
      user_id: 1,
      created_at: new Date(wake.getTime() + 600_000).toISOString(),
      updated_at: new Date(wake.getTime() + 600_000).toISOString(),
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 60 + (daysAgo % 5),
        resting_heart_rate: options.rhr ?? 55 + (daysAgo % 2),
        hrv_rmssd_milli: options.hrv ?? 60 + (daysAgo % 2 === 0 ? 2 : -2),
        spo2_percentage: 95,
        skin_temp_celsius: 34,
      },
    },
  };
}

function clientFor(
  count: number,
  overrides: Record<number, DayOptions> = {},
  extra: { workouts?: unknown[]; naps?: unknown[] } = {}
): WhoopClient {
  const days = Array.from({ length: count }, (_, daysAgo) =>
    dayRecords(daysAgo, overrides[daysAgo] ?? {})
  );
  const data: Record<string, unknown[]> = {
    "/v2/cycle": days.map((day) => day.cycle),
    "/v2/activity/sleep": [...days.map((day) => day.sleep), ...(extra.naps ?? [])],
    "/v2/recovery": days.map((day) => day.recovery),
    "/v2/activity/workout": extra.workouts ?? [],
  };
  return {
    get: async <T>(path: string): Promise<T> =>
      ({ records: data[path.split("?")[0]!] ?? [], next_token: null }) as T,
  };
}

describe("getDailyMetrics", () => {
  // Regression for the calendar's day shift: grouping by calendar date put a
  // cycle that starts at 22:00 on the previous day's row, away from the sleep
  // and recovery WHOOP links to it. Rows must follow the cycle.
  it("labels each cycle with the local day you woke up, keeping its metrics together", async () => {
    const result = await getDailyMetrics(clientFor(3), { days: 3 }, NOW);

    expect(result.days.map((row) => row.date)).toEqual(["2026-11-20", "2026-11-19", "2026-11-18"]);
    const today = result.days[0]!;
    expect(today).toMatchObject({
      cycle_id: 1000,
      recovery_score: 60,
      recovery_zone: "yellow",
      day_strain: 10,
      steps: 8000,
      energy_kj: 8368,
      energy_kcal: 2000,
      sleep_end: "2026-11-20T06:30:00.000Z",
      asleep_hours: 9,
      time_in_bed_hours: 9.5,
      sleep_need_hours: 8,
    });
    expect(result.days[1]).toMatchObject({ cycle_id: 1001, day_strain: 10.1, steps: 8001 });
  });

  it("flags a metric outside mean ± 2 SD of the previous 30 days", async () => {
    const result = await getDailyMetrics(clientFor(40, { 0: { hrv: 30 } }), { days: 1 }, NOW);

    expect(result.days[0]!.out_of_norm).toEqual({ hrv_rmssd_milli: "low" });
    expect(result.norms.hrv_rmssd_milli?.samples).toBe(30);
  });

  it("does not judge a metric with fewer than 14 prior days", async () => {
    const result = await getDailyMetrics(clientFor(10, { 0: { hrv: 5 } }), { days: 1 }, NOW);

    expect(result.days[0]!.out_of_norm).toEqual({});
    expect(result.norms.hrv_rmssd_milli).toBeNull();
  });

  it("assigns workouts by when they started and counts naps apart from the main sleep", async () => {
    const workout = (id: string, start: string, sport: string): Record<string, unknown> => ({
      id,
      user_id: 1,
      created_at: start,
      updated_at: start,
      start,
      end: new Date(Date.parse(start) + 45 * 60_000).toISOString(),
      timezone_offset: "+01:00",
      sport_name: sport,
      score_state: "SCORED",
      score: null,
    });
    const nap = {
      ...dayRecords(0).sleep,
      id: "nap-0",
      nap: true,
      start: "2026-11-20T08:00:00.000Z",
      end: "2026-11-20T08:30:00.000Z",
    };

    const result = await getDailyMetrics(
      clientFor(
        2,
        {},
        {
          workouts: [
            workout("w-today", "2026-11-20T07:30:00.000Z", "walking"),
            workout("w-yesterday", "2026-11-19T12:00:00.000Z", "weightlifting_msk"),
          ],
          naps: [nap],
        }
      ),
      { days: 2 },
      NOW
    );

    expect(result.days[0]).toMatchObject({
      workouts: 1,
      workout_minutes: 45,
      workout_sports: ["walking"],
      naps: 1,
      nap_hours: 0.5,
      sleep_end: "2026-11-20T06:30:00.000Z",
    });
    expect(result.days[1]).toMatchObject({ workouts: 1, workout_sports: ["weightlifting_msk"] });
  });

  it("reports steps as null when WHOOP sends none", async () => {
    const result = await getDailyMetrics(clientFor(1, { 0: { steps: null } }), { days: 1 }, NOW);

    expect(result.days[0]!.steps).toBeNull();
  });

  // The server returns only what the output contract names; a field missing
  // from it would be silently stripped before reaching the client.
  it("returns output the contract accepts without dropping fields", async () => {
    const result = await getDailyMetrics(clientFor(20), { days: 5 }, NOW);

    expect(dailyMetricsOutputSchema.parse(result)).toEqual(result);
  });
});
