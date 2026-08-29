const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Controles de janela
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Captura de tela
  getSources: () => ipcRenderer.invoke('get-sources'),
  // Avisa o processo principal qual fonte foi escolhida no modal, pra ele
  // usar no setDisplayMediaRequestHandler (getDisplayMedia não carrega o id
  // da fonte no request, então esse vínculo precisa ser feito por fora).
  setCaptureSourceId: (id) => ipcRenderer.send('set-capture-source-id', id),

  // Versão do app (exibida sempre no canto inferior esquerdo)
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Log básico do app (grava em disco via processo principal)
  log: (level, message) => ipcRenderer.send('renderer-log', level, message),
  // Diagnóstico: onde o log está e como abri-lo (ver Configurações → Avançado)
  getLogPath: () => ipcRenderer.invoke('get-log-path'),
  openLogs:   () => ipcRenderer.invoke('open-logs'),
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  // Áudio do sistema SEM o próprio app (módulo nativo — ver
  // main/system-audio.js). Os blocos chegam por evento; a função devolvida
  // por onSystemAudioChunk remove o ouvinte, senão duas capturas seguidas
  // deixariam dois ouvintes somando o mesmo áudio.
  systemAudioSupported: () => ipcRenderer.invoke('system-audio-supported'),
  systemAudioStart:     () => ipcRenderer.invoke('system-audio-start'),
  systemAudioStop:      () => ipcRenderer.send('system-audio-stop'),
  onSystemAudioChunk:   (cb) => {
    const handler = (_e, chunk) => cb(chunk)
    ipcRenderer.on('system-audio-chunk', handler)
    return () => ipcRenderer.removeListener('system-audio-chunk', handler)
  },

  // Auto-update
  startUpdate:          () => ipcRenderer.send('update-start'),
  installUpdate:        () => ipcRenderer.send('update-install'),
  checkForUpdates:      () => ipcRenderer.send('check-for-updates'),
  onUpdateAvailable:    (cb) => ipcRenderer.on('update-available', (_e, data) => cb(data)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
  onUpdateProgress:     (cb) => ipcRenderer.on('update-download-progress', (_e, data) => cb(data)),
  onUpdateReady:        (cb) => ipcRenderer.on('update-ready', () => cb()),
  onUpdateError:        (cb) => ipcRenderer.on('update-error', (_e, data) => cb(data)),
})