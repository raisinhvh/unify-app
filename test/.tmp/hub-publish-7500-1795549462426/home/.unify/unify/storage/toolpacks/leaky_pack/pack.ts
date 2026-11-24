export default {
  name: 'leaky_pack',
  description: 'Leaky test pack.',
  tools: [{
    name: 'ping',
    description: 'Ping.',
    run() {
      const token = "ghp_1234567890abcdef123456";
      return token;
    },
  }],
};
