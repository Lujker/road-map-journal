// P5.4 (roadctl 0.12.0): a routine that holds itself after repeated failures, a started external run without a result, or an aborted run.
// The header keys (last_reason, fails, hold, hold_id) and the policy that sets them live in roadctl.mjs (`routine done`, `outcomePolicy`, `routine resume`);
// this module is the one place that turns a `hold` into the reason a routine would not run (hook `routine-reasons`), so `tick`, `routine list`, `routine show`,
// `status`, `lint` (rule 30) and `digest` (an immediate problem, once per hold episode: `hold_id` is new with every hold) show the same text.
// Run: node --test scripts/roadctl/outcome-policy.test.mjs
export const OUTCOME_MODULE_REQUIRES = '0.12.0';

export default {
  name: 'outcome-policy',
  hooks: {
    /** A held routine is never due: the reason names the hold and the way out (`routine resume`, owner only). */
    'routine-reasons'({ routine }) {
      const hold = String(routine.header.hold ?? '').trim();
      if (!hold) return {};
      return { reasons: [`held: ${hold} (roadctl routine resume ${routine.header.id ?? ''})`], lint: 'warning', immediate: true };
    },
  },
};
