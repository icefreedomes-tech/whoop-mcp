/**
 * Joins WHOOP cycles with their sleeps, recoveries and workouts, one entry per
 * cycle.
 *
 * A cycle opens when you fall asleep and runs until the next sleep, and WHOOP
 * links that night's sleep and recovery to it by cycle_id. Grouping by calendar
 * date instead splits them: with a bedtime before midnight the cycle starts on
 * one date while its sleep and recovery land on the next. A cycle is labelled
 * with the local day you woke up in it, which is how WHOOP labels a day.
 */

import type { z } from "zod";
import type {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import { HOUR_MS, localDay } from "./analytics-utils.js";

export type CycleRecord = z.infer<typeof cycleRecordSchema>;
export type SleepRecord = z.infer<typeof sleepRecordSchema>;
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
export type WorkoutRecord = z.infer<typeof workoutRecordSchema>;

export interface CycleDay {
  /** Local YYYY-MM-DD you woke up in this cycle. */
  date: string;
  cycle: CycleRecord;
  /** The cycle's main (non-nap) sleep, the longest if WHOOP records several. */
  sleep: SleepRecord | undefined;
  naps: SleepRecord[];
  /** Recovery for this cycle's main sleep. */
  recovery: RecoveryRecord | undefined;
  /** Workouts that started while this cycle was open. */
  workouts: WorkoutRecord[];
}

function duration(record: { start: string; end: string }): number {
  return Date.parse(record.end) - Date.parse(record.start);
}

/** Local day a cycle covers: the day you woke from its sleep. */
export function cycleDate(cycle: CycleRecord, sleep: SleepRecord | undefined): string {
  if (sleep) return localDay(sleep.end, sleep.timezone_offset);
  // No sleep recorded. A cycle starts at bedtime, so half a day later falls in
  // the day it covers, whether bedtime was before or after midnight.
  const midCycle = new Date(Date.parse(cycle.start) + 12 * HOUR_MS).toISOString();
  return localDay(midCycle, cycle.timezone_offset);
}

/**
 * Group records by the cycle they belong to, newest cycle first.
 *
 * @param now - Upper bound for the still-open cycle when assigning workouts.
 */
export function joinByCycle(
  cycles: CycleRecord[],
  sleeps: SleepRecord[],
  recoveries: RecoveryRecord[],
  workouts: WorkoutRecord[],
  now: Date
): CycleDay[] {
  const sleepsByCycle = new Map<number, SleepRecord[]>();
  for (const sleep of sleeps) {
    const list = sleepsByCycle.get(sleep.cycle_id) ?? [];
    list.push(sleep);
    sleepsByCycle.set(sleep.cycle_id, list);
  }

  return [...cycles]
    .sort((left, right) => Date.parse(right.start) - Date.parse(left.start))
    .map((cycle) => {
      const own = sleepsByCycle.get(cycle.id) ?? [];
      const sleep = own
        .filter((record) => !record.nap)
        .sort((left, right) => duration(right) - duration(left))[0];
      const naps = own.filter((record) => record.nap);
      const recovery = recoveries.find(
        (record) =>
          record.cycle_id === cycle.id && sleep !== undefined && record.sleep_id === sleep.id
      );
      const cycleStart = Date.parse(cycle.start);
      const cycleEnd = cycle.end ? Date.parse(cycle.end) : now.getTime();
      const ownWorkouts = workouts.filter((workout) => {
        const start = Date.parse(workout.start);
        return start >= cycleStart && start < cycleEnd;
      });
      return {
        date: cycleDate(cycle, sleep),
        cycle,
        sleep,
        naps,
        recovery,
        workouts: ownWorkouts,
      };
    });
}
