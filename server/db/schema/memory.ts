import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// One fileMemory() document per eve memory scope key. `version` backs the
// optimistic concurrency that eve's memory backend contract requires.
export const memoryDocuments = pgTable("memory_documents", {
  key: text("key").primaryKey(),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
