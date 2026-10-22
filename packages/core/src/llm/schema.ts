import { z } from "zod";

/**
 * Zod schema for a single candidate file mutation.
 *
 * NOTE: `content` is the full new file content, not a git patch or unified diff.
 * Applying the mutation is a deterministic overwrite of the target path.
 */
export const FileMutationSchema = z.object({
  path: z.string().min(1, "Mutation path cannot be empty"),
  content: z.string({ required_error: "Mutation content must be provided" }),
  rationale: z.string().default(""),
});

export type FileMutation = z.infer<typeof FileMutationSchema>;

/**
 * Structured LLM response schema.
 *
 * An empty `mutations: []` list represents the model intentionally
 * "giving up" when it believes no further optimizations are possible.
 */
export const MutationSchema = z.object({
  mutations: z.array(FileMutationSchema),
});

export type MutationPayload = z.infer<typeof MutationSchema>;
