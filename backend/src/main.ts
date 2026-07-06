import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { isAbsolute, join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true captures the unparsed request body (req.rawBody) so provider
  // webhooks (Razorpay / WhatsApp) can be HMAC signature-verified over the exact
  // bytes received. JSON parsing still happens normally for everything else.
  // Disable Nest's default 100kb body parser; register Express parsers with a big
  // limit — bulk legacy-sync payloads (POST /sync/*) are several MB. The json
  // `verify` hook preserves the raw body for webhook HMAC signature checks.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(json({ limit: '25mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));

  const config = app.get(ConfigService);

  // Serve uploaded images/photos statically at /uploads (same dir StorageService
  // writes to). Production can instead point imageUrl at R2/Cloudinary CDN URLs.
  const configuredUploadDir = config.get<string>('UPLOAD_DIR');
  const uploadDir = configuredUploadDir
    ? (isAbsolute(configuredUploadDir) ? configuredUploadDir : join(process.cwd(), configuredUploadDir))
    : join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadDir, { prefix: '/uploads' });

  // Fail fast if the JWT signing secret is missing/weak. Without this a misconfigured
  // deploy would sign tokens with an `undefined`/placeholder secret (auth bypass risk).
  const jwtSecret = config.get<string>('JWT_SECRET');
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error(
      'JWT_SECRET is not set or too short (need >=16 chars). Set a strong secret in the environment before starting.',
    );
  }
  if (
    process.env.NODE_ENV === 'production' &&
    jwtSecret === 'eclat-dev-secret-change-in-prod'
  ) {
    throw new Error('JWT_SECRET is still the dev placeholder in production. Set a real secret.');
  }

  // Validate + strip unknown fields at the edge (CLAUDE.md rule #3).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject (not silently strip) unknown body fields — blocks mass-assignment
      // attempts (e.g. a client trying to POST status/requestedRole/approvedRole).
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // CORS for the Next.js frontend. Origins come from CORS_ORIGINS (comma-separated)
  // in production; default to localhost for dev. Set CORS_ORIGINS to the real
  // frontend domain(s) on Railway/Vercel before go-live.
  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Store-Id'],
  });

  // Read PORT straight from the env (Railway injects it) and bind 0.0.0.0 so the
  // platform proxy can reach the container (binding ::/localhost causes 502s).
  const port = Number(process.env.PORT) || 4000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Eclat backend listening on 0.0.0.0:${port}`);
}
bootstrap();
