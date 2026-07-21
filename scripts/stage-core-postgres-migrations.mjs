#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const source = resolve(repoRoot, "packages/core/src/postgres/migrations");
const destination = resolve(repoRoot, "packages/core/dist/postgres/migrations");

if (!existsSync(source)) {
  throw new Error(`PostgreSQL migration source directory is missing: ${source}`);
}

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
console.log(`[fusion] staged PostgreSQL migrations into ${destination}`);
