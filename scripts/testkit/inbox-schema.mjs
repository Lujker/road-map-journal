/** Problems in the model-free owner inbox contract (version 1). */
export function inboxProblems(value) {
  const problems = [];
  if (!value || value.version !== 1 || !Array.isArray(value.items)) return ['expected version 1 and items array'];
  for (const [index, item] of value.items.entries()) {
    if (!item || !['question', 'decision', 'review', 'approval', 'escalation', 'proposed', 'milestone'].includes(item.type)) problems.push(`items[${index}]: invalid type`);
    if (typeof item?.target !== 'string' || !item.target) problems.push(`items[${index}]: invalid target`);
    if (!/^[a-f0-9]{64}$/.test(item?.hash ?? '')) problems.push(`items[${index}]: invalid hash`);
    if (typeof item?.confirmation !== 'string' || !item.confirmation) problems.push(`items[${index}]: invalid confirmation`);
    if (['question', 'decision'].includes(item?.type) && (!item.question || typeof item.question.id !== 'string')) problems.push(`items[${index}]: missing question`);
  }
  return problems;
}
