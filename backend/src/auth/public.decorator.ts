import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Mark a route as not requiring authentication (e.g. POST /auth/login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
