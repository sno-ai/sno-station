# Third-Party Notices

Sno Station bundles or vendors the following third-party work. Each item lists where it lives
in this repository, its upstream, and its license. Every npm dependency not listed here is
consumed unmodified through `package.json` under its own license.

## mblaze — `apps/reach/vendor/mblaze`

- Upstream: https://github.com/leahneukirchen/mblaze (source snapshot from tag v1.4)
- License: public domain (CC0 1.0), with two MIT-licensed files (`mystrverscmp.c`,
  `mymemmem`) by Rich Felker. Full text and attribution in `apps/reach/NOTICE` and
  `apps/reach/vendor/mblaze/COPYING`.

## pplx-embed-v1-0.6b (ONNX, INT8) — bundled embedding model, `packages/embedder`

- Model: `tss-deposium/pplx-embed-v1-0.6b-onnx-int8-standard` on Hugging Face, an ONNX
  quantisation of `perplexity-ai/pplx-embed-v1-0.6B`.
- License: MIT (model card).
- The model is downloaded at first use; it is not committed to this repository.

## mmarco-mMiniLMv2-L12-H384-v1 (ONNX, 8-bit) — local recall ranking model, `packages/embedder`

- Model: `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` on Hugging Face, a multilingual cross-encoder trained on mMARCO, a
  machine translation of MS MARCO.
- License: Apache-2.0 (model card).
- The model is downloaded at first use; it is not committed to this repository.

## SQLite3MultipleCiphers — via `better-sqlite3-multiple-ciphers`, `packages/sqlite-crypto`

- Upstream: https://github.com/utelle/SQLite3MultipleCiphers
- License: MIT. Used unmodified through the npm package.

---

If you believe a notice is missing or wrong, open an issue or email security@sno.ai.
