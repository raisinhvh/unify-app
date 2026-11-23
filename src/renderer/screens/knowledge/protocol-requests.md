# Knowledge: engine requests

The engine already handles the Knowledge contract (`src/engine/unify/requests/index.ts`, types in
`src/engine/unify/requests/types.ts`): `knowledgeList`, `readKnowledge`, `saveKnowledge`, `removeKnowledge`,
`setKnowledgeAudience`, `importSkillFolder`, `openKnowledge`. Replies echo `requestId` when the request had one.
`screens/knowledge/adapter.ts` mirrors those types exactly.

## Still needed

### `undoKnowledgeChange`

The document's Details column offers **Open change** and **Undo** when an agent (not `you`) edited the item in
the last 24 hours (`knowledge.agentWrites` on). Open uses `openKnowledge`. Undo needs:

```ts
// UI -> engine (no requestId; fire and forget)
{ type: 'undoKnowledgeChange'; id: string }
```

The engine restores the file(s) to the version before the agent's last write (the review checkpoint for that
write, or a copy kept when the agent saved), then replies with a fresh `{ type: 'knowledgeState', items }`. If
there is nothing to undo, reply `{ type: 'knowledgeError', message: 'Nothing to undo.' }`.

`KnowledgeItem.updatedBy` should be the agent's display name (or `'you'` for the user) so the UI can tell the two
apart.
