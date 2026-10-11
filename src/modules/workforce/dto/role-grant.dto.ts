import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Grant a Role to a UserAccount at exactly one scope level. The level is
 * implied by which of the optional tenant ids are present: all three empty
 * means organization scope, `factoryId` alone means factory scope, and so on.
 * The service validates that exactly one coherent level is described, that the
 * target lies within the granting principal's own authority, and that an
 * Employee-role grant is pinned to the account's own placement.
 */
export class GrantRoleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userAccountId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  roleId!: string;

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
