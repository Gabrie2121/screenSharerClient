#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   PONTE PARA QUEM FICOU PRESO NUMA BUILD -dev

   O PROBLEMA
   Builds "-dev" antigas rodam com `autoUpdater.channel = 'dev'`, o que as
   faz procurar um `dev.yml` no GitHub Releases. Esse arquivo nunca foi
   publicado: o electron-builder só gera o nome do canal quando existe
   `channel` em build.publish, e não existe — as 13 releases têm apenas
   `latest.yml`. Resultado: essas instalações ficaram permanentemente sem
   atualização, procurando um arquivo inexistente, sem erro visível.

   POR QUE PUBLICAR UMA VERSÃO NOVA NÃO BASTA
   A correção do updater está DENTRO do binário novo. Mas o binário velho é
   quem decide onde procurar, e ele só olha `dev.yml`. Publicar mais uma
   release com `latest.yml` não muda nada para eles — continuam presos.

   O QUE ESTE SCRIPT FAZ
   Sobe um `dev.yml` (cópia byte a byte do `latest.yml` — o conteúdo não tem
   nada de específico de canal, só versão, hash e caminho) como asset extra
   da release recém-publicada. Aí o cliente velho finalmente ACHA o que
   procura, atualiza, e passa a rodar o código novo — que não usa canal
   nenhum e lê `latest.yml` como todo mundo. Uma única atualização basta
   para desfazer o bloqueio; daí em diante ele segue o fluxo normal.

   Vale manter nas próximas releases "-dev" como seguro para retardatários:
   quem só abrir o app daqui a meses ainda vai encontrar a ponte.

   O token vem de GH_TOKEN no ambiente — nunca é lido de arquivo nem
   passado por argumento.
═══════════════════════════════════════════════════════════════ */
const fs = require('fs')
const path = require('path')

const pkg = require('../package.json')
const { owner, repo } = pkg.build.publish
const tag = `v${pkg.version}`
const DIST = path.join(__dirname, '..', 'dist')

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  console.error('[dev-bridge] GH_TOKEN não definido — pulando o upload do dev.yml.')
  process.exit(1)
}

const api = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...opts.headers,
  },
})

async function main() {
  const latest = path.join(DIST, 'latest.yml')
  if (!fs.existsSync(latest)) {
    throw new Error('dist/latest.yml não existe — rode o build/release antes.')
  }

  const devYml = path.join(DIST, 'dev.yml')
  fs.copyFileSync(latest, devYml)

  const res = await api(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`)
  if (!res.ok) {
    throw new Error(`Release ${tag} não encontrada (${res.status}). `
      + 'Publique a release antes de rodar a ponte.')
  }
  const release = await res.json()

  // Substituir exige apagar o asset antigo: a API recusa nome duplicado.
  const existing = release.assets.find(a => a.name === 'dev.yml')
  if (existing) {
    await api(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${existing.id}`,
      { method: 'DELETE' })
  }

  const body = fs.readFileSync(devYml)
  const upload = await api(
    `${release.upload_url.split('{')[0]}?name=dev.yml`,
    { method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body },
  )
  if (!upload.ok) {
    throw new Error(`Falha no upload do dev.yml (${upload.status}): ${await upload.text()}`)
  }

  console.log(`[dev-bridge] dev.yml publicado em ${tag} — `
    + 'instalações antigas presas no canal "dev" agora conseguem atualizar.')
}

main().catch((err) => {
  console.error(`[dev-bridge] ${err.message}`)
  process.exit(1)
})
