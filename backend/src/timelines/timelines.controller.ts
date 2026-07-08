import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TimelinesService } from './timelines.service';
import {
  CreateOrderDto,
  CreateWorkflowDto,
  OrdersQueryDto,
} from './dto/timelines.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('timelines')
export class TimelinesController {
  constructor(private readonly timelines: TimelinesService) {}

  @Get('orders')
  orders(
    @CurrentUser() user: AuthUser,
    @Query() query: OrdersQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.timelines.orders(user, query, store);
  }

  @Get('orders/:id')
  order(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.timelines.order(user, id);
  }

  /** Book a custom (CO-…) or stock/replenishment (SO-…) order (Module 2). */
  @Post('orders')
  createOrder(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.timelines.createOrder(user, dto);
  }

  /** Attach/replace an order reference image (multipart field `file`). Managers and above. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('orders/:id/image')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadOrderImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.timelines.setOrderImage(user, id, file);
  }

  /** Attach the advance-payment receipt photo (multipart field `file`). Managers and above. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('orders/:id/receipt')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadOrderReceipt(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.timelines.setOrderReceipt(user, id, file);
  }

  @Get('replenishment')
  replenishment(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.timelines.replenishment(user, store);
  }

  @Post('workflows')
  createWorkflow(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkflowDto) {
    return this.timelines.createWorkflow(user, dto);
  }
}
