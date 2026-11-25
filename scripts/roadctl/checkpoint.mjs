import fs from 'node:fs';

const usage = 'usage: roadctl checkpoint CARD_ID --board DIR --as AGENT < handoff.json';

export default {
  name: 'checkpoint',
  commands: {
    checkpoint: {
      group: 'Record', effect: 'write', hidden: true,
      summary: 'record an explicit card-bound handoff supplied by an agent',
      purpose: 'Reads sensitive JSON {did, next, in_flight} from stdin and appends it to the card Log, which may be shared through git; never include secrets or provider errors. Requires one writer per card; validation and write are not atomic. Not an automatic checkpoint or proof that work stopped.',
      usage: [usage.slice(7)],
      flags: [['--board DIR', 'explicit board directory (required)'], ['--as AGENT', 'author of the handoff (required)']],
      examples: ['roadctl checkpoint W-3 --board ./board --as worker < handoff.json'],
      changes: 'Appends one Log entry and updates as_of on that card only; no status change, commit, delivery or retry.',
      exits: '0 recorded; 1 refused by mandate; 2 invalid input, unavailable board, refused target or write failure',
      run({ args, flags, api, out }) {
        const id = args[1];
        if (flags.project !== undefined || args.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(id ?? '') || typeof flags.board !== 'string' || !flags.board.trim()
          || typeof flags.as !== 'string' || !/^[A-Za-z0-9@._-]{1,100}$/.test(flags.as)) throw new Error(usage);
        let board;
        try { board = api.loadBoard(api.findBoard(process.cwd(), flags.board)); }
        catch { throw new Error('checkpoint board is unavailable or malformed'); }
        if (api.boardRequires(board.config)) throw new Error('checkpoint board requires an unsupported roadctl version');
        const cards = board.cards.filter((c) => c.header.id === id);
        if (cards.length !== 1 || cards[0].errors.length || (board.config.status_map?.[cards[0].header.status] ?? cards[0].header.status) !== 'doing') throw new Error('checkpoint requires one valid doing card with that exact id');
        const chunk = Buffer.alloc(8193);
        let size = 0;
        while (size < chunk.length) {
          const n = fs.readSync(0, chunk, size, chunk.length - size, null);
          if (!n) break;
          size += n;
        }
        if (size > 8192) throw new Error('checkpoint input exceeds 8192 bytes');
        let handoff;
        try { handoff = JSON.parse(chunk.subarray(0, size).toString('utf8')); }
        catch { throw new Error('checkpoint input must be JSON {did, next, in_flight}'); }
        const keys = ['did', 'next', 'in_flight'];
        if (!handoff || Array.isArray(handoff) || Object.keys(handoff).length !== keys.length
          || keys.some((k) => typeof handoff[k] !== 'string' || !handoff[k].trim() || handoff[k].length > 350 || /[\x00-\x1f\x7f]/.test(handoff[k]))) throw new Error('checkpoint requires only nonempty did, next, in_flight strings (350 characters each, no control characters)');
        const plain = (s) => s.replace(/[\\_]/g, '\\$&').replace(/\|/g, '¦').replace(/[`<>*#\[\]]/g, '');
        api.appendLog(board, id, `checkpoint: did: ${plain(handoff.did)} | next: ${plain(handoff.next)} | in-flight: ${plain(handoff.in_flight)}`, { author: flags.as, loose: true, maxLength: 2200 });
        const wasStale = api.workBasisStale(board, cards[0]);
        const holder = api.delegationInfo(cards[0]).claim?.agent;
        const reconciled = wasStale && (!holder || holder === flags.as) && api.checkpointWorkBasis(board, cards[0]);
        out(`checkpoint recorded on ${id}; not committed${wasStale ? reconciled ? '; reassess and check the impact before reporting' : '; dependencies still unresolved, checkpoint again after they are current' : ''}`);
        return 0;
      },
    },
  },
};
