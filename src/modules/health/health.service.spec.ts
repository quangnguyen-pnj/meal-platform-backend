import { Test } from '@nestjs/testing';
import { PrismaService } from '../../common/database/prisma.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  function createService(queryRaw: jest.Mock): HealthService {
    return new HealthService({
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
  }

  it('reports ok when the database responds', async () => {
    const service = createService(jest.fn().mockResolvedValue([{ '1': 1 }]));

    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('up');
    expect(typeof result.timestamp).toBe('string');
  });

  it('reports degraded when the database query throws', async () => {
    const service = createService(
      jest.fn().mockRejectedValue(new Error('connection refused')),
    );

    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.database).toBe('down');
  });

  it('wires through the Nest DI container', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: { $queryRaw: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);
    await expect(service.check()).resolves.toMatchObject({ status: 'ok' });
  });
});
