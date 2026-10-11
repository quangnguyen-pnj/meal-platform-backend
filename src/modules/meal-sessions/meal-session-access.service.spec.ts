import { evaluateRegistrationWindow } from './meal-session-access.service';

const OPENS = new Date('2025-03-10T02:00:00.000Z');
const CUTOFF = new Date('2025-03-11T02:00:00.000Z');

function session(status: string) {
  return {
    id: 'session-1',
    status: status as never,
    opensAt: OPENS,
    cutoffAt: CUTOFF,
  };
}

describe('evaluateRegistrationWindow', () => {
  it('reports OPEN for an OPEN session before cutoff', () => {
    const now = new Date('2025-03-10T12:00:00.000Z');
    const window = evaluateRegistrationWindow(session('OPEN'), now);
    expect(window.state).toBe('OPEN');
    expect(window.isOpen).toBe(true);
  });

  it('reports CUTOFF_PASSED after cutoff WITHOUT any background job, even if status is still OPEN', () => {
    // One millisecond past cutoff. The stored status is still OPEN (no close
    // worker ran), yet the window must already report closed by time alone.
    const now = new Date(CUTOFF.getTime() + 1);
    const window = evaluateRegistrationWindow(session('OPEN'), now);
    expect(window.state).toBe('CUTOFF_PASSED');
    expect(window.isOpen).toBe(false);
  });

  it('treats the exact cutoff instant as closed (half-open window)', () => {
    const window = evaluateRegistrationWindow(
      session('OPEN'),
      new Date(CUTOFF),
    );
    expect(window.state).toBe('CUTOFF_PASSED');
    expect(window.isOpen).toBe(false);
  });

  it('reports BEFORE_OPEN when now is before opensAt even if OPEN', () => {
    const now = new Date(OPENS.getTime() - 1);
    const window = evaluateRegistrationWindow(session('OPEN'), now);
    expect(window.state).toBe('BEFORE_OPEN');
    expect(window.isOpen).toBe(false);
  });

  it('reports BEFORE_OPEN for DRAFT and PUBLISHED sessions', () => {
    const now = new Date('2025-03-10T12:00:00.000Z');
    expect(evaluateRegistrationWindow(session('DRAFT'), now).state).toBe(
      'BEFORE_OPEN',
    );
    expect(evaluateRegistrationWindow(session('PUBLISHED'), now).state).toBe(
      'BEFORE_OPEN',
    );
  });

  it('reports CANCELLED regardless of time', () => {
    const now = new Date('2025-03-10T12:00:00.000Z');
    const window = evaluateRegistrationWindow(session('CANCELLED'), now);
    expect(window.state).toBe('CANCELLED');
    expect(window.isOpen).toBe(false);
  });

  it('reports CLOSED for an explicitly closed session still before cutoff', () => {
    const now = new Date('2025-03-10T12:00:00.000Z');
    const window = evaluateRegistrationWindow(session('CLOSED'), now);
    expect(window.state).toBe('CLOSED');
    expect(window.isOpen).toBe(false);
  });

  it('echoes opensAt and cutoffAt as ISO instants', () => {
    const now = new Date('2025-03-10T12:00:00.000Z');
    const window = evaluateRegistrationWindow(session('OPEN'), now);
    expect(window.opensAt).toBe(OPENS.toISOString());
    expect(window.cutoffAt).toBe(CUTOFF.toISOString());
  });
});
