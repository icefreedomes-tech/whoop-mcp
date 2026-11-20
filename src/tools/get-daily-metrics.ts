/**
 * Tool: get_daily_metrics
 *
 * One row per day with every daily metric WHOOP exposes (recovery, sleep, day
 * strain, energy, heart rate, steps, naps and workouts), each judged against
 * your own previous 30 days.
 */

import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopNetworkError } from "../api/client.js";
import {
  ENDPOINT_CYCLE,
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
} from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import {
  DAY_MS,
  DISCLAIMER,
  HOUR_MS,
  asleepHours,
  loadAnalyticsSource,
} from "./analytics-utils.js";
import { resolveDateExpression } from "./date-utils.js";
import { joinByCycle, type CycleDay } from "./daily-rows.js";
import { mean, standardDeviation } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const dailyMetricsInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("Number of days to return. Default: 14. Max: 90."),
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      'First day to return (ISO date or expression such as "last month"). Without it, the table ends today.'
    ),
});

/** Metrics judged against the personal 30-day norm. */
export const NORM_METRICS = [
  "recovery_score",
  "hrv_rmssd_milli",
  "resting_heart_rate",
  "spo2_pct",
  "skin_temp_celsius",
  "respiratory_rate",
  "asleep_hours",
  "day_strain",
  "steps",
] as const;
const normMetricSchema = z.enum(NORM_METRICS);
type NormMetric = z.infer<typeof normMetricSchema>;

const value = z.number().finite().nullable();
const normSchema = z.object({
  mean: z.number().finite(),
  sd: z.number().finite(),
  low: z.number().finite(),
  high: z.number().finite(),
  samples: z.number().int(),
});

export const dailyRowSchema = z.object({
  date: z.string(),
  cycle_id: z.number().int(),
  recovery_score: value,
  recovery_zone: z.enum(["green", "yellow", "red"]).nullable(),
  hrv_rmssd_milli: value,
  resting_heart_rate: value,
  spo2_pct: value,
  skin_temp_celsius: value,
  user_calibrating: z.boolean().nullable(),
  sleep_start: z.string().nullable(),
  sleep_end: z.string().nullable(),
  time_in_bed_hours: value,
  asleep_hours: value,
  light_hours: value,
  deep_hours: value,
  rem_hours: value,
  awake_hours: value,
  sleep_need_hours: value,
  sleep_performance_pct: value,
  sleep_efficiency_pct: value,
  sleep_consistency_pct: value,
  respiratory_rate: value,
  sleep_cycles: value,
  disturbances: value,
  naps: z.number().int(),
  nap_hours: z.number().finite(),
  day_strain: value,
  energy_kj: value,
  energy_kcal: value,
  average_heart_rate: value,
  max_heart_rate: value,
  steps: value,
  workouts: z.number().int(),
  workout_minutes: z.number().finite(),
  workout_sports: z.array(z.string()),
  out_of_norm: z.partialRecord(normMetricSchema, z.enum(["high", "low"])),
});

export const dailyMetricsOutputSchema = z.object({
  period: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
  days: z.array(dailyRowSchema),
  norms: z.record(normMetricSchema, normSchema.nullable()),
  method: z.string(),
  truncated: z.boolean(),
  disclaimer: z.string(),
});

export type DailyRow = z.infer<typeof dailyRowSchema>;
export type DailyMetrics = z.infer<typeof dailyMetricsOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 14;
const NORM_WINDOW_DAYS = 30;
const NORM_MIN_SAMPLES = 14;
const NORM_SD_MULTIPLE = 2;
const KJ_PER_KCAL = 4.184;

const METHOD =
  `Rows are WHOOP cycles labelled with the local day you woke up. A metric is "high" or ` +
  `"low" when it falls outside mean ± ${NORM_SD_MULTIPLE} SD of the previous ` +
  `${NORM_WINDOW_DAYS} days, given at least ${NORM_MIN_SAMPLES} of them; calibrating ` +
  `recoveries are left out of norms. This is the server's rule, not WHOOP's Health Monitor.`;

function round(input: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(input * factor) / factor;
}

function hours(milli: number): number {
  return round(milli / HOUR_MS);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function recoveryZone(score: number): "green" | "yellow" | "red" {
  if (score >= 67) return "green";
  if (score >= 34) return "yellow";
  return "red";
}

function buildRow(day: CycleDay): Omit<DailyRow, "out_of_norm"> {
  const recovery = day.recovery?.score_state === "SCORED" ? (day.recovery.score ?? null) : null;
  const sleep = day.sleep?.score_state === "SCORED" ? (day.sleep.score ?? null) : null;
  const cycle = day.cycle.score_state === "SCORED" ? (day.cycle.score ?? null) : null;
  const stages = sleep?.stage_summary;
  const need = sleep?.sleep_needed;
  const sports: string[] = [];
  for (const workout of day.workouts) {
    if (!sports.includes(workout.sport_name)) sports.push(workout.sport_name);
  }
  const span = (record: { start: string; end: string }): number =>
    Math.max(0, Date.parse(record.end) - Date.parse(record.start));

  return {
    date: day.date,
    cycle_id: day.cycle.id,
    recovery_score: recovery?.recovery_score ?? null,
    recovery_zone: recovery ? recoveryZone(recovery.recovery_score) : null,
    hrv_rmssd_milli: recovery?.hrv_rmssd_milli ?? null,
    resting_heart_rate: recovery?.resting_heart_rate ?? null,
    spo2_pct: recovery?.spo2_percentage ?? null,
    skin_temp_celsius: recovery?.skin_temp_celsius ?? null,
    user_calibrating: recovery ? recovery.user_calibrating : null,
    sleep_start: day.sleep?.start ?? null,
    sleep_end: day.sleep?.end ?? null,
    time_in_bed_hours: stages ? hours(stages.total_in_bed_time_milli) : null,
    asleep_hours: sleep && day.sleep ? round(asleepHours(day.sleep)) : null,
    light_hours: stages ? hours(stages.total_light_sleep_time_milli) : null,
    deep_hours: stages ? hours(stages.total_slow_wave_sleep_time_milli) : null,
    rem_hours: stages ? hours(stages.total_rem_sleep_time_milli) : null,
    awake_hours: stages ? hours(stages.total_awake_time_milli) : null,
    sleep_need_hours: need
      ? hours(
          need.baseline_milli +
            need.need_from_sleep_debt_milli +
            need.need_from_recent_strain_milli +
            need.need_from_recent_nap_milli
        )
      : null,
    sleep_performance_pct: sleep?.sleep_performance_percentage ?? null,
    sleep_efficiency_pct: sleep?.sleep_efficiency_percentage ?? null,
    sleep_consistency_pct: sleep?.sleep_consistency_percentage ?? null,
    respiratory_rate: sleep?.respiratory_rate ?? null,
    sleep_cycles: stages?.sleep_cycle_count ?? null,
    disturbances: stages?.disturbance_count ?? null,
    naps: day.naps.length,
    nap_hours: hours(day.naps.reduce((total, nap) => total + span(nap), 0)),
    day_strain: cycle?.strain ?? null,
    energy_kj: cycle?.kilojoule ?? null,
    energy_kcal: cycle ? Math.round(cycle.kilojoule / KJ_PER_KCAL) : null,
    average_heart_rate: cycle?.average_heart_rate ?? null,
    max_heart_rate: cycle?.max_heart_rate ?? null,
    steps: day.cycle.step_count ?? null,
    workouts: day.workouts.length,
    workout_minutes: Math.round(
      day.workouts.reduce((total, workout) => total + span(workout), 0) / 60_000
    ),
    workout_sports: sports,
  };
}

/** Value used for norms; calibrating recoveries are excluded. */
function normValue(row: Omit<DailyRow, "out_of_norm">, metric: NormMetric): number | null {
  const isRecoveryMetric =
    metric === "recovery_score" ||
    metric === "hrv_rmssd_milli" ||
    metric === "resting_heart_rate" ||
    metric === "spo2_pct" ||
    metric === "skin_temp_celsius";
  if (isRecoveryMetric && row.user_calibrating) return null;
  return row[metric];
}

function normFor(
  rows: Omit<DailyRow, "out_of_norm">[],
  date: string,
  metric: NormMetric
): z.infer<typeof normSchema> | null {
  const from = addDays(date, -NORM_WINDOW_DAYS);
  const values = rows
    .filter((row) => row.date >= from && row.date < date)
    .map((row) => normValue(row, metric))
    .filter((entry): entry is number => entry !== null);
  if (values.length < NORM_MIN_SAMPLES) return null;
  const average = mean(values);
  const sd = standardDeviation(values);
  return {
    mean: round(average),
    sd: round(sd),
    low: round(average - NORM_SD_MULTIPLE * sd),
    high: round(average + NORM_SD_MULTIPLE * sd),
    samples: values.length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Every daily WHOOP metric for a date range, with personal-norm flags.
 */
export async function getDailyMetrics(
  client: WhoopClient,
  params: z.infer<typeof dailyMetricsInputSchema> = {},
  now: Date = new Date()
): Promise<DailyMetrics> {
  const { days = DEFAULT_DAYS, start } = dailyMetricsInputSchema.parse(params);
  const requestedStart = start ? resolveDateExpression(start, now).start.slice(0, 10) : undefined;

  // Fetch the norm window and two days of padding for timezones and evening
  // bedtimes, in addition to the rows themselves.
  const firstDay =
    requestedStart ?? new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const period = {
    start: new Date(
      Date.parse(`${firstDay}T00:00:00Z`) - (NORM_WINDOW_DAYS + 2) * DAY_MS
    ).toISOString(),
    end: now.toISOString(),
  };
  const [cycles, sleeps, recoveries, workouts] = await Promise.all([
    loadAnalyticsSource(client, ENDPOINT_CYCLE, period, cycleRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_RECOVERY, period, recoveryRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_WORKOUT, period, workoutRecordSchema),
  ]);
  if (cycles.quality.status === "fetch_failed")
    throw new WhoopNetworkError("Cycle source unavailable");

  const allRows = joinByCycle(
    cycles.records,
    sleeps.records,
    recoveries.records,
    workouts.records,
    now
  ).map(buildRow);

  const latest = allRows[0]?.date ?? now.toISOString().slice(0, 10);
  const rangeStart = requestedStart ?? addDays(latest, -(days - 1));
  const rangeEnd = requestedStart ? [addDays(requestedStart, days - 1), latest].sort()[0]! : latest;

  const rows: DailyRow[] = allRows
    .filter((row) => row.date >= rangeStart && row.date <= rangeEnd)
    .map((row) => {
      const outOfNorm: DailyRow["out_of_norm"] = {};
      for (const metric of NORM_METRICS) {
        const current = normValue(row, metric);
        const norm = current === null ? null : normFor(allRows, row.date, metric);
        if (current === null || !norm) continue;
        if (current < norm.low) outOfNorm[metric] = "low";
        else if (current > norm.high) outOfNorm[metric] = "high";
      }
      return { ...row, out_of_norm: outOfNorm };
    });

  const normDate = rows[0] ? addDays(rows[0].date, 1) : addDays(latest, 1);
  const norms = Object.fromEntries(
    NORM_METRICS.map((metric) => [metric, normFor(allRows, normDate, metric)])
  ) as DailyMetrics["norms"];

  return {
    period: { start: rangeStart, end: rangeEnd, days: rows.length },
    days: rows,
    norms,
    method: METHOD,
    truncated: [cycles, sleeps, recoveries, workouts].some((source) => source.quality.truncated),
    disclaimer: DISCLAIMER,
  };
}
