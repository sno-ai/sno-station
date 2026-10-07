# @snoai/chunking

Splits text into chunks the same way every time, on your machine, with no model in the loop.

It is one of the building blocks of the Sno Station memory engine: before a conversation or
document can be searched by meaning and by keyword, it has to be cut into pieces of the right
size. This package does that cutting. Conversations, prose and structured text each get their
own boundaries, and Chinese, Japanese and Korean text is counted properly instead of being
treated as one long word. The same input always gives the same chunks and the same chunk ids.

## Install

```bash
npm install @snoai/chunking@1.1.1
```

## Usage

```ts
import { chunk, getCjkRatio } from "@snoai/chunking";

const chunks = chunk("user: Remember the deployment checklist.", {
	contentType: "conversation",
	targetTokens: 4096,
	maxTokens: 4096,
});

console.log(chunks.map((c) => c.chunkText));
console.log(getCjkRatio("abc 中文"));
```

The package runs locally. It does not call hosted chunking APIs, fetch implementation code during
install, require private npm credentials, or use an LLM for token counting or boundaries.

Who it is for: the memory engine ([`@snoai/memory`](https://www.npmjs.com/package/@snoai/memory))
and anyone who needs deterministic chunking. If you want shared agent memory, start with the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md).
Licensed under Apache-2.0.
