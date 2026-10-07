# @snoai/embedder

Local text embeddings for Sno Station: the part that lets memory be found by meaning, with no
API key and no network call after the first download.

It runs a quantized ONNX embedding model on your machine (1024-dimension vectors, pinned to a
fixed model revision) through `@huggingface/transformers`, and adds an in-memory LRU cache so
repeated text is not embedded twice.

- `LocalEmbedProvider` creates the embeddings; `CachedEmbeddingProvider` wraps it with the cache.
- `ensureModelDownloaded` fetches the model once into a cache folder, and `isModelCached`
  tells you whether it is already there. The shared memory setup calls it, so your first agent
  session does not wait for the download.

```ts
import { ensureModelDownloaded, LocalEmbedProvider } from "@snoai/embedder";
```

Who it is for: the memory engine, and anyone building on it. If you only want shared agent
memory, you install it as part of the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md),
then add the plugin for your agent ([Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude),
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw)).

```bash
npm install @snoai/embedder@1.1.0
```

Licensed under Apache-2.0.
