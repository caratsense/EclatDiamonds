import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, UpdateUserRoleDto, UpdateUserStoreDto } from './dto/users.dto';

/** Pull each user's store assignments (for the HO staff list). */
const USER_INCLUDE = {
  userStores: {
    include: { store: { select: { id: true, name: true } } },
    orderBy: { isPrimary: 'desc' as const },
  },
} as const;

/** Two-letter initials fallback for a freshly-provisioned login. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || name.slice(0, 2).toUpperCase()
  );
}

/** Last 10 digits of a phone (Indian mobile) — same rule the OTP login matches on. */
function last10(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public HO list/detail shape. */
  private toView(user: any) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      role: user.role as Role,
      stores: (user.userStores ?? []).map((us: any) => ({
        id: us.store.id,
        name: us.store.name,
      })),
      isActive: user.isActive,
    };
  }

  /** GET /users — every staff member with their store assignments. */
  async list() {
    const users = await this.prisma.user.findMany({
      orderBy: { name: 'asc' },
      include: USER_INCLUDE,
    });
    return users.map((u) => this.toView(u));
  }

  /**
   * POST /users — head office onboards a staff member (default salesperson) and
   * links them to a store as their primary. They then sign in via WhatsApp OTP
   * with their phone (matched on the last 10 digits) — the generated password is
   * only a placeholder so the row is valid; it is never shared.
   */
  async create(dto: CreateUserDto) {
    const phone = dto.phone?.trim() || null;
    const rawEmail = dto.email?.trim().toLowerCase() || null;

    if (!phone && !rawEmail) {
      throw new BadRequestException('Provide a phone number and/or an email so the user can sign in');
    }
    if (phone && !last10(phone)) {
      throw new BadRequestException('Enter a valid 10-digit mobile number');
    }

    const store = await this.prisma.store.findUnique({ where: { id: dto.storeId } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }

    // Email is a required unique column. When only a phone is given, synthesize a
    // stable placeholder so OTP-by-phone remains the real login identifier.
    const email = rawEmail ?? `${last10(phone!)}@staff.local`;

    const clash = await this.prisma.user.findUnique({ where: { email } });
    if (clash) throw new ConflictException(`A user with email "${email}" already exists`);

    // Random password — the user logs in via OTP, never with this.
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
    const role: Role = dto.role ?? 'salesperson';

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email,
        phone,
        initials: initialsOf(dto.name),
        role,
        passwordHash,
        isActive: true,
        userStores: {
          create: { storeId: dto.storeId, isPrimary: true },
        },
      },
      include: USER_INCLUDE,
    });
    return this.toView(user);
  }

  /** PATCH /users/:id/role — change a user's primary role (never to head_office). */
  async updateRole(id: string, dto: UpdateUserRoleDto) {
    await this.getOrThrow(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { role: dto.role },
      include: USER_INCLUDE,
    });
    return this.toView(user);
  }

  /**
   * PATCH /users/:id/store — reassign the user's PRIMARY store. Demotes any other
   * primary link and upserts the target as the new primary (keeping existing links).
   */
  async updateStore(id: string, dto: UpdateUserStoreDto) {
    await this.getOrThrow(id);
    const store = await this.prisma.store.findUnique({ where: { id: dto.storeId } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }

    await this.prisma.$transaction([
      this.prisma.userStore.updateMany({
        where: { userId: id, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.userStore.upsert({
        where: { userId_storeId: { userId: id, storeId: dto.storeId } },
        update: { isPrimary: true },
        create: { userId: id, storeId: dto.storeId, isPrimary: true },
      }),
    ]);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      include: USER_INCLUDE,
    });
    return this.toView(user);
  }

  private async getOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
