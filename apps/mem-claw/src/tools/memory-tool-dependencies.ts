/* Shared host tool dependencies; no runtime composition. */
export { existsSync, realpathSync } from "node:fs";
export { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
export { homedir } from "node:os";
export { basename, dirname, join, resolve, sep } from "node:path";
export { Type } from "@sinclair/typebox";
export { Mutex } from "async-mutex";
export type { OpenClawPluginApi as SnoStationMemPluginApi } from "openclaw/plugin-sdk/core";
export { z } from "zod";
export { RESOURCES_BY_LOCALE } from "@snoai/memory/internal/engine/i18n/all-resources";
export type { Locale } from "@snoai/memory/internal/engine/i18n/locales";
export { DEFAULT_LOCALE } from "@snoai/memory/internal/engine/i18n/locales";
export { SnoStationMemError } from "@snoai/memory/internal/engine/shared/errors";
export { AGGREGATION_OPERATIONS, MEMORY_CATEGORIES } from "@snoai/memory/internal/engine/shared/types";
