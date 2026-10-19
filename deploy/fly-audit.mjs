#!/usr/bin/env node
// Lists the demo app's billable Fly.io resources and fails if anything beyond the expected set
// exists (ADR 0019, billing controls). Fly.io cannot cap spending, so Philip runs this weekly and
// after every deployment, with his own flyctl login:
//
//   node deploy/fly-audit.mjs [app name]
//
// Expected: one machine (shared CPU, 1 CPU, at most 1 GB), one volume of at most 1 GB, and no
// dedicated IPv4 address. It reads only; it never changes anything. flyctl's JSON field names are
// read defensively, and this script will be checked against real output at the first deployment.

import { execFileSync } from 'node:child_process'

const app = process.argv[2] ?? 'kalyth-demo'
const fly = (...args) =>
  JSON.parse(execFileSync('flyctl', [...args, '-a', app, '--json'], { encoding: 'utf8' }) || '[]')
const list = (value) => (Array.isArray(value) ? value : [])

const problems = []
const machines = list(fly('machines', 'list'))
const volumes = list(fly('volumes', 'list'))
const ips = list(fly('ips', 'list'))

console.log(`app ${app}`)
for (const m of machines) {
  const guest = m.config?.guest ?? {}
  console.log(
    `  machine ${m.id} ${m.state ?? '?'} in ${m.region ?? '?'}: ${guest.cpu_kind ?? '?'} ${guest.cpus ?? '?'} CPU, ${guest.memory_mb ?? '?'} MB`,
  )
  if (guest.cpu_kind !== undefined && guest.cpu_kind !== 'shared') {
    problems.push(`machine ${m.id} is not a shared CPU`)
  }
  if ((guest.cpus ?? 1) > 1) problems.push(`machine ${m.id} has ${guest.cpus} CPUs`)
  if ((guest.memory_mb ?? 0) > 1024) problems.push(`machine ${m.id} has ${guest.memory_mb} MB`)
}
if (machines.length !== 1) problems.push(`${machines.length} machines, expected 1`)

for (const v of volumes) {
  const size = v.size_gb ?? v.SizeGb
  console.log(
    `  volume ${v.id} ${v.name ?? ''}: ${size ?? '?'} GB in ${v.region ?? v.Region ?? '?'}`,
  )
  if ((size ?? 0) > 1) problems.push(`volume ${v.id} is ${size} GB`)
}
if (volumes.length !== 1) problems.push(`${volumes.length} volumes, expected 1`)

for (const ip of ips) {
  const type = String(ip.Type ?? ip.type ?? '')
  console.log(`  ip ${ip.Address ?? ip.address ?? '?'} ${type}`)
  if (/v4/i.test(type) && !/shared/i.test(type)) {
    problems.push(`dedicated IPv4 ${ip.Address ?? ip.address} (2 USD a month)`)
  }
}

if (problems.length > 0) {
  console.error('\nunexpected billable resources:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nonly the expected resources exist. Now check the invoice so far in the dashboard.')
