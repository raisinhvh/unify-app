export default {
  name: "notes",
  description: "Read and append local notes.",
  tools: [
    { name: "list", description: 'Tool list.', run() { return 'ok'; } },
    { name: "add", description: 'Tool add.', run() { return 'ok'; } }
  ],
};
