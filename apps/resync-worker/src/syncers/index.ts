/**
 * Syncer registry. SYNCER_ORDER is the dependency order used by a full run
 * (members first so downstream syncers can resolve legacyId -> uuid). See
 * docs/legacy-resync-plan.md §7.
 */
import type { Syncer } from '../types';
import { membersSyncer } from './members';
import { enrollmentsSyncer } from './enrollments';
import { kycSyncer } from './kyc';
import { programsSyncer } from './programs';
import { treeSyncer } from './tree';
import { connectSyncer } from './connect';
import { commissionsSyncer } from './commissions';
import { reviewsSyncer } from './reviews';
import { postsSyncer } from './posts';

// Ordered list: insertion order === run order.
const ordered: Syncer[] = [
  membersSyncer,
  enrollmentsSyncer,
  kycSyncer,
  programsSyncer, // before tree: tree only syncs joins of programs linked to a product
  treeSyncer,
  connectSyncer, // after tree: overrides LEGACY_PARENT with the legacy connect (P0-1 option C)
  commissionsSyncer,
  reviewsSyncer,
  postsSyncer,
];

export const registry: Record<string, Syncer> = Object.fromEntries(ordered.map((s) => [s.name, s]));
export const SYNCER_ORDER: string[] = ordered.map((s) => s.name);
