import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/** Shared HTTP setup for the server and the end-to-end tests. */
export function setupApp(app: INestApplication) {
  const config = app.get(ConfigService);
  const http = app.getHttpAdapter().getInstance();
  if (config.get('TRUST_PROXY')) http.set('trust proxy', Number(config.get('TRUST_PROXY')) || 1);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: (config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
}
