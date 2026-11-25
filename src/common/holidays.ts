import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** The holiday covering a date, if any. */
export function holidayOn(db: Db, date: Date) {
  return db.holiday.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } }, orderBy: { startDate: 'asc' }, select: { name: true } });
}

/** Western Easter Sunday for a year (anonymous Gregorian algorithm). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const plus = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Nigerian federal public holidays with fixed or calculable dates between two dates.
 * Eid al-Fitr, Eid al-Adha and Id el-Maulud follow the moon and are announced by the Federal Government each year,
 * so the Ministry adds those (and any state holidays or replacement days) by hand.
 */
export function nationalHolidays(from: Date, to: Date): { name: string; date: Date }[] {
  const out: { name: string; date: Date }[] = [];
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
    const easter = easterSunday(y);
    out.push(
      { name: "New Year's Day", date: utc(y, 1, 1) },
      { name: 'Good Friday', date: plus(easter, -2) },
      { name: 'Easter Monday', date: plus(easter, 1) },
      { name: "Workers' Day", date: utc(y, 5, 1) },
      { name: 'Democracy Day', date: utc(y, 6, 12) },
      { name: 'Independence Day', date: utc(y, 10, 1) },
      { name: 'Christmas Day', date: utc(y, 12, 25) },
      { name: 'Boxing Day', date: utc(y, 12, 26) },
    );
  }
  return out.filter((h) => h.date >= from && h.date <= to).sort((a, b) => a.date.getTime() - b.date.getTime());
}
