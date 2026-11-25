/**
 * Test preload (`node --import`, wired in the `test` script): points every
 * mutable-data seam at a private temp dir BEFORE any test module loads, so a
 * suite that touches chatStore/graph/jobStore never writes into a real data
 * dir. Without it, a shell that exports LH_DATA_DIR (the Codespace does, to
 * the learnharness-data clone) gets fixture chats like "steer: live" in the
 * user's history. config.ts reads these vars once at import, so this must run
 * first. Suites that set their own LH_DATA_DIR/LH_AUTH_FILE still win: they
 * assign after this preload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

process.on("exit", () => {
	fs.rmSync(dir, { recursive: true, force: true });
});
