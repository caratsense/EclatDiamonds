import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../common/auth-user';

@Controller('stores')
export class StoresController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /stores — the stores in the caller's scope (frontend Store[] shape). */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const stores = await this.prisma.store.findMany({
      where: user.allStores ? { isAggregate: false } : { id: { in: user.storeIds } },
      orderBy: { name: 'asc' },
    });
    return stores.map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city,
      isAggregate: s.isAggregate || undefined,
    }));
  }
}
