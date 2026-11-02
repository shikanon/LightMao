import type { Schedule } from '../../packages/shared/types.ts';

export function nextOccurrence(
  s: Pick<Schedule, 'frequency' | 'time' | 'intervalMinutes' | 'timezone'>,
  after = new Date(),
): string {
  if (s.frequency === 'interval')
    return new Date(after.getTime() + s.intervalMinutes * 60000).toISOString();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: s.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: s.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const afterDay = day.format(after);
  const afterTime = formatter.format(after);
  // UTC-minute scan handles DST gaps/repeated hours without using the host timezone.
  const start = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < 60 * 50; i++) {
    const t = new Date(start + i * 60000);
    if (formatter.format(t) === s.time && !(afterTime >= s.time && day.format(t) === afterDay))
      return t.toISOString();
  }
  throw new Error('无法计算下一次运行时间');
}
