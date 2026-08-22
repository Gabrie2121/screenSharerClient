import { $ } from './core/dom.js'
import { appLog } from './core/logger.js'
import { toast } from './core/toast.js'

/* ═══════════════════════════════════════════════════════════════
   TITLEBAR
═══════════════════════════════════════════════════════════════ */
$('btn-min').onclick   = () => window.electronAPI?.minimize()
$('btn-max').onclick   = () => window.electronAPI?.maximize()
$('btn-close').onclick = () => window.electronAPI?.close()

/* ═══════════════════════════════════════════════════════════════
   VERSÃO DO APP — canto inferior esquerdo, em toda a tela do sistema.
   Também funciona como botão de "verificar atualização" manual (antes só
   checava sozinho ao abrir o app, sem jeito de forçar uma nova checagem).
═══════════════════════════════════════════════════════════════ */
const appVersionBtn = $('app-version')
let appVersionLabel = ''
let checkingUpdate = false

window.electronAPI?.getAppVersion().then((version) => {
  appVersionLabel = `v${version}`
  appVersionBtn.textContent = appVersionLabel
})

appVersionBtn.onclick = () => {
  if (checkingUpdate) return
  checkingUpdate = true
  appVersionBtn.textContent = 'Verificando…'
  appLog('INFO', 'Usuário pediu verificação manual de atualização')
  window.electronAPI?.checkForUpdates()
}

window.electronAPI?.onUpdateNotAvailable(() => {
  checkingUpdate = false
  appVersionBtn.textContent = appVersionLabel
  toast('Você já está na versão mais recente.')
})

/* ═══════════════════════════════════════════════════════════════
   ATUALIZAÇÃO DO APP
   Botão fica escondido até o processo principal avisar que há uma versão
   nova (ver src/main/updater.js). Um clique baixa, instala e reinicia sozinho.
═══════════════════════════════════════════════════════════════ */
const btnUpdate = $('btn-update')
const updateText = $('update-text')

// Depois que o download termina, a atualização só é instalada quando a
// pessoa confirma clicando de novo — reiniciar sozinho derrubaria uma
// sessão de compartilhamento em andamento sem aviso.
let updateReady = false

btnUpdate.onclick = () => {
  if (btnUpdate.disabled) return

  if (updateReady) {
    appLog('INFO', 'Usuário confirmou reinício para instalar a atualização')
    window.electronAPI?.installUpdate()
    return
  }

  btnUpdate.disabled = true
  btnUpdate.classList.remove('error')
  updateText.textContent = 'Baixando atualização…'
  appLog('INFO', 'Download de atualização iniciado pelo usuário')
  window.electronAPI?.startUpdate()
}

window.electronAPI?.onUpdateAvailable(({ version }) => {
  appLog('INFO', `Nova versão disponível: v${version}`)
  checkingUpdate = false
  appVersionBtn.textContent = appVersionLabel
  updateReady = false
  btnUpdate.classList.remove('hidden', 'error')
  btnUpdate.disabled = false
  updateText.textContent = `Atualizar para v${version}`
})

window.electronAPI?.onUpdateProgress(({ percent }) => {
  updateText.textContent = `Baixando atualização… ${percent}%`
})

window.electronAPI?.onUpdateReady(() => {
  appLog('INFO', 'Atualização baixada — aguardando confirmação para reiniciar')
  updateReady = true
  btnUpdate.classList.remove('error')
  btnUpdate.disabled = false
  updateText.textContent = 'Reiniciar para atualizar'
})

window.electronAPI?.onUpdateError(({ message }) => {
  appLog('ERROR', `Falha na atualização: ${message}`)
  // Se o erro veio de uma checagem manual (clique no badge de versão), o
  // botão de atualização ainda não apareceu — sem isso a pessoa clicava e
  // não via nenhum retorno.
  if (checkingUpdate) {
    checkingUpdate = false
    appVersionBtn.textContent = appVersionLabel
    toast(`Não foi possível verificar atualizações: ${message}`)
  }
  updateReady = false
  btnUpdate.classList.add('error')
  btnUpdate.disabled = false
  updateText.textContent = 'Erro ao atualizar — tentar de novo'
})
