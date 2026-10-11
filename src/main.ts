import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // All routes are served under the /v1 prefix per the API contract.
  app.setGlobalPrefix('v1');

  const configService = app.get(ConfigService);

  // Allow the web app's origin with credentials so a browser client can send
  // the Authorization header (and cookies, if adopted later) cross-origin.
  app.enableCors({
    origin: configService
      .get<string>('WEB_ORIGIN', 'http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim()),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT', 3000);

  await app.listen(port);
}

void bootstrap();
