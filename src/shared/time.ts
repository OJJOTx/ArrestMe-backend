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
