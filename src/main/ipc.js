const fs = require('fs')
const path = require('path')
const { app, ipcMain, desktopCapturer, shell } = require('electron')
const { log, LOG_DIR, LOG_FILE } = require('./logger.js')

/* ═══════════════════════════════════════════════════════════════
   IPC diverso — log do renderer, versão do app e lista de fontes de
   captura. Controles de janela (minimizar/maximizar/fechar) ficam em
   window.js, junto da criação da BrowserWindow; atualização em updater.js.
═══════════════════════════════════════════════════════════════ */

// Permite que o renderer também grave eventos no log básico do app
// (entrar em sala, iniciar/parar compartilhamento, erros, etc.)
ipcMain.on('renderer-log', (_e, level, message) => log(level, `[renderer] ${message}`))

// Versão exibida no canto inferior esquerdo (ver js/titlebar.js)
ipcMain.handle('get-app-version', () => app.getVersion())

/* ═══════════════════════════════════════════════════════════════
   ACESSO AO LOG PELA PRÓPRIA APLICAÇÃO
   Em build empacotada o caminho do log muda (app.getName() passa a ser
   "ShareSync", não o name do package.json), então não adianta decorar um
   caminho — quem sabe onde está é o app. Estes dois handlers são o que
   torna possível investigar um problema de usuário sem pedir pra ele
   caçar pasta escondida no AppData.
═══════════════════════════════════════════════════════════════ */
ipcMain.handle('get-log-path', () => LOG_FILE)

ipcMain.handle('open-logs', async () => {
  // showItemInFolder abre a pasta JÁ com o arquivo selecionado — melhor que
  // openPath(LOG_FILE), que tentaria abrir o .log no programa associado (às
  // vezes nenhum) em vez de mostrar onde ele está.
  try {
    shell.showItemInFolder(LOG_FILE)
    return true
  } catch (err) {
    log('WARN', `Falha ao abrir a pasta de logs: ${err.message}`)
    // Reserva: abre a pasta, mesmo sem selecionar o arquivo.
    await shell.openPath(LOG_DIR)
    return false
  }
})

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }))
})

/* ═══════════════════════════════════════════════════════════════
   LINKS E ARQUIVOS DO CHAT

   Os dois handlers abaixo recebem URLs vindas do renderer, ou seja, de
   texto que outra pessoa da sala digitou. Por isso os dois conferem o
   PROTOCOLO antes de agir: sem isso, um `file:///C:/...` numa mensagem
   viraria "abrir um arquivo qualquer da máquina de quem clicou".
═══════════════════════════════════════════════════════════════ */
function urlWeb(bruta) {
  try {
    const u = new URL(bruta)
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null
  } catch {
    return null
  }
}

// Link do chat vai pro navegador do sistema. Abrir dentro da janela
// levaria o app inteiro pra fora — ele não tem barra de endereço nem botão
// de voltar, e a pessoa ficaria presa numa página qualquer.
ipcMain.handle('open-external', async (_e, url) => {
  if (!urlWeb(url)) {
    log('WARN', `Link recusado (protocolo não permitido): ${url}`)
    return false
  }
  await shell.openExternal(url)
  return true
})

/* Baixar um anexo do chat pra pasta de Downloads.

   Um único ouvinte de 'will-download' por sessão, com os pedidos numa
   fila por URL: registrar um `once` por clique parece mais simples, mas
   dois downloads iniciados quase juntos trocariam de destino entre si —
   o `once` que dispara primeiro atende o item que chegar primeiro, não
   necessariamente o dele. */
const downloadsPendentes = new Map()
const sessoesOuvindo = new WeakSet()

function nomeLivre(pasta, nome) {
  const ext = path.extname(nome)
  const base = path.basename(nome, ext)
  let candidato = path.join(pasta, nome)
  let n = 1
  // Não sobrescreve o que já está lá: dois prints com o mesmo nome viram
  // "print (1).png", como faria o navegador.
  while (fs.existsSync(candidato)) {
    candidato = path.join(pasta, `${base} (${n++})${ext}`)
  }
  return candidato
}

ipcMain.handle('download-file', (e, url, nomeSugerido) => {
  if (!urlWeb(url)) return Promise.reject(new Error('Endereço não permitido'))

  const ses = e.sender.session
  if (!sessoesOuvindo.has(ses)) {
    sessoesOuvindo.add(ses)
    ses.on('will-download', (_event, item) => {
      const pedido = downloadsPendentes.get(item.getURL())
      // Download que não veio deste handler (nenhum hoje, mas se um dia
      // vier): deixa o Electron tratar do jeito padrão.
      if (!pedido) return
      downloadsPendentes.delete(item.getURL())

      const destino = nomeLivre(
        app.getPath('downloads'),
        pedido.nome || item.getFilename() || 'arquivo',
      )
      item.setSavePath(destino)
      item.once('done', (_ev, estado) => {
        if (estado === 'completed') {
          log('INFO', `Anexo salvo em ${destino}`)
          pedido.resolve(destino)
        } else {
          log('WARN', `Download de ${item.getURL()} terminou como "${estado}"`)
          pedido.reject(new Error(estado))
        }
      })
    })
  }

  return new Promise((resolve, reject) => {
    downloadsPendentes.set(url, { nome: nomeSugerido, resolve, reject })
    e.sender.downloadURL(url)
  })
})
