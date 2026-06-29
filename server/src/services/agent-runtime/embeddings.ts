import path from "node:path";
import { resolvePaperclipHomeDir } from "../../home-paths.js";
import { logger } from "../../middleware/logger.js";

/**
 * Minimal, swappable embedding seam. The default implementation runs a small multilingual
 * model fully in-process on the host (no API key, no per-call cost, no data leaves the box).
 *
 * Everything degrades gracefully: if the optional `@huggingface/transformers` dependency is
 * missing or fails to load (e.g. an ARM/onnxruntime issue), `getEmbedder()` returns a function
 * that always resolves `null`. Callers MUST treat `null` as "embeddings unavailable" and fall
 * back to heuristic ranking — embeddings are an optimization, never a hard requirement.
 */

export type EmbedKind = "query" | "passage";

/** Returns one vector per input text, or `null` if embeddings are unavailable. */
export type EmbedFn = (texts: string[], kind: EmbedKind) => Promise<number[][] | null>;

// `Xenova/multilingual-e5-small` ships ONNX weights compatible with transformers.js and handles
// Dutch + English well. 384 dimensions. If this id ever changes, re-run the backfill script:
// stored `embeddingModel` lets us detect and ignore stale vectors.
export const EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIM = 384;

// e5 models require these instruction prefixes; mismatching them silently degrades retrieval.
const PREFIX: Record<EmbedKind, string> = {
  query: "query: ",
  passage: "passage: ",
};

let embedderPromise: Promise<EmbedFn> | null = null;

const NULL_EMBEDDER: EmbedFn = async () => null;

async function buildEmbedder(): Promise<EmbedFn> {
  try {
    // Dynamic import via a variable specifier so TypeScript does not require the optional
    // dependency to be installed at compile time.
    const specifier = "@huggingface/transformers";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(specifier);
    if (mod?.env) {
      // Cache the (~120MB int8) model once under the Paperclip home dir.
      mod.env.cacheDir = path.join(resolvePaperclipHomeDir(), "models", "transformers");
      mod.env.allowLocalModels = true;
    }
    const extractor = await mod.pipeline("feature-extraction", EMBEDDING_MODEL_ID, { dtype: "q8" });

    const embed: EmbedFn = async (texts, kind) => {
      if (!texts.length) return [];
      try {
        const prefixed = texts.map((t) => PREFIX[kind] + (t ?? ""));
        const output = await extractor(prefixed, { pooling: "mean", normalize: true });
        const list = output.tolist() as number[][];
        return list;
      } catch (err) {
        logger.warn({ err }, "embeddings: embed call failed; falling back to heuristic ranking");
        return null;
      }
    };

    logger.info({ model: EMBEDDING_MODEL_ID }, "embeddings: local embedder ready");
    return embed;
  } catch (err) {
    logger.warn(
      { err },
      "embeddings: local embedder unavailable (@huggingface/transformers missing or failed to load); using heuristic ranking",
    );
    return NULL_EMBEDDER;
  }
}

/**
 * Lazily initialize and cache the embedder. Safe to call repeatedly. Never throws — on failure
 * it resolves a no-op embedder that returns `null`.
 */
export function getEmbedder(): Promise<EmbedFn> {
  if (!embedderPromise) {
    embedderPromise = buildEmbedder();
  }
  return embedderPromise;
}

/** Reset the cached embedder (tests only). */
export function __resetEmbedderForTests(): void {
  embedderPromise = null;
}

/**
 * Cosine similarity of two vectors. e5 outputs are already L2-normalized, so this is a plain
 * dot product; we still guard against length mismatch (e.g. stale vectors from another model).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
