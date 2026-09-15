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

  // The app runs behind Railway's edge proxy: trust the first X-Forwarded-For hop
  // so req.ip is the real client IP (per-IP rate limiting depends on this).
  app.set('trust proxy', 1);

  // Baseline security headers + drop the "X-Powered-By: Express" fingerprint.
  // This is a JSON API (the HTML/CSP origin is Vercel), so the four cheap,
  // always-safe headers cover it without pulling in helmet. ponytail: add a CSP
  // here only if this service ever starts serving HTML.
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  const config = app.get(ConfigService);

  // Serve uploaded images/photos statically at /uploads (same dir StorageService
  // writes to). Production can instead point imageUrl at R2/Cloudinary CDN URLs.
  const configuredUploadDir = config.get<string>('UPLOAD_DIR');
  const uploadDir = configuredUploadDir
    ? (isAbsolute(configuredUploadDir) ? configuredUploadDir : join(process.cwd(), configuredUploadDir))
    : join(process.cwd(), 'uploads');
  /*
   * People, not products.
   *
   * The static handler below is express middleware and runs BEFORE Nest's
   * router, which means before JwtAuthGuard, RolesGuard and EntitlementGuard —
   * so anything it serves is served to anyone who has the path, signed in or
   * not. That is an acceptable trade for catalogue images, which the shop wants
   * on a CDN and which reveal nothing about a person.
   *
   * It is not acceptable for the two folders below. `attendance` holds
   * photographs of named employees' faces at a known time and place, and
   * `visits` holds photographs of customers at a counter. Those are read
   * through authenticated routes that check the caller against the record
   * (see HrmsController.attendancePhoto), so nothing legitimate needs this
   * path — and a refusal here means a leaked URL is no longer a permanent
   * unauthenticated grant.
   *
   * `exports` holds generated archives — every catalogue photograph in one
   * file. Those leave only through the head-office download route, which
   * audits who took them (CatalogueExportController).
   *
   * 404, not 403: whether a particular photo exists is itself information.
   */
  const PRIVATE_MEDIA = /^\/uploads\/org\/[^/]+\/(attendance|visits|exports)\//i;
  app.use((req: { path?: string; url: string }, res: any, next: () => void) => {
    const raw = req.path ?? req.url;
    if (!/^\/uploads\//i.test(raw)) return next();
    // Tested DECODED as well: the static handler decodes before it touches the
    // disk, so `/uploads/org/x/%65xports/…` would otherwise slip past a regex
    // that only sees the encoded form. An upload path that will not decode is
    // refused rather than guessed at.
    let decoded: string | null;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = null;
    }
    if (decoded === null || PRIVATE_MEDIA.test(raw) || PRIVATE_MEDIA.test(decoded)) {
      res.status(404).json({ statusCode: 404, message: 'Not found' });
      return;
    }
    next();
  });
  app.useStaticAssets(uploadDir, {
    prefix: '/uploads',
    setHeaders: (res: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

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

  // CORS for the Next.js frontend. Allows all localhost ports for local dev
  // (3000, 3177, etc.) and explicit production domains from CORS_ORIGINS.
  const rawCors = config.get<string>('CORS_ORIGINS');
  const configuredOrigins = rawCors
    ? rawCors.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, mobile, same-origin)
      if (!origin) return callback(null, true);
      // Allow any localhost or 127.0.0.1 port during local development
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(origin)) {
        return callback(null, true);
      }
      // Check explicit configured origins
      if (configuredOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Store-Id'],
    // A cross-origin page can only read response headers listed here. Without
    // these, a download saved as "leads.xlsx" instead of its dated name and its
    // row count read as 0.
    exposedHeaders: ['Content-Disposition', 'X-Export-Rows'],
  });

  // Read PORT straight from the env (Railway injects it) and bind 0.0.0.0 so the
  // platform proxy can reach the container (binding ::/localhost causes 502s).
  const port = Number(process.env.PORT) || 4000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Eclat backend listening on 0.0.0.0:${port}`);
}
bootstrap();
