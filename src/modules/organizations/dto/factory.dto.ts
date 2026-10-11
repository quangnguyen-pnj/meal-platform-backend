import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateFactoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}

export class UpdateFactoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}
