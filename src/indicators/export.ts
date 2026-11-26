import PDFDocument from 'pdfkit';
import { strToU8, zipSync } from 'fflate';
import { DEFINITIONS, Figures } from './indicators.service';

type Report = {
  scope: { label: string; level: string };
  session: { name: string };
  term: { name: string } | null;
  staffAsOf: string | null;
  totals: Figures;
  breakdown: { name: string; lga: string; code?: string; figures: Figures }[];
  generatedAt: string;
};
type Trend = { bySession: { session: string; students: number; girlsShare: number | null; gpi: number | null; pupilsPerTeacher: number | null; attendanceRate: number | null; passRate: number | null }[] };

/** The columns of every table export, in order. */
const COLUMNS: { title: string; get: (f: Figures) => string | number | null }[] = [
  { title: 'Schools', get: (f) => f.schools },
  { title: 'Students', get: (f) => f.students },
  { title: 'Girls', get: (f) => f.girls },
  { title: 'Boys', get: (f) => f.boys },
  { title: 'Gender parity index', get: (f) => f.gpi },
  { title: 'Primary', get: (f) => f.byStage.primary },
  { title: 'Junior secondary', get: (f) => f.byStage.jss },
  { title: 'Senior secondary', get: (f) => f.byStage.sss },
  { title: 'Classes', get: (f) => f.classes },
  { title: 'Average class size', get: (f) => f.averageClassSize },
  { title: 'Teachers', get: (f) => f.teachers },
  { title: 'Pupils per teacher', get: (f) => f.pupilsPerTeacher },
  { title: 'Qualified teachers %', get: (f) => f.qualifiedTeachers },
  { title: 'TRCN-registered teachers %', get: (f) => f.trcnTeachers },
  { title: 'Non-teaching staff', get: (f) => f.nonTeachingStaff },
  { title: 'Attendance rate %', get: (f) => f.attendanceRate },
  { title: 'Subject results', get: (f) => f.resultEntries },
  { title: 'Average score', get: (f) => f.average },
  { title: 'Pass rate %', get: (f) => f.passRate },
  { title: 'Pass rate girls %', get: (f) => f.passRateGirls },
  { title: 'Pass rate boys %', get: (f) => f.passRateBoys },
  { title: 'Credit rate %', get: (f) => f.creditRate },
  { title: 'Schools inspected', get: (f) => f.inspected },
  { title: 'Condition critical', get: (f) => f.condition.critical },
  { title: 'Condition poor', get: (f) => f.condition.poor },
];

export function fileName(r: Report, ext: string) {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `osun-eduos-indicators-${slug(r.scope.label)}-${slug(r.session.name)}${r.term ? '-' + slug(r.term.name) : ''}.${ext}`;
}

function tableRows(r: Report) {
  const first = r.scope.level === 'lga' ? ['School', 'School number'] : ['LGA'];
  const head = [...first, ...COLUMNS.map((c) => c.title)];
  const body = r.breakdown.map((b) => [...(r.scope.level === 'lga' ? [b.name, b.code ?? ''] : [b.name]), ...COLUMNS.map((c) => c.get(b.figures))]);
  const total = [...(r.scope.level === 'lga' ? ['Total', ''] : ['Total']), ...COLUMNS.map((c) => c.get(r.totals))];
  return [head, ...body, total];
}

// ---------- CSV ----------

/** One CSV cell. Cells starting with = + - @ are prefixed so spreadsheet programs never run them as formulas. */
export function csvCell(v: unknown) {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV file with a byte-order mark, so Excel reads it as UTF-8. */
export const csvFile = (rows: unknown[][]) => '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function toCsv(r: Report): string {
  return csvFile(tableRows(r));
}

// ---------- Excel ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function colName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function sheetXml(rows: (string | number | null)[][], widths: number[]) {
  const cells = rows
    .map((row, ri) => {
      const header = ri === 0;
      const cs = row
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          if (v === null || v === undefined || v === '') return '';
          if (typeof v === 'number') return `<c r="${ref}"${header ? ' s="1"' : ''}><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cs}</row>`;
    })
    .join('');
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${cells}</sheetData></worksheet>`;
}

/** A small, dependable .xlsx writer: one sheet per table, bold frozen header row. */
export function toXlsx(r: Report, t: Trend): Buffer {
  const table = tableRows(r);
  const summary: (string | number | null)[][] = [
    ['Indicator', 'Value'],
    ['Area', r.scope.label],
    ['Session', r.session.name],
    ['Term', r.term?.name ?? 'Whole session'],
    ...COLUMNS.map((c) => [c.title, c.get(r.totals)] as (string | number | null)[]),
    ['Staff counted as at', r.staffAsOf],
    ['Generated', r.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC'],
  ];
  const trend: (string | number | null)[][] = [
    ['Session', 'Students', 'Girls %', 'Gender parity index', 'Pupils per teacher', 'Attendance rate %', 'Pass rate %'],
    ...t.bySession.map((s) => [s.session, s.students, s.girlsShare, s.gpi, s.pupilsPerTeacher, s.attendanceRate, s.passRate]),
  ];
  const defs: (string | number | null)[][] = [['Indicator', 'What it means'], ...DEFINITIONS.map((d) => [d.name, d.meaning])];
  const sheets = [
    { name: 'Summary', xml: sheetXml(summary, [34, 24]) },
    { name: r.scope.level === 'lga' ? 'By school' : 'By LGA', xml: sheetXml(table, table[0].map((_, i) => (i === 0 ? 32 : 14))) },
    { name: 'Trend', xml: sheetXml(trend, [14, 12, 10, 18, 18, 18, 12]) },
    { name: 'Definitions', xml: sheetXml(defs, [28, 100]) },
  ];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" xfId="0"/><xf fontId="1" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml)));
  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------- PDF ----------

const INDIGO = '#2B3786';
const MUTED = '#5B6275';
/** Chart colours checked for colour-blind readers (same as the web dashboard). */
const SERIES_1 = '#4757B8';

/** A printable summary for meetings: headline figures, a chart of the areas, the full table and definitions. */
export function toPdf(r: Report, t: Trend): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: `Education indicators: ${r.scope.label}, ${r.session.name}`, Author: 'Osun EduOS' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 72;
    const f = r.totals;
    const fmt = (v: number | null, suffix = '') => (v === null || v === undefined ? '–' : `${v.toLocaleString('en-NG')}${suffix}`);

    doc.fillColor(INDIGO).font('Helvetica-Bold').fontSize(20).text('Osun State Ministry of Education');
    doc.fillColor('#111').fontSize(14).text(`Education indicators: ${r.scope.label}`);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10)
      .text(`${r.session.name} session${r.term ? `, ${r.term.name}` : ''} · generated ${r.generatedAt.slice(0, 10)} from Osun EduOS · staff as at ${r.staffAsOf}`);
    doc.moveDown(0.8);

    // Headline figures.
    const tiles: [string, string][] = [
      ['Schools', fmt(f.schools)], ['Students', fmt(f.students)], ['Gender parity', fmt(f.gpi)], ['Pupils per teacher', fmt(f.pupilsPerTeacher)],
      ['Qualified teachers', fmt(f.qualifiedTeachers, '%')], ['Attendance', fmt(f.attendanceRate, '%')], ['Pass rate', fmt(f.passRate, '%')], ['Credit rate', fmt(f.creditRate, '%')],
    ];
    const tw = (W - 7 * 8) / 8;
    let y = doc.y;
    tiles.forEach(([k, v], i) => {
      const x = 36 + i * (tw + 8);
      doc.roundedRect(x, y, tw, 58, 6).lineWidth(0.7).strokeColor('#C9CDE0').stroke();
      doc.fillColor(MUTED).fontSize(7.5).text(k.toUpperCase(), x + 8, y + 8, { width: tw - 16, lineBreak: false, ellipsis: true });
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(18).text(v, x + 8, y + 26, { width: tw - 16, lineBreak: false });
      doc.font('Helvetica');
    });
    y += 74;

    // Bar chart: pass rate and attendance by area.
    const items = r.breakdown.filter((b) => b.figures.students > 0).slice(0, 30);
    if (items.length) {
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(`Pass rate and attendance by ${r.scope.level === 'lga' ? 'school' : 'LGA'}`, 36, y);
      doc.font('Helvetica');
      y += 18;
      const chartH = 150, baseY = y + chartH, bw = Math.min(28, (W - 20) / items.length);
      doc.strokeColor('#DDD').lineWidth(0.5);
      for (const g of [0, 25, 50, 75, 100]) {
        const gy = baseY - (g / 100) * chartH;
        doc.moveTo(56, gy).lineTo(56 + items.length * bw, gy).stroke();
        doc.fillColor(MUTED).fontSize(7).text(`${g}%`, 30, gy - 3, { width: 22, align: 'right' });
      }
      items.forEach((b, i) => {
        const x = 58 + i * bw;
        const pass = b.figures.passRate ?? 0, att = b.figures.attendanceRate ?? 0;
        doc.rect(x, baseY - (pass / 100) * chartH, bw * 0.42, (pass / 100) * chartH).fill(SERIES_1);
        doc.rect(x + bw * 0.44, baseY - (att / 100) * chartH, bw * 0.42, (att / 100) * chartH).fill('#B4651B');
        doc.save().rotate(-55, { origin: [x + bw / 2, baseY + 6] }).fillColor('#333').fontSize(6.5).text(b.name.slice(0, 24), x + bw / 2 - 60, baseY + 2, { width: 60, align: 'right' }).restore();
      });
      const lx = 70 + items.length * bw;
      doc.rect(lx, y + 4, 8, 8).fill(SERIES_1);
      doc.fillColor('#333').fontSize(8).text('Pass rate', lx + 12, y + 4);
      doc.rect(lx, y + 18, 8, 8).fill('#B4651B');
      doc.fillColor('#333').text('Attendance', lx + 12, y + 18);
      y = baseY + 70;
    }

    // Trend.
    if (t.bySession.length > 1) {
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text('Trend by session', 36, y);
      doc.font('Helvetica').fontSize(8.5).fillColor('#333');
      y += 16;
      const tcols = ['Session', 'Students', 'Girls %', 'GPI', 'Pupils/teacher', 'Attendance %', 'Pass rate %'];
      const cw = 90;
      tcols.forEach((c, i) => doc.font('Helvetica-Bold').text(c, 36 + i * cw, y, { width: cw - 6 }));
      doc.font('Helvetica');
      for (const s of t.bySession) {
        y += 13;
        [s.session, fmt(s.students), fmt(s.girlsShare), fmt(s.gpi), fmt(s.pupilsPerTeacher), fmt(s.attendanceRate), fmt(s.passRate)].forEach((v, i) => doc.text(String(v), 36 + i * cw, y, { width: cw - 6 }));
      }
    }

    // Full table on its own pages.
    doc.addPage();
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text(`Indicators by ${r.scope.level === 'lga' ? 'school' : 'LGA'}`);
    const cols: [string, (f: Figures) => string][] = [
      ['Schools', (x) => fmt(x.schools)], ['Students', (x) => fmt(x.students)], ['Girls %', (x) => fmt(x.girlsShare)], ['GPI', (x) => fmt(x.gpi)],
      ['Teachers', (x) => fmt(x.teachers)], ['Pupils/ teacher', (x) => fmt(x.pupilsPerTeacher)], ['Qualified %', (x) => fmt(x.qualifiedTeachers)],
      ['Attend. %', (x) => fmt(x.attendanceRate)], ['Average', (x) => fmt(x.average)], ['Pass %', (x) => fmt(x.passRate)], ['Credit %', (x) => fmt(x.creditRate)],
      ['Inspected', (x) => fmt(x.inspected)], ['Poor or critical', (x) => fmt(x.condition.poor + x.condition.critical)],
    ];
    const nameW = 170, cw = (W - nameW) / cols.length;
    let ty = doc.y + 8;
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
      doc.text(r.scope.level === 'lga' ? 'School' : 'LGA', 36, ty, { width: nameW });
      cols.forEach(([h], i) => doc.text(h, 36 + nameW + i * cw, ty, { width: cw - 4, align: 'right' }));
      ty += 20;
      doc.font('Helvetica').fillColor('#111');
    };
    header();
    const line = (name: string, x: Figures, bold = false) => {
      if (ty > doc.page.height - 50) {
        doc.addPage();
        ty = 36;
        header();
      }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      doc.text(name, 36, ty, { width: nameW, ellipsis: true, lineBreak: false });
      cols.forEach(([, g], i) => doc.text(g(x), 36 + nameW + i * cw, ty, { width: cw - 4, align: 'right' }));
      ty += 13;
    };
    r.breakdown.forEach((b) => line(b.name, b.figures));
    doc.moveTo(36, ty).lineTo(36 + W, ty).lineWidth(0.5).strokeColor('#999').stroke();
    ty += 4;
    line('Total', r.totals, true);

    // Definitions.
    doc.addPage();
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text('What the indicators mean');
    doc.moveDown(0.5);
    for (const d of DEFINITIONS) {
      doc.font('Helvetica-Bold').fontSize(9).text(d.name, { continued: true }).font('Helvetica').text(`: ${d.meaning}`);
      doc.moveDown(0.3);
    }
    doc.moveDown(1).fillColor(MUTED).fontSize(8).text('Figures come from the records schools keep in Osun EduOS. Results include only classes whose results the school has released.');
    doc.end();
  });
}
