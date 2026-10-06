import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', 'migrations')
const files = (await readdir(root)).filter(file => file.endsWith('.sql')).sort()
const namePattern = /^\d+_[a-z0-9][a-z0-9_-]*\.sql$/
const errors = []

if (!files.length) errors.push('Nenhuma migration SQL encontrada.')

for (const file of files) {
  if (!namePattern.test(file)) errors.push(`${file}: nome inválido; use <versão>_<descrição>.sql`)
  const sql = (await readFile(path.join(root, file), 'utf8')).trim()
  if (!sql) errors.push(`${file}: migration vazia`)
}

for (let index = 1; index < files.length; index += 1) {
  if (files[index - 1] >= files[index]) errors.push(`Ordem de migrations inválida: ${files[index - 1]} / ${files[index]}`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`Migrations válidas: ${files.length}`)
