// The list of roadctl modules. To add a module: create scripts/roadctl/<name>.mjs (default export, see registry.mjs),
// its own test file scripts/roadctl/<name>.test.mjs, and add ONE import and ONE array entry here (append at the end).
// roadctl.mjs itself is not edited for a new module that only needs the seams.
import { buildRegistry } from './registry.mjs';
import probe from './probe.mjs';
import doctor from './doctor.mjs';
import runLedger from './run-ledger.mjs';

export const MODULES = [probe, doctor, runLedger];

export const buildModuleRegistry = (opts) => buildRegistry(MODULES, opts);
