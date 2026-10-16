import { parseArgs } from 'node:util'
import { BudgetLedger, defaultLedgerPath } from '@kalyth/gateway'

// Shows or sets the model spend cap in the user's ledger (ADR 0010). Setting a cap is how an
// approved budget takes effect; each change is kept with its note.
//
//   pnpm budget
//   pnpm budget set 0.50 --note "KAL-20261016-010 spike"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { note: { type: 'string' } },
})
const ledger = new BudgetLedger(defaultLedgerPath())
const usd = (micro: number) => `${(micro / 1e6).toFixed(4)} USD`

if (positionals[0] === 'set') {
  const amount = Number(positionals[1])
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000) {
    process.stderr.write('usage: pnpm budget set <usd between 0 and 1000> --note <approval>\n')
    process.exit(2)
  }
  if (!values.note?.trim()) {
    process.stderr.write('a cap needs --note naming its approval, e.g. a queue entry\n')
    process.exit(2)
  }
  ledger.setCap(Math.round(amount * 1e6), values.note)
} else if (positionals.length > 0) {
  process.stderr.write('usage: pnpm budget [set <usd> --note <approval>]\n')
  process.exit(2)
}

const s = ledger.status()
process.stdout.write(
  [
    `ledger:    ${defaultLedgerPath()}`,
    `cap:       ${usd(s.capMicroUsd)}${s.capNote ? ` (${s.capNote}, set ${s.capSetAt})` : ' (none set: paid calls are refused)'}`,
    `spent:     ${usd(s.spentMicroUsd)}`,
    `reserved:  ${usd(s.reservedMicroUsd)} (in flight or unknown outcome; counted as spent)`,
    `remaining: ${usd(s.remainingMicroUsd)}`,
    `calls:     ${s.calls}`,
    '',
  ].join('\n'),
)
ledger.close()
