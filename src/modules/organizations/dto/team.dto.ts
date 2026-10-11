import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateTeamDto {
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
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}

export class UpdateTeamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}
