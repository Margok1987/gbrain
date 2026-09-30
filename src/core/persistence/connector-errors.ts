/**
 * Typed connector refusals and the hints that travel with them.
 *
 * The coordinator persists only a failed receipt's code and message
 * (coordinator.ts `requestError`), so a code delivered through a stored
 * receipt gets its `suggestion`, `detail` and `docs` pointer rebuilt here,
 * deterministically, from the code, the message and the receipt's own fields.
 */
import { OperationError } from '../ops/contract.ts';
import { describeConnectorAccount, type ConnectorAccount } from './connector-state.ts';
import type { ConnectorConfig, ConnectorKind } from './connector-identity.ts';
import type { GitHubSourceConfig } from '../github-source.ts';
import type { GoogleSourceConfig } from '../google/types.ts';

export const REFUSAL_DOCS = 'docs/guides/write-refusals.md';
export const docsAnchor = (code: string) => `${REFUSAL_DOCS}#${code.replaceAll('_', '-')}`;

/** The two exits for a changed connector account: restore the credential, or add a new source deliberately. */
export function connectorAccountChanged(sourceId: string, kind: ConnectorKind, config: ConnectorConfig,
  recorded: ConnectorAccount | string, resolved: ConnectorAccount | string | null): OperationError {
  const show = (value: ConnectorAccount | string | null) => value === null ? 'no resolvable account' : typeof value === 'string' ? value : describeConnectorAccount(value);
  let restore: string;
  let replace: string;
  if (kind === 'google') {
    const google = config as GoogleSourceConfig;
    const where = google.access === 'command' ? `the command configured as g_token_command (${google.tokenCommand ?? 'unset'})`
      : google.access === 'env' ? `the environment variable configured as g_token_env (${google.tokenEnv ?? 'unset'})` : `the vault credential (gbrain google connect --account ${google.account})`;
    restore = `restore ${where} so it yields a token for ${show(recorded)}, then retry: gbrain sync --source ${sourceId}`;
    replace = `add a new source for the new account (gbrain google setup --account ${typeof resolved === 'object' && resolved?.kind === 'google' ? resolved.email : '<email>'}), `
      + `then archive this one: gbrain sources archive ${sourceId}`;
  } else {
    const github = config as GitHubSourceConfig;
    const installation = typeof resolved === 'object' && resolved?.kind === 'github' && resolved.installationId !== null ? resolved.installationId : '<installation-id>';
    restore = github.app ? `restore the GitHub App credential (gh_app_id ${github.app.appId}, key at gh_app_pem_path) for ${show(recorded)}, then retry: gbrain sync --source ${sourceId}`
      : `restore the token in the environment variable configured as gh_token_env (${github.tokenEnv}) for ${show(recorded)}, then retry: gbrain sync --source ${sourceId}`;
    replace = `add a new source pinned to the intended installation (gbrain sources add <new-id> --kind github --scope ${github.scope}`
      + `${github.scope === 'repos' ? ` --repos ${github.repos.join(',')}` : ''}${github.app ? ` --app-id ${github.app.appId} --app-pem <path>` : ''} --app-install ${installation}), `
      + `then archive this one: gbrain sources archive ${sourceId}`;
  }
  // Account emails and installation ids stay in the local suggestion: job records persist and serve the message remotely.
  const error = new OperationError('connector_account_changed',
    `Connector source ${sourceId} is pinned to a different account than its credential resolves to. Nothing was imported.`,
    `The source is pinned to ${show(recorded)}; the credential resolves to ${show(resolved)}. (A) ${restore}. `
      + `(B) For a deliberate account change, ${replace}; existing pages stay under ${sourceId}. No reset flag authorizes an account change.`,
    docsAnchor('connector_account_changed'));
  error.detail = resolved === null ? 'account_unresolved' : 'account_changed';
  return error;
}

export const CONNECTOR_INTENT_OUTDATED_PRE_UPGRADE = 'The connector request was admitted before this upgrade in the retired intent format.';
export const CONNECTOR_INTENT_OUTDATED_OLD_HOST = 'A connector host older than this release admitted the request in the retired intent format.';

/** Rebuilds the suggestion, detail and docs pointer for a code delivered through a stored receipt. */
export function receiptDeliveredHint(receipt: { error_code?: string | null; error_message?: string | null; source_id?: string; intent?: Record<string, unknown> | null }):
  { suggestion: string; detail?: string; docs: string } | null {
  const source = receipt.source_id ?? '<source>';
  switch (receipt.error_code) {
    case 'connector_intent_outdated': {
      const preUpgrade = receipt.error_message === CONNECTOR_INTENT_OUTDATED_PRE_UPGRADE;
      return preUpgrade
        ? { detail: 'pre_upgrade', docs: docsAnchor('connector_intent_outdated'),
          suggestion: `No host upgrade is needed: the item is fetched again on the next run under a new request ID. Run: gbrain sync --source ${source}` }
        : { docs: docsAnchor('connector_intent_outdated'),
          suggestion: `Upgrade gbrain on the host that runs connector jobs for ${source} (gbrain upgrade), then run gbrain sync --source ${source}; the item is fetched again under a new request ID.` };
    }
    case 'unsupported_mutation_protocol': {
      const kind = String(receipt.intent?.kind ?? '');
      if (!kind.startsWith('connector_v2_')) return null;
      return { detail: 'consumer_upgrade_required', docs: docsAnchor('unsupported_mutation_protocol'),
        suggestion: `The persistence consumer that owns ${source} runs a gbrain older than this connector. Run gbrain upgrade on every consumer and worktree-owner host, then gbrain sync --source ${source}.` };
    }
    default:
      return null;
  }
}
