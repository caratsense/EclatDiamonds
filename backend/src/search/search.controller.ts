import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';

/** GET /search?q= — any authenticated role; store-scoped inside the service. */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  run(
    @CurrentUser() user: AuthUser,
    @Query() q: SearchQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.search.search(user, q.q, q.storeId ?? store);
  }
}
