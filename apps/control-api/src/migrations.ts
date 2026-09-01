import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

const defaultMigrationsDirectory = fileURLToPath(
  new URL("../../../db/migrations/", import.meta.url),
);

export async function runMigrations(
  sql: Sql,
  directory = process.env.AGENTWEAVE_MIGRATIONS_DIR ?? defaultMigrationsDirectory,
): Promise<string[]> {
  const files = (await readdir(directory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    if (file === "000_schema_migrations.sql") {
      await sql.unsafe(await readFile(join(directory, file), "utf8"));
    }

    const existing = await sql`select version from schema_migrations where version = ${file}`;
    if (existing.length) continue;

    const source = await readFile(join(directory, file), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`insert into schema_migrations (version) values (${file})`;
    });
    applied.push(file);
  }

  return applied;
}
