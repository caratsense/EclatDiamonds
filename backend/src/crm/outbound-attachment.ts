/**
 * Where a conversation's outbound attachments live, and how a key offered by a
 * caller is checked against that.
 *
 * Its own file because two layers need the same rule and they must not drift:
 * `storeAttachment` writes the key, `queueOutbound` decides whether to trust
 * one it was handed. A second copy of this string in the second place is the
 * bug waiting to happen.
 */

/** One folder per thread. The trailing slash matters — see the sibling-prefix test. */
export function outboundAttachmentFolder(
  organisationId: string,
  conversationId: string,
): string {
  return `org/${organisationId}/outbound/${conversationId}/`;
}

/**
 * May this conversation attach this key?
 *
 * The organisation prefix alone is not enough. Every key in the tenant carries
 * it — another thread's inbound photograph, a different customer's quote PDF —
 * so checking only that would let a caller name any file in the business and
 * have us deliver it to a customer. The conversation segment is the actual
 * boundary; `readPrivate` then enforces the tenant one underneath.
 */
export function isOwnAttachmentKey(
  key: string,
  organisationId: string,
  conversationId: string,
): boolean {
  if (!key || !organisationId || !conversationId) return false;
  // `..` would climb out of the folder while still matching the prefix.
  if (key.includes('..')) return false;
  return key.startsWith(outboundAttachmentFolder(organisationId, conversationId));
}
