export interface Clock {
  now(): Date;
  nowMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }
}

export class ManualClock implements Clock {
  private currentMs: number;

  constructor(initial: Date | number = Date.now()) {
    this.currentMs = typeof initial === 'number' ? initial : initial.getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowMs(): number {
    return this.currentMs;
  }

  advanceMs(deltaMs: number): void {
    this.currentMs += deltaMs;
  }

  set(next: Date | number): void {
    this.currentMs = typeof next === 'number' ? next : next.getTime();
  }
}

/**
 * Formats a Date into UTC MySQL DATETIME(3) string: YYYY-MM-DD HH:MM:SS.mmm
 */
export function toMysqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * Parses a MySQL DATETIME(3) value (Date instance or UTC string) back into a JS Date.
 */
export function fromMysqlDateTime(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const isoCandidate = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(isoCandidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid MySQL datetime value: ${value}`);
  }
  return parsed;
}

export interface TimeWindowRule {
  /** 0 = Sunday ... 6 = Saturday */
  daysOfWeek: number[];
  /** Minutes since midnight in `timezone` (0..1439) */
  startMinuteOfDay: number;
  /** Minutes since midnight in `timezone` (1..1440) */
  endMinuteOfDay: number;
}

export interface AllowedTimeWindowsConfig {
  timezone: string;
  windows: TimeWindowRule[];
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isWithinAllowedTimeWindows(
  at: Date,
  config: AllowedTimeWindowsConfig | null | undefined
): boolean {
  if (!config || config.windows.length === 0) {
    return true;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(at);
  const weekdayPart = parts.find((p) => p.type === 'weekday')?.value;
  const hourPart = parts.find((p) => p.type === 'hour')?.value;
  const minutePart = parts.find((p) => p.type === 'minute')?.value;

  if (!weekdayPart || hourPart === undefined || minutePart === undefined) {
    return false;
  }

  const dayOfWeek = WEEKDAY_MAP[weekdayPart];
  if (dayOfWeek === undefined) return false;

  const hour = Number(hourPart) % 24;
  const minute = Number(minutePart);
  const minuteOfDay = hour * 60 + minute;

  return config.windows.some(
    (w) =>
      w.daysOfWeek.includes(dayOfWeek) &&
      minuteOfDay >= w.startMinuteOfDay &&
      minuteOfDay < w.endMinuteOfDay
  );
}

export interface RecurrenceRuleConfig {
  /** 0 = Sunday ... 6 = Saturday */
  daysOfWeek: number[];
  /** HH:MM in 24-hour format (00:00..23:59) */
  localStartTime: string;
  /** Optional HH:MM in 24-hour format */
  localEndTime?: string | null;
  /** Duration in minutes (1..720) */
  durationMinutes: number;
  /** IANA timezone identifier */
  timezone: string;
  /** YYYY-MM-DD inclusive recurrence end date in `timezone` */
  endDate: string;
  /** Upper bound on total occurrences (1..365) */
  maxOccurrences: number;
}

interface ZonedWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedWallParts(instant: Date, timezone: string): ZonedWallParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(instant);
  const getNum = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: getNum('year'),
    month: getNum('month'),
    day: getNum('day'),
    hour: getNum('hour') % 24,
    minute: getNum('minute'),
    second: getNum('second')
  };
}

function getTimezoneOffsetMs(instantMs: number, timezone: string): number {
  const w = getZonedWallParts(new Date(instantMs), timezone);
  const wallAsUtcMs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const roundedInstantMs = Math.floor(instantMs / 1000) * 1000;
  return wallAsUtcMs - roundedInstantMs;
}

export function isValidLocalDateString(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

export function isValidLocalTimeString(timeStr: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Deterministically resolves a local calendar date (`YYYY-MM-DD`) and 24h time (`HH:MM`)
 * in an IANA timezone to a UTC `Date`:
 * - For ambiguous Fall-Back DST times (where the local clock repeats an hour), picks the first occurrence.
 * - For non-existent Spring-Forward DST gap times, shifts forward by the DST gap using the pre-transition offset.
 */
export function resolveLocalDateTimeToUtc(
  dateStr: string,
  timeStr: string,
  timezone: string
): Date {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  if (!isValidLocalDateString(dateStr)) {
    throw new Error(`Invalid local date string: ${dateStr}`);
  }
  if (!isValidLocalTimeString(timeStr)) {
    throw new Error(`Invalid local time string: ${timeStr}`);
  }

  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  const [hour, minute] = timeStr.split(':').map(Number) as [number, number];

  const targetWallUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const initialOffset = getTimezoneOffsetMs(targetWallUtcMs, timezone);
  const guess1 = targetWallUtcMs - initialOffset;

  // Check 2 hours before guess1 to capture the pre-transition offset in both DST directions
  const preOffset = getTimezoneOffsetMs(guess1 - 2 * 3600_000, timezone);
  const postOffset = getTimezoneOffsetMs(guess1 + 2 * 3600_000, timezone);

  const candidateEarlier = targetWallUtcMs - preOffset;
  const earlierParts = getZonedWallParts(new Date(candidateEarlier), timezone);
  if (
    earlierParts.year === year &&
    earlierParts.month === month &&
    earlierParts.day === day &&
    earlierParts.hour === hour &&
    earlierParts.minute === minute
  ) {
    return new Date(candidateEarlier);
  }

  const candidateLater = targetWallUtcMs - postOffset;
  const laterParts = getZonedWallParts(new Date(candidateLater), timezone);
  if (
    laterParts.year === year &&
    laterParts.month === month &&
    laterParts.day === day &&
    laterParts.hour === hour &&
    laterParts.minute === minute
  ) {
    return new Date(candidateLater);
  }

  // Non-existent Spring-Forward gap: deterministically advance using pre-transition offset
  return new Date(candidateEarlier);
}

/**
 * Computes the next valid UTC occurrence for a recurring schedule strictly after `afterUtc`.
 * Returns `null` if `occurrencesCompleted >= maxOccurrences` or no occurrence exists on or before `endDate`.
 */
export function computeNextRecurrenceUtc(
  rule: RecurrenceRuleConfig,
  afterUtc: Date,
  occurrencesCompleted = 0
): Date | null {
  if (occurrencesCompleted >= rule.maxOccurrences) {
    return null;
  }
  if (!rule.daysOfWeek.length || !isValidIanaTimezone(rule.timezone)) {
    return null;
  }
  if (!isValidLocalDateString(rule.endDate) || !isValidLocalTimeString(rule.localStartTime)) {
    return null;
  }

  const zonedNow = getZonedWallParts(afterUtc, rule.timezone);
  const baseDayUtcMs = Date.UTC(zonedNow.year, zonedNow.month - 1, zonedNow.day);
  const allowedDays = new Set(rule.daysOfWeek);

  // Search up to 400 days forward to cover any valid weekly recurrence up to endDate
  for (let dayOffset = -1; dayOffset <= 400; dayOffset++) {
    const candidateDayUtc = new Date(baseDayUtcMs + dayOffset * 86_400_000);
    const yyyy = candidateDayUtc.getUTCFullYear();
    const mm = String(candidateDayUtc.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(candidateDayUtc.getUTCDate()).padStart(2, '0');
    const candidateDateStr = `${yyyy}-${mm}-${dd}`;

    if (candidateDateStr > rule.endDate) {
      return null;
    }

    const dow = candidateDayUtc.getUTCDay();
    if (!allowedDays.has(dow)) {
      continue;
    }

    const occurrenceUtc = resolveLocalDateTimeToUtc(
      candidateDateStr,
      rule.localStartTime,
      rule.timezone
    );
    if (occurrenceUtc.getTime() > afterUtc.getTime()) {
      return occurrenceUtc;
    }
  }

  return null;
}
