import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // Secret used to sign and verify JWT access and refresh tokens. Must be set
  // locally; the .env.example placeholder is for development only.
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  // Access-token lifetime (seconds). Short-lived; refresh tokens rotate it.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_ACCESS_TTL_SECONDS = 900;

  // Refresh-token lifetime (seconds). Default 30 days.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_REFRESH_TTL_SECONDS = 2592000;

  // Comma-separated list of allowed web origins for CORS (used when the web
  // app sends credentialed requests).
  @IsString()
  WEB_ORIGIN = 'http://localhost:3001';
}

/**
 * Validates process environment at startup. Fails fast with a clear message
 * so a missing DATABASE_URL or malformed PORT never produces a confusing
 * runtime error later.
 */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${errors
        .map((error) => Object.values(error.constraints ?? {}).join(', '))
        .join('; ')}`,
    );
  }

  return validated;
}
