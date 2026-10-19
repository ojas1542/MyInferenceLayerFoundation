import { z } from "zod";
import { requireInternalRequest } from "~~/server/utils/internal-api";
import { readMemoryDocument } from "~~/server/utils/memory-documents";

const querySchema = z.object({
  key: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const { key } = await getValidatedQuery(event, querySchema.parse);
  const document = await readMemoryDocument(key);

  return { document: document ?? null };
});
