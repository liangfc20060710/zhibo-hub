import { uid } from '../agent_core/util.mjs';

export const PERFORMATIVES = [
  'CFP',
  'PROPOSE',
  'AWARD',
  'ACCEPT',
  'REJECT',
  'INFORM',
  'REQUEST',
  'VOTE',
  'VETO',
  'ESCALATE',
  'HEARTBEAT'
];

export function createEnvelope({
  sender,
  receiver = null,
  performative = 'INFORM',
  content = {},
  traceId,
  inReplyTo = null,
  priority = 5,
  meta = {}
}) {
  if (!sender) throw new Error('Envelope.sender is required');
  if (!PERFORMATIVES.includes(performative)) {
    throw new Error(`Unknown performative: ${performative}`);
  }
  if (!traceId) throw new Error('Envelope.traceId is required');
  return {
    msgId: uid('MSG'),
    sender,
    receiver,
    performative,
    inReplyTo,
    priority,
    content,
    traceId,
    createdAt: Date.now(),
    meta
  };
}

export function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return false;
  if (!env.msgId || !env.sender || !env.traceId) return false;
  if (!PERFORMATIVES.includes(env.performative)) return false;
  return true;
}
