/**
 * A structured turn can be delivered again after a broker retry or control-api
 * restart. Persisted message ids are derived from the stable turn id, so a
 * replay must not publish the already-persisted message a second time.
 */
export function shouldPublishMessage(messageId: string, knownMessageIds: ReadonlySet<string>): boolean {
  return !knownMessageIds.has(messageId);
}
