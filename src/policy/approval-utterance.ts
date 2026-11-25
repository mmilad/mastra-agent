const APPROVE_SHORT = new Set([
  'approve',
  'approve it',
  'approve that',
  'approve this',
  'approve the task',
  'please approve',
  'please approve it',
  'go ahead',
  'go ahead and approve',
  'yes approve',
  'yes, approve',
  'yes please',
  'do it',
  'sure',
  'ok',
  'okay',
  'yes',
  'yep',
  'yeah',
]);

const DENY_SHORT = new Set([
  'deny',
  'deny it',
  'deny that',
  'no',
  'no thanks',
  'cancel',
  'cancel it',
  'stop',
  'reject',
  'reject it',
]);

function normalizeUtterance(message: string): string {
  return message.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
}

/** User clearly means “approve the pending worker permission” without pasting a token. */
export function isInformalApproval(message: string): boolean {
  const text = normalizeUtterance(message);
  if (!text) return false;
  if (APPROVE_SHORT.has(text)) return true;
  if (/^approve\s+(it|that|this|them|the task)$/.test(text)) return true;
  if (/^(yes|yep|yeah|ok|okay|sure)\s*,?\s*(approve(\s+it)?)?$/.test(text)) return true;
  return false;
}

export function isInformalDenial(message: string): boolean {
  const text = normalizeUtterance(message);
  if (!text) return false;
  if (DENY_SHORT.has(text)) return true;
  if (/^(no|don't|do not)\s+(do it|approve)/.test(text)) return true;
  return false;
}