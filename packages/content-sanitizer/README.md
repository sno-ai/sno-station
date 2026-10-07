# @snoai/content-sanitizer

Cleans text before it is stored, on your machine, with no model in the loop.

It is one of the building blocks of the Sno Station memory engine: what an agent reads and says
can contain pasted secrets, private blocks and noisy markup, and none of that should end up in a
memory. This package turns text, HTML and email, rich text, structured JSON, transcripts and
JSONL replays into plain, extraction-ready text, and redacts secrets and private blocks on the
way. It hands the result to [`@snoai/chunking`](https://www.npmjs.com/package/@snoai/chunking)
for splitting; it has no chunker of its own and needs no hosted service.

## Install

```bash
npm install @snoai/content-sanitizer@1.1.0
```

## Public APIs

- `sanitizeContentIngress(input)`
- `sanitizeAndChunkContent(input, options?)`
- `redactForStorage(text)`
- `sanitizePlainText(text, options?)`
- `projectHtml(html, options?)`
- `projectRichText(value, options?)`
- `sanitizeStructuredJsonForStorage(value, options?)`
- `sanitizeTranscript(value, options?)`
- `parseReplayJsonl(text, options?)`
- `validateExtractedContentForStorage(value, options?)`

Only `mode: "storage-safe"` is supported. Preview-preserving behavior belongs in a
caller-owned adapter, not this package.

Who it is for: the memory engine ([`@snoai/memory`](https://www.npmjs.com/package/@snoai/memory))
and anyone who needs storage-safe text. If you want shared agent memory, start with the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md).
Licensed under Apache-2.0.
