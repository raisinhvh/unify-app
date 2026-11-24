export default {
  name: 'sample_pack',
  description: 'A clean test toolpack for publishing.',
  tools: [
    { name: 'status', description: 'Report current status.', run() { return 'ok'; } },
    { name: 'list', description: 'List available items.', run() { return []; } },
  ],
};
