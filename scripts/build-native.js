/* ═══════════════════════════════════════════════════════════════
   COMPILA O MÓDULO NATIVO  —  `npm run build:native`

   O addon de captura de áudio por processo (native/process-audio) é C++ e
   precisa ser compilado contra a ABI do Electron, não a do Node instalado.
   Este script lê a versão do Electron do próprio projeto e passa pro
   node-gyp — assim atualizar o Electron não exige lembrar de trocar um
   número escrito à mão em algum lugar.

   Exige: Visual Studio Build Tools com "Desktop development with C++" e o
   Windows SDK. Fora do Windows não há o que compilar (a API é do WASAPI),
   então o script sai em silêncio e o app usa o caminho antigo.
═══════════════════════════════════════════════════════════════ */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

if (process.platform !== 'win32') {
  console.log('build:native — pulando: a captura por processo só existe no Windows')
  process.exit(0)
}

const raiz = path.join(__dirname, '..')
const modulo = path.join(raiz, 'native', 'process-audio')
const versaoElectron = require(path.join(raiz, 'node_modules', 'electron', 'package.json')).version

console.log(`build:native — compilando contra Electron ${versaoElectron}`)

try {
  execFileSync(process.execPath, [
    path.join(raiz, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    'rebuild',
    `--target=${versaoElectron}`,
    '--arch=x64',
    '--dist-url=https://electronjs.org/headers',
  ], { cwd: modulo, stdio: 'inherit' })
} catch {
  console.error('\nbuild:native FALHOU.')
  console.error('O app ainda funciona sem o módulo — cai no loopback do sistema inteiro,')
  console.error('que traz de volta o eco da voz e não abre em algumas máquinas.')
  console.error('Para compilar: instale o Visual Studio Build Tools com o workload')
  console.error('"Desenvolvimento para desktop com C++" e rode `npm run build:native` de novo.')
  process.exit(1)
}

const binario = path.join(modulo, 'build', 'Release', 'process_audio.node')
if (!fs.existsSync(binario)) {
  console.error('build:native — compilou sem erro mas o .node não apareceu:', binario)
  process.exit(1)
}
console.log('build:native — ok:', path.relative(raiz, binario))
