/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Read-only DB usage analysis: find empty tables and columns that are
 * entirely NULL / always-default (candidates for cleanup).
 *
 *   pnpm tsx scripts/analyze-db-usage.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

type ColInfo = {
  table: string;
  column: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function main() {
  const tables: { table_name: string }[] = await prisma.$queryRawUnsafe(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
      AND table_name NOT IN ('_prisma_migrations')
    ORDER BY table_name
  `);

  const cols: ColInfo[] = await prisma.$queryRawUnsafe(`
    SELECT table_name AS table, column_name AS column, data_type,
           is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public'
    ORDER BY table_name, ordinal_position
  `);

  const colsByTable = new Map<string, ColInfo[]>();
  for (const c of cols) {
    if (!colsByTable.has(c.table)) colsByTable.set(c.table, []);
    colsByTable.get(c.table)!.push(c);
  }

  const emptyTables: string[] = [];
  const tableRows: { table: string; rows: number }[] = [];
  const deadColumns: { table: string; column: string; reason: string }[] = [];
  let analyzedCols = 0;

  for (const { table_name } of tables) {
    const cntRows: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "${table_name}"`,
    );
    const n = cntRows[0].n as number;
    tableRows.push({ table: table_name, rows: n });
    if (n === 0) {
      emptyTables.push(table_name);
      continue; // skip column analysis for empty tables
    }

    // Column analysis only on populated tables — EXHAUSTIVE: every column, every type.
    // Cast to ::text so json/uuid/timestamp/date/array all get the same treatment.
    for (const c of colsByTable.get(table_name) ?? []) {
      analyzedCols++;
      const colQ = `"${c.column}"`;
      const r: any[] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(${colQ})::int AS non_null,
                COUNT(DISTINCT ${colQ}::text)::int AS d,
                MIN(${colQ}::text) AS v
         FROM "${table_name}"`,
      );
      const { non_null, d, v } = r[0];
      if (non_null === 0) {
        deadColumns.push({ table: table_name, column: c.column, reason: 'all NULL' });
      } else if (d === 1) {
        const allRows = non_null === n ? '' : ` (NULL in ${n - non_null}/${n})`;
        deadColumns.push({
          table: table_name,
          column: c.column,
          reason: `always = ${JSON.stringify(v)}${allRows} (default ${c.column_default ?? 'none'})`,
        });
      }
    }
  }

  console.log('\n========== ROW COUNTS ==========');
  for (const t of tableRows.sort((a, b) => a.rows - b.rows)) {
    console.log(`${String(t.rows).padStart(8)}  ${t.table}`);
  }

  console.log('\n========== EMPTY TABLES (0 rows) ==========');
  for (const t of emptyTables) console.log(`  - ${t}`);
  console.log(`  total: ${emptyTables.length}`);

  console.log('\n========== DEAD / CONSTANT COLUMNS (in populated tables) ==========');
  let curr = '';
  for (const d of deadColumns) {
    if (d.table !== curr) {
      console.log(`\n  ${d.table}:`);
      curr = d.table;
    }
    console.log(`     - ${d.column.padEnd(28)} ${d.reason}`);
  }
  console.log(`\n  total dead/constant columns: ${deadColumns.length}`);

  console.log('\n========== COVERAGE ==========');
  console.log(`  tables total: ${tables.length}  | empty: ${emptyTables.length}  | populated: ${tables.length - emptyTables.length}`);
  console.log(`  columns total: ${cols.length}  | analyzed (in populated tables): ${analyzedCols}  | in empty tables (whole table empty): ${cols.length - analyzedCols}`);
  console.log(`  every analyzed column checked for: all-NULL  AND  single-distinct-value (every data type, ::text cast)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
