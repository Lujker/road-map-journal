/** Problems in the model-free owner inbox contract (versions 1, 2 and 3). */
// Version 1 is the contract of roadctl 0.13.0: seven item types, every item with a hash. Version 2 (P5.44 a1) adds one
// type, `refused`: a card or routine whose `## Questions` data cannot be read is an item of its own with the reason and the
// same required fields as the others, so one broken item no longer refuses the whole answer. The version is the marker: a
// strict version 1 client sees a version it does not know and refuses the answer by that, instead of failing on one card.
const V1_TYPES = ['question', 'decision', 'review', 'approval', 'escalation', 'proposed', 'milestone'];
const V2_TYPES = [...V1_TYPES, 'refused'];

export function inboxProblems(value) {
  const problems = [];
  if (!value || ![1, 2, 3].includes(value.version) || !Array.isArray(value.items)) return ['expected version 1, 2 or 3 and items array'];
  const types = value.version === 1 ? V1_TYPES : V2_TYPES;
  if (value.version === 3 && (!value.milestones || !Number.isInteger(value.milestones.waiting) || value.milestones.waiting < 0 || typeof value.milestones.blocked !== 'boolean' || !(value.milestones.reason === null || typeof value.milestones.reason === 'string'))) problems.push('invalid milestone summary');
  for (const [index, item] of value.items.entries()) {
    if (!item || !types.includes(item.type)) problems.push(`items[${index}]: invalid type`);
    if (typeof item?.target !== 'string' || !item.target) problems.push(`items[${index}]: invalid target`);
    if (!/^[a-f0-9]{64}$/.test(item?.hash ?? '')) problems.push(`items[${index}]: invalid hash`);
    if (typeof item?.confirmation !== 'string' || !item.confirmation) problems.push(`items[${index}]: invalid confirmation`);
    if (['question', 'decision'].includes(item?.type) && (!item.question || typeof item.question.id !== 'string')) problems.push(`items[${index}]: missing question`);
    if (item?.type === 'refused' && (typeof item.reason !== 'string' || !item.reason)) problems.push(`items[${index}]: missing reason`);
  }
  return problems;
}
