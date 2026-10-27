import { execFileSync } from 'node:child_process';

/** Builds jimmywax_test from the migration ledger, once per run. */
export default function setup() {
  if (process.env.SKIP_DB_RESET === '1') return;
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/db-reset.ts',
      process.env.TEST_DB_NAME ?? 'jimmywax_test',
      '--seed',
    ],
    {
      stdio: 'inherit',
      shell: true,
    },
  );
}
