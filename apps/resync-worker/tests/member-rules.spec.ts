import { describe, expect, it } from 'vitest';
import { planMemberSync, type MemberSyncCurrent, type MemberSyncLegacy } from '../src/syncers/member-rules';

const MD5 = '5f4dcc3b5aa765d61d8327deb882cf99';
const BCRYPT = '$2y$10$abcdefghijklmnopqrstuuJ9mXo0b1XnQm6f8m0y5z3d9yq6Qe1a.';

const untouched: MemberSyncCurrent = { profileUpdatedAt: null, passwordUpdatedAt: null, scheduledDeletionAt: null };
const appOwned: MemberSyncCurrent = {
  profileUpdatedAt: new Date('2026-09-01T00:00:00Z'),
  passwordUpdatedAt: new Date('2026-09-01T00:00:00Z'),
  scheduledDeletionAt: null,
};
const legacy: MemberSyncLegacy = {
  fullName: 'Budi',
  avatarUrl: 'https://img/a.png',
  bio: 'halo',
  password: MD5,
  isActive: true,
};

describe('planMemberSync', () => {
  it('gives a never-touched member the legacy profile and password', () => {
    const plan = planMemberSync(untouched, legacy);
    expect(plan.profile).toEqual({ fullName: 'Budi', avatarUrl: 'https://img/a.png', bio: 'halo' });
    expect(plan.password).toEqual({ hash: MD5, algo: 'legacy' });
    expect(plan.isActive).toBe(true);
  });

  it('derives the algo from the hash shape', () => {
    expect(planMemberSync(untouched, { ...legacy, password: BCRYPT }).password).toEqual({
      hash: BCRYPT,
      algo: 'bcrypt',
    });
  });

  it('keeps an app-edited profile but still takes the legacy password', () => {
    const plan = planMemberSync({ ...untouched, profileUpdatedAt: appOwned.profileUpdatedAt }, legacy);
    expect(plan.profile).toBeNull();
    expect(plan.password).toEqual({ hash: MD5, algo: 'legacy' });
  });

  it('keeps an app-changed password but still takes the legacy profile', () => {
    const plan = planMemberSync({ ...untouched, passwordUpdatedAt: appOwned.passwordUpdatedAt }, legacy);
    expect(plan.password).toBeNull();
    expect(plan.profile).not.toBeNull();
  });

  it('never clobbers the stored hash with a null legacy password', () => {
    expect(planMemberSync(untouched, { ...legacy, password: null }).password).toBeNull();
  });

  it('propagates a legacy deactivation even when the app owns profile and password', () => {
    expect(planMemberSync(appOwned, { ...legacy, isActive: false }).isActive).toBe(false);
  });

  it('propagates a legacy reactivation even when the app owns profile and password', () => {
    expect(planMemberSync(appOwned, legacy).isActive).toBe(true);
  });

  it('does not reactivate a member who scheduled deletion in the app', () => {
    const plan = planMemberSync({ ...untouched, scheduledDeletionAt: new Date('2026-10-01T00:00:00Z') }, legacy);
    expect(plan.isActive).toBeNull();
  });

  it('still deactivates a member with a scheduled deletion', () => {
    const plan = planMemberSync(
      { ...untouched, scheduledDeletionAt: new Date('2026-10-01T00:00:00Z') },
      { ...legacy, isActive: false },
    );
    expect(plan.isActive).toBe(false);
  });
});
