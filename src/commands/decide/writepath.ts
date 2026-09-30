/**
 * Write-path slot lanes (S7 triage, S8 grounding, S9 conflict): registers
 * their `gbrain decide` subcommands, what-if reducers and dataset adapters.
 * Loaded by `loadDecideLanes()` before any decide subcommand or help runs.
 */
import { whatIfGrounding } from '../../core/cycle/grounding-decide.ts';
import { whatIfTriage } from '../../core/cycle/triage-decide.ts';
import '../../core/cycle/decide-datasets.ts';
import { registerWhatIfReducer } from './receipts.ts';

registerWhatIfReducer('triage', whatIfTriage);
registerWhatIfReducer('grounding', whatIfGrounding);
