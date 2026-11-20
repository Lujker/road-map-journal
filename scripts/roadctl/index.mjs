// The list of roadctl modules. To add a module: create scripts/roadctl/<name>.mjs (default export, see registry.mjs),
// its own test file scripts/roadctl/<name>.test.mjs, and add ONE import and ONE array entry here (append at the end).
// roadctl.mjs itself is not edited for a new module that only needs the seams.
import { buildRegistry } from './registry.mjs';
import probe from './probe.mjs';
import doctor from './doctor.mjs';
import runLedger from './run-ledger.mjs';
import pause from './pause.mjs';
import digest from './digest.mjs';
import supervise from './supervise.mjs';
import approvalHash from './approval-hash.mjs';
import launch from './launch.mjs';
import mandate from './mandate.mjs';
import ownerGateModule, { ownerGate } from './owner-gate.mjs';
import stats from './stats.mjs';
import environment from './environment.mjs';
import plan from './plan.mjs';
import checkpoint from './checkpoint.mjs';
import outcomePolicy from './outcome-policy.mjs';
import limitCheckpoint from './limit-checkpoint.mjs';
import ownerQuestions from './owner-questions.mjs';

export const MODULES = [probe, doctor, runLedger, pause, digest, supervise, approvalHash, launch, mandate, ownerGateModule, stats, environment, plan, checkpoint, outcomePolicy, limitCheckpoint, ownerQuestions];

export const buildModuleRegistry = (opts) => ({ ...buildRegistry(MODULES, opts), ownerGate }); // P5.3: main() asks ownerGate before every command
