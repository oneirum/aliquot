import * as migration_20261103_213528_initial from './20261103_213528_initial.ts';

export const migrations = [
  {
    up: migration_20261103_213528_initial.up,
    down: migration_20261103_213528_initial.down,
    name: '20261103_213528_initial'
  },
];
