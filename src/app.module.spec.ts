import { TestingModule, Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * Boots the full application dependency-injection graph the same way the real
 * server does at startup. `.compile()` resolves every provider and guard
 * across all feature modules without running lifecycle hooks, so it catches a
 * missing provider or a missing module export (the class of wiring bug that
 * unit tests miss because they never instantiate the whole container) while
 * staying hermetic: no database connection and no open port.
 */
describe('AppModule dependency graph', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/meal';
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('resolves every provider across all feature modules', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
