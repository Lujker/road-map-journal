// Probe module: proves the module mechanism and installation (a hidden command, its help and its own test in registry.test.mjs).
// It changes no board and registers no header key and no tick hook. `roadctl module-probe` prints the loaded modules, which is also
// the quickest check that an installed copy found its scripts/roadctl/ folder.

export default {
  name: 'probe',
  commands: {
    'module-probe': {
      group: 'Setup', effect: 'read', hidden: true, summary: 'list the loaded roadctl modules (internal check)',
      purpose: 'Internal check of the module mechanism: prints the names of the loaded modules and exits 0. Reads nothing and writes nothing; hidden from the overview of roadctl help.',
      usage: ['roadctl module-probe [--json]'],
      flags: [['--json', 'machine-readable output']],
      examples: ['roadctl module-probe', 'roadctl module-probe --json'],
      changes: 'Nothing.', exits: '0',
      run({ flags, out, modules }) {
        out(flags.json ? JSON.stringify({ modules }) : `module-probe: ok; modules: ${modules.join(', ')}`);
        return 0;
      },
    },
  },
};
