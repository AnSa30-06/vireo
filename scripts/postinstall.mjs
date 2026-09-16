// Runs after `npm install`. Deliberately does nothing that can fail the install:
// heavy work (browser download, gateway bootstrap) belongs to `ledgerline setup`,
// which can report progress and errors to a user who is watching.
import { ensureDirs } from "../src/util/paths.mjs";

try {
  ensureDirs();
  console.log("ledgerline: data directories ready. Run `ledgerline setup` to finish configuration.");
} catch (err) {
  console.log(`ledgerline: postinstall skipped (${err.message}). Run \`ledgerline setup\` when ready.`);
}
