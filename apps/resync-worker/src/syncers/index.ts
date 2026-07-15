/**
 * Syncer registry. SYNCER_ORDER is the dependency order used by a full run
 * (members first so downstream syncers can resolve legacyId -> uuid). See
 * docs/specs/legacy-resync-plan.md §7.
 */
import type { Syncer } from '../types';
import { membersSyncer } from './members';
import { enrollmentsSyncer } from './enrollments';
import { kycSyncer } from './kyc';
import { treeSyncer } from './tree';
import { commissionsSyncer } from './commissions';
import { reviewsSyncer } from './reviews';
import { postsSyncer } from './posts';

// Ordered list: insertion order === run order.
const ordered: Syncer[] = [
  membersSyncer,
  enrollmentsSyncer,
  kycSyncer,
  treeSyncer,
  commissionsSyncer,
  reviewsSyncer,
  postsSyncer,
];

export const registry: Record<string, Syncer> = Object.fromEntries(ordered.map((s) => [s.name, s]));
export const SYNCER_ORDER: string[] = ordered.map((s) => s.name);
