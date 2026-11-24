import { BadRequestException } from '@nestjs/common';

/** Parses a YYYY-MM-DD date as a UTC calendar date. */
export function parseDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label} must be a date (YYYY-MM-DD).`);
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${label} is not a real date.`);
  return d;
}

export function today(): Date {
  return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
}

export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
