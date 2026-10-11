import * as argon2 from 'argon2';
import { PrismaService } from '../../common/database/prisma.service';
import { LocalIdentityProvider } from './local-identity-provider';

describe('LocalIdentityProvider', () => {
  const email = 'lan.tt01@pnj.com.vn';
  const password = 'local-only-password';

  function createProvider(findUnique: jest.Mock): LocalIdentityProvider {
    return new LocalIdentityProvider({
      userAccount: { findUnique },
    } as unknown as PrismaService);
  }

  it('returns the identity when email and Argon2id password match', async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const provider = createProvider(
      jest.fn().mockResolvedValue({
        id: 'acc-1',
        email,
        passwordHash,
        isActive: true,
      }),
    );

    const identity = await provider.authenticate({ email, password });

    expect(identity).toEqual({ userAccountId: 'acc-1', email });
  });

  it('returns null when the password does not match the stored hash', async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const provider = createProvider(
      jest.fn().mockResolvedValue({
        id: 'acc-1',
        email,
        passwordHash,
        isActive: true,
      }),
    );

    const identity = await provider.authenticate({
      email,
      password: 'wrong-password',
    });

    expect(identity).toBeNull();
  });

  it('returns null for an unknown account without comparing a password', async () => {
    const provider = createProvider(jest.fn().mockResolvedValue(null));

    const identity = await provider.authenticate({ email, password });

    expect(identity).toBeNull();
  });

  it('returns null for an inactive account', async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const provider = createProvider(
      jest.fn().mockResolvedValue({
        id: 'acc-1',
        email,
        passwordHash,
        isActive: false,
      }),
    );

    expect(await provider.authenticate({ email, password })).toBeNull();
  });

  it('returns null for an account with no local password hash', async () => {
    const provider = createProvider(
      jest.fn().mockResolvedValue({
        id: 'acc-1',
        email,
        passwordHash: null,
        isActive: true,
      }),
    );

    expect(await provider.authenticate({ email, password })).toBeNull();
  });
});
