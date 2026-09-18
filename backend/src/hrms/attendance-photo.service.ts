import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import { StorageService } from '../storage/storage.service';

/**
 * Reading back an attendance photo.
 *
 * ## Why this exists rather than a link
 *
 * The punch photo was written to object storage and its URL handed straight to
 * the client. On the local provider that URL is served by express static, which
 * runs ahead of Nest's router and therefore ahead of every guard in the
 * application — so an attendance photo was fetchable by anyone who had the link,
 * from any organisation, signed in or not. On R2 the bucket is configured for
 * public read, so the URL is a bearer capability there too.
 *
 * A face photograph of a named employee at a named time and place is not a
 * catalogue thumbnail. It is the one class of object in this system where "the
 * path is unguessable" is not an acceptable substitute for a check. So the URL
 * no longer leaves the server: the API returns a route on THIS controller, and
 * the bytes are handed over only after the caller has been checked against the
 * record.
 *
 * ## Who may look
 *
 * The staffer themselves, and a manager at a branch the record belongs to.
 * A colleague at the same counter may not — they have no reason to hold a
 * picture of someone else's face, and "same organisation" is not a reason.
 *
 * ## At-rest protection
 *
 * New attendance objects are AES-256-GCM envelopes written by StorageService.
 * The existing R2 bucket may remain public for catalogue images: somebody who
 * obtains an attendance object URL receives authenticated ciphertext, never the
 * face photograph. The key remains server-only. Namespaced legacy plaintext is
 * accepted on read during migration; every new production write fails closed
 * when `ATTENDANCE_MEDIA_KEY` is absent.
 */
@Injectable()
export class AttendancePhotoService {
  private readonly logger = new Logger(AttendancePhotoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The stored bytes of one punch photo, or a refusal.
   *
   * `which` is the punch, not a file name: a caller names the record and the end
   * of the day it wants, never a path. There is no way to ask this for an
   * arbitrary object.
   */
  async read(
    user: AuthUser,
    recordId: string,
    which: 'in' | 'out',
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const record = await this.prisma.attendanceRecord.findFirst({
      // Organisation first. A record id is a cuid, but a lookup that finds the
      // row and then decides is a lookup that can be got wrong later.
      where: { id: recordId, organisationId: user.organisationId },
      select: {
        id: true,
        staffId: true,
        storeId: true,
        checkInPhotoUrl: true,
        checkOutPhotoUrl: true,
      },
    });
    if (!record) throw new NotFoundException('No such attendance record.');

    const isOwn = record.staffId === user.id;
    const isManager = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;
    if (!isOwn) {
      if (!isManager) {
        throw new ForbiddenException('Only a manager may review another person’s punch photo.');
      }
      // A manager, but only at a branch they actually cover.
      this.scope.assertStoreAllowed(user, record.storeId);
    }

    const stored = which === 'in' ? record.checkInPhotoUrl : record.checkOutPhotoUrl;
    if (!stored) throw new NotFoundException('No photo was taken with this punch.');

    // Belt and braces: the object must sit under this tenant's prefix. A row
    // pointing somewhere else is a bug, and a bug must not become a disclosure.
    if (!StorageService.keyBelongsTo(stored, user.organisationId)) {
      this.logger.error(
        `Attendance record ${record.id} points at an object outside its own organisation. Refusing.`,
      );
      throw new NotFoundException('No photo was taken with this punch.');
    }

    const object = await this.storage.readAttendanceObject(user.organisationId, stored);
    if (!object) throw new NotFoundException('That photo is no longer stored.');
    return object;
  }
}
