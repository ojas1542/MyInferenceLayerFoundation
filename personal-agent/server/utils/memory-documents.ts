import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";

export interface MemoryDocument {
  content: string;
  version: string;
}

export async function readMemoryDocument(key: string): Promise<MemoryDocument | undefined> {
  const [row] = await db.select()
    .from(schema.memoryDocuments)
    .where(eq(schema.memoryDocuments.key, key))
    .limit(1);

  return row ? { content: row.content, version: String(row.version) } : undefined;
}

/**
 * Replaces a memory document only if it is still at `expectedVersion`, or
 * creates it when `expectedVersion` is null and it does not exist yet.
 * Throws a 409 when another write got there first.
 */
export async function writeMemoryDocument(
  key: string,
  content: string,
  expectedVersion: string | null,
): Promise<MemoryDocument> {
  const table = schema.memoryDocuments;
  const rows = expectedVersion === null
    ? await db.insert(table)
        .values({ key, content, version: 1 })
        .onConflictDoNothing()
        .returning({ version: table.version })
    : await db.update(table)
        .set({ content, version: sql`${table.version} + 1` })
        .where(and(
          eq(table.key, key),
          eq(table.version, Number(expectedVersion)),
        ))
        .returning({ version: table.version });

  const [row] = rows;
  if (!row) {
    throw createError({
      statusCode: 409,
      statusMessage: "Memory document changed since it was read",
    });
  }

  return { content, version: String(row.version) };
}
