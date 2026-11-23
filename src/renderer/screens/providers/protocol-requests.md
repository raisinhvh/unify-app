# Providers — protocol requests

The Providers screen builds against messages that exist in the engine today (`accountsState`, `modelState`,
`usageState`, `refreshUsage`, `addAccount`, `addOAuthAccount`, `reauthAccount`, `removeAccount`, `cursorLogin`,
`cursorLogout`). The five messages below are the missing pieces; everything is typed in `adapter.ts` and sent
through `postProviderRequest()`, which adds a fresh `requestId`.

Every reply carries the same `requestId`, so a slow sign-out cannot be mistaken for another account's.

```ts
export interface ProviderRequestBase {
  requestId: string;
}

export type ProviderRequest =
  | (ProviderRequestBase & { type: 'setModelEnabled'; modelId: string; enabled: boolean })
  | (ProviderRequestBase & { type: 'renameAccount'; accountId: string; label: string })
  | (ProviderRequestBase & { type: 'setAccountDefaultModel'; accountId: string; modelId: string })
  | (ProviderRequestBase & { type: 'signOutAccount'; accountId: string })
  | (ProviderRequestBase & { type: 'openProviderUsage'; accountId: string });

/** One result for any ProviderRequest. The engine must send exactly one per requestId. */
export type ProviderReply = {
  type: 'providerRequestResult';
  requestId: string;
  ok: boolean;
  /** Human-readable reason when ok is false; shown as a notice. */
  error?: string;
};
```

## `setModelEnabled`

Turns one model on/off for this installation. The screen toggles optimistically; the next `modelState`
(`SidebarModel.enabled`) is authoritative. Persist per model id, not per account.

## `renameAccount`

Sets the display label shown in the sidebar, breadcrumb and usage table. Trimmed, non-empty, max ~40 chars.
`accountsState`'s `SidebarAccount.label` answers it. Keep provider-level defaults (`Claude account`) intact.

## `setAccountDefaultModel`

The model new chats on this account start with (`SidebarAccount` has no such field today; add
`defaultModel?: string` or persist it engine-side and include it in `accountsState`). The model must be served
through that account; reject unknown ids.

## `signOutAccount`

OAuth only. Clears the stored tokens for that account and leaves the account row in place with
`usage.fix = 'signin'` until the user signs in again. API-key accounts use the existing `removeAccount`
message. Cursor uses `cursorLogout`.

## `openProviderUsage`

The user chose “View usage” for an account: refresh that account's `usageState` soon (the in-app Usage page
opens immediately). If the provider has a web dashboard the engine may also open it, but refreshing is the
contract. Do not block the reply on the network fetch: answer `ok: true` once the refresh is scheduled.

## Existing messages the screen sends unchanged

| Screen action | Message |
| --- | --- |
| Add provider → OAuth (Anthropic / OpenAI) | `addOAuthAccount { provider, label }` |
| Add provider → Cursor | `cursorLogin` |
| Add provider → API key (Mistral / Gemini) | `addAccount { provider, label, secret }` |
| Add provider → self-hosted | `addAccount { provider: 'self-hosted', label, secret?, baseURL }` |
| Account sign out (OAuth) | above `signOutAccount` request |
| Account remove (API key) | `removeAccount { accountId }` |
| Usage refresh | `refreshUsage { accountId? }` |
| Account row “Sign in” | `reauthAccount { accountId }` (Cursor: `cursorLogin`) |
