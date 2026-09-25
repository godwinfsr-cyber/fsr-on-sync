// Import FIRST in a test file: points DATA_DIR at a throwaway folder before ../../src/config.ts is evaluated,
// so tests never read or write the real sync databases in data/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-sync-test-"));
