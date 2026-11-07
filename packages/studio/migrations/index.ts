import * as migration_20261103_213528_initial from './20261103_213528_initial.ts';
import * as migration_20261107_032327_agent_project from './20261107_032327_agent_project.ts';

export const migrations = [
  {
    up: migration_20261103_213528_initial.up,
    down: migration_20261103_213528_initial.down,
    name: '20261103_213528_initial',
  },
  {
    up: migration_20261107_032327_agent_project.up,
    down: migration_20261107_032327_agent_project.down,
    name: '20261107_032327_agent_project'
  },
];
