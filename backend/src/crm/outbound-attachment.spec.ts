import { ATTACHABLE_IMAGE_MIMES, attachmentKind } from '../omnichannel/omnichannel.service';
import { isOwnAttachmentKey, outboundAttachmentFolder } from './outbound-attachment';

/**
 * Sending a photograph to a customer.
 *
 * Outbound media used to fail permanently with "WhatsApp media delivery is not
 * connected yet", so a salesperson could not send the ring the customer had
 * just asked to see. It now rides the same stored-attachment instruction a
 * quote PDF uses — which is exactly why the key has to be checked: that
 * instruction was documented as never coming from a request body, and now one
 * value in it does.
 */
describe('outbound attachments', () => {
  const ORG = 'org_eclat';
  const CONVO = 'cmv123conversation';
  const mine = `${outboundAttachmentFolder(ORG, CONVO)}a1b2.jpg`;

  describe('which WhatsApp message the bytes become', () => {
    it.each(ATTACHABLE_IMAGE_MIMES)('%s is sent as an image', (mime) => {
      // A photograph sent as a document is delivered and useless: WhatsApp
      // shows a file to download instead of the piece of jewellery.
      expect(attachmentKind(mime)).toBe('image');
    });

    it('a PDF is still sent as a document', () => {
      expect(attachmentKind('application/pdf')).toBe('document');
    });
  });

  describe('a key the caller offers', () => {
    it('is accepted when this conversation uploaded it', () => {
      expect(isOwnAttachmentKey(mine, ORG, CONVO)).toBe(true);
    });

    it('is refused when it belongs to another conversation', () => {
      // The whole point. Same organisation, same folder shape, different
      // customer — and without this check we would have delivered it.
      const theirs = `${outboundAttachmentFolder(ORG, 'cmvOTHERconversation')}a1b2.jpg`;
      expect(isOwnAttachmentKey(theirs, ORG, CONVO)).toBe(false);
    });

    it('is refused when it belongs to another organisation', () => {
      const other = `${outboundAttachmentFolder('org_someone_else', CONVO)}a1b2.jpg`;
      expect(isOwnAttachmentKey(other, ORG, CONVO)).toBe(false);
    });

    it('is refused for a quote PDF or any other private document', () => {
      expect(isOwnAttachmentKey(`org/${ORG}/documents/quote-QT-2008.pdf`, ORG, CONVO)).toBe(false);
    });

    it('is refused for an inbound photo from the same thread', () => {
      // Inbound media is stored elsewhere; re-sending it is not what the
      // attach button does, and allowing it would widen the rule for nothing.
      expect(isOwnAttachmentKey(`org/${ORG}/inbound/${CONVO}/x.jpg`, ORG, CONVO)).toBe(false);
    });

    it('is refused when it tries to climb out of the folder', () => {
      expect(
        isOwnAttachmentKey(`${outboundAttachmentFolder(ORG, CONVO)}../../documents/q.pdf`, ORG, CONVO),
      ).toBe(false);
    });

    it('is refused for a sibling conversation whose id merely starts the same', () => {
      // Why the folder ends in a slash: without it, conversation "abc" would
      // accept a key written for conversation "abcdef".
      const sibling = `org/${ORG}/outbound/${CONVO}extra/a1b2.jpg`;
      expect(isOwnAttachmentKey(sibling, ORG, CONVO)).toBe(false);
    });

    it.each([
      ['', ORG, CONVO],
      [mine, '', CONVO],
      [mine, ORG, ''],
    ])('is refused when something is missing (%s,%s,%s)', (key, org, convo) => {
      expect(isOwnAttachmentKey(key, org, convo)).toBe(false);
    });
  });
});
