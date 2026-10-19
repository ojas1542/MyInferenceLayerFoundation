import { z } from "zod";
import { requireInternalRequest } from "~~/server/utils/internal-api";
import { writeMemoryDocument } from "~~/server/utils/memory-documents";

const bodySchema = z.object({
  key: z.string().min(1),
  content: z.string(),
  expectedVersion: z.string().regex(/^\d+$/).nullable(),
});

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const { key, content, expectedVersion } = await readValidatedBody(event, bodySchema.parse);
  const document = await writeMemoryDocument(key, content, expectedVersion);

  return { document };
});
