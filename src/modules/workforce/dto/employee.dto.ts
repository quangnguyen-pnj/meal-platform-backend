import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Credentials for a UserAccount created alongside (or linked to) an employee.
 * The password is only ever accepted here and hashed with Argon2id by the
 * service; it is never stored or logged in plaintext and never echoed back.
 */
export class EmployeeAccountDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(255)
  password!: string;
}

export class CreateEmployeeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  employeeCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fullName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsBoolean()
  hasPersonalDevice?: boolean;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  factoryId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  departmentId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  teamId!: string;

  /**
   * Optional login account to create and link. Omit it for workers who do not
   * log in (for example a production worker with no personal device).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => EmployeeAccountDto)
  account?: EmployeeAccountDto;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fullName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsBoolean()
  hasPersonalDevice?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  factoryId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  departmentId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  teamId?: string;
}
