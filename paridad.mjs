import { banks } from './dist/index.js'
import { writeFileSync, readFileSync } from 'node:fs'

const env = readFileSync('/Users/cabane/dev/personal/bank-sync/.env', 'utf8')
const get = (k) => { const l = env.split('\n').find(x => x.startsWith(k + '=')); return l.slice(l.indexOf('=') + 1).trim() }

const t0 = Date.now()
const res = await banks.santander.scrape({
  rut: get('SANTANDER_RUT'),
  password: get('SANTANDER_PASSWORD'),
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  onProgress: (s) => console.log(`  · ${s}`),
})

console.log(`\nsuccess: ${res.success}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
if (!res.success) { console.log('error:', res.error); process.exit(1) }

console.log(`\n=== CUENTAS (${res.accounts?.length ?? 0}) ===`)
for (const a of res.accounts ?? []) console.log(`  "${a.label ?? '(sin label)'}"  saldo=${a.balance}  movs=${a.movements.length}`)

console.log(`\n=== TARJETAS (${res.creditCards?.length ?? 0}) ===`)
for (const c of res.creditCards ?? []) {
  console.log(`  "${c.label}"  movs=${c.movements?.length ?? 0}  periodo=${c.billingPeriod ?? '?'}  vence=${c.nextDueDate ?? '?'}`)
  const cuotas = (c.movements ?? []).filter(m => m.installments)
  if (cuotas.length) console.log(`     en cuotas: ${cuotas.length} -> ${cuotas.slice(0,3).map(m => m.installments).join(', ')}`)
}

const all = [
  ...(res.accounts ?? []).flatMap(a => a.movements.map(m => ({ ...m, _acc: a.label }))),
  ...(res.creditCards ?? []).flatMap(c => (c.movements ?? []).map(m => ({ ...m, _acc: c.label }))),
]
const bySource = {}
for (const m of all) bySource[m.source] = (bySource[m.source] || 0) + 1
console.log(`\n=== MOVIMIENTOS: ${all.length} ===`)
console.table(bySource)
console.log('\nMuestra:')
all.slice(0, 6).forEach(m => console.log(`  ${m.date} ${String(m.amount).padStart(10)} "${m.description.slice(0,44)}" [${m.source}]`))

writeFileSync('/private/tmp/claude-501/-Users-cabane-dev-personal/5da98104-0f93-46f1-8bb0-9d751e93815f/scratchpad/lib-result.json', JSON.stringify(res, null, 2))
console.log('\nGuardado en lib-result.json')
