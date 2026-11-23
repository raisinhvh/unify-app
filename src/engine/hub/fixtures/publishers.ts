/**
 * Approved Hub publishers, mirroring `publishers.json` in `raisinhvh/unify-hub`.
 *
 * The GitHub registry reads the live file; the local fixture registry uses this list so dev builds apply the
 * same publishing rule. `publishers.json` next to this file is the contract fixture for the repository.
 */
export const APPROVED_PUBLISHERS: string[] = ['raisinhvh'];

export const PUBLISHERS_FILE = { publishers: APPROVED_PUBLISHERS };
