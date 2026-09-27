export interface LearningActivity {
  weeklyRecords: Array<{ date: string; count: number }>;
  streakDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

export function calculateLearningActivity(recordDates: string[], today: string): LearningActivity {
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const counts = new Map<string, number>();
  for (const date of recordDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const dayOfWeek = new Date(todayTime).getUTCDay();
  const monday = todayTime - ((dayOfWeek + 6) % 7) * DAY_MS;
  const weeklyRecords = Array.from({ length: 7 }, (_, index) => {
    const date = isoDay(monday + index * DAY_MS);
    return { date, count: counts.get(date) ?? 0 };
  });
  let cursor = counts.has(today) ? todayTime : todayTime - DAY_MS;
  let streakDays = 0;
  while (counts.has(isoDay(cursor))) {
    streakDays++;
    cursor -= DAY_MS;
  }
  return { weeklyRecords, streakDays };
}
